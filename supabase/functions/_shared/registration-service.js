/*
 * Caso de uso de cadastro integrado: obra + pedido + item + tipo de peca.
 * A Edge Function valida a chamada HTTP; este servico aplica as regras,
 * consulta o dominio de planejamento e delega a gravacao atomica a uma RPC.
 */
import { reconcileFactoryPlan } from "./factory-plan-service.js";
import { calculatePieceMetrics } from "./piece-metrics.js";
import { resolveRequestedDueDate } from "./registration-rules.js";
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
  const validation = code === "P0001" || code.startsWith("22") || code.startsWith("23");
  const message = conflict
    ? "Ja existe um cadastro com o mesmo codigo ou numero nesta unidade."
    : validation && error?.message ? error.message : fallback;
  throw Object.assign(new Error(message), {
    status: conflict ? 409 : code.startsWith("23") || code.startsWith("22") || code === "P0001" ? 422 : 500,
  });
}

/**
 * O esquema antigo exige minutos por unidade. Usamos a duração da concretagem
 * apenas para preencher esses campos de compatibilidade; o prazo da peça vem
 * das etapas de concretagem, cura e acabamento no planejamento.
 */
async function castingMinutesForLegacyFields(db, organizationId) {
  const { data, error } = await registrationRepository.getCastingDurationMinutes(db, organizationId);
  if (error) throwDatabaseError(error, "Não foi possível consultar a duração da concretagem.");
  const minutes = Number(data?.numeric_value);
  if (data?.unit !== "min" || !Number.isInteger(minutes) || minutes <= 0) {
    invalid("Configure a duração da concretagem em minutos antes de incluir peças.", 409);
  }
  return minutes;
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

  const dimensions = {
    x: positiveDecimal(input.dimensionXcm, "Largura X"),
    y: positiveDecimal(input.dimensionYcm, "Comprimento Y"),
    z: positiveDecimal(input.dimensionZcm, "Dimensão Z"),
  };
  const metrics = calculatePieceMetrics(dimensions);

  const castingMinutes = await castingMinutesForLegacyFields(db, organizationId);
  piece.production_minutes_per_unit = castingMinutes;

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
  const moldsForDimensions = resolveCatalogMolds(pieceKind, dimensions.x, dimensions.z, moldRows || []);
  if (!moldsForDimensions || molds.some((mold) => !moldsForDimensions.some((expected) =>
    expected.role === mold.role && expected.catalogCode === mold.catalogCode
  ))) {
    invalid(pieceKind === "braco"
      ? "A forma BRAÇO precisa corresponder às dimensões X × Z da peça."
      : "A forma LEITO precisa corresponder a X e a LATERAL precisa corresponder a Z.", 422);
  }

  // Este fluxo cria um orçamento. Não calcula nem grava posições; a confirmação
  // passa exclusivamente pelo Planejamento transacional da Etapa 5.
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
      observations: String(input.pieceObservations || "").trim(),
      productionMinutesPerUnit: castingMinutes,
      moldCatalogs: Object.fromEntries(molds.map((mold) => [mold.role, mold.catalogCode])),
    },
    plans: [],
    planningCalendarDays: [],
  };
  const { data, error } = await registrationRepository.createRegistration(db, organizationId, registration);
  if (error) throwDatabaseError(error, "Nao foi possivel gravar obra, pedido, peca e planejamento. A RPC depende da proposta SQL aprovada.");

  return {
    registration: data,
    planning: {
      committed: false,
      simulatedOnly: true,
      waitingForPosition: false,
      feasible: null,
      plannedUnitCount: 0,
      warning: "Orçamento salvo sem reserva; simule no Planejamento.",
    },
  };
}

