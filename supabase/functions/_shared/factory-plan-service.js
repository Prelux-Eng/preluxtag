import { FactorySimulationError, simulateProductionOrders } from "./factory-simulation-service.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function selectedQuoteIds(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 30 || value.some((id) => typeof id !== "string" || !id.trim())) {
    throw new FactorySimulationError("Selecione até 30 orçamentos válidos.", 400);
  }
  const ids = [...new Set(value.map((id) => id.trim()))];
  if (ids.length !== value.length) throw new FactorySimulationError("Não repita orçamentos na confirmação.", 400);
  return ids;
}

/** Representação estável para detectar o uso da mesma chave em outra ação. */
export function confirmationRequestFingerprint(orderIds) {
  return JSON.stringify({
    action: "confirm_factory_plan",
    orderIds: [...orderIds].sort(),
  });
}

async function savedConfirmation({ db, organizationId, idempotencyKey, requestFingerprint }) {
  const { data, error } = await db.from("factory_plan_confirmation_receipts")
    .select("request_fingerprint, response")
    .eq("organization_id", organizationId)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if (error) {
    throw new FactorySimulationError("Não foi possível consultar a confirmação anterior.", 500);
  }
  if (!data) return null;
  if (data.request_fingerprint !== requestFingerprint) {
    throw new FactorySimulationError("Esta chave de confirmação já foi usada com outra solicitação.", 409);
  }
  if (!data.response || typeof data.response !== "object" || !data.response.scenario || !data.response.result) {
    throw new FactorySimulationError("O recibo da confirmação está incompleto; procure o suporte.", 500);
  }
  return { ...data.response, replayed: true };
}

function persistencePayload(scenario) {
  const addDay = (date) => {
    const value = new Date(`${date}T00:00:00.000Z`);
    value.setUTCDate(value.getUTCDate() + 1);
    return value.toISOString().slice(0, 10);
  };
  const orders = scenario.orders.map((order) => ({
    orderId: order.orderId,
    plan: {
      effectiveStartDate: order.units.map((unit) => unit.castDate).sort()[0] ?? null,
      plannedEndDate: order.plannedEndDate,
      forecastEndDate: order.forecastEndDate,
      units: order.units.map((unit) => ({
        ...unit,
        plannedEndDate: unit.finishDate,
      })),
    },
  }));

  const requiredDates = new Set();
  for (const order of scenario.orders) {
    for (const unit of order.units) {
      for (const date of unit.preparationDates || []) requiredDates.add(date);
      if (unit.preparationStartDate) {
        for (let date = unit.preparationStartDate; date <= unit.castDate; date = addDay(date)) {
          requiredDates.add(date);
        }
      }
      requiredDates.add(unit.castDate);
      requiredDates.add(unit.finishDate);
    }
  }
  const calendarDays = scenario.commitContext.calendarDays
    .filter((day) => requiredDates.has(day.date))
    .map((day) => ({
      date: day.date,
      is_working: day.is_working,
      capacity_minutes: day.capacity_minutes,
      source: day.source,
      exception_id: day.exception_id,
      note: day.note,
    }));

  return { orders, calendarDays };
}

async function commitScenario({
  db,
  organizationId,
  selectedQuoteIds: requestedQuotes,
  allowEmpty,
  idempotencyKey = null,
}) {
  const quoteIds = selectedQuoteIds(requestedQuotes);
  const requestFingerprint = idempotencyKey ? confirmationRequestFingerprint(quoteIds) : null;
  if (idempotencyKey) {
    const previous = await savedConfirmation({ db, organizationId, idempotencyKey, requestFingerprint });
    if (previous) return previous;
  }

  const scenario = await simulateProductionOrders({
    db,
    organizationId,
    input: { orderIds: quoteIds, allowEmpty },
  });
  if (!allowEmpty && !scenario.orders.length) {
    throw new FactorySimulationError("Não há pedidos aprovados ou orçamentos selecionados para confirmar.", 422);
  }

  const scenarioOrdersById = new Map(scenario.orders.map((order) => [order.orderId, order]));
  for (const quoteId of quoteIds) {
    if (scenarioOrdersById.get(quoteId)?.status !== "orcamento") {
      throw new FactorySimulationError("Somente orçamentos ainda não aprovados podem ser selecionados.", 409);
    }
  }

  const { orders, calendarDays } = persistencePayload(scenario);
  const { commitContext: _internalContext, ...publicScenario } = scenario;
  const rpcName = idempotencyKey
    ? "commit_factory_simulation_idempotent"
    : "commit_factory_simulation";
  const rpcParameters = {
    p_org_id: organizationId,
    p_expected_revision: scenario.commitContext.sourceRevision,
    p_approve_order_ids: quoteIds,
    p_plans: orders,
    p_calendar_days: calendarDays,
  };
  if (idempotencyKey) {
    rpcParameters.p_idempotency_key = idempotencyKey;
    rpcParameters.p_request_fingerprint = requestFingerprint;
    rpcParameters.p_scenario = publicScenario;
  }
  const { data, error } = await db.rpc(rpcName, rpcParameters);
  if (error) {
    if (error.code === "40001") {
      throw new FactorySimulationError("Os dados mudaram enquanto a fila era confirmada. Atualize e tente novamente.", 409);
    }
    const status = error.code === "23505" || error.code === "23P01" ? 409 : 422;
    throw new FactorySimulationError(error.message || "Não foi possível confirmar o Planejamento.", status);
  }

  if (idempotencyKey) return data;
  return { scenario: publicScenario, result: data, replayed: false };
}

/** Recalcula e persiste a fila aprovada sem aprovar orçamentos. */
export function reconcileFactoryPlan({ db, organizationId }) {
  return commitScenario({ db, organizationId, selectedQuoteIds: [], allowEmpty: true });
}

/** Recalcula a fila e aprova os orçamentos selecionados no mesmo commit. */
export function confirmFactoryPlan({ db, organizationId, orderIds = [], idempotencyKey }) {
  if (typeof idempotencyKey !== "string" || !UUID_RE.test(idempotencyKey)) {
    throw new FactorySimulationError("Envie uma chave UUID exclusiva para esta confirmação.", 400);
  }
  return commitScenario({
    db,
    organizationId,
    selectedQuoteIds: orderIds,
    allowEmpty: false,
    idempotencyKey,
  });
}
