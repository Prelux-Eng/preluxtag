/**
 * Planejamento linear PRELUX.
 *
 * A capacidade de concretagem é medida em posições ocupadas por dia útil.
 * O campo legado de minutos registra somente a carga de concretagem do dia.
 * A duração do processo vem das etapas: concretagem, cura e acabamento.
 * O módulo é puro para permitir os mesmos cálculos nas Edge Functions e nos
 * testes Node.js.
 */

import { buildProductionPhases } from "./production-phases.js";

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
  return {
    code,
    status,
    configurationKind: readField(position, "configurationKind", "configuration_kind"),
  };
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
    pieceKind: readField(item, "pieceKind", "piece_kind"),
    quantity,
    curingDays,
    productionMinutesPerUnit,
    requiredMoldCodes,
    requiresMoldConfig,
  };
}

function itemHasMoldConfiguration(item) {
  // Os moldes exigidos acompanham o item; não ficam gravados na posição.
  const requiredCountByKind = { braco: 1, pilar: 2, viga: 2, placa: 0 };
  const expectedCount = requiredCountByKind[item.pieceKind];
  if (expectedCount === 0) return item.requiredMoldCodes.length === 0;
  if (expectedCount !== undefined) return item.requiredMoldCodes.length === expectedCount;
  return item.requiredMoldCodes.length > 0 || !item.requiresMoldConfig;
}