/** Salva primeiro o cabeçalho do pedido; a obra é opcional e pode ser criada ou atualizada. */
export async function createOrderHeader(db, organizationId, input) {
  const orderId = crypto.randomUUID();
  const linkedWork = input.work && typeof input.work === "object" ? input.work : null;
  const startDate = isoDate(linkedWork?.startDate || input.startDate);
  const requestedDueDate = resolveRequestedDueDate({
    startDate,
    manualDate: String(linkedWork?.requestedDueDate || input.requestedDueDate || ""),
    manuallyEdited: linkedWork?.requestedDueDateManual === true || input.requestedDueDateManual === true,
  });
  const clientName = requiredText(linkedWork?.clientName || input.clientName, "o cliente", 180);
  const work = linkedWork ? {
    workNumber: requiredText(linkedWork.workNumber, "o número da obra", 80).toLocaleUpperCase(),
    name: requiredText(linkedWork.name, "o nome da obra", 180),
    responsibleName: String(linkedWork.responsibleName || "").trim(),
    address: String(linkedWork.address || "").trim(),
    clientName,
    startDate,
    requestedDueDate,
  } : null;

  const { data, error } = await registrationRepository.createOrderHeader(db, organizationId, {
    orderId,
    clientName,
    startDate,
    requestedDueDate,
    observations: String(input.orderObservations || "").trim(),
    work,
  });
  if (error) throwDatabaseError(error, "Não foi possível salvar o pedido inicial.");
  return { order: data };
}

function catalogMeasure(value) {
  const text = String(value ?? "").trim().replace(",", ".");
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
  const arm = text.match(/^(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)$/i);
  return arm ? [Number(arm[1]), Number(arm[2])] : null;
}

export function resolveCatalogMolds(pieceKind, x, z, catalog) {
  if (pieceKind === "placa") return [];
  if (pieceKind === "braco") {
    const row = catalog.find((entry) => {
      if (entry.mold_type !== "BRACO") return false;
      const measure = catalogMeasure(entry.measure_label);
      return Array.isArray(measure) && measure[0] === x && measure[1] === z;
    });
    return row ? [{ role: "braco", catalogCode: row.code }] : null;
  }
  const bed = catalog.find((entry) => entry.mold_type === "LEITO" && catalogMeasure(entry.measure_label) === x);
  const side = catalog.find((entry) => entry.mold_type === "LATERAL" && catalogMeasure(entry.measure_label) === z);
  return bed && side
    ? [{ role: "leito", catalogCode: bed.code }, { role: "lateral", catalogCode: side.code }]
    : null;
}

