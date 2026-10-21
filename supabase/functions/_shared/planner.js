/**
 * Regras puras de planejamento da produção.
 *
 * Este arquivo não acessa banco nem DOM. Isso permite testar o cálculo no
 * Node e reutilizá-lo em qualquer Edge Function do Supabase.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class PlannerError extends Error {
  constructor(message, status = 422, details = null) {
    super(message);
    this.name = "PlannerError";
    this.status = status;
    this.details = details;
  }
}

export function normalizeDate(value, fieldName = "data") {
  const date = String(value ?? "").trim();
  if (!DATE_RE.test(date)) {
    throw new PlannerError(`${fieldName} deve estar no formato YYYY-MM-DD.`);
  }

  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || toISODate(parsed) !== date) {
    throw new PlannerError(`${fieldName} não é uma data válida.`);
  }
  return date;
}

export function toISODate(date) {
  return date.toISOString().slice(0, 10);
}

export function addDays(dateValue, amount) {
  const date = new Date(`${normalizeDate(dateValue)}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + Number(amount || 0));
  return toISODate(date);
}

export function dateRange(startValue, endValue) {
  const start = normalizeDate(startValue, "data inicial");
  const end = normalizeDate(endValue, "data final");
  if (end < start) {
    throw new PlannerError("A data final não pode ser anterior à data inicial.");
  }

  const result = [];
  let current = start;
  while (current <= end) {
    result.push(current);
    current = addDays(current, 1);
  }
  return result;
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function positiveInteger(value) {
  return Math.max(0, Math.floor(numberOrZero(value)));
}

function readField(object, camelName, snakeName, fallback = null) {
  return object?.[camelName] ?? object?.[snakeName] ?? fallback;
}

function normalizedCalendarDay(day) {
  const date = normalizeDate(readField(day, "date", "date"), "dia do calendário");
  const isWorking = Boolean(readField(day, "isWorking", "is_working", false));
  const capacityMinutes = isWorking
    ? Math.max(0, numberOrZero(readField(day, "capacityMinutes", "capacity_minutes", 0)))
    : 0;

  return { date, isWorking, capacityMinutes };
}

function normalizedExistingSchedule(schedule) {
  return {
    date: normalizeDate(
      readField(schedule, "workDate", "work_date"),
      "data da programação",
    ),
    plannedMinutes: Math.max(
      0,
      numberOrZero(readField(schedule, "plannedMinutes", "planned_minutes", 0)),
    ),
    status: String(schedule?.status ?? "planned"),
  };
}

/**
 * Calcula um plano diário, respeitando capacidade em minutos e estoque.
 *
 * A ordem dos itens recebidos é preservada. Assim, o comercial pode definir a
 * sequência dos tipos de peça no pedido e o restante da capacidade do dia é
 * compartilhado entre todos os itens.
 */
