import { addDays, normalizeDate, planOrder, PlannerError } from "./planner.js";

export class OrderPlanningError extends Error {
  constructor(message, status = 422, details = null) {
    super(message);
    this.name = "OrderPlanningError";
    this.status = status;
    this.details = details;
  }
}

function throwIfError(error, context) {
  if (error) {
    throw new OrderPlanningError(`${context}: ${error.message}`, 500);
  }
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/** Carrega as dependências do pedido e recalcula o plano no servidor. */
export async function buildOrderPlan({ db, organizationId, input = {} }) {
  const orderId = String(input.orderId || "").trim();
  if (!orderId) throw new OrderPlanningError("orderId é obrigatório.", 400);

  const { data: order, error: orderError } = await db
    .from("orders")
    .select("id, client_id, start_date, requested_due_date, planned_end_date, status, observations")
    .eq("organization_id", organizationId)
    .eq("id", orderId)
    .eq("is_active", true)
    .maybeSingle();
  throwIfError(orderError, "Não foi possível carregar o pedido");
  if (!order) throw new OrderPlanningError("Pedido não encontrado.", 404);
  if (order.status === "cancelado" || order.status === "entregue") {
    throw new OrderPlanningError("Pedidos cancelados ou entregues não podem ser replanejados.", 409);
  }

  const { data: settings, error: settingsError } = await db
    .from("calendar_settings")
    .select("default_capacity_minutes, planning_horizon_days")
    .eq("organization_id", organizationId)
    .maybeSingle();
  throwIfError(settingsError, "Não foi possível carregar as configurações do calendário");

  const { data: rawItems, error: itemsError } = await db
    .from("order_items")
    .select("id, piece_type_id, quantity, production_minutes_snapshot, sequence")
    .eq("organization_id", organizationId)
    .eq("order_id", orderId)
    .order("sequence", { ascending: true });
  throwIfError(itemsError, "Não foi possível carregar os itens do pedido");
  if (!rawItems?.length) throw new OrderPlanningError("O pedido precisa ter ao menos um item.", 422);

  const pieceTypeIds = [...new Set(rawItems.map((item) => item.piece_type_id))];
  const { data: pieceTypes, error: pieceTypesError } = await db
    .from("piece_types")
    .select("id, code, name, production_minutes_per_unit")
    .eq("organization_id", organizationId)
    .in("id", pieceTypeIds);
  throwIfError(pieceTypesError, "Não foi possível carregar os tipos de peça");

  const { data: inventory, error: inventoryError } = pieceTypeIds.length
    ? await db
        .from("v_piece_inventory")
        .select("piece_type_id, stock_quantity, reserved_quantity, available_stock_quantity, quantity_in_production")
        .eq("organization_id", organizationId)
        .in("piece_type_id", pieceTypeIds)
    : { data: [], error: null };
  throwIfError(inventoryError, "Não foi possível consultar o estoque");

  const { data: ownReservations, error: ownReservationsError } = pieceTypeIds.length
    ? await db
        .from("stock_reservations")
        .select("piece_type_id, quantity")
        .eq("organization_id", organizationId)
        .eq("order_id", orderId)
        .eq("status", "reserved")
    : { data: [], error: null };
  throwIfError(ownReservationsError, "Não foi possível consultar as reservas do pedido");

  const startDate = normalizeDate(
    input.startDate || order.start_date || todayUTC(),
    "data de início",
  );
  const requestedDueDate = input.requestedDueDate !== undefined
    ? input.requestedDueDate
    : order.requested_due_date || null;
  const dueDate = requestedDueDate ? normalizeDate(requestedDueDate, "prazo de entrega") : null;
  if (dueDate && dueDate < startDate) {
    throw new OrderPlanningError("O prazo de entrega não pode ser anterior ao início.", 422);
  }

  const horizonDays = Math.min(
    730,
    Math.max(1, Math.floor(numberOrZero(settings?.planning_horizon_days || 365))),
  );
  const endDate = dueDate || addDays(startDate, horizonDays);
  if (endDate > addDays(startDate, 730)) {
    throw new OrderPlanningError("O intervalo máximo de planejamento é de 730 dias.", 422);
  }

  const { data: calendarDays, error: calendarError } = await db
    .from("calendar_days")
    .select("date, is_working, capacity_minutes")
    .eq("organization_id", organizationId)
    .gte("date", startDate)
    .lte("date", endDate)
    .order("date", { ascending: true });
  throwIfError(calendarError, "Não foi possível carregar os dias do calendário");
  if (!calendarDays?.length) {
    throw new OrderPlanningError(
      "Não há dias de calendário gerados para o período. Execute a reconstrução do calendário.",
      409,
    );
  }

  const { data: existingSchedules, error: schedulesError } = await db
    .from("production_schedules")
    .select("order_id, order_item_id, work_date, planned_quantity, planned_minutes, status")
    .eq("organization_id", organizationId)
    .neq("order_id", orderId)
    .in("status", ["planned", "in_progress", "done"])
    .gte("work_date", startDate)
    .lte("work_date", endDate);
  throwIfError(schedulesError, "Não foi possível consultar a capacidade ocupada");

  const pieceTypeById = new Map((pieceTypes || []).map((piece) => [piece.id, piece]));
  const inventoryById = new Map((inventory || []).map((item) => [item.piece_type_id, item]));
  const ownReservationById = new Map();
  for (const reservation of ownReservations || []) {
    ownReservationById.set(
      reservation.piece_type_id,
      (ownReservationById.get(reservation.piece_type_id) || 0) + numberOrZero(reservation.quantity),
    );
  }

  const plannerItems = rawItems.map((item) => {
    const piece = pieceTypeById.get(item.piece_type_id);
    if (!piece) throw new OrderPlanningError(`Tipo de peça ${item.piece_type_id} não encontrado.`, 422);
    const inventoryRow = inventoryById.get(item.piece_type_id);
    const availableStock =
      numberOrZero(inventoryRow?.available_stock_quantity) +
      numberOrZero(ownReservationById.get(item.piece_type_id));
    return {
      itemId: item.id,
      pieceTypeId: item.piece_type_id,
      code: piece.code,
      name: piece.name,
      quantity: item.quantity,
      productionMinutesSnapshot:
        numberOrZero(item.production_minutes_snapshot) ||
        numberOrZero(piece.production_minutes_per_unit),
      stockAvailable: availableStock,
    };
  });

  let calculated;
  try {
    calculated = planOrder({
      calendarDays,
      items: plannerItems,
      existingSchedules,
      startDate,
      dueDate,
    });
  } catch (error) {
    if (error instanceof PlannerError) {
      throw new OrderPlanningError(error.message, error.status, error.details);
    }
    throw error;
  }

  return {
    ...calculated,
    order: {
      id: order.id,
      clientId: order.client_id,
      status: order.status,
    },
    generatedAt: new Date().toISOString(),
  };
}
