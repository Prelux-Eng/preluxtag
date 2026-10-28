/**
 * Planejamento linear PRELUX.
 *
 * A capacidade de concretagem é medida em posições ocupadas por dia útil.
 * O tempo informado no cadastro é mantido apenas como dado de referência.
 * O módulo é puro para permitir os mesmos cálculos nas Edge Functions e nos
 * testes Node.js.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const DEFAULT_POSITION_CODES = Object.freeze(["P01", "P02", "P03", "P04"]);

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
  const days = Number(amount);
  if (!Number.isInteger(days)) throw new PlannerError("A quantidade de dias deve ser inteira.");
  const date = new Date(`${normalizeDate(dateValue)}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return toISODate(date);
}

export function dateRange(startValue, endValue) {
  const start = normalizeDate(startValue, "data inicial");
  const end = normalizeDate(endValue, "data final");
  if (end < start) throw new PlannerError("A data final não pode ser anterior à data inicial.");

  const result = [];
  for (let current = start; current <= end; current = addDays(current, 1)) result.push(current);
  return result;
}

function readField(object, camelName, snakeName, fallback = null) {
  return object?.[camelName] ?? object?.[snakeName] ?? fallback;
}

function integerValue(value, label, { minimum = 0, fallback = null } = {}) {
  if ((value === undefined || value === null || value === "") && fallback !== null) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum) {
    throw new PlannerError(`${label} deve ser um número inteiro maior ou igual a ${minimum}.`);
  }
  return number;
}

function normalizedCalendarDay(day) {
  return {
    date: normalizeDate(readField(day, "date", "date"), "dia do calendário"),
    isWorking: Boolean(readField(day, "isWorking", "is_working", false)),
  };
}

function normalizedPosition(position) {
  const code = String(readField(position, "code", "code", "")).trim();
  const status = String(position?.status ?? "disponivel");
  if (!/^P0[1-4]$/.test(code)) throw new PlannerError(`Posição de molde inválida: ${code || "sem código"}.`);
  const catalogCodes = [
    readField(position, "bracoCatalogCode", "braco_catalog_code"),
    readField(position, "leitoCatalogCode", "leito_catalog_code"),
    readField(position, "lateralCatalogCode", "lateral_catalog_code"),
  ].filter(Boolean).map((value) => String(value).trim());
  return { code, status, catalogCodes };
}

function normalizedItem(item, index) {
  const itemId = String(readField(item, "itemId", "item_id", "")).trim();
  const pieceTypeId = String(readField(item, "pieceTypeId", "piece_type_id", "")).trim();
  const quantity = integerValue(readField(item, "quantity", "quantity"), "A quantidade", { minimum: 1 });
  const curingDays = integerValue(
    readField(item, "curingDays", "curing_days", 2),
    "O tempo de cura",
    { minimum: 1, fallback: 2 },
  );
  const productionMinutesPerUnit = integerValue(
    readField(item, "productionMinutesSnapshot", "production_minutes_snapshot", 0),
    "O tempo de produção registrado",
    { minimum: 0, fallback: 0 },
  );
  const rawRequiredMoldCodes = readField(item, "requiredMoldCodes", "required_mold_codes", []);
  const requiredMoldCodes = Array.isArray(rawRequiredMoldCodes)
    ? rawRequiredMoldCodes.map((value) => String(value).trim()).filter(Boolean).sort()
    : [];
  const requiresMoldConfig = Boolean(readField(item, "requiresMoldConfig", "requires_mold_config", requiredMoldCodes.length > 0));

  if (!itemId || !pieceTypeId) {
    throw new PlannerError(`O item ${index + 1} precisa ter identificador e peça válidos.`);
  }

  return {
    itemId,
    pieceTypeId,
    code: item.code ?? null,
    name: item.name ?? null,
    quantity,
    curingDays,
    productionMinutesPerUnit,
    requiredMoldCodes,
    requiresMoldConfig,
  };
}

function positionCanProduce(position, item) {
  if (!item.requiredMoldCodes.length) return !item.requiresMoldConfig;
  const configured = [...position.catalogCodes].sort();
  return configured.length === item.requiredMoldCodes.length &&
    configured.every((code, index) => code === item.requiredMoldCodes[index]);
}

function scheduleDate(schedule) {
  return normalizeDate(
    readField(schedule, "castDate", "planned_cast_date") ??
      readField(schedule, "workDate", "work_date"),
    "data da concretagem",
  );
}

function schedulePositionCodes(schedule) {
  const value = readField(schedule, "positionCodes", "position_codes", null);
  if (Array.isArray(value)) return value.map((code) => String(code).trim()).filter(Boolean);
  const code = readField(schedule, "positionCode", "position_code", null);
  return code ? [String(code).trim()] : [];
}

function reservePosition(occupiedByDate, date, code, reservation, conflicts) {
  const byPosition = occupiedByDate.get(date) || new Map();
  const current = byPosition.get(code);
  if (current) {
    conflicts.push({
      type: "position",
      date,
      positionCode: code,
      message: `A posição ${code} já está ocupada em ${date}.`,
      existingOrderId: current.orderId ?? null,
      conflictingOrderId: reservation.orderId ?? null,
    });
    return false;
  }
  byPosition.set(code, reservation);
  occupiedByDate.set(date, byPosition);
  return true;
}

function reserveExistingCapacity({
  existingSchedules,
  existingAllocations,
  positions,
  occupiedByDate,
  startDate,
  castHorizonEnd,
  conflicts,
}) {
  for (const allocation of existingAllocations) {
    const status = String(allocation.status ?? "planned");
    if (["cancelled", "cancelado"].includes(status)) continue;
    const date = normalizeDate(
      readField(allocation, "scheduledDate", "scheduled_date"),
      "data da alocação existente",
    );
    if (date < startDate || date > castHorizonEnd) continue;
    const code = String(readField(allocation, "positionCode", "position_code", "")).trim();
    if (!positions.some((position) => position.code === code)) {
      conflicts.push({ type: "position", date, positionCode: code || null, message: `Alocação existente aponta para posição inválida em ${date}.` });
      continue;
    }
    reservePosition(occupiedByDate, date, code, {
      orderId: allocation.orderId ?? allocation.order_id ?? null,
      status,
      source: "allocation",
    }, conflicts);
  }

  for (const schedule of existingSchedules) {
    const status = String(schedule.status ?? "planned");
    if (["cancelled", "cancelado"].includes(status)) continue;
    const date = scheduleDate(schedule);
    if (date < startDate || date > castHorizonEnd) continue;

    const requestedCodes = schedulePositionCodes(schedule);
    const quantity = integerValue(
      readField(schedule, "plannedQuantity", "planned_quantity", requestedCodes.length || 1),
      "A quantidade já programada",
      { minimum: 1 },
    );
    const codes = requestedCodes.length ? requestedCodes.slice(0, quantity) : [];
    let reserved = 0;

    for (const code of codes) {
      if (reservePosition(occupiedByDate, date, code, {
        orderId: schedule.orderId ?? schedule.order_id ?? null,
        status,
        source: "legacy_schedule",
      }, conflicts)) reserved += 1;
    }

    while (reserved < quantity) {
      const used = occupiedByDate.get(date) || new Map();
      const free = positions.find((position) => !used.has(position.code));
      if (!free) {
        conflicts.push({
          type: "capacity",
          date,
          requestedQuantity: quantity,
          message: `Há mais de quatro concretagens já programadas em ${date}.`,
        });
        break;
      }
      if (reservePosition(occupiedByDate, date, free.code, {
        orderId: schedule.orderId ?? schedule.order_id ?? null,
        status,
        source: "legacy_schedule",
      }, conflicts)) reserved += 1;
    }
  }
}

function nextWorkingDateAfter(date, calendarByDate, latestDate) {
  for (let candidate = addDays(date, 1); candidate <= latestDate; candidate = addDays(candidate, 1)) {
    if (calendarByDate.get(candidate)?.isWorking) return candidate;
  }
  return null;
}

/**
 * Programa cada unidade em uma das posições P01–P04.
 *
 * A data inicial não útil avança até o próximo dia útil. A cura conta dias
 * corridos a partir do dia seguinte à concretagem. O acabamento ocorre no
 * próximo dia útil após o fim da cura. Posição é ocupada somente na data de
 * concretagem.
 */
