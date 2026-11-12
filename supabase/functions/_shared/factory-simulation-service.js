/**
 * Adaptador somente de leitura entre Supabase e o simulador puro.
 *
 * Pedidos aprovados entram sempre na fila firme. Orçamentos entram apenas
 * quando seus IDs são pedidos explicitamente no cenário. Ordens já iniciadas
 * não são reprogramadas; suas alocações permanecem como capacidade ocupada.
 */
import { buildCalendarDays } from "./calendar.js";
import { addDays, PlannerError } from "./planner.js";
import { simulateFactory } from "./factory-simulator.js";

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

async function fixedReservations({ db, organizationId, startedOrderIds, positions, timeZone }) {
  if (!startedOrderIds.length) return [];
  const units = checked(await db.from("production_orders")
    .select("id, order_id")
    .eq("organization_id", organizationId)
    .in("order_id", startedOrderIds)
    .in("status", ["planned", "in_progress", "done", "scrapped"])
    .limit(10000), "Não foi possível ler unidades em execução");
  if (!units.length) return [];
  const unitIds = units.map((unit) => unit.id);
  const allocations = checked(await db.from("allocations")
    .select("production_order_id, mold_position_id, scheduled_date, occupied_from_at, occupied_until_at, status")
    .eq("organization_id", organizationId)
    .in("production_order_id", unitIds)
    .in("status", ["planned", "in_progress", "done"])
    .limit(10000), "Não foi possível ler posições ocupadas");
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
    return { positionCode, startDate, endDate };
  });
}

export async function simulateProductionOrders({ db, organizationId, input = {} }) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new FactorySimulationError("Envie um objeto JSON com os pedidos a simular.", 400);
  }
  const requestedIds = selectedIds(input);
  const [ordersResult, positionsResult, settingsResult, rulesResult, orgResult] = await Promise.all([
    db.from("orders")
      .select("id, order_number, status, start_date, requested_due_date, approved_at, created_at, is_active")
      .eq("organization_id", organizationId).eq("is_active", true)
      .in("status", ["orcamento", "aprovado", "em_producao", "atrasado"])
      .limit(1000),
    db.from("mold_positions")
      .select("id, code, status, configuration_kind, braco_catalog_code, leito_catalog_code, lateral_catalog_code")
      .eq("organization_id", organizationId).order("code", { ascending: true }),
    db.from("calendar_settings")
      .select("default_capacity_minutes, planning_horizon_days")
      .eq("organization_id", organizationId).maybeSingle(),
    db.from("calendar_working_rules")
      .select("weekday, is_working, capacity_minutes")
      .eq("organization_id", organizationId),
    db.from("organizations").select("timezone").eq("id", organizationId).maybeSingle(),
  ]);
  const allOrders = checked(ordersResult, "Não foi possível ler os pedidos");
  const positions = checked(positionsResult, "Não foi possível ler as posições");
  const settingsRow = checked(settingsResult, "Não foi possível ler o calendário");
  const settings = Array.isArray(settingsRow) ? { default_capacity_minutes: 480 } : settingsRow;
  const rules = checked(rulesResult, "Não foi possível ler os dias úteis");
  const organization = checked(orgResult, "Não foi possível ler a unidade");
  const timeZone = organization.timezone || "America/Sao_Paulo";
  const selected = new Set(requestedIds);
  if (requestedIds.some((id) => !allOrders.some((order) => order.id === id))) {
    throw new FactorySimulationError("Um pedido selecionado não existe ou está encerrado.", 404);
  }
  const candidateOrders = allOrders.filter((order) =>
    ["aprovado", "em_producao", "atrasado"].includes(order.status) || selected.has(order.id)
  );
  if (!candidateOrders.length) throw new FactorySimulationError("Não há pedidos para simular.");
  if (candidateOrders.length > 30) throw new FactorySimulationError("A fila contém mais de 30 pedidos; reduza o cenário.", 422);
  if (positions.length !== 4) throw new FactorySimulationError("Cadastre as quatro posições P01–P04 antes de simular.", 409);

  const candidateIds = candidateOrders.map((order) => order.id);
  const startedUnits = checked(await db.from("production_orders")
    .select("order_id")
    .eq("organization_id", organizationId)
    .in("order_id", candidateIds)
    .in("status", ["in_progress", "done", "scrapped"])
    .limit(10000), "Não foi possível verificar produção iniciada");
  const startedOrderIds = [...new Set(startedUnits.map((unit) => unit.order_id))];
  if (requestedIds.some((id) => startedOrderIds.includes(id))) {
    throw new FactorySimulationError("Pedido com produção iniciada não pode ser reprogramado neste cenário.", 409);
  }
  const schedulableOrders = candidateOrders.filter((order) => !startedOrderIds.includes(order.id));
  if (!schedulableOrders.length) throw new FactorySimulationError("Todos os pedidos da fila já iniciaram produção.", 409);
  const orderIds = schedulableOrders.map((order) => order.id);
  const startDate = schedulableOrders.map((order) => order.start_date).sort()[0];
  const endDate = addDays(schedulableOrders.map((order) => order.start_date).sort().at(-1), 740);

  const [itemsResult, exceptionsResult, adjustmentsResult, reservations] = await Promise.all([
    db.from("order_items")
      .select("id, order_id, piece_type_id, quantity, sequence")
      .eq("organization_id", organizationId).in("order_id", orderIds)
      .order("sequence", { ascending: true }).limit(10000),
    db.from("calendar_exceptions")
      .select("id, name, kind, start_date, end_date, is_working, capacity_minutes, priority, is_active, updated_at")
      .eq("organization_id", organizationId).eq("is_active", true)
      .lte("start_date", endDate).gte("end_date", startDate),
    db.from("delay_adjustments")
      .select("order_id, impact_days")
      .eq("organization_id", organizationId).in("order_id", orderIds).limit(10000),
    fixedReservations({ db, organizationId, startedOrderIds, positions, timeZone }),
  ]);
  const items = checked(itemsResult, "Não foi possível ler os itens");
  const exceptions = checked(exceptionsResult, "Não foi possível ler as exceções");
  const adjustments = checked(adjustmentsResult, "Não foi possível ler ajustes de prazo");
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
  const impactByOrder = new Map();
  for (const adjustment of adjustments) {
    impactByOrder.set(adjustment.order_id,
      (impactByOrder.get(adjustment.order_id) || 0) + Number(adjustment.impact_days));
  }
  const calendarDays = buildCalendarDays({
    startDate,
    endDate,
    settings,
    rules,
    exceptions,
  });
  const scenario = simulateFactory({
    calendarDays,
    positions,
    existingReservations: reservations,
    orders: schedulableOrders.map((order) => ({
      ...order,
      items: itemsByOrder.get(order.id) || [],
      adjustmentDays: impactByOrder.get(order.id) || 0,
    })),
  });
  return {
    ...scenario,
    selectedOrderIds: requestedIds,
    fixedStartedOrderCount: startedOrderIds.length,
    generatedAt: new Date().toISOString(),
  };
}
