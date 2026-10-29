/*
 * Regras de prazo e etapas por pedido compartilhadas entre as funções de
 * planejamento e operações. Mantém a simulação e o salvamento usando a mesma
 * fila de produção e as mesmas durações.
 */
import { buildCalendarDays } from "./calendar.js";
import {
  addDays,
  DEFAULT_POSITION_CODES,
  normalizeDate,
  planOrder,
  PlannerError,
} from "./planner.js";

const DEFAULT_CURING_DAYS = 2;

function ensureFourPositions(positions) {
  const codes = new Set((positions || []).map((position) => position.code));
  const missing = DEFAULT_POSITION_CODES.filter((code) => !codes.has(code));
  if (missing.length) {
    throw new OrderPlanningError(`Cadastro incompleto das posições de molde: ${missing.join(", ")}.`, 409);
  }
}

export class OrderPlanningError extends Error {
  constructor(message, status = 422, details = null) {
    super(message);
    this.name = "OrderPlanningError";
    this.status = status;
    this.details = details;
  }
}

function throwIfError(error, context) {
  if (error) throw new OrderPlanningError(`${context}: ${error.message}`, 500);
}

function todaySaoPaulo() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function positiveSetting(value, fallback, maximum = 730) {
  const parsed = Math.floor(numberOrZero(value));
  return Math.min(maximum, Math.max(1, parsed || fallback));
}

function daysBetween(startDate, endDate) {
  return Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000);
}

async function loadCalendarDays({ db, organizationId, startDate, endDate, settings }) {
  const [{ data: rules, error: rulesError }, { data: exceptions, error: exceptionsError }] = await Promise.all([
    db.from("calendar_working_rules")
      .select("weekday, is_working, capacity_minutes")
      .eq("organization_id", organizationId),
    db.from("calendar_exceptions")
      .select("id, name, kind, start_date, end_date, is_working, capacity_minutes, priority, is_active, updated_at")
      .eq("organization_id", organizationId)
      .eq("is_active", true)
      .lte("start_date", endDate)
      .gte("end_date", startDate),
  ]);
  throwIfError(rulesError, "Não foi possível carregar os dias úteis");
  throwIfError(exceptionsError, "Não foi possível carregar as exceções do calendário");

  const days = buildCalendarDays({
    startDate,
    endDate,
    settings,
    rules: rules || [],
    exceptions: exceptions || [],
  });
  const records = days.map((day) => ({ organization_id: organizationId, ...day }));

  // Mantém calendar_days atualizado para as demais telas, sem usar minutos
  // como capacidade de concretagem.
  for (let index = 0; index < records.length; index += 500) {
    const { error } = await db.from("calendar_days").upsert(records.slice(index, index + 500), {
      onConflict: "organization_id,date",
    });
    throwIfError(error, "Não foi possível preparar o calendário do planejamento");
  }
  return days;
}

