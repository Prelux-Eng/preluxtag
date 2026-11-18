/**
 * Simulador diário da produção PRELUX.
 *
 * Não consulta o banco nem grava dados. Recebe parâmetros versionados e
 * calcula a fila, a preparação, a concretagem, a cura e o acabamento. Os
 * valores abaixo só são usados por chamadores legados sem snapshot de Engenharia.
 */
import { addDays, normalizeDate, PlannerError } from "./planner.js";
import { calculatePieceMetrics } from "./piece-metrics.js";
import { validateEngineeringParameters } from "./engineering-domain.js";

const DEFAULT_ENGINEERING_PARAMETERS = Object.freeze({
  preparationWorkdays: 5,
  castingWorkdays: 1,
  curingCalendarDays: 2,
  finishingWorkdays: 1,
  maxCastingsPerWorkday: 4,
  maximumOrderCalendarDays: 90,
  castingStartTime: "08:00",
  concreteDensityKgM3: 2_500,
});

export const FACTORY_RULES = Object.freeze({
  preparationWorkingDays: 5,
  castingWorkingDays: 1,
  curingCalendarDays: 2,
  finishingWorkingDays: 1,
  maxCastingsPerWorkday: 4,
  maximumCalendarDays: 90,
  planningHorizonDays: 730,
  maximumUnits: 5000,
});

const CLOSED_STATUSES = new Set(["cancelado", "entregue", "concluido"]);
const FIRM_STATUSES = new Set(["aprovado", "em_producao", "atrasado"]);
const SIMULATED_STATUSES = new Set(["orcamento", ...FIRM_STATUSES]);
const PIECE_KINDS = new Set(["braco", "pilar", "viga", "placa"]);

function differenceInDays(start, end) {
  return Math.round((Date.parse(end + "T00:00:00Z") - Date.parse(start + "T00:00:00Z")) / 86_400_000);
}

function positiveInteger(value, label, maximum = FACTORY_RULES.maximumUnits) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > maximum) {
    throw new PlannerError(`${label} deve ser um inteiro entre 1 e ${maximum}.`);
  }
  return number;
}

function engineeringParametersFor(order) {
  const input = order.engineeringParameters ?? order.engineering_parameters;
  if (!input) return { ...DEFAULT_ENGINEERING_PARAMETERS };
  try {
    return validateEngineeringParameters(input);
  } catch (error) {
    throw new PlannerError(`Parâmetros de Engenharia inválidos no pedido ${order.id ?? order.orderId ?? ""}: ${error.message}`);
  }
}

function configurationFor(item) {
  const kind = String(item.pieceKind ?? item.piece_kind ?? "").trim();
  const rawCodes = item.requiredMoldCodes ?? item.required_mold_codes ?? [];
  if (!Array.isArray(rawCodes)) throw new PlannerError("Os moldes do item precisam ser uma lista.");
  const codes = rawCodes
    .map((code) => String(code).trim().toUpperCase()).sort();
  if (!PIECE_KINDS.has(kind)) throw new PlannerError("O tipo da peça deve ser braço, pilar, viga ou placa.");
  if (kind === "placa") {
    if (codes.length) throw new PlannerError("Placa não pode exigir molde.");
    return { kind: "placa", codes: [], key: "placa" };
  }
  if (kind === "braco") {
    if (codes.length !== 1 || !codes[0].startsWith("BRACO_")) {
      throw new PlannerError("Braço precisa de um molde BRAÇO do catálogo.");
    }
    return { kind: "braco", codes, key: `braco:${codes[0]}` };
  }
  if (codes.length !== 2 || !codes.some((code) => code.startsWith("LEITO_")) ||
      !codes.some((code) => code.startsWith("LATERAL_"))) {
    throw new PlannerError("Pilar e viga precisam de um LEITO e uma LATERAL.");
  }
  return { kind: "pilar_viga", codes, key: `pilar_viga:${codes.join("|")}` };
}

function configurationFromCatalogCodes(rawCodes) {
  if (!Array.isArray(rawCodes)) return null;
  const codes = rawCodes.map((code) => String(code).toUpperCase()).sort();
  if (codes.length === 1 && codes[0].startsWith("BRACO_")) return `braco:${codes[0]}`;
  if (codes.length === 2 && codes.some((code) => code.startsWith("LEITO_")) &&
      codes.some((code) => code.startsWith("LATERAL_"))) return `pilar_viga:${codes.join("|")}`;
  return null;
}

