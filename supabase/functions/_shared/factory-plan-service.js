import { FactorySimulationError, simulateProductionOrders } from "./factory-simulation-service.js";

function selectedQuoteIds(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 30 || value.some((id) => typeof id !== "string" || !id.trim())) {
    throw new FactorySimulationError("Selecione até 30 orçamentos válidos.", 400);
  }
  const ids = [...new Set(value.map((id) => id.trim()))];
  if (ids.length !== value.length) throw new FactorySimulationError("Não repita orçamentos na confirmação.", 400);
  return ids;
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

async function commitScenario({ db, organizationId, selectedQuoteIds: requestedQuotes, allowEmpty }) {
  const quoteIds = selectedQuoteIds(requestedQuotes);
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
  const { data, error } = await db.rpc("commit_factory_simulation", {
    p_org_id: organizationId,
    p_expected_revision: scenario.commitContext.sourceRevision,
    p_approve_order_ids: quoteIds,
    p_plans: orders,
    p_calendar_days: calendarDays,
  });
  if (error) {
    if (error.code === "40001") {
      throw new FactorySimulationError("Os dados mudaram enquanto a fila era confirmada. Atualize e tente novamente.", 409);
    }
    const status = error.code === "23505" || error.code === "23P01" ? 409 : 422;
    throw new FactorySimulationError(error.message || "Não foi possível confirmar o Planejamento.", status);
  }

  const { commitContext: _internalContext, ...publicScenario } = scenario;
  return { scenario: publicScenario, result: data };
}

/** Recalcula e persiste a fila aprovada sem aprovar orçamentos. */
export function reconcileFactoryPlan({ db, organizationId }) {
  return commitScenario({ db, organizationId, selectedQuoteIds: [], allowEmpty: true });
}

/** Recalcula a fila e aprova os orçamentos selecionados no mesmo commit. */
export function confirmFactoryPlan({ db, organizationId, orderIds = [] }) {
  return commitScenario({ db, organizationId, selectedQuoteIds: orderIds, allowEmpty: false });
}