export function planOrder({
  calendarDays = [],
  items = [],
  existingSchedules = [],
  startDate,
  dueDate = null,
}) {
  const start = normalizeDate(startDate, "data de início");
  const due = dueDate ? normalizeDate(dueDate, "prazo de entrega") : null;

  if (due && due < start) {
    throw new PlannerError("O prazo de entrega não pode ser anterior ao início.");
  }

  const days = calendarDays
    .map(normalizedCalendarDay)
    .filter((day) => day.date >= start && (!due || day.date <= due));

  const capacityByDate = new Map(
    days.map((day) => [day.date, day.isWorking ? day.capacityMinutes : 0]),
  );
  const reservedByDate = new Map();

  for (const rawSchedule of existingSchedules) {
    const schedule = normalizedExistingSchedule(rawSchedule);
    if (schedule.status === "cancelled" || schedule.status === "cancelado") continue;
    if (!capacityByDate.has(schedule.date)) continue;
    reservedByDate.set(
      schedule.date,
      (reservedByDate.get(schedule.date) || 0) + schedule.plannedMinutes,
    );
  }

  const workingDays = days.filter((day) => day.isWorking && day.capacityMinutes > 0);
  const schedules = [];
  const itemPlans = [];
  let totalRequestedQuantity = 0;
  let totalStockQuantity = 0;
  let totalToProduce = 0;
  let totalPlannedQuantity = 0;
  let totalPlannedMinutes = 0;

  for (const rawItem of items) {
    const itemId = String(readField(rawItem, "itemId", "item_id", ""));
    const pieceTypeId = String(readField(rawItem, "pieceTypeId", "piece_type_id", ""));
    const requestedQuantity = positiveInteger(readField(rawItem, "quantity", "quantity", 0));
    const stockAvailable = positiveInteger(
      readField(rawItem, "stockAvailable", "stock_available", 0),
    );
    const stockQuantityUsed = Math.min(requestedQuantity, stockAvailable);
    const quantityToProduce = Math.max(requestedQuantity - stockQuantityUsed, 0);
    const productionMinutesPerUnit = Math.max(
      1,
      positiveInteger(
        readField(
          rawItem,
          "productionMinutesSnapshot",
          "production_minutes_snapshot",
          0,
        ),
      ),
    );

    if (!itemId || !pieceTypeId || requestedQuantity < 1) {
      throw new PlannerError("Cada item do pedido precisa de peça, identificador e quantidade válida.");
    }

    const itemPlan = {
      itemId,
      pieceTypeId,
      code: rawItem.code ?? null,
      name: rawItem.name ?? null,
      requestedQuantity,
      stockAvailable,
      stockQuantityUsed,
      quantityToProduce,
      productionMinutesPerUnit,
      plannedQuantity: 0,
      remainingQuantity: quantityToProduce,
      plannedMinutes: 0,
      missingMinutes: 0,
      schedules: [],
    };

    totalRequestedQuantity += requestedQuantity;
    totalStockQuantity += stockQuantityUsed;
    totalToProduce += quantityToProduce;

    if (quantityToProduce > 0) {
      for (const day of workingDays) {
        if (itemPlan.remainingQuantity <= 0) break;

        const alreadyReserved = reservedByDate.get(day.date) || 0;
        const availableMinutes = Math.max(0, day.capacityMinutes - alreadyReserved);
        const possibleQuantity = Math.floor(availableMinutes / productionMinutesPerUnit);
        const quantityForDay = Math.min(itemPlan.remainingQuantity, possibleQuantity);
        if (quantityForDay <= 0) continue;

        const plannedMinutes = quantityForDay * productionMinutesPerUnit;
        const schedule = {
          itemId,
          pieceTypeId,
          workDate: day.date,
          plannedQuantity: quantityForDay,
          plannedMinutes,
        };

        itemPlan.schedules.push(schedule);
        schedules.push(schedule);
        itemPlan.plannedQuantity += quantityForDay;
        itemPlan.remainingQuantity -= quantityForDay;
        itemPlan.plannedMinutes += plannedMinutes;
        totalPlannedQuantity += quantityForDay;
        totalPlannedMinutes += plannedMinutes;
        reservedByDate.set(day.date, alreadyReserved + plannedMinutes);
      }
    }

    itemPlan.missingMinutes = itemPlan.remainingQuantity * productionMinutesPerUnit;
    itemPlans.push(itemPlan);
  }

  const overloadedDays = days
    .map((day) => ({
      date: day.date,
      capacityMinutes: day.capacityMinutes,
      reservedMinutes: reservedByDate.get(day.date) || 0,
      availableMinutes: Math.max(
        0,
        day.capacityMinutes - (reservedByDate.get(day.date) || 0),
      ),
    }))
    .filter((day) => day.reservedMinutes > day.capacityMinutes);

  const remainingQuantity = itemPlans.reduce(
    (total, item) => total + item.remainingQuantity,
    0,
  );
  const plannedDates = schedules.map((schedule) => schedule.workDate).sort();
  const plannedEndDate = plannedDates.length ? plannedDates[plannedDates.length - 1] : null;
  const conflicts = [...overloadedDays.map((day) => ({
    type: "capacity",
    ...day,
  }))];

  if (remainingQuantity > 0) {
    conflicts.push({
      type: "deadline",
      dueDate: due,
      remainingQuantity,
      message: due
        ? "A capacidade disponível até o prazo não atende toda a quantidade a produzir."
        : "O horizonte de planejamento não atende toda a quantidade a produzir.",
    });
  }

  return {
    feasible: remainingQuantity === 0,
    startDate: start,
    dueDate: due,
    plannedEndDate,
    workingDays: workingDays.length,
    totalRequestedQuantity,
    totalStockQuantity,
    totalToProduce,
    totalPlannedQuantity,
    totalPlannedMinutes,
    totalRemainingQuantity: remainingQuantity,
    items: itemPlans,
    schedules,
    conflicts,
  };
}
