/**
 * Adaptador somente de leitura entre Supabase e o simulador puro.
 *
 * Pedidos aprovados entram sempre na fila firme. Orçamentos entram apenas
 * quando seus IDs são pedidos explicitamente no cenário. Ordens já iniciadas
 * não são reprogramadas; suas alocações permanecem como capacidade ocupada.
 */
import { buildCalendarDays } from "./calendar.js";
import { addDays } from "./planner.js";
import { validateEngineeringParameters } from "./engineering-domain.js";
import { simulateProject } from "./project-domain.js";
import { buildDailyProductionSteps } from "./production-phases.js";

export class FactorySimulationError extends Error {
  constructor(message, status = 422) {
    super(message);
    this.name = "FactorySimulationError";
    this.status = status;
  }
}

function checked(result, message) {
  if (result.error) throw new FactorySimulationError(`${message}: ${result.error.message}`, 500);
  return result.data ?? [];
}

function engineeringVersionFromRow(row) {
  return {
    id: row.id,
    version: Number(row.version_number),
    parameters: validateEngineeringParameters({
      preparationWorkdays: row.preparation_workdays,
      castingWorkdays: row.casting_workdays,
      curingCalendarDays: row.curing_calendar_days,
      finishingWorkdays: row.finishing_workdays,
      maxCastingsPerWorkday: row.max_castings_per_workday,
      maximumOrderCalendarDays: row.maximum_order_calendar_days,
      castingStartTime: String(row.casting_start_time).slice(0, 5),
      concreteDensityKgM3: row.concrete_density_kg_m3,
    }),
  };
}

function localDate(instant, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instant));
}

function selectedIds(input) {
  const ids = input.orderIds ?? (input.orderId ? [input.orderId] : []);
  if (!Array.isArray(ids) || ids.length > 30 || ids.some((id) => typeof id !== "string" || !id.trim())) {
    throw new FactorySimulationError("Informe até 30 identificadores de pedidos válidos.", 400);
  }
  const unique = [...new Set(ids.map((id) => id.trim()))];
  if (unique.length !== ids.length) throw new FactorySimulationError("Não repita pedidos na simulação.", 400);
  return unique;
}

async function fixedReservations({ db, organizationId, startedOrderIds, positions, timeZone, today }) {
  const units = startedOrderIds.length ? checked(await db.from("production_orders")
    .select("id, order_id")
    .eq("organization_id", organizationId)
    .in("order_id", startedOrderIds)
    .in("status", ["planned", "in_progress", "done", "pronta", "scrapped"])
    .limit(10000), "Não foi possível ler unidades em execução") : [];
  const unitIds = units.map((unit) => unit.id);
  const fields = "id, production_order_id, mold_position_id, scheduled_date, occupied_from_at, occupied_until_at, mold_catalog_codes, status";
  const startedAllocations = unitIds.length ? checked(await db.from("allocations")
    .select(fields)
    .eq("organization_id", organizationId)
    .in("production_order_id", unitIds)
    .in("status", ["planned", "in_progress", "done"])
    .limit(10000), "Não foi possível ler posições ocupadas") : [];
  // Uma concretagem já concluída hoje também consumiu a posição hoje,
  // mesmo que o pedido tenha saído da fila por entrega.
  const completedToday = checked(await db.from("allocations")
    .select(fields)
    .eq("organization_id", organizationId)
    .eq("status", "done")
    .gte("scheduled_date", today)
    .limit(10000), "Não foi possível ler concretagens concluídas");
  const withdrawnCasts = checked(await db.from("withdrawn_unit_form_events")
    .select("source_allocation_id, mold_position_id, scheduled_date, occupied_from_at, occupied_until_at, mold_catalog_codes")
    .eq("organization_id", organizationId)
    .eq("casting_completed", true)
    .gte("scheduled_date", today)
    .limit(10000), "Não foi possível ler concretagens retiradas do pedido")
    .map((event) => ({ ...event, id: event.source_allocation_id, status: "done" }));
  const allocations = [...new Map([...startedAllocations, ...completedToday, ...withdrawnCasts]
    .map((allocation) => [allocation.id, allocation])).values()];
  const codeById = new Map(positions.map((position) => [position.id, position.code]));
  return allocations.map((allocation) => {
    const positionCode = codeById.get(allocation.mold_position_id);
    if (!positionCode) throw new FactorySimulationError("Uma alocação existente aponta para posição desconhecida.", 409);
    const startDate = allocation.occupied_from_at
      ? localDate(allocation.occupied_from_at, timeZone)
      : allocation.scheduled_date;
    // O fim é exclusivo. Uma reserva até 00:00 de terça ocupa só segunda.
    const endDate = allocation.occupied_until_at
      ? localDate(new Date(Date.parse(allocation.occupied_until_at) - 1), timeZone)
      : allocation.scheduled_date;
    return {
      positionCode, startDate, endDate,
      status: allocation.status,
      moldCatalogCodes: allocation.mold_catalog_codes,
      occupiedUntilAt: allocation.occupied_until_at,
    };
  });
}