export function planOrder({
  calendarDays = [],
  items = [],
  existingSchedules = [],
  existingAllocations = [],
  positions = DEFAULT_POSITION_CODES.map((code) => ({ code, status: "disponivel" })),
  startDate,
  dueDate = null,
  planningHorizonDays = 730,
}) {
  const requestedStartDate = normalizeDate(startDate, "data de início");
  const due = dueDate ? normalizeDate(dueDate, "prazo de entrega") : null;
  if (due && due < requestedStartDate) {
    throw new PlannerError("O prazo de entrega não pode ser anterior à data de início.");
  }

  const horizon = integerValue(planningHorizonDays, "O horizonte de planejamento", { minimum: 1 });
  if (horizon > 730) throw new PlannerError("O horizonte máximo de planejamento é de 730 dias.");

  const days = calendarDays.map(normalizedCalendarDay).sort((a, b) => a.date.localeCompare(b.date));
  const calendarByDate = new Map(days.map((day) => [day.date, day]));
  const latestCalendarDate = days.at(-1)?.date ?? null;
  if (!latestCalendarDate || !calendarByDate.has(requestedStartDate)) {
    throw new PlannerError("O calendário não contém a data inicial solicitada.", 409);
  }

  const positionList = positions
    .map(normalizedPosition)
    .filter((position) => position.status !== "em_manutencao")
    .sort((a, b) => a.code.localeCompare(b.code));
  if (!positionList.length) throw new PlannerError("Não há posição de molde disponível para programação.", 409);
  if (new Set(positionList.map((position) => position.code)).size !== positionList.length) {
    throw new PlannerError("O catálogo contém posições de molde duplicadas.");
  }

  let effectiveStartDate = requestedStartDate;
  while (effectiveStartDate <= latestCalendarDate && !calendarByDate.get(effectiveStartDate)?.isWorking) {
    effectiveStartDate = addDays(effectiveStartDate, 1);
  }
  if (effectiveStartDate > latestCalendarDate) {
    throw new PlannerError("Não há dia útil disponível após a data inicial informada.", 409);
  }

  const castHorizonEnd = addDays(effectiveStartDate, horizon - 1);
  if (castHorizonEnd > latestCalendarDate) {
    throw new PlannerError("O calendário não cobre o horizonte de planejamento completo.", 409, {
      requiredThrough: addDays(castHorizonEnd, 10),
      availableThrough: latestCalendarDate,
    });
  }

  const normalizedItems = items.map(normalizedItem);
  if (!normalizedItems.length) throw new PlannerError("O pedido precisa ter ao menos um item.");

  const conflicts = [];
  const itemsWithoutPosition = normalizedItems.filter((item) => !positionList.some((position) => positionCanProduce(position, item)));
  for (const item of itemsWithoutPosition) {
    conflicts.push({
      type: "mold_configuration",
      pieceTypeId: item.pieceTypeId,
      message: `Nenhuma posição tem a configuração de moldes cadastrada para ${item.code || item.name || "esta peça"}.`,
    });
  }
  const occupiedByDate = new Map();
  reserveExistingCapacity({
    existingSchedules,
    existingAllocations,
    positions: positionList,
    occupiedByDate,
    startDate: effectiveStartDate,
    castHorizonEnd,
    conflicts,
  });

  const workingDates = days
    .filter((day) => day.isWorking && day.date >= effectiveStartDate && day.date <= castHorizonEnd)
    .map((day) => day.date);
  const units = [];
  const itemPlans = [];

  for (const item of normalizedItems) {
    const itemUnits = [];
    let unitSequence = 0;

    for (const castDate of workingDates) {
      if (itemUnits.length >= item.quantity) break;
      const occupied = occupiedByDate.get(castDate) || new Map();
      const freePositions = positionList.filter((position) =>
        !occupied.has(position.code) && positionCanProduce(position, item)
      );

      for (const position of freePositions) {
        if (itemUnits.length >= item.quantity) break;
        const cureStartDate = addDays(castDate, 1);
        const cureEndDate = addDays(castDate, item.curingDays);
        const finishDate = nextWorkingDateAfter(cureEndDate, calendarByDate, latestCalendarDate);
        if (!finishDate) continue;

        unitSequence += 1;
        const unit = {
          itemId: item.itemId,
          pieceTypeId: item.pieceTypeId,
          unitSequence,
          positionCode: position.code,
          castDate,
          workDate: castDate,
          curingDays: item.curingDays,
          cureStartDate,
          cureEndDate,
          finishDate,
          plannedEndDate: finishDate,
          productionMinutesSnapshot: item.productionMinutesPerUnit,
        };
        itemUnits.push(unit);
        units.push(unit);
        reservePosition(occupiedByDate, castDate, position.code, {
          orderId: null,
          status: "planned",
          source: "current_order",
        }, conflicts);
      }
    }

    const itemEndDates = itemUnits.map((unit) => unit.plannedEndDate).sort();
    itemPlans.push({
      itemId: item.itemId,
      pieceTypeId: item.pieceTypeId,
      code: item.code,
      name: item.name,
      requestedQuantity: item.quantity,
      quantityToProduce: item.quantity,
      curingDays: item.curingDays,
      productionMinutesPerUnit: item.productionMinutesPerUnit,
      plannedQuantity: itemUnits.length,
      remainingQuantity: item.quantity - itemUnits.length,
      plannedMinutes: itemUnits.length * item.productionMinutesPerUnit,
      plannedEndDate: itemEndDates.at(-1) ?? null,
      units: itemUnits,
    });
  }

  const schedulesByKey = new Map();
  for (const unit of units) {
    const key = `${unit.itemId}|${unit.castDate}`;
    const schedule = schedulesByKey.get(key) || {
      itemId: unit.itemId,
      pieceTypeId: unit.pieceTypeId,
      workDate: unit.castDate,
      castDate: unit.castDate,
      plannedQuantity: 0,
      plannedMinutes: 0,
      positionCodes: [],
      curingDays: unit.curingDays,
      cureStartDate: unit.cureStartDate,
      cureEndDate: unit.cureEndDate,
      finishDate: unit.finishDate,
      plannedEndDate: unit.plannedEndDate,
    };
    schedule.plannedQuantity += 1;
    schedule.plannedMinutes += unit.productionMinutesSnapshot;
    schedule.positionCodes.push(unit.positionCode);
    schedulesByKey.set(key, schedule);
  }

  const schedules = [...schedulesByKey.values()].sort((a, b) =>
    a.workDate.localeCompare(b.workDate) || a.itemId.localeCompare(b.itemId)
  );
  const totalRequestedQuantity = normalizedItems.reduce((sum, item) => sum + item.quantity, 0);
  const totalPlannedQuantity = units.length;
  const totalRemainingQuantity = totalRequestedQuantity - totalPlannedQuantity;
  const plannedCastDates = units.map((unit) => unit.castDate).sort();
  const plannedEndDates = units.map((unit) => unit.plannedEndDate).sort();
  const plannedCastEndDate = plannedCastDates.at(-1) ?? null;
  const partialEndDate = plannedEndDates.at(-1) ?? null;
  const plannedEndDate = totalRemainingQuantity === 0 ? partialEndDate : null;
  const dueMet = !due || (plannedEndDate !== null && plannedEndDate <= due);

  if (!dueMet && totalRemainingQuantity === 0) {
    conflicts.push({
      type: "deadline",
      dueDate: due,
      suggestedDueDate: plannedEndDate,
      remainingQuantity: 0,
      message: `O prazo solicitado é inviável. A data viável mais próxima é ${plannedEndDate}.`,
    });
  }
  if (totalRemainingQuantity > 0) {
    conflicts.push({
      type: itemsWithoutPosition.length ? "mold_configuration" : "horizon",
      dueDate: due,
      suggestedDueDate: null,
      remainingQuantity: totalRemainingQuantity,
      message: itemsWithoutPosition.length
        ? `Há ${totalRemainingQuantity} unidade(s) sem posição com a configuração de moldes exigida; revise os moldes nas posições P01–P04.`
        : `O horizonte não comporta ${totalRemainingQuantity} unidade(s); amplie o horizonte ou revise as posições disponíveis.`,
    });
  }

  const totalPlannedMinutes = units.reduce((sum, unit) => sum + unit.productionMinutesSnapshot, 0);
  const feasible = totalRemainingQuantity === 0 && dueMet && !conflicts.some((item) =>
    item.type === "capacity" || item.type === "position" || item.type === "mold_configuration"
  );

  return {
    feasible,
    requestedStartDate,
    startDate: requestedStartDate,
    effectiveStartDate,
    dueDate: due,
    plannedCastEndDate,
    plannedEndDate,
    partialEndDate,
    baselineEndDate: plannedEndDate,
    forecastEndDate: plannedEndDate,
    suggestedDueDate: dueMet ? null : plannedEndDate,
    workingDays: workingDates.length,
    capacityPerWorkingDay: positionList.length,
    totalRequestedQuantity,
    totalToProduce: totalRequestedQuantity,
    totalPlannedQuantity,
    totalPlannedMinutes,
    totalRemainingQuantity,
    items: itemPlans,
    units,
    schedules,
    conflicts,
  };
}