function positionConfiguration(position) {
  const kind = position.configurationKind ?? position.configuration_kind ?? null;
  if (kind === "placa") return "placa";
  // A última concretagem concluída prevalece sobre um cadastro legado da
  // posição. Depois de desmontar, os campos legados não valem mais.
  const installed = configurationFromCatalogCodes(position.installedMoldCatalogCodes ?? position.installed_mold_catalog_codes);
  if (installed) return installed;
  if (position.formResetAt ?? position.form_reset_at) return null;
  if (kind === "braco") {
    const code = position.bracoCatalogCode ?? position.braco_catalog_code;
    return code ? `braco:${String(code).toUpperCase()}` : null;
  }
  if (kind === "pilar_viga") {
    const bed = position.leitoCatalogCode ?? position.leito_catalog_code;
    const side = position.lateralCatalogCode ?? position.lateral_catalog_code;
    return bed && side ? `pilar_viga:${[bed, side].map((code) => String(code).toUpperCase()).sort().join("|")}` : null;
  }
  return null;
}

function normalizedCalendar(days) {
  const byDate = new Map();
  const capacityByDate = new Map();
  for (const day of days || []) {
    const date = normalizeDate(day.date, "dia do calendário");
    if (byDate.has(date)) throw new PlannerError(`O calendário contém a data duplicada ${date}.`);
    const capacity = Number(day.capacityMinutes ?? day.capacity_minutes ?? 0);
    const isWorking = Boolean(day.isWorking ?? day.is_working) && capacity > 0;
    byDate.set(date, isWorking);
    capacityByDate.set(date, isWorking ? capacity : 0);
  }
  return {
    byDate,
    capacityByDate,
    working: [...byDate].filter(([, isWorking]) => isWorking).map(([date]) => date).sort(),
    firstDate: [...byDate.keys()].sort()[0] ?? null,
    lastDate: [...byDate.keys()].sort().at(-1) ?? null,
  };
}

