/*
 * Caso de uso de cadastro integrado: obra + pedido + item + tipo de peca.
 * A Edge Function valida a chamada HTTP; este servico aplica as regras,
 * consulta o dominio de planejamento e delega a gravacao atomica a uma RPC.
 */
import { buildPlanningQueue } from "./order-planning.js";
import { calculatePieceMetrics } from "./piece-metrics.js";
import { productionMinutesForKind, resolveRequestedDueDate } from "./registration-rules.js";
import { registrationRepository } from "./registration-repository.js";

function invalid(message, status = 422) {
  throw Object.assign(new Error(message), { status });
}

function requiredText(value, label, maxLength) {
  const result = String(value ?? "").trim();
  if (!result) invalid(`Informe ${label}.`, 400);
  if (result.length > maxLength) invalid(`${label} deve ter no maximo ${maxLength} caracteres.`, 400);
  return result;
}

function isoDate(value) {
  const result = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) invalid("Informe uma data de inicio valida.", 400);
  const parsed = new Date(`${result}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) invalid("Informe uma data de inicio valida.", 400);
  return result;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) invalid(`${label} deve ser um inteiro maior que zero.`, 400);
  return parsed;
}

function positiveDecimal(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) invalid(`${label} deve ser maior que zero.`, 400);
  return parsed;
}

function throwDatabaseError(error, fallback) {
  const code = String(error?.code || "");
  const conflict = code === "23505";
  throw Object.assign(new Error(conflict ? "Ja existe um cadastro com o mesmo codigo ou numero nesta unidade." : fallback), {
    status: conflict ? 409 : code.startsWith("23") || code.startsWith("22") || code === "P0001" ? 422 : 500,
  });
}

/** Valida e coordena a criacao completa sem expor acesso ao banco ao navegador. */
export async function createOrderPieceRegistration(db, organizationId, input) {
  const startDate = isoDate(input.startDate);
  const dueDate = resolveRequestedDueDate({
    startDate,
    manualDate: String(input.requestedDueDate || ""),
    manuallyEdited: input.requestedDueDateManual === true,
  });
  const pieceKind = String(input.pieceKind || "");
  if (!["braco", "pilar", "viga"].includes(pieceKind)) invalid("Selecione braco, pilar ou viga.", 400);

  const pieceId = crypto.randomUUID();
  const orderId = crypto.randomUUID();
  const itemId = crypto.randomUUID();
  const quantity = positiveInteger(input.quantity, "A quantidade");
  const work = {
    workNumber: requiredText(input.workNumber, "o numero da obra", 80),
    name: requiredText(input.workName, "o nome da obra", 180),
    responsibleName: requiredText(input.responsibleName, "o engenheiro responsavel", 180),
    address: requiredText(input.address, "o endereco da obra", 300),
    clientName: requiredText(input.clientName, "o cliente", 180),
    startDate,
    requestedDueDate: dueDate,
  };
  const piece = {
    id: pieceId,
    organization_id: organizationId,
    code: requiredText(input.pieceCode, "o codigo da peca", 60).toLocaleUpperCase(),
    name: requiredText(input.pieceName, "o nome da peca", 180),
    piece_kind: pieceKind,
    production_minutes_per_unit: 0,
  };

  const geometryParts = input.geometryParts == null ? [] : input.geometryParts;
  if (!Array.isArray(geometryParts)) invalid("A composicao geometrica precisa ser uma lista de partes.", 400);
  const dimensions = {
    x: positiveDecimal(input.dimensionXcm, "Largura X"),
    y: positiveDecimal(input.dimensionYcm, "Comprimento Y"),
    z: positiveDecimal(input.dimensionZcm, "Espessura Z"),
    geometryParts,
  };
  const metrics = calculatePieceMetrics(dimensions);

  const { data: timeSettings, error: timeError } = await registrationRepository.getProductionMinutes(db, organizationId);
  if (timeError) throwDatabaseError(timeError, "Configure o tempo por tipo de peca depois de aplicar a migration aprovada.");
  const configuredMinutes = Object.fromEntries((timeSettings || []).map((row) => [
    row.constant_key.replace("production_minutes_", ""), Number(row.numeric_value),
  ]));
  // As tres configuracoes sao exigidas antes do primeiro cadastro, conforme a decisao da PRELUX.
  for (const kind of ["braco", "pilar", "viga"]) productionMinutesForKind(kind, configuredMinutes);
  const productionMinutes = productionMinutesForKind(pieceKind, configuredMinutes);
  piece.production_minutes_per_unit = productionMinutes;

  const molds = pieceKind === "braco"
    ? [{ role: "braco", catalogCode: requiredText(input.bracoCatalogCode, "a forma de braco", 80) }]
    : [
      { role: "leito", catalogCode: requiredText(input.leitoCatalogCode, "a forma LEITO", 80) },
      { role: "lateral", catalogCode: requiredText(input.lateralCatalogCode, "a forma LATERAL", 80) },
    ];
  const { data: moldRows, error: moldError } = await registrationRepository.getMoldCatalogEntries(db, molds.map((mold) => mold.catalogCode));
  if (moldError) throwDatabaseError(moldError, "Nao foi possivel validar as formas do catalogo.");
  const validTypes = { braco: "BRACO", leito: "LEITO", lateral: "LATERAL" };
  if (molds.some((mold) => !(moldRows || []).some((row) => row.code === mold.catalogCode && row.mold_type === validTypes[mold.role]))) {
    invalid("Selecione formas existentes compativeis com o tipo de peca.", 400);
  }

  const draftOrder = {
    id: orderId,
    order_number: "",
    client_id: null,
    start_date: startDate,
    requested_due_date: dueDate,
    planned_end_date: null,
    forecast_end_date: null,
    status: "orcamento",
    created_at: new Date().toISOString(),
    is_active: true,
  };
  const draftItem = {
    id: itemId,
    order_id: orderId,
    piece_type_id: pieceId,
    quantity,
    production_minutes_snapshot: productionMinutes,
    sequence: 1,
  };

  const queuePlan = await buildPlanningQueue({
    db,
    organizationId,
    input: {
      persistCalendarDays: false,
      draft: { order: draftOrder, item: draftItem, piece, requiredMoldCodes: molds.map((mold) => mold.catalogCode) },
    },
  });

  const targetPlan = queuePlan.targetPlan || null;
  const targetHasPosition = Boolean(targetPlan?.feasible);
  const plans = (queuePlan?.plans || [])
    .filter((entry) => entry.orderId !== orderId || targetHasPosition)
    .map((entry) => ({ orderId: entry.orderId, plan: entry.plan }));
  const plannedDates = new Set(plans.flatMap((entry) => entry.plan.units.map((unit) => unit.castDate)));
  const planningCalendarDays = queuePlan.calendarDays.filter((day) => plannedDates.has(day.date));
  const registration = {
    orderId,
    itemId,
    pieceId,
    work,
    order: { status: "orcamento", requestedDueDate: dueDate, startDate, observations: String(input.orderObservations || "").trim() },
    item: { quantity, sequence: 1, observations: String(input.itemObservations || "").trim() },
    piece: {
      code: piece.code,
      name: piece.name,
      pieceKind,
      dimensionXcm: dimensions.x,
      dimensionYcm: dimensions.y,
      dimensionZcm: dimensions.z,
      volumeCm3: metrics.volumeCm3,
      volumeM3: metrics.volumeM3,
      weightKg: metrics.weightKg,
      geometryParts,
      observations: String(input.pieceObservations || "").trim(),
      productionMinutesPerUnit: productionMinutes,
      moldCatalogs: Object.fromEntries(molds.map((mold) => [mold.role, mold.catalogCode])),
    },
    plans,
    planningCalendarDays,
  };
  const { data, error } = await registrationRepository.createRegistration(db, organizationId, registration);
  if (error) throwDatabaseError(error, "Nao foi possivel gravar obra, pedido, peca e planejamento. A RPC depende da proposta SQL aprovada.");

  return {
    registration: data,
    planning: {
      committed: true,
      waitingForPosition: !targetHasPosition,
      feasible: targetHasPosition,
      plannedUnitCount: targetPlan?.units?.length || 0,
      warning: targetHasPosition ? null : "Pedido salvo e aguardando uma posicao compativel.",
    },
  };
}
