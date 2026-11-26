/*
 * Caso de uso de cadastro integrado: obra + pedido + item + tipo de peca.
 * A Edge Function valida a chamada HTTP; este servico aplica as regras,
 * consulta o dominio de planejamento e delega a gravacao atomica a uma RPC.
 */
import { simulateAndPersistFactoryDeadlines } from "./factory-plan-service.js";
import { calculatePieceMetrics } from "./piece-metrics.js";
import { getCurrentEngineeringParameters } from "./engineering-service.js";
import { registrationRepository } from "./registration-repository.js";
import { nextRegistrationCode } from "./registration-codes.js";

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

/** Mantém compatibilidade com clientes antigos usando o fluxo em duas etapas. */
export async function createOrderPieceRegistration(db, organizationId, input) {
  const sourceWork = input.work && typeof input.work === "object" ? input.work : null;
  const startDate = isoDate(sourceWork?.startDate || input.startDate);
  const work = sourceWork || (input.workNumber ? {
    workNumber: input.workNumber,
    name: input.workName,
    responsibleName: input.responsibleName,
    address: input.address,
    clientName: input.clientName,
    startDate,
  } : null);
  const { order } = await createOrderHeader(db, organizationId, {
    clientName: work?.clientName || input.clientName,
    startDate,
    requestedDueDate: null,
    orderObservations: input.orderObservations,
    work: work ? { ...work, startDate, requestedDueDate: null } : null,
  });
  const orderId = order?.orderId || order?.id;
  if (!orderId) invalid("Não foi possível obter o identificador do pedido criado.", 500);

  const item = await addOrderPieceItem(db, organizationId, {
    orderId,
    pieceCode: input.pieceCode,
    pieceName: input.pieceName,
    pieceKind: input.pieceKind,
    quantity: input.quantity,
    dimensionXcm: input.dimensionXcm,
    dimensionYcm: input.dimensionYcm,
    dimensionZcm: input.dimensionZcm,
    pieceObservations: input.pieceObservations,
    itemObservations: input.itemObservations,
  });
  return { order, ...item };
}