function normalizedOrders(orders) {
  if (!Array.isArray(orders)) throw new PlannerError("Os pedidos precisam ser enviados como uma lista.");
  const ids = new Set();
  let totalUnits = 0;
  const result = orders.map((order) => {
    const id = String(order.id ?? order.orderId ?? "").trim();
    if (!id || ids.has(id)) throw new PlannerError("Cada pedido precisa de um identificador único.");
    ids.add(id);
    const status = String(order.status ?? "orcamento").trim();
    if (CLOSED_STATUSES.has(status)) throw new PlannerError(`O pedido ${id} está encerrado e não pode ser simulado.`);
    if (!SIMULATED_STATUSES.has(status)) throw new PlannerError(`O pedido ${id} tem status inválido para simulação.`);
    const startDate = normalizeDate(order.startDate ?? order.start_date, "início do pedido");
    const requestedDueDate = order.requestedDueDate ?? order.requested_due_date ?? null;
    const dueDate = requestedDueDate ? normalizeDate(requestedDueDate, "prazo solicitado") : null;
    if (dueDate && dueDate < startDate) throw new PlannerError("O prazo solicitado não pode anteceder o início.");
    const engineeringParameters = engineeringParametersFor(order);
    const externalAdjustments = Array.isArray(order.delayAdjustments ?? order.delay_adjustments)
      ? (order.delayAdjustments ?? order.delay_adjustments).map((adjustment) => {
        const impactDays = Number(adjustment.impactDays ?? adjustment.impact_days);
        if (!Number.isInteger(impactDays) || impactDays === 0) {
          throw new PlannerError("O impacto de um ajuste externo precisa ser um número inteiro diferente de zero.");
        }
        const occurredOn = normalizeDate(adjustment.occurredOn ?? adjustment.occurred_on, "data do ajuste externo");
        const reason = String(adjustment.reason ?? "").trim();
        if (!reason) throw new PlannerError("Todo ajuste externo precisa informar o motivo.");
        return { reason, occurredOn, impactDays };
      })
      : [];
    const adjustmentDays = externalAdjustments.length
      ? externalAdjustments.reduce((sum, adjustment) => sum + adjustment.impactDays, 0)
      : Number(order.adjustmentDays ?? 0);
    if (!Array.isArray(order.items) || !order.items.length) throw new PlannerError(`O pedido ${id} não tem itens.`);
    const items = order.items.map((item, index) => {
      const itemId = String(item.id ?? item.itemId ?? "").trim();
      if (!itemId) throw new PlannerError("Um item do pedido está sem identificador.");
      const quantity = positiveInteger(item.quantity, "A quantidade do item");
      const sequence = positiveInteger(item.sequence ?? index + 1, "A sequência do item", 10000);
      const curingDays = positiveInteger(
        item.curingDays ?? item.curing_days ?? engineeringParameters.curingCalendarDays,
        "A duração da cura",
        365,
      );
      const productionMinutesSnapshot = Number(
        item.productionMinutesSnapshot ?? item.production_minutes_snapshot,
      );
      if (!Number.isSafeInteger(productionMinutesSnapshot) || productionMinutesSnapshot < 1) {
        throw new PlannerError(`O item ${itemId} precisa ter minutos de concretagem configurados antes do planejamento.`);
      }
      const config = configurationFor(item);
      const x = item.dimensionXcm ?? item.dimension_x_cm;
      const y = item.dimensionYcm ?? item.dimension_y_cm;
      const z = item.dimensionZcm ?? item.dimension_z_cm;
      const metrics = x == null && y == null && z == null
        ? null // Tipos legados podem não ter dimensões; não inventamos volume.
        : calculatePieceMetrics({
          x,
          y,
          z,
          concreteDensityKgM3: engineeringParameters.concreteDensityKgM3,
        });
      totalUnits += quantity;
      return {
        id: itemId,
        pieceTypeId: String(item.pieceTypeId ?? item.piece_type_id ?? ""),
        sequence,
        quantity,
        curingDays,
        productionMinutesSnapshot,
        config,
        metrics,
      };
    }).sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
    return {
      id,
      orderNumber: order.orderNumber ?? order.order_number ?? null,
      status,
      firm: FIRM_STATUSES.has(status),
      approvedAt: String(order.approvedAt ?? order.approved_at ?? order.createdAt ?? order.created_at ?? ""),
      createdAt: String(order.createdAt ?? order.created_at ?? ""),
      startDate,
      dueDate,
      adjustmentDays,
      externalAdjustments,
      engineeringParameterVersionId: order.engineeringParameterVersionId ?? order.engineering_parameter_version_id ?? null,
      engineeringParameterVersion: order.engineeringParameterVersion ?? order.engineering_parameter_version ?? null,
      engineeringParameters,
      items,
    };
  });
  if (totalUnits > FACTORY_RULES.maximumUnits) {
    throw new PlannerError(`A simulação aceita no máximo ${FACTORY_RULES.maximumUnits} unidades.`);
  }
  if (result.some((order) => !Number.isInteger(order.adjustmentDays))) {
    throw new PlannerError("O impacto acumulado dos ajustes precisa ser em dias inteiros.");
  }
  return result.sort((left, right) =>
    Number(right.firm) - Number(left.firm) ||
    left.approvedAt.localeCompare(right.approvedAt) ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

function normalizedPositions(positions, reservations, asOfDate) {
  const states = new Map();
  for (const position of positions || []) {
    const code = String(position.code ?? "").trim();
    if (!/^P0[1-4]$/.test(code) || states.has(code)) throw new PlannerError("As posições P01–P04 devem ser únicas.");
    const currentReservation = reservations.some((reservation) =>
      (reservation.positionCode ?? reservation.position_code) === code &&
      ["planned", "in_progress", "done"].includes(reservation.status) &&
      (reservation.startDate ?? reservation.start_date) <= asOfDate &&
      (reservation.endDate ?? reservation.end_date) >= asOfDate
    );
    states.set(code, {
      code,
      // Preparação e concretagem são ocupações temporárias: a reserva fixa
      // informa quando a posição volta. Manutenção ou ocupação sem data de
      // liberação conhecida continuam bloqueadas.
      available: position.status === "disponivel" ||
        (["em_preparacao", "em_producao"].includes(position.status) && currentReservation),
      plateOnly: (position.configurationKind ?? position.configuration_kind) === "placa",
      initialConfig: positionConfiguration(position),
      formResetAt: position.formResetAt ?? position.form_reset_at ?? null,
      formResetLocalDate: position.formResetLocalDate ?? position.form_reset_local_date ?? null,
      events: [],
      busy: new Set(),
      preparationDays: 0,
      castingDays: 0,
    });
  }
  for (const reservation of reservations || []) {
    const state = states.get(String(reservation.positionCode ?? reservation.position_code ?? ""));
    if (!state) throw new PlannerError("Uma reserva existente aponta para posição desconhecida.");
    const start = normalizeDate(reservation.startDate ?? reservation.start_date, "início da reserva");
    const end = normalizeDate(reservation.endDate ?? reservation.end_date ?? start, "fim da reserva");
    if (end < start) throw new PlannerError("O fim da reserva não pode anteceder seu início.");
    for (let date = start; date <= end; date = addDays(date, 1)) state.busy.add(date);
    const installed = configurationFromCatalogCodes(reservation.moldCatalogCodes ?? reservation.mold_catalog_codes);
    const eventAt = reservation.occupiedUntilAt ?? reservation.occupied_until_at ?? null;
    const afterReset = !state.formResetAt || (eventAt
      ? Date.parse(eventAt) > Date.parse(state.formResetAt)
      : end > state.formResetLocalDate);
    if (installed && afterReset) state.events.push({ date: end, key: installed });
  }
  for (const state of states.values()) state.events.sort((a, b) => a.date.localeCompare(b.date));
  return [...states.values()].sort((a, b) => a.code.localeCompare(b.code));
}

function configurationAt(position, date) {
  let key = position.initialConfig;
  for (const event of position.events) {
    if (event.date > date) break;
    key = event.key;
  }
  return key;
}

function candidateFor(
  position,
  item,
  startDate,
  calendar,
  engineeringParameters,
  castingsByDate,
  productionMinutesByDate,
) {
  if (!position.available || position.plateOnly !== (item.config.kind === "placa")) return null;
  const firstIndex = calendar.working.findIndex((date) => date >= startDate);
  if (firstIndex < 0) return null;
  const horizonEnd = addDays(startDate, FACTORY_RULES.planningHorizonDays - 1);
  for (let index = firstIndex; index < calendar.working.length; index += 1) {
    const castDate = calendar.working[index];
    if (castDate > horizonEnd) break;
    if (position.busy.has(castDate)) continue;
    if ((castingsByDate.get(castDate) || 0) >= engineeringParameters.maxCastingsPerWorkday) continue;
    const dailyCapacity = calendar.capacityByDate.get(castDate) || 0;
    const scheduledMinutes = productionMinutesByDate.get(castDate) || 0;
    if (scheduledMinutes + item.productionMinutesSnapshot > dailyCapacity) continue;
    if (configurationAt(position, castDate) === item.config.key) {
      return { position, castDate, preparationDates: [] };
    }
    if (item.config.kind === "placa" || index - engineeringParameters.preparationWorkdays < firstIndex) continue;
    const preparationDates = calendar.working.slice(index - engineeringParameters.preparationWorkdays, index);
    if (preparationDates.length !== engineeringParameters.preparationWorkdays ||
        preparationDates.some((date) => position.busy.has(date))) continue;
    return { position, castDate, preparationDates };
  }
  return null;
}

function workingDatesAfter(date, count, calendar) {
  return calendar.working.filter((day) => day > date).slice(0, count);
}

function bestCandidate(
  positions,
  item,
  startDate,
  calendar,
  engineeringParameters,
  castingsByDate,
  productionMinutesByDate,
) {
  const candidates = positions.map((position) => candidateFor(
    position,
    item,
    startDate,
    calendar,
    engineeringParameters,
    castingsByDate,
    productionMinutesByDate,
  )).filter(Boolean);
  candidates.sort((a, b) =>
    a.castDate.localeCompare(b.castDate) ||
    a.preparationDates.length - b.preparationDates.length ||
    a.position.code.localeCompare(b.position.code)
  );
  return candidates[0] ?? null;
}

function reserve(candidate, item, castingsByDate, productionMinutesByDate) {
  const { position, castDate, preparationDates } = candidate;
  for (const date of preparationDates) position.busy.add(date);
  position.busy.add(castDate);
  position.preparationDays += preparationDates.length;
  position.castingDays += 1;
  castingsByDate.set(castDate, (castingsByDate.get(castDate) || 0) + 1);
  productionMinutesByDate.set(
    castDate,
    (productionMinutesByDate.get(castDate) || 0) + item.productionMinutesSnapshot,
  );
  if (preparationDates.length) {
    position.events.push({ date: preparationDates.at(-1), key: item.config.key });
    position.events.sort((a, b) => a.date.localeCompare(b.date));
  }
}

/**
 * Retorna previsão para todos os pedidos sem efeitos colaterais. Orçamentos
 * entram depois dos aprovados apenas neste cenário e nunca viram reserva.
 */
export function simulateProject({ calendarDays, positions, orders, existingReservations = [], earliestSchedulingDate = null }) {
  const calendar = normalizedCalendar(calendarDays);
  const queue = normalizedOrders(orders);
  const schedulingFloor = earliestSchedulingDate
    ? normalizeDate(earliestSchedulingDate, "primeira data de programação")
    : null;
  const positionStates = normalizedPositions(positions, existingReservations, schedulingFloor ?? calendar.firstDate);
  if (queue.length && (!positionStates.length || !positionStates.some((position) => position.available))) {
    throw new PlannerError("Não há posição de produção disponível.");
  }
  const results = [];
  const castingsByDate = new Map();
  const productionMinutesByDate = new Map();
  for (const reservation of existingReservations || []) {
    if (!["planned", "in_progress", "done"].includes(reservation.status ?? "planned")) continue;
    const castDate = reservation.scheduledDate ?? reservation.scheduled_date ??
      reservation.castDate ?? reservation.cast_date ?? reservation.endDate ?? reservation.end_date;
    if (!castDate || !calendar.capacityByDate.has(castDate)) continue;
    castingsByDate.set(castDate, (castingsByDate.get(castDate) || 0) + 1);
    const capacity = calendar.capacityByDate.get(castDate) || 0;
    const rawMinutes = reservation.productionMinutesSnapshot ?? reservation.production_minutes_snapshot;
    const reservedMinutes = Number(rawMinutes);
    // Eventos antigos sem retrato da carga ainda reservam o turno inteiro.
    // Isso evita oferecer capacidade que pode já ter sido consumida.
    const minutes = Number.isSafeInteger(reservedMinutes) && reservedMinutes > 0
      ? reservedMinutes
      : capacity;
    productionMinutesByDate.set(
      castDate,
      (productionMinutesByDate.get(castDate) || 0) + minutes,
    );
  }
  for (const order of queue) {
    // A data contratual do pedido continua intacta para prazo e atraso. A
    // programação física começa hoje quando o pedido foi aberto no passado.
    const schedulingStartDate = schedulingFloor && schedulingFloor > order.startDate
      ? schedulingFloor
      : order.startDate;
    if (!calendar.byDate.has(schedulingStartDate)) {
      throw new PlannerError(`O calendário não contém a data inicial do pedido ${order.id}.`, 409);
    }
    const units = [];
    const conflicts = [];
    let totalRequested = 0;
    let totalProductionMinutes = 0;
    let totalVolumeM3 = 0;
    let totalWeightKg = 0;
    for (const item of order.items) {
      totalRequested += item.quantity;
      for (let sequence = 1; sequence <= item.quantity; sequence += 1) {
        const candidate = bestCandidate(
          positionStates,
          item,
          schedulingStartDate,
          calendar,
          order.engineeringParameters,
          castingsByDate,
          productionMinutesByDate,
        );
        if (!candidate) {
          const canFitAnyWorkingDay = calendar.working.some((date) =>
            date >= schedulingStartDate &&
            (calendar.capacityByDate.get(date) || 0) >= item.productionMinutesSnapshot
          );
          conflicts.push({
            type: canFitAnyWorkingDay ? "position" : "capacity",
            itemId: item.id,
            unitSequence: sequence,
            productionMinutesSnapshot: item.productionMinutesSnapshot,
            message: canFitAnyWorkingDay
              ? "Nenhuma posição compatível com capacidade diária disponível cabe no horizonte de simulação."
              : `A carga de concretagem de ${item.productionMinutesSnapshot} minutos excede a capacidade diária disponível no calendário.`,
          });
          continue;
        }
        const cureStartDate = addDays(candidate.castDate, 1);
        const cureEndDate = addDays(candidate.castDate, item.curingDays);
        const finishingDates = workingDatesAfter(
          cureEndDate,
          order.engineeringParameters.finishingWorkdays,
          calendar,
        );
        if (finishingDates.length !== order.engineeringParameters.finishingWorkdays) {
          conflicts.push({ type: "calendar", itemId: item.id, unitSequence: sequence, message: "O calendário não alcança o acabamento desta unidade." });
          continue;
        }
        reserve(candidate, item, castingsByDate, productionMinutesByDate);
        totalVolumeM3 += item.metrics?.volumeM3 ?? 0;
        totalWeightKg += item.metrics?.weightKg ?? 0;
        totalProductionMinutes += item.productionMinutesSnapshot;
        units.push({
          itemId: item.id,
          pieceTypeId: item.pieceTypeId,
          unitSequence: sequence,
          positionCode: candidate.position.code,
          preparationRequired: candidate.preparationDates.length > 0,
          preparationReason: item.config.kind === "placa"
            ? "A placa usa a bancada plana e não exige preparação de forma."
            : candidate.preparationDates.length
              ? "A posição não tinha a configuração de forma solicitada instalada."
              : "A configuração de forma solicitada já estava instalada na posição.",
          positionSelectionReason: "Posição compatível com a primeira data disponível; em empate, foi escolhida a posição de menor código.",
          moldCatalogCodes: item.config.codes,
          preparationStartDate: candidate.preparationDates[0] ?? null,
          preparationEndDate: candidate.preparationDates.at(-1) ?? null,
          preparationDates: candidate.preparationDates,
          curingDays: item.curingDays,
          productionMinutesSnapshot: item.productionMinutesSnapshot,
          castDate: candidate.castDate,
          cureStartDate,
          cureEndDate,
          finishingDates,
          finishDate: finishingDates.at(-1),
          castingStartTime: order.engineeringParameters.castingStartTime,
          volumeM3: item.metrics?.volumeM3 ?? null,
          weightKg: item.metrics?.weightKg ?? null,
        });
      }
    }
    const plannedEndDate = units.map((unit) => unit.finishDate).sort().at(-1) ?? null;
    const forecastEndDate = plannedEndDate ? addDays(plannedEndDate, order.adjustmentDays) : null;
    const maximumDueDate = addDays(order.startDate, order.engineeringParameters.maximumOrderCalendarDays);
    const overLimitDays = forecastEndDate ? Math.max(0, differenceInDays(maximumDueDate, forecastEndDate)) : null;
    const requestedDelayDays = forecastEndDate && order.dueDate
      ? Math.max(0, differenceInDays(order.dueDate, forecastEndDate)) : null;
    const complete = units.length === totalRequested;
    results.push({
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      reservesCapacityOnConfirmation: order.firm,
      engineeringParameterVersionId: order.engineeringParameterVersionId,
      engineeringParameterVersion: order.engineeringParameterVersion,
      engineeringParameters: order.engineeringParameters,
      startDate: order.startDate,
      requestedDueDate: order.dueDate,
      externalAdjustments: order.externalAdjustments,
      totalExternalAdjustmentDays: order.adjustmentDays,
      maximumDueDate,
      plannedEndDate,
      forecastEndDate,
      durationCalendarDays: forecastEndDate ? differenceInDays(order.startDate, forecastEndDate) : null,
      overLimitDays,
      requestedDelayDays,
      maximumQuantityWithinLimit: units.filter((unit) =>
        addDays(unit.finishDate, order.adjustmentDays) <= maximumDueDate
      ).length,
      maximumQuantityWithin90Days: units.filter((unit) =>
        addDays(unit.finishDate, order.adjustmentDays) <= maximumDueDate
      ).length,
      suggestedDueDate: requestedDelayDays ? forecastEndDate : null,
      feasible: complete && overLimitDays === 0 && (!order.dueDate || requestedDelayDays === 0),
      totalRequestedQuantity: totalRequested,
      totalPlannedQuantity: units.length,
      totalProductionMinutes,
      totalVolumeM3,
      totalWeightKg,
      conflicts,
      units,
    });
  }
  const usage = positionStates.map((position) => ({
    positionCode: position.code,
    preparationDays: position.preparationDays,
    castingDays: position.castingDays,
    occupiedDays: position.preparationDays + position.castingDays,
  }));
  const busiest = [...usage].sort((a, b) => b.occupiedDays - a.occupiedDays || a.positionCode.localeCompare(b.positionCode))[0];
  const dailyCapacityUsage = [...productionMinutesByDate]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, minutesUsed]) => {
      const capacityMinutes = calendar.capacityByDate.get(date) || 0;
      return {
        date,
        minutesUsed,
        capacityMinutes,
        remainingMinutes: Math.max(0, capacityMinutes - minutesUsed),
        castings: castingsByDate.get(date) || 0,
      };
    });
  return {
    rules: FACTORY_RULES,
    parameterVersions: [...new Map(queue.map((order) => [
      order.engineeringParameterVersionId ?? `default:${order.id}`,
      {
        id: order.engineeringParameterVersionId,
        version: order.engineeringParameterVersion,
        parameters: order.engineeringParameters,
      },
    ])).values()],
    allFeasible: results.every((order) => order.feasible),
    orderCount: results.length,
    totalUnits: results.reduce((sum, order) => sum + order.totalPlannedQuantity, 0),
    dailyCapacityUsage,
    bottleneck: busiest?.occupiedDays ? { type: "position", ...busiest } : null,
    positionUsage: usage,
    orders: results,
  };
}