export async function simulateProductionOrders({ db, organizationId, input = {}, now = new Date() }) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new FactorySimulationError("Envie um objeto JSON com os pedidos a simular.", 400);
  }
  const requestedIds = selectedIds(input);
  const revisionResult = await db.from("factory_plan_revisions")
    .select("revision").eq("organization_id", organizationId).maybeSingle();
  if (revisionResult.error) throw new FactorySimulationError("Não foi possível conferir a versão do Planejamento.", 500);
  const sourceRevision = Number(revisionResult.data?.revision);
  if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 1) {
    throw new FactorySimulationError("A versão do Planejamento não foi inicializada.", 500);
  }

  const [ordersResult, positionsResult, settingsResult, rulesResult, orgResult, formsResult] = await Promise.all([
    db.from("orders")
      .select("id, order_number, status, start_date, requested_due_date, approved_at, created_at, is_active, engineering_parameter_version_id")
      .eq("organization_id", organizationId).eq("is_active", true)
      .in("status", ["orcamento", "aprovado", "em_producao", "atrasado"])
      .limit(1000),
    db.from("mold_positions")
      .select("id, code, status, configuration_kind, braco_catalog_code, leito_catalog_code, lateral_catalog_code, form_reset_at")
      .eq("organization_id", organizationId).order("code", { ascending: true }),
    db.from("calendar_settings")
      .select("default_capacity_minutes, planning_horizon_days")
      .eq("organization_id", organizationId).maybeSingle(),
    db.from("calendar_working_rules")
      .select("weekday, is_working, capacity_minutes")
      .eq("organization_id", organizationId),
    db.from("organizations").select("timezone").eq("id", organizationId).maybeSingle(),
    db.rpc("factory_installed_form_by_position", { p_org_id: organizationId }),
  ]);
  const allOrders = checked(ordersResult, "Não foi possível ler os pedidos");
  const organization = checked(orgResult, "Não foi possível ler a unidade");
  const timeZone = organization.timezone || "America/Sao_Paulo";
  const installedForms = new Map(checked(formsResult, "Não foi possível ler as formas montadas")
    .map((form) => [form.mold_position_id, form.mold_catalog_codes]));
  const positions = checked(positionsResult, "Não foi possível ler as posições").map((position) => ({
    ...position,
    installedMoldCatalogCodes: installedForms.get(position.id) || [],
    formResetLocalDate: position.form_reset_at ? localDate(position.form_reset_at, timeZone) : null,
  }));
  const settingsRow = checked(settingsResult, "Não foi possível ler o calendário");
  const settings = Array.isArray(settingsRow) ? { default_capacity_minutes: 480 } : settingsRow;
  const rules = checked(rulesResult, "Não foi possível ler os dias úteis");
  const selected = new Set(requestedIds);
  if (requestedIds.some((id) => !allOrders.some((order) => order.id === id))) {
    throw new FactorySimulationError("Um pedido selecionado não existe ou está encerrado.", 404);
  }
  const candidateOrders = allOrders.filter((order) =>
    ["aprovado", "em_producao", "atrasado"].includes(order.status) || selected.has(order.id)
  );
  if (!candidateOrders.length && input.allowEmpty !== true) throw new FactorySimulationError("Não há pedidos para simular.");
  if (candidateOrders.length > 30) throw new FactorySimulationError("A fila contém mais de 30 pedidos; reduza o cenário.", 422);
  if (positions.length !== 4) throw new FactorySimulationError("Cadastre as quatro posições P01–P04 antes de simular.", 409);

  const candidateIds = candidateOrders.map((order) => order.id);
  const [unitsResult, startedSchedulesResult] = candidateIds.length ? await Promise.all([
    db.from("production_orders").select("id, order_id, status").eq("organization_id", organizationId)
      .in("order_id", candidateIds).limit(10000),
    db.from("production_schedules").select("order_id").eq("organization_id", organizationId)
      .in("order_id", candidateIds).in("status", ["in_progress", "done"]).limit(10000),
  ]) : [{ data: [], error: null }, { data: [], error: null }];
  const productionUnits = checked(unitsResult, "Não foi possível verificar produção iniciada");
  const unitIds = productionUnits.map((unit) => unit.id);
  const [startedStepsResult, startedAllocationsResult] = unitIds.length ? await Promise.all([
    db.from("production_order_steps").select("production_order_id").eq("organization_id", organizationId)
      .in("production_order_id", unitIds).in("status", ["in_progress", "done"]).limit(10000),
    db.from("allocations").select("production_order_id").eq("organization_id", organizationId)
      .in("production_order_id", unitIds).in("status", ["in_progress", "done"]).limit(10000),
  ]) : [{ data: [], error: null }, { data: [], error: null }];
  const startedUnitIds = new Set([
    ...productionUnits.filter((unit) => ["in_progress", "done", "pronta", "scrapped"].includes(unit.status)).map((unit) => unit.id),
    ...checked(startedStepsResult, "Não foi possível verificar etapas iniciadas").map((step) => step.production_order_id),
    ...checked(startedAllocationsResult, "Não foi possível verificar posições ocupadas").map((allocation) => allocation.production_order_id),
  ]);
  const startedOrderIds = [...new Set([
    ...productionUnits.filter((unit) => startedUnitIds.has(unit.id)).map((unit) => unit.order_id),
    ...checked(startedSchedulesResult, "Não foi possível verificar produção iniciada").map((schedule) => schedule.order_id),
    ...candidateOrders.filter((order) => order.status === "em_producao").map((order) => order.id),
  ])];
  if (requestedIds.some((id) => startedOrderIds.includes(id))) {
    throw new FactorySimulationError("Pedido com produção iniciada não pode ser reprogramado neste cenário.", 409);
  }
  const schedulableOrders = candidateOrders.filter((order) => !startedOrderIds.includes(order.id));
  if (!schedulableOrders.length && input.allowEmpty !== true) {
    throw new FactorySimulationError("Todos os pedidos da fila já iniciaram produção.", 409);
  }
  const orderIds = schedulableOrders.map((order) => order.id);
  const referencedParameterVersionIds = [...new Set(schedulableOrders
    .map((order) => order.engineering_parameter_version_id)
    .filter(Boolean))];
  const [parameterVersionsResult, currentParameterVersionResult] = await Promise.all([
    referencedParameterVersionIds.length
      ? db.from("engineering_parameter_versions")
        .select("id, version_number, preparation_workdays, casting_workdays, curing_calendar_days, finishing_workdays, max_castings_per_workday, maximum_order_calendar_days, casting_start_time, concrete_density_kg_m3")
        .eq("organization_id", organizationId)
        .in("id", referencedParameterVersionIds)
      : Promise.resolve({ data: [], error: null }),
    db.from("engineering_parameter_versions")
      .select("id, version_number, preparation_workdays, casting_workdays, curing_calendar_days, finishing_workdays, max_castings_per_workday, maximum_order_calendar_days, casting_start_time, concrete_density_kg_m3")
      .eq("organization_id", organizationId)
      .order("version_number", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  const parameterVersions = checked(parameterVersionsResult, "Não foi possível ler as versões de Engenharia")
    .map(engineeringVersionFromRow);
  const currentParameterVersionRow = checked(currentParameterVersionResult, "Não foi possível ler a versão atual de Engenharia");
  if (!currentParameterVersionRow) {
    throw new FactorySimulationError("Os parâmetros de Engenharia ainda não foram inicializados.", 409);
  }
  const currentParameterVersion = engineeringVersionFromRow(currentParameterVersionRow);
  const parametersById = new Map(parameterVersions.map((entry) => [entry.id, entry]));
  const versionForOrder = new Map();
  for (const order of schedulableOrders) {
    const version = order.engineering_parameter_version_id
      ? parametersById.get(order.engineering_parameter_version_id)
      : currentParameterVersion;
    if (!version) {
      throw new FactorySimulationError(`A versão de Engenharia do pedido ${order.order_number} não existe para esta organização.`, 409);
    }
    versionForOrder.set(order.id, version);
  }
  const today = localDate(now, timeZone);
  const dates = schedulableOrders.map((order) => order.start_date > today ? order.start_date : today).sort();
  const startDate = dates[0] || today;
  const endDate = addDays(dates.at(-1) || today, 740);

  const [itemsResult, exceptionsResult, adjustmentsResult, reservations] = await Promise.all([
    orderIds.length ? db.from("order_items")
      .select("id, order_id, piece_type_id, quantity, sequence, production_minutes_snapshot")
      .eq("organization_id", organizationId).in("order_id", orderIds)
      .order("sequence", { ascending: true }).limit(10000)
      : Promise.resolve({ data: [], error: null }),
    db.from("calendar_exceptions")
      .select("id, name, kind, start_date, end_date, is_working, capacity_minutes, priority, is_active, updated_at")
      .eq("organization_id", organizationId).eq("is_active", true)
      .lte("start_date", endDate).gte("end_date", startDate),
    orderIds.length ? db.from("delay_adjustments")
      .select("order_id, reason, occurred_on, impact_days")
      .eq("organization_id", organizationId).in("order_id", orderIds)
      .order("occurred_on", { ascending: true }).limit(10000)
      : Promise.resolve({ data: [], error: null }),
    fixedReservations({ db, organizationId, startedOrderIds, positions, timeZone, today }),
  ]);
  const items = checked(itemsResult, "Não foi possível ler os itens");
  const exceptions = checked(exceptionsResult, "Não foi possível ler as exceções");
  const adjustments = checked(adjustmentsResult, "Não foi possível ler ajustes de prazo");
  const orderIdsWithItems = new Set(items.map((item) => item.order_id));
  const selectedWithoutItems = requestedIds.find((id) => !orderIdsWithItems.has(id));
  if (selectedWithoutItems) {
    throw new FactorySimulationError("Inclua ao menos um item no orçamento antes de simulá-lo.", 422);
  }
  const pieceIds = [...new Set(items.map((item) => item.piece_type_id))];
  const [piecesResult, moldsResult] = await Promise.all([
    pieceIds.length ? db.from("piece_types")
      .select("id, piece_kind, dimension_x_cm, dimension_y_cm, dimension_z_cm")
      .eq("organization_id", organizationId).in("id", pieceIds)
      : Promise.resolve({ data: [], error: null }),
    pieceIds.length ? db.from("piece_type_molds")
      .select("piece_type_id, role, catalog_code")
      .eq("organization_id", organizationId).in("piece_type_id", pieceIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  const pieceById = new Map(checked(piecesResult, "Não foi possível ler tipos de peça").map((piece) => [piece.id, piece]));
  const moldsByPiece = new Map();
  for (const mold of checked(moldsResult, "Não foi possível ler os moldes exigidos")) {
    const codes = moldsByPiece.get(mold.piece_type_id) || [];
    codes.push(mold.catalog_code);
    moldsByPiece.set(mold.piece_type_id, codes);
  }
  const itemsByOrder = new Map();
  for (const item of items) {
    const piece = pieceById.get(item.piece_type_id);
    if (!piece) throw new FactorySimulationError("Um item da fila aponta para tipo de peça inexistente.", 409);
    const list = itemsByOrder.get(item.order_id) || [];
    list.push({
      ...item,
      pieceKind: piece.piece_kind,
      requiredMoldCodes: moldsByPiece.get(piece.id) || [],
      dimensionXcm: piece.dimension_x_cm,
      dimensionYcm: piece.dimension_y_cm,
      dimensionZcm: piece.dimension_z_cm,
    });
    itemsByOrder.set(item.order_id, list);
  }
  const adjustmentsByOrder = new Map();
  for (const adjustment of adjustments) {
    const list = adjustmentsByOrder.get(adjustment.order_id) || [];
    list.push({
      reason: adjustment.reason,
      occurredOn: adjustment.occurred_on,
      impactDays: Number(adjustment.impact_days),
    });
    adjustmentsByOrder.set(adjustment.order_id, list);
  }
  const calendarDays = buildCalendarDays({ startDate, endDate, settings, rules, exceptions });
  const scenario = simulateProject({
    calendarDays,
    positions,
    existingReservations: reservations,
    earliestSchedulingDate: today,
    orders: schedulableOrders.filter((order) => orderIdsWithItems.has(order.id)).map((order) => ({
      ...order,
      items: itemsByOrder.get(order.id) || [],
      delayAdjustments: adjustmentsByOrder.get(order.id) || [],
      engineeringParameterVersionId: versionForOrder.get(order.id).id,
      engineeringParameterVersion: versionForOrder.get(order.id).version,
      engineeringParameters: versionForOrder.get(order.id).parameters,
    })),
  });

  const itemById = new Map(items.map((item) => [item.id, item]));
  const orderPlanById = new Map(scenario.orders.map((entry) => [entry.orderId, entry]));
  for (const order of scenario.orders) {
    for (const unit of order.units) {
      const item = itemById.get(unit.itemId);
      const orderPlan = orderPlanById.get(item?.order_id);
      const curingDays = Number(unit.curingDays);
      const phases = buildDailyProductionSteps({
        castDate: unit.castDate,
        finishDate: unit.finishDate,
        preparationDates: unit.preparationDates,
        calendarDays,
        curingDays,
        timeZone,
        castStartTime: unit.castingStartTime,
        preparationWorkdays: orderPlan?.engineeringParameters.preparationWorkdays,
      });
      Object.assign(unit, {
        curingDays,
        productionMinutesSnapshot: Number(item?.production_minutes_snapshot || 0),
        plannedEndDate: unit.finishDate,
        ...phases,
      });
    }
  }

  const revisionAfter = await db.from("factory_plan_revisions")
    .select("revision").eq("organization_id", organizationId).maybeSingle();
  if (revisionAfter.error) throw new FactorySimulationError("Não foi possível validar os dados do Planejamento.", 500);
  if (Number(revisionAfter.data?.revision) !== sourceRevision) {
    throw new FactorySimulationError("Os dados do Planejamento mudaram durante o cálculo. Atualize a simulação.", 409);
  }

  return {
    ...scenario,
    selectedOrderIds: requestedIds,
    fixedStartedOrderCount: startedOrderIds.length,
    generatedAt: new Date().toISOString(),
    commitContext: { sourceRevision, calendarDays, timeZone },
  };
}