/** Salva primeiro o cabeçalho do pedido; a obra é opcional e pode ser criada ou atualizada. */
export async function createOrderHeader(db, organizationId, input) {
  const orderId = crypto.randomUUID();
  let linkedWork = input.work && typeof input.work === "object" ? input.work : null;
  if (input.workId) {
    const { data: existingWork, error: workError } = await db.from("works")
      .select("id, work_number, name, client_id, address, responsible_name, start_date")
      .eq("organization_id", organizationId).eq("id", input.workId).eq("is_active", true).maybeSingle();
    if (workError) throwDatabaseError(workError, "Não foi possível consultar a obra selecionada.");
    if (!existingWork?.work_number || !existingWork.start_date) invalid("A obra selecionada precisa ter número e data de início.", 422);
    const { data: existingClient, error: clientError } = await db.from("clients")
      .select("name").eq("organization_id", organizationId).eq("id", existingWork.client_id).maybeSingle();
    if (clientError) throwDatabaseError(clientError, "Não foi possível consultar o cliente da obra.");
    if (!existingClient?.name) invalid("A obra selecionada não tem cliente válido.", 422);
    linkedWork = {
      workNumber: existingWork.work_number,
      name: existingWork.name,
      responsibleName: existingWork.responsible_name,
      address: existingWork.address,
      clientName: existingClient.name,
      startDate: existingWork.start_date,
    };
  }
  const startDate = isoDate(linkedWork?.startDate || input.startDate);
  // A data só pode ser calculada depois que as quantidades entrarem no pedido.
  const requestedDueDate = null;
  const clientName = requiredText(linkedWork?.clientName || input.clientName, "o cliente", 180);
  const work = linkedWork ? {
    // A seleção existente usa seu número estável; uma obra nova recebe o próximo no banco.
    workNumber: input.workId ? linkedWork.workNumber : await nextRegistrationCode(db, "work"),
    name: requiredText(linkedWork.name, "o nome da obra", 180),
    responsibleName: String(linkedWork.responsibleName || "").trim(),
    address: String(linkedWork.address || "").trim(),
    clientName,
    startDate,
    requestedDueDate,
  } : null;

  // Uma mudança de início pode tornar previsões antigas anteriores ao início.
  // Libere apenas essas datas antes da trigger de herança; se o cabeçalho falhar,
  // restaure os valores anteriores.
  let staleOrderDeadlines = [];
  if (work) {
    const escapedWorkNumber = work.workNumber.replace(/[\\%_]/g, "\\$&");
    const matchingWorks = await db.from("works").select("id, work_number, start_date")
      .eq("organization_id", organizationId).ilike("work_number", escapedWorkNumber).limit(20);
    if (matchingWorks.error) throwDatabaseError(matchingWorks.error, "Não foi possível verificar a obra antes de atualizar seu início.");
    const existingWork = (matchingWorks.data || []).find((row) =>
      String(row.work_number || "").trim().toLocaleUpperCase() === work.workNumber.toLocaleUpperCase()
    );
    if (existingWork && existingWork.start_date !== startDate) {
      const staleResult = await db.from("orders").select("id, requested_due_date")
        .eq("organization_id", organizationId).eq("work_id", existingWork.id)
        .lt("requested_due_date", startDate);
      if (staleResult.error) throwDatabaseError(staleResult.error, "Não foi possível consultar os prazos existentes da obra.");
      staleOrderDeadlines = (staleResult.data || []).filter((row) => row.requested_due_date);
      if (staleOrderDeadlines.length) {
        const clearResult = await db.from("orders").update({ requested_due_date: null })
          .eq("organization_id", organizationId).in("id", staleOrderDeadlines.map((row) => row.id));
        if (clearResult.error) throwDatabaseError(clearResult.error, "Não foi possível atualizar os prazos antigos da obra.");
      }
    }
  }

  const { data, error } = await registrationRepository.createOrderHeader(db, organizationId, {
    orderId,
    clientName,
    startDate,
    requestedDueDate,
    observations: String(input.orderObservations || "").trim(),
    work,
  });
  if (error) {
    if (staleOrderDeadlines.length) {
      await Promise.all(staleOrderDeadlines.map((row) => db.from("orders")
        .update({ requested_due_date: row.requested_due_date })
        .eq("organization_id", organizationId).eq("id", row.id)));
    }
    throwDatabaseError(error, "Não foi possível salvar o pedido inicial.");
  }
  return { order: { ...data, workNumber: work?.workNumber || null } };
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
  const { parameters: engineeringParameters } = await getCurrentEngineeringParameters(db, organizationId);
  const metrics = calculatePieceMetrics({
    ...dimensions,
    concreteDensityKgM3: engineeringParameters.concreteDensityKgM3,
  });
  const piece = {
    id: pieceId,
    organization_id: organizationId,
    code: "", // Recebe o sequencial depois da validação das medidas e formas.
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

  piece.code = await nextRegistrationCode(db, "piece");

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
  let estimatedDueDates = {};
  try {
    ({ scenario, result, estimatedDueDates } = await simulateAndPersistFactoryDeadlines({
      db,
      organizationId,
      orderIds: isBudget ? [orderId] : [],
    }));
  } catch (error) {
    planningError = error;
  }
  const targetPlan = scenario?.orders?.find((entry) => entry.orderId === orderId) || null;
  const plannedUnitCount = Number(targetPlan?.totalPlannedQuantity || 0);
  const requestedUnitCount = Number(targetPlan?.totalRequestedQuantity || quantity);
  const waitingForPosition = Boolean(targetPlan) && plannedUnitCount < requestedUnitCount;
  const estimatedDueDate = estimatedDueDates[orderId] || null;
  const warning = planningError
    ? "O item foi salvo, mas o prazo não pôde ser calculado. Atualize o Planejamento."
    : waitingForPosition
      ? `${requestedUnitCount - plannedUnitCount} unidade(s) aguardam posição ou capacidade; o prazo será calculado quando todas puderem ser programadas.`
      : isBudget
        ? "Orçamento salvo sem reserva; o prazo é uma estimativa e poderá mudar quando a fila for aprovada."
        : null;

  return {
    registration: data,
    pieceCode: piece.code,
    planning: {
      committed: !isBudget && !planningError,
      simulatedOnly: isBudget,
      waitingForPosition,
      feasible: Boolean(targetPlan?.feasible),
      plannedUnitCount,
      requestedUnitCount,
      estimatedDueDate,
      totalProductionMinutes: Number(targetPlan?.totalProductionMinutes || 0),
      positionCodes: [...new Set((targetPlan?.units || []).map((unit) => unit.positionCode))],
      reservedUnitCount: result?.scheduledUnitCount || 0,
      warning,
    },
  };
}