async function loadExistingReservations({ db, organizationId, startDate, endDate, currentOrderId = null, onlyOrderIds = null }) {
  const [{ data: units, error: unitsError }, { data: legacy, error: legacyError }] = await Promise.all([
    db.from("production_orders")
      .select("id, order_id, order_item_id, planned_cast_date, status")
      .eq("organization_id", organizationId)
      .in("status", ["planned", "in_progress", "done", "scrapped"])
      .gte("planned_cast_date", startDate)
      .lte("planned_cast_date", endDate)
      .limit(10000),
    db.from("production_schedules")
      .select("order_id, order_item_id, work_date, planned_quantity, status")
      .eq("organization_id", organizationId)
      .in("status", ["planned", "in_progress", "done"])
      .gte("work_date", startDate)
      .lte("work_date", endDate)
      .limit(10000),
  ]);
  throwIfError(unitsError, "Não foi possível consultar as ordens de produção existentes");
  throwIfError(legacyError, "Não foi possível consultar as programações existentes");

  const unitIds = (units || []).map((unit) => unit.id);
  const allocationsResult = unitIds.length
    ? await db.from("allocations")
      .select("production_order_id, mold_position_id, scheduled_date, status")
      .eq("organization_id", organizationId)
      .in("production_order_id", unitIds)
      .in("status", ["planned", "in_progress", "done"])
      .gte("scheduled_date", startDate)
      .lte("scheduled_date", endDate)
      .limit(10000)
    : { data: [], error: null };
  throwIfError(allocationsResult.error, "Não foi possível consultar as posições já alocadas");

  const positionIds = [...new Set((allocationsResult.data || []).map((row) => row.mold_position_id).filter(Boolean))];
  const positionsResult = positionIds.length
    ? await db.from("mold_positions").select("id, code").eq("organization_id", organizationId).in("id", positionIds)
    : { data: [], error: null };
  throwIfError(positionsResult.error, "Não foi possível consultar as posições alocadas");

  const includeOrder = (orderId) => orderId !== currentOrderId && (!onlyOrderIds || onlyOrderIds.has(orderId));
  const includedUnits = (units || []).filter((unit) => includeOrder(unit.order_id));
  const includedLegacy = (legacy || []).filter((row) => includeOrder(row.order_id));
  const includedUnitIds = new Set(includedUnits.map((unit) => unit.id));
  const unitById = new Map(includedUnits.map((unit) => [unit.id, unit]));
  const codeByPositionId = new Map((positionsResult.data || []).map((position) => [position.id, position.code]));
  const unitCountBySchedule = new Map();
  for (const unit of includedUnits) {
    const key = `${unit.order_id}|${unit.order_item_id}|${unit.planned_cast_date}`;
    unitCountBySchedule.set(key, (unitCountBySchedule.get(key) || 0) + 1);
  }
  const existingAllocations = (allocationsResult.data || [])
    .filter((allocation) => includedUnitIds.has(allocation.production_order_id))
    .map((allocation) => ({
      ...allocation,
      orderId: unitById.get(allocation.production_order_id)?.order_id ?? null,
      positionCode: codeByPositionId.get(allocation.mold_position_id) ?? null,
    }))
    .filter((allocation) => allocation.orderId !== currentOrderId);

  // Programações antigas continuam ocupando posições. Quando a mesma data e
  // item já têm ordens unitárias, reserva só a diferença para não contar duas
  // vezes o resumo legado gravado pela migração 006.
  const existingSchedules = includedLegacy.flatMap((row) => {
    const key = `${row.order_id}|${row.order_item_id}|${row.work_date}`;
    const representedByUnits = unitCountBySchedule.get(key) || 0;
    const legacyQuantity = Math.max(0, numberOrZero(row.planned_quantity));
    const remainingQuantity = legacyQuantity - representedByUnits;
    return remainingQuantity > 0 ? [{ ...row, planned_quantity: remainingQuantity }] : [];
  });

  return { existingSchedules, existingAllocations };
}

/** Mantém a interface antiga, usando agora a fila global de pedidos. */
export async function buildOrderPlan(options) {
  const queuePlan = await buildPlanningQueue(options);
  return queuePlan.targetPlan;
}