function positionCanProduce(position, item) {
  // A posição é apenas o espaço físico. O planejador a associa ao pedido que
  // contém os moldes exigidos quando encontra uma vaga livre.
  if (item.pieceKind === "placa") return position.configurationKind === "placa";
  if (position.configurationKind === "placa") return false;
  return itemHasMoldConfiguration(item);
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

function addOccupiedInterval(intervalsByPosition, code, startAt, endAt) {
  const start = Date.parse(startAt);
  const end = Date.parse(endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return false;
  const intervals = intervalsByPosition.get(code) || [];
  intervals.push({ start, end });
  intervalsByPosition.set(code, intervals);
  return true;
}

function intervalOverlaps(intervalsByPosition, code, startAt, endAt) {
  const start = Date.parse(startAt);
  const end = Date.parse(endAt);
  return (intervalsByPosition.get(code) || []).some((interval) =>
    start < interval.end && end > interval.start
  );
}

function reserveExistingCapacity({
  existingSchedules,
  existingAllocations,
  positions,
  occupiedByDate,
  intervalsByPosition,
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
    const code = String(readField(allocation, "positionCode", "position_code", "")).trim();
    if (!positions.some((position) => position.code === code)) {
      conflicts.push({ type: "position", date, positionCode: code || null, message: `Alocação existente aponta para posição inválida em ${date}.` });
      continue;
    }
    const occupiedFromAt = readField(allocation, "occupiedFromAt", "occupied_from_at", null);
    const occupiedUntilAt = readField(allocation, "occupiedUntilAt", "occupied_until_at", null);
    if (occupiedFromAt || occupiedUntilAt) {
      if (!occupiedFromAt || !occupiedUntilAt || !addOccupiedInterval(intervalsByPosition, code, occupiedFromAt, occupiedUntilAt)) {
        conflicts.push({ type: "position", date, positionCode: code, message: `A alocação da posição ${code} contém um intervalo de ocupação inválido.` });
        continue;
      }
    }
    if (date >= startDate && date <= castHorizonEnd) {
      reservePosition(occupiedByDate, date, code, {
        orderId: allocation.orderId ?? allocation.order_id ?? null,
        status,
        source: "allocation",
      }, conflicts);
    }
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
  productionTiming = null,
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

  const allPositions = positions.map(normalizedPosition).sort((a, b) => a.code.localeCompare(b.code));
  if (!allPositions.length) throw new PlannerError("As posições físicas ainda não foram cadastradas para programação.", 409);
  if (new Set(allPositions.map((position) => position.code)).size !== allPositions.length) {
    throw new PlannerError("O catálogo contém posições de molde duplicadas.");
  }
  const positionList = allPositions.filter((position) => position.status !== "em_manutencao");

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
  const itemsWithoutMoldConfiguration = normalizedItems.filter((item) => !itemHasMoldConfiguration(item));
  const itemsWithoutCompatiblePosition = normalizedItems.filter((item) =>
    itemHasMoldConfiguration(item) && !positionList.some((position) => positionCanProduce(position, item))
  );
  for (const item of itemsWithoutMoldConfiguration) {
    conflicts.push({
      type: "mold_configuration",
      pieceTypeId: item.pieceTypeId,
      message: `Não há configuração de molde compatível cadastrada para ${item.code || item.name || "esta peça"}.`,
    });
  }
  const occupiedByDate = new Map();
  const intervalsByPosition = new Map();
  reserveExistingCapacity({
    existingSchedules,
    existingAllocations,
    positions: positionList,
    occupiedByDate,
    intervalsByPosition,
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
      const phases = productionTiming
        ? buildProductionPhases({ castDate, ...productionTiming })
        : null;
      // A cura ocupa a posição, mas não consome os minutos de trabalho do dia.
      // Quando há etapas detalhadas, a carga diária vem da concretagem delas.
      const castingMinutes = phases?.steps.find((step) => step.stepKind === "concretagem")?.durationMinutes
        ?? item.productionMinutesPerUnit;
      const occupied = occupiedByDate.get(castDate) || new Map();
      const freePositions = positionList.filter((position) =>
        !occupied.has(position.code) && positionCanProduce(position, item) &&
        (!phases || !intervalOverlaps(intervalsByPosition, position.code, phases.occupiedFromAt, phases.occupiedUntilAt))
      );

      for (const position of freePositions) {
        if (itemUnits.length >= item.quantity) break;
        const cureStartDate = phases?.cureStartDate ?? addDays(castDate, 1);
        const cureEndDate = phases?.cureEndDate ?? addDays(castDate, item.curingDays);
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
          productionMinutesSnapshot: castingMinutes,
          ...(phases ? {
            steps: phases.steps,
            occupiedFromAt: phases.occupiedFromAt,
            occupiedUntilAt: phases.occupiedUntilAt,
          } : {}),
        };
        itemUnits.push(unit);
        units.push(unit);
        reservePosition(occupiedByDate, castDate, position.code, {
          orderId: null,
          status: "planned",
          source: "current_order",
        }, conflicts);
        if (phases) addOccupiedInterval(intervalsByPosition, position.code, phases.occupiedFromAt, phases.occupiedUntilAt);
      }
    }

    const itemEndDates = itemUnits.map((unit) => unit.plannedEndDate).sort();
    const plannedCastingMinutes = itemUnits.reduce((sum, unit) => sum + unit.productionMinutesSnapshot, 0);
    itemPlans.push({
      itemId: item.itemId,
      pieceTypeId: item.pieceTypeId,
      code: item.code,
      name: item.name,
      requestedQuantity: item.quantity,
      quantityToProduce: item.quantity,
      curingDays: item.curingDays,
      productionMinutesPerUnit: itemUnits[0]?.productionMinutesSnapshot ?? item.productionMinutesPerUnit,
      plannedQuantity: itemUnits.length,
      remainingQuantity: item.quantity - itemUnits.length,
      plannedMinutes: plannedCastingMinutes,
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
    const hasCompatiblePosition = itemsWithoutCompatiblePosition.length === 0 && positionList.length > 0;
    conflicts.push({
      type: itemsWithoutMoldConfiguration.length
        ? "mold_configuration"
        : itemsWithoutCompatiblePosition.length || !positionList.length ? "position" : "horizon",
      dueDate: due,
      suggestedDueDate: null,
      remainingQuantity: totalRemainingQuantity,
      message: itemsWithoutMoldConfiguration.length
        ? `Há ${totalRemainingQuantity} unidade(s) sem configuração de molde compatível; revise os moldes exigidos no cadastro da peça.`
        : hasCompatiblePosition
          ? `O horizonte não comporta ${totalRemainingQuantity} unidade(s); amplie o horizonte ou revise as posições disponíveis.`
          : `Há ${totalRemainingQuantity} unidade(s) aguardando posição física adequada; confira a disponibilidade das posições.`,
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