/** Cria a peça e seu item sob o pedido existente; a fila associa os moldes à posição livre. */
export async function addOrderPieceItem(db, organizationId, input) {
  const orderId = requiredText(input.orderId, "o pedido", 80);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(orderId)) {
    invalid("O identificador do pedido é inválido.", 400);
  }
  const pieceKind = String(input.pieceKind || "");
  if (!["braco", "pilar", "viga", "placa"].includes(pieceKind)) invalid("Selecione braço, pilar, viga ou placa.", 400);
  const pieceId = crypto.randomUUID();
  const itemId = crypto.randomUUID();
  const quantity = positiveInteger(input.quantity, "A quantidade");
  const dimensions = {
    x: positiveDecimal(input.dimensionXcm, pieceKind === "placa" ? "Largura X" : "Dimensão X"),
    y: positiveDecimal(input.dimensionYcm, pieceKind === "placa" ? "Altura Y" : "Comprimento Y"),
    z: positiveDecimal(input.dimensionZcm, pieceKind === "placa" ? "Espessura Z" : "Dimensão Z"),
  };
  const metrics = calculatePieceMetrics(dimensions);
  const piece = {
    id: pieceId,
    organization_id: organizationId,
    code: requiredText(input.pieceCode, "o código da peça", 60).toLocaleUpperCase(),
    name: requiredText(input.pieceName, "o nome da peça", 180),
    piece_kind: pieceKind,
    production_minutes_per_unit: 0,
  };

  const { data: order, error: orderError } = await registrationRepository.getOrder(db, organizationId, orderId);
  if (orderError) throwDatabaseError(orderError, "Não foi possível localizar o pedido.");
  if (!order || order.is_active !== true) invalid("Pedido não encontrado ou inativo.", 404);
  if (["cancelado", "entregue", "concluido"].includes(order.status)) invalid("Não é possível incluir itens em um pedido encerrado.", 409);

  const { data: project, error: projectError } = await db.from("engineering_projects")
    .select("id").eq("organization_id", organizationId).eq("order_id", orderId).maybeSingle();
  if (projectError) throwDatabaseError(projectError, "Não foi possível verificar a etapa de engenharia do pedido.");
  if (project) invalid("Este pedido já avançou para Engenharia. Inclua os itens antes de criar o projeto.", 409);

  const { data: sequenceRow, error: sequenceError } = await registrationRepository.getNextItemSequence(db, organizationId, orderId);
  if (sequenceError) throwDatabaseError(sequenceError, "Não foi possível definir a sequência do item.");
  const sequence = Number(sequenceRow?.sequence || 0) + 1;

  const castingMinutes = await castingMinutesForLegacyFields(db, organizationId);
  piece.production_minutes_per_unit = castingMinutes;

  const catalogTypes = pieceKind === "placa" ? [] : pieceKind === "braco" ? ["BRACO"] : ["LEITO", "LATERAL"];
  const catalogResult = catalogTypes.length
    ? await registrationRepository.getMoldCatalogByTypes(db, catalogTypes)
    : { data: [], error: null };
  if (catalogResult.error) throwDatabaseError(catalogResult.error, "Não foi possível consultar o catálogo de formas.");
  const molds = resolveCatalogMolds(pieceKind, dimensions.x, dimensions.z, catalogResult.data || []);
  if (!molds) {
    invalid(pieceKind === "braco"
      ? "Não existe forma fixa de braço com as medidas X × Z informadas no catálogo."
      : "Não existe a combinação cadastrada de LEITO X e LATERAL Z para essas medidas.", 422);
  }

  // Orçamentos podem ser simulados no Planejamento, mas não gravam alocações.
  // Somente pedidos aprovados entram na fila que confirma posições.
  const isBudget = order.status === "orcamento";

  const registration = {
    orderId,
    itemId,
    pieceId,
    sequence,
    item: { quantity, observations: String(input.itemObservations || "").trim() },
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
      observations: String(input.pieceObservations || "").trim(),
      productionMinutesPerUnit: castingMinutes,
      moldCatalogs: Object.fromEntries(molds.map((mold) => [mold.role, mold.catalogCode])),
    },
    // A gravação do item não envia horários antigos. O motor da Etapa 5
    // refaz a fila a partir dos dados persistidos depois que a RPC retorna.
    plans: [],
    planningCalendarDays: [],
  };
  const { data, error } = await registrationRepository.addOrderPieceItem(db, organizationId, registration);
  if (error) throwDatabaseError(error, "Não foi possível salvar o item, a peça e o planejamento.");

  let scenario = null;
  let result = null;
  let planningError = null;
  if (!isBudget) {
    try {
      ({ scenario, result } = await reconcileFactoryPlan({ db, organizationId }));
    } catch (error) {
      planningError = error;
    }
  }
  const targetPlan = scenario?.orders?.find((entry) => entry.orderId === orderId) || null;
  const plannedUnitCount = Number(targetPlan?.totalPlannedQuantity || 0);
  const requestedUnitCount = Number(targetPlan?.totalRequestedQuantity || quantity);
  const waitingForPosition = !isBudget && plannedUnitCount < requestedUnitCount;
  const warning = isBudget
    ? "Orçamento salvo sem reserva; simule-o no Planejamento."
    : planningError
      ? "O item foi salvo, mas a fila não pôde ser atualizada. Recarregue o Planejamento."
      : waitingForPosition ? "O item foi salvo e parte da quantidade aguarda posição livre." : null;

  return {
    registration: data,
    planning: {
      committed: !isBudget && !planningError,
      simulatedOnly: isBudget,
      waitingForPosition,
      feasible: Boolean(targetPlan?.feasible),
      plannedUnitCount,
      positionCodes: [...new Set((targetPlan?.units || []).map((unit) => unit.positionCode))],
      reservedUnitCount: result?.scheduledUnitCount || 0,
      warning,
    },
  };
}