/** Reprograma a fila toda que ainda não começou, em data e ordem de cadastro. */
export async function buildPlanningQueue({ db, organizationId, input = {} }) {
  const targetOrderId = String(input.orderId || "").trim();
  if (!targetOrderId) throw new OrderPlanningError("orderId é obrigatório.", 400);

  const [ordersResult, settingsResult, positionsResult] = await Promise.all([
    db.from("orders")
      .select("id, order_number, client_id, start_date, requested_due_date, planned_end_date, forecast_end_date, status, created_at")
      .eq("organization_id", organizationId)
      .eq("is_active", true)
      .order("start_date", { ascending: true })
      .order("created_at", { ascending: true })
      .limit(1000),
    db.from("calendar_settings")
      .select("default_capacity_minutes, planning_horizon_days")
      .eq("organization_id", organizationId)
      .maybeSingle(),
    db.from("mold_positions")
      .select("id, code, status, configuration_kind, braco_catalog_code, leito_catalog_code, lateral_catalog_code")
      .eq("organization_id", organizationId)
      .order("code", { ascending: true }),
  ]);
  throwIfError(ordersResult.error, "Não foi possível carregar a fila de pedidos");
  throwIfError(settingsResult.error, "Não foi possível carregar as configurações do calendário");
  throwIfError(positionsResult.error, "Não foi possível carregar as quatro posições de molde");

  const allOrders = ordersResult.data || [];
  const orders = allOrders.filter((order) =>
    !["cancelado", "entregue", "concluido"].includes(order.status)
  );
  const targetOrder = orders.find((order) => order.id === targetOrderId);
  const closedTargetExists = input.allowClosedTarget === true && allOrders.some((order) => order.id === targetOrderId);
  if (!targetOrder && !closedTargetExists) throw new OrderPlanningError("Pedido não encontrado ou encerrado.", 404);
  if (!positionsResult.data?.length) {
    throw new OrderPlanningError("As quatro posições de molde ainda não foram cadastradas no banco.", 409);
  }
  ensureFourPositions(positionsResult.data);

  const orderIds = orders.map((order) => order.id);
  const [itemsResult, startedUnitsResult, startedLegacyResult, startedAllocationsResult] = await Promise.all([
    orderIds.length
      ? db.from("order_items")
        .select("id, order_id, piece_type_id, quantity, production_minutes_snapshot, sequence")
        .eq("organization_id", organizationId)
        .in("order_id", orderIds)
        .order("sequence", { ascending: true })
        .limit(10000)
      : Promise.resolve({ data: [], error: null }),
    db.from("production_orders")
      .select("order_id")
      .eq("organization_id", organizationId)
      .in("status", ["in_progress", "done", "scrapped"])
      .limit(10000),
    db.from("production_schedules")
      .select("order_id")
      .eq("organization_id", organizationId)
      .in("status", ["in_progress", "done"])
      .limit(10000),
    db.from("allocations")
      .select("production_order_id")
      .eq("organization_id", organizationId)
      .in("status", ["in_progress", "done"])
      .limit(10000),
  ]);
  throwIfError(itemsResult.error, "Não foi possível carregar os itens da fila");
  throwIfError(startedUnitsResult.error, "Não foi possível verificar a produção iniciada");
  throwIfError(startedLegacyResult.error, "Não foi possível verificar as programações em andamento");
  throwIfError(startedAllocationsResult.error, "Não foi possível verificar as posições em produção");

  const activeOrderIds = new Set(orderIds);
  const startedAllocationUnitIds = [...new Set((startedAllocationsResult.data || []).map((row) => row.production_order_id))];
  const startedAllocationUnitsResult = startedAllocationUnitIds.length
    ? await db.from("production_orders")
      .select("order_id")
      .eq("organization_id", organizationId)
      .in("id", startedAllocationUnitIds)
      .limit(10000)
    : { data: [], error: null };
  throwIfError(startedAllocationUnitsResult.error, "Não foi possível localizar os pedidos das posições em produção");
  const startedOrderIds = new Set([
    ...(startedUnitsResult.data || []).map((row) => row.order_id),
    ...(startedLegacyResult.data || []).map((row) => row.order_id),
    ...(startedAllocationUnitsResult.data || []).map((row) => row.order_id),
  ].filter((id) => activeOrderIds.has(id)));
  if (startedOrderIds.has(targetOrderId)) {
    throw new OrderPlanningError("Pedido com produção iniciada ou concluída não pode ser replanejado.", 409);
  }

  const itemGroups = new Map();
  for (const item of itemsResult.data || []) {
    const group = itemGroups.get(item.order_id) || [];
    group.push(item);
    itemGroups.set(item.order_id, group);
  }
  if (targetOrder && !itemGroups.get(targetOrderId)?.length) {
    throw new OrderPlanningError("O pedido precisa ter ao menos um item.", 422);
  }

  const pieceTypeIds = [...new Set((itemsResult.data || []).map((item) => item.piece_type_id))];
  const piecesResult = pieceTypeIds.length
    ? await db.from("piece_types")
      .select("id, code, name, piece_kind, production_minutes_per_unit")
      .eq("organization_id", organizationId)
      .in("id", pieceTypeIds)
    : { data: [], error: null };
  throwIfError(piecesResult.error, "Não foi possível carregar as peças da fila");
  const pieceById = new Map((piecesResult.data || []).map((piece) => [piece.id, piece]));
  const requirementsResult = pieceTypeIds.length
    ? await db.from("piece_type_molds")
      .select("piece_type_id, role, catalog_code")
      .eq("organization_id", organizationId)
      .in("piece_type_id", pieceTypeIds)
      .limit(5000)
    : { data: [], error: null };
  throwIfError(requirementsResult.error, "Não foi possível carregar os moldes exigidos pelas peças");
  const requiredMoldsByPiece = new Map();
  for (const requirement of requirementsResult.data || []) {
    const required = requiredMoldsByPiece.get(requirement.piece_type_id) || [];
    required.push(requirement.catalog_code);
    requiredMoldsByPiece.set(requirement.piece_type_id, required);
  }

  const configuredHorizon = positiveSetting(settingsResult.data?.planning_horizon_days, 365);
  const queue = orders
    .filter((order) => itemGroups.get(order.id)?.length && !startedOrderIds.has(order.id))
    .map((order) => {
      const startDate = normalizeDate(
        order.id === targetOrderId
          ? input.startDate || order.start_date || todaySaoPaulo()
          : order.start_date || todaySaoPaulo(),
        "data de início",
      );
      const rawDueDate = order.id === targetOrderId && input.requestedDueDate !== undefined
        ? input.requestedDueDate
        : order.requested_due_date;
      const dueDate = rawDueDate ? normalizeDate(rawDueDate, "prazo de entrega") : null;
      if (dueDate && dueDate < startDate) {
        throw new OrderPlanningError(`O prazo do pedido ${order.id} não pode ser anterior ao início.`, 422);
      }
      const dueHorizon = dueDate ? daysBetween(startDate, dueDate) + 1 : 1;
      if (order.id === targetOrderId && dueHorizon > 730) {
        throw new OrderPlanningError("O prazo solicitado ultrapassa o horizonte máximo de 730 dias.", 422);
      }
      return {
        ...order,
        startDate,
        dueDate,
        horizonDays: Math.min(730, Math.max(configuredHorizon, Math.min(730, dueHorizon))),
      };
    })
    .sort((left, right) =>
      left.startDate.localeCompare(right.startDate) ||
      String(left.created_at || "").localeCompare(String(right.created_at || "")) ||
      left.id.localeCompare(right.id)
    );

  if (!queue.length && closedTargetExists) {
    return {
      targetPlan: null,
      plans: [],
      queue: { replanOrderCount: 0, lockedOrderCount: startedOrderIds.size, infeasibleOrderIds: [] },
      removedTargetFromPlan: true,
      generatedAt: new Date().toISOString(),
    };
  }

  const firstDate = queue.map((order) => order.startDate).sort()[0];
  const lastDate = queue.map((order) => addDays(order.startDate, order.horizonDays + 10)).sort().at(-1);
  const calendarDays = await loadCalendarDays({
    db,
    organizationId,
    startDate: firstDate,
    endDate: lastDate,
    settings: settingsResult.data || { default_capacity_minutes: 480 },
  });

  const { existingSchedules, existingAllocations } = await loadExistingReservations({
    db,
    organizationId,
    startDate: firstDate,
    endDate: lastDate,
    onlyOrderIds: startedOrderIds,
  });
  const reservedAllocations = [...existingAllocations];
  const committedPlans = [];
  let targetPlan = null;

  for (const order of queue) {
    if (startedOrderIds.has(order.id)) continue;
    const plannerItems = (itemGroups.get(order.id) || []).map((item) => {
      const piece = pieceById.get(item.piece_type_id);
      if (!piece) throw new OrderPlanningError(`Peça ${item.piece_type_id} não encontrada.`, 422);
      return {
        itemId: item.id,
        pieceTypeId: item.piece_type_id,
        code: piece.code,
        name: piece.name,
        requiredMoldCodes: requiredMoldsByPiece.get(item.piece_type_id) || [],
        requiresMoldConfig: ["braco", "pilar", "viga"].includes(piece.piece_kind),
        quantity: item.quantity,
        curingDays: DEFAULT_CURING_DAYS,
        productionMinutesSnapshot: numberOrZero(item.production_minutes_snapshot) ||
          numberOrZero(piece.production_minutes_per_unit),
      };
    });
    let plan;
    try {
      plan = planOrder({
        calendarDays,
        items: plannerItems,
        existingSchedules,
        existingAllocations: reservedAllocations,
        positions: positionsResult.data,
        startDate: order.startDate,
        dueDate: order.dueDate,
        planningHorizonDays: order.horizonDays,
      });
    } catch (error) {
      if (error instanceof PlannerError) throw new OrderPlanningError(error.message, error.status, error.details);
      throw error;
    }
    plan.order = {
      id: order.id,
      orderNumber: order.order_number,
      clientId: order.client_id,
      status: order.status,
      previousPlannedEndDate: order.planned_end_date,
      previousForecastEndDate: order.forecast_end_date,
      createdAt: order.created_at,
    };
    committedPlans.push({ orderId: order.id, plan });
    if (order.id === targetOrderId) targetPlan = plan;
    for (const unit of plan.units) {
      reservedAllocations.push({
        orderId: order.id,
        scheduled_date: unit.castDate,
        positionCode: unit.positionCode,
        status: "planned",
      });
    }
  }

  if (!targetPlan && !closedTargetExists) throw new OrderPlanningError("Não foi possível calcular o pedido solicitado.", 422);
  const infeasiblePlans = committedPlans.filter((entry) => !entry.plan.feasible);
  return {
    targetPlan,
    plans: committedPlans,
    queue: {
      replanOrderCount: committedPlans.length,
      lockedOrderCount: startedOrderIds.size,
      infeasibleOrderIds: infeasiblePlans.map((entry) => entry.orderId),
    },
    removedTargetFromPlan: closedTargetExists,
    generatedAt: new Date().toISOString(),
  };
}
