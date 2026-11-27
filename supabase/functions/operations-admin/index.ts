/*
 * Endpoint das telas de Cadastros.
 * Valida formulários, calcula métricas das peças e delega persistência ao
 * PostgreSQL/Supabase. Regras de planejamento reutilizadas ficam em _shared.
 */
import { getServerConfig } from "../_shared/env.js";
import { ensurePost, handleError, json, readJson } from "../_shared/http.js";
import { findWorkingDayCompletionDate } from "../_shared/order-planning.js";
import { simulateAndPersistFactoryDeadlines } from "../_shared/factory-plan-service.js";
import { calculatePieceMetrics } from "../_shared/piece-metrics.js";
import { calculatePlateMetrics } from "../_shared/plate-metrics.js";
import { getCurrentEngineeringParameters } from "../_shared/engineering-service.js";
import { addOrderPieceItem, createOrderHeader, createOrderPieceRegistration } from "../_shared/registration-service.js";
import { nextRegistrationCode } from "../_shared/registration-codes.js";
import { createAdminClient } from "../_shared/supabaseClient.js";

const WORK_STATUSES = new Set(["planejamento", "ativa", "concluida", "cancelada"]);
const ORDER_STATUSES = new Set(["orcamento", "aprovado", "em_producao", "concluido", "entregue", "atrasado", "cancelado"]);
const MOLD_STATUSES = new Set(["ativo", "manutencao", "bloqueado", "retirado"]);
const POSITION_STATUSES = new Set(["disponivel", "em_preparacao", "em_producao", "em_manutencao"]);
const PREPARATION_STATUSES = new Set(["planejada", "em_andamento", "aguardando_aprovacao", "aprovada", "reprovada", "cancelada"]);
const ALLOCATION_STATUSES = new Set(["planned", "in_progress", "done", "cancelled"]);
const DELETE_KINDS = new Set(["order", "piece_type", "mold"]);

// Edições conservam o número original; somente cadastros novos consomem sequência.
async function stableRegistrationCode(db: any, organizationId: string, table: "works" | "piece_types", id: string | null) {
  if (!id) return nextRegistrationCode(db, table === "works" ? "work" : "piece");
  const column = table === "works" ? "work_number" : "code";
  const { data, error } = await db.from(table).select(column)
    .eq("organization_id", organizationId).eq("id", id).maybeSingle();
  if (error) throwDbError(error, "Não foi possível consultar o número atual do cadastro.");
  if (!data?.[column]) throw badRequest("Cadastro não encontrado ou sem número.", 404);
  return data[column] as string;
}

function badRequest(message: string, status = 400) {
  return Object.assign(new Error(message), { status });
}

function textValue(value: unknown, label: string, maxLength = 500, required = false) {
  const result = String(value ?? "").trim();
  if (required && !result) throw badRequest(`Informe ${label}.`);
  if (result.length > maxLength) throw badRequest(`${label} deve ter no máximo ${maxLength} caracteres.`);
  return result;
}

function dateValue(value: unknown, label: string, optional = false): string | null {
  const result = String(value ?? "").trim();
  if (!result && optional) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) throw badRequest(`Informe uma ${label} válida.`);
  const parsed = new Date(`${result}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) {
    throw badRequest(`Informe uma ${label} válida.`);
  }
  return result;
}

function integerValue(value: unknown, label: string, minimum: number, optional = false) {
  const raw = String(value ?? "").trim();
  if (!raw && optional) return null;
  const number = Number(raw);
  if (!Number.isInteger(number) || number < minimum) {
    throw badRequest(`${label} deve ser um número inteiro maior ou igual a ${minimum}.`);
  }
  return number;
}

function decimalValue(value: unknown, label: string, optional = false) {
  const raw = String(value ?? "").trim();
  if (!raw && optional) return null;
  const number = Number(raw);
  if (!Number.isFinite(number) || number < 0) throw badRequest(`${label} deve ser um número maior ou igual a zero.`);
  return number;
}

function addDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function enumValue(value: unknown, values: Set<string>, fallback: string, label: string) {
  const result = String(value || fallback);
  if (!values.has(result)) throw badRequest(`${label} inválido.`);
  return result;
}

function throwDbError(error: any, label: string): never {
  if (!error) throw new Error(label);
  const message = String(error.message || label);
  const code = String(error.code || "");
  const isConflict = code === "23505" || /ocupado|sobreposi[cç][aã]o|conflito|já existe|outra prepara[cç][aã]o/i.test(message);
  const status = isConflict ? 409 : code === "P0001" || code.startsWith("23") || code.startsWith("22") ? 422 : 500;
  const safeMessage = status === 500
    ? label
    : code === "23505"
      ? "Já existe um cadastro com o mesmo código ou número nesta unidade."
      : message;
  throw Object.assign(new Error(safeMessage), { status });
}

/** Preenche o campo legado de minutos com a etapa de concretagem já configurada. */
async function castingMinutesForLegacyFields(db: ReturnType<typeof createAdminClient>, organizationId: string) {
  const { data, error } = await db.from("calculation_constants")
    .select("numeric_value, unit")
    .eq("organization_id", organizationId)
    .eq("constant_key", "casting_duration_minutes")
    .maybeSingle();
  if (error) throwDbError(error, "Não foi possível consultar a duração da concretagem.");
  const minutes = Number(data?.numeric_value);
  if (data?.unit !== "min" || !Number.isInteger(minutes) || minutes <= 0) {
    throw badRequest("Configure a duração da concretagem em minutos antes de cadastrar peças.", 409);
  }
  return minutes;
}

async function resolveClientId(db: any, organizationId: string, input: Record<string, unknown>) {
  const clientId = String(input.clientId || "").trim();
  if (clientId) return clientId;
  const name = textValue(input.clientName, "o cliente", 180, true);
  const { data: current, error: readError } = await db.from("clients")
    .select("id").eq("organization_id", organizationId).eq("name", name).eq("is_active", true)
    .limit(1).maybeSingle();
  if (readError) throwDbError(readError, "Não foi possível consultar o cliente.");
  if (current?.id) return current.id;
  const { data, error } = await db.from("clients")
    .insert({ organization_id: organizationId, name })
    .select("id").single();
  if (error) throwDbError(error, "Não foi possível cadastrar o cliente.");
  return data.id;
}

function buildMoldCombinations(catalog: any[]) {
  const arms = catalog.filter((item) => item.mold_type === "BRACO");
  const beds = catalog.filter((item) => item.mold_type === "LEITO");
  const sides = catalog.filter((item) => item.mold_type === "LATERAL");
  return [
    ...arms.map((arm) => ({
      key: arm.code,
      piece_kind: "braco",
      configuration_kind: "braco",
      braco_catalog_code: arm.code,
      leito_catalog_code: null,
      lateral_catalog_code: null,
      label: `BRAÇO ${arm.measure_label} cm`,
    })),
    ...["pilar", "viga"].flatMap((pieceKind) => beds.flatMap((bed) => sides.map((side) => ({
      key: `${bed.code}|${side.code}`,
      piece_kind: pieceKind,
      configuration_kind: "pilar_viga",
      braco_catalog_code: null,
      leito_catalog_code: bed.code,
      lateral_catalog_code: side.code,
      label: `LEITO ${bed.measure_label} cm × LATERAL ${side.measure_label} cm`,
    })))),
  ];
}

async function readOperationsData(db: any, organizationId: string) {
  const [clientsResult, worksResult, ordersResult, piecesResult, moldsResult, compatResult, preparationsResult, allocationsResult, catalogResult, pieceMoldsResult, positionsResult] = await Promise.all([
    db.from("clients").select("id, name, document, contact_name, phone, email, address, is_active")
      .eq("organization_id", organizationId).eq("is_active", true).order("name").limit(1000),
    db.from("works").select("id, work_number, name, client_id, address, responsible_name, start_date, requested_due_date, status, observations, is_active, created_at, updated_at")
      .eq("organization_id", organizationId).eq("is_active", true).order("name").limit(1000),
    db.from("orders").select("id, order_number, work_id, client_id, start_date, requested_due_date, planned_end_date, status, observations, is_active, created_at, updated_at")
      .eq("organization_id", organizationId).eq("is_active", true).order("start_date", { ascending: false }).limit(1000),
    db.from("piece_types").select("id, category_id, code, name, piece_kind, dimension_x_cm, dimension_y_cm, dimension_z_cm, dimensions, volume_cm3, weight_kg, volume_m3, production_minutes_per_unit, initial_stock_quantity, stock_minimum_quantity, observations, custom_fields, is_active")
      .eq("organization_id", organizationId).order("code").limit(1000),
    db.from("molds").select("id, code, name, mold_type, dimensions, catalog_code, cycle_minutes_per_unit, preparation_days, status, observations, created_at, updated_at")
      .eq("organization_id", organizationId).order("code").limit(1000),
    db.from("mold_piece_types").select("mold_id, piece_type_id")
      .eq("organization_id", organizationId).limit(5000),
    db.from("mold_preparations").select("id, mold_id, start_date, end_date, status, checklist, approved_by, approved_at, observations, created_at, updated_at")
      .eq("organization_id", organizationId).order("start_date", { ascending: false }).limit(1000),
    db.from("resource_allocations").select("id, resource_kind, mold_id, resource_name, order_item_id, start_date, end_date, status, conflict_reason, conflict_responsible, observations, created_at, updated_at")
      .eq("organization_id", organizationId).order("start_date", { ascending: false }).limit(2000),
    db.from("mold_catalog").select("code, mold_type, measure_label, sort_order").order("sort_order"),
    db.from("piece_type_molds").select("piece_type_id, role, catalog_code")
      .eq("organization_id", organizationId).limit(5000),
    db.from("mold_positions").select("id, code, status, notes, configuration_kind, braco_catalog_code, leito_catalog_code, lateral_catalog_code")
      .eq("organization_id", organizationId).order("code").limit(4),
  ]);
  const results = [clientsResult, worksResult, ordersResult, piecesResult, moldsResult, compatResult, preparationsResult, allocationsResult, catalogResult, pieceMoldsResult, positionsResult];
  const labels = ["clientes", "obras", "pedidos", "tipos de peça", "moldes", "compatibilidades", "preparações", "alocações", "catálogo fixo de moldes", "moldes das peças", "posições de molde"];
  results.forEach((result, index) => { if (result.error) throwDbError(result.error, `Não foi possível carregar ${labels[index]}.`); });
  const installedFormsResult = await db.rpc("factory_installed_form_by_position", { p_org_id: organizationId });
  if (installedFormsResult.error) throwDbError(installedFormsResult.error, "Não foi possível carregar as formas montadas.");
  const installedFormsByPosition = new Map((installedFormsResult.data || []).map((form: any) => [
    form.mold_position_id, form.mold_catalog_codes || [],
  ]));
  const combinationsResult = await db.from("piece_mold_combinations")
    .select("piece_kind, configuration_kind, option_key, braco_catalog_code, leito_catalog_code, lateral_catalog_code, label, sort_order")
    .order("piece_kind").order("sort_order");
  const moldCombinations = combinationsResult.error
    ? buildMoldCombinations(catalogResult.data || [])
    : combinationsResult.data || [];

  const orderIds = (ordersResult.data || []).map((order: any) => order.id);
  const itemsResult = orderIds.length
    ? await db.from("order_items").select("id, order_id, piece_type_id, quantity, production_minutes_snapshot, sequence, observations")
      .eq("organization_id", organizationId).in("order_id", orderIds).order("sequence")
    : { data: [], error: null };
  if (itemsResult.error) throwDbError(itemsResult.error, "Não foi possível carregar os itens dos pedidos.");

  // Consultas opcionais da Etapa 5. Um banco sem a migration 009 continua
  // servindo as telas legadas, mas a resposta informa que o novo fluxo não está ativo.
  const [projectsResult, sectionsResult, sectionItemsResult, stepsResult, constantsResult, productionOrdersResult, labelsResult] = await Promise.all([
    db.from("engineering_projects").select("id, order_id, created_at, updated_at")
      .eq("organization_id", organizationId).limit(1000),
    db.from("project_sections").select("id, project_id, section_name, sort_order, created_at, updated_at")
      .eq("organization_id", organizationId).order("sort_order").limit(5000),
    db.from("project_section_items").select("id, section_id, order_item_id, quantity")
      .eq("organization_id", organizationId).limit(10000),
    db.from("production_order_steps").select("id, production_order_id, step_kind, sequence, duration_minutes, planned_start_at, planned_end_at, actual_start_at, actual_end_at, status, notes")
      .eq("organization_id", organizationId).order("planned_start_at").limit(10000),
    db.from("calculation_constants").select("constant_key, numeric_value, unit")
      .eq("organization_id", organizationId).order("constant_key"),
    db.from("production_orders").select("id, order_id, order_item_id, unit_sequence, status")
      .eq("organization_id", organizationId).limit(20000),
    db.from("production_labels").select("production_order_id, order_id, label_code, order_number, piece_code, piece_name, client_name, observations, version_number, generated_at")
      .eq("organization_id", organizationId).order("generated_at", { ascending: false }).limit(20000),
  ]);
  const fabio2Results = [projectsResult, sectionsResult, sectionItemsResult, stepsResult, constantsResult, productionOrdersResult];
  const fabio2Available = fabio2Results.every((result) => !result.error);
  if (labelsResult.error) throwDbError(labelsResult.error, "Não foi possível carregar as etiquetas dos pedidos.");

  const clients = clientsResult.data || [];
  const works = worksResult.data || [];
  const pieces = piecesResult.data || [];
  const activePieces = pieces.filter((piece: any) => piece.is_active);
  const molds = moldsResult.data || [];
  const clientById = new Map(clients.map((client: any) => [client.id, client.name]));
  const workById = new Map(works.map((work: any) => [work.id, work.name]));
  const pieceById = new Map(pieces.map((piece: any) => [piece.id, piece]));
  const allocatedItemIds = new Set((allocationsResult.data || []).map((allocation: any) => allocation.order_item_id));
  const unitsByItem = new Map<string, number>();
  for (const unit of productionOrdersResult.data || []) {
    if (unit.status === "cancelled") continue;
    unitsByItem.set(unit.order_item_id, (unitsByItem.get(unit.order_item_id) || 0) + 1);
  }
  const itemsByOrder = new Map<string, any[]>();
  for (const item of itemsResult.data || []) {
    const list = itemsByOrder.get(item.order_id) || [];
    const piece: any = pieceById.get(item.piece_type_id);
    list.push({ ...item, piece_code: piece?.code || "", piece_name: piece?.name || "" });
    itemsByOrder.set(item.order_id, list);
  }
  const orderItemById = new Map((itemsResult.data || []).map((item: any) => [item.id, item]));
  const productionStepsByUnit = new Map<string, any[]>();
  for (const step of stepsResult.data || []) {
    const list = productionStepsByUnit.get(step.production_order_id) || [];
    list.push(step);
    productionStepsByUnit.set(step.production_order_id, list);
  }
  const sectionsByProject = new Map<string, any[]>();
  for (const section of sectionsResult.data || []) {
    const rows = sectionsByProject.get(section.project_id) || [];
    rows.push(section);
    sectionsByProject.set(section.project_id, rows);
  }
  const projectItemsBySection = new Map<string, any[]>();
  for (const item of sectionItemsResult.data || []) {
    const rows = projectItemsBySection.get(item.section_id) || [];
    rows.push({ ...item, order_item: orderItemById.get(item.order_item_id) || null });
    projectItemsBySection.set(item.section_id, rows);
  }
  const moldIdsByPiece = new Map<string, string[]>();
  const pieceIdsByMold = new Map<string, string[]>();
  for (const pair of compatResult.data || []) {
    moldIdsByPiece.set(pair.piece_type_id, [...(moldIdsByPiece.get(pair.piece_type_id) || []), pair.mold_id]);
    pieceIdsByMold.set(pair.mold_id, [...(pieceIdsByMold.get(pair.mold_id) || []), pair.piece_type_id]);
  }
  const catalogByCode = new Map((catalogResult.data || []).map((row: any) => [row.code, row]));
  const moldCatalogsByPiece = new Map<string, Record<string, string>>();
  for (const requirement of pieceMoldsResult.data || []) {
    const moldsForPiece = moldCatalogsByPiece.get(requirement.piece_type_id) || {};
    moldsForPiece[requirement.role] = requirement.catalog_code;
    moldCatalogsByPiece.set(requirement.piece_type_id, moldsForPiece);
  }
  const projects = fabio2Available
    ? (projectsResult.data || []).map((project: any) => ({
      ...project,
      sections: (sectionsByProject.get(project.id) || []).map((section: any) => ({
        ...section,
        items: projectItemsBySection.get(section.id) || [],
      })),
    }))
    : [];
  return {
    schemaVersion: fabio2Available ? 5 : 4,
    fabio2Available,
    fabio2UnavailableReason: fabio2Available ? null : "A migration 009 não está instalada ou suas tabelas não estão disponíveis.",
    clients,
    works: works.map((work: any) => ({ ...work, client_name: clientById.get(work.client_id) || "" })),
    orders: (ordersResult.data || []).map((order: any) => ({
      ...order,
      client_name: clientById.get(order.client_id) || "",
      work_name: workById.get(order.work_id) || "",
      items: itemsByOrder.get(order.id) || [],
      hasResourceAllocation: (itemsByOrder.get(order.id) || []).some((item) => allocatedItemIds.has(item.id)),
      waitingForPosition: !["cancelado", "entregue", "concluido"].includes(order.status) && (itemsByOrder.get(order.id) || []).some((item) =>
        (unitsByItem.get(item.id) || 0) < Number(item.quantity)
      ),
    })),
    pieceTypes: activePieces.map((piece: any) => ({
      ...piece,
      mold_ids: moldIdsByPiece.get(piece.id) || [],
      mold_catalogs: moldCatalogsByPiece.get(piece.id) || {},
    })),
    molds: molds.map((mold: any) => ({
      ...mold,
      catalog_label: catalogByCode.has(mold.catalog_code)
        ? `${catalogByCode.get(mold.catalog_code).mold_type} ${catalogByCode.get(mold.catalog_code).measure_label} cm`
        : null,
      piece_type_ids: pieceIdsByMold.get(mold.id) || [],
    })),
    moldCatalog: catalogResult.data || [],
    moldCombinations,
    positions: (positionsResult.data || []).map((position: any) => ({
      ...position,
      installed_mold_catalog_codes: installedFormsByPosition.get(position.id) || [],
    })),
    preparations: preparationsResult.data || [],
    allocations: allocationsResult.data || [],
    engineeringProjects: projects,
    productionOrderSteps: fabio2Available ? stepsResult.data || [] : [],
    productionUnits: fabio2Available ? (productionOrdersResult.data || []).map((unit: any) => {
      const item: any = orderItemById.get(unit.order_item_id);
      const piece: any = pieceById.get(item?.piece_type_id);
      return { ...unit, piece_code: piece?.code || "", piece_name: piece?.name || "",
        steps: (productionStepsByUnit.get(unit.id) || []).sort((a, b) => a.sequence - b.sequence) };
    }) : [],
    productionLabels: labelsResult.data || [],
    calculationConstants: fabio2Available ? constantsResult.data || [] : [],
  };
}

async function replanOpenQueue(
  db: any,
  organizationId: string,
  quoteOrderIds: string[] = [],
  targetOrderId: string | null = null,
  affectedWorkIds: string[] = [],
) {
  const { scenario, result, estimatedDueDates } = await simulateAndPersistFactoryDeadlines({
    db,
    organizationId,
    orderIds: quoteOrderIds,
    affectedOrderIds: targetOrderId ? [targetOrderId] : [],
    affectedWorkIds,
  });
  const waitingOrders = (scenario.orders || []).filter((order: any) =>
    order.totalPlannedQuantity < order.totalRequestedQuantity
  );
  const warnings = waitingOrders.map((order: any) =>
    `${order.orderNumber || "Pedido"}: ${order.totalRequestedQuantity - order.totalPlannedQuantity} unidade(s) aguardam posição.`
  );
  return {
    committed: true,
    plannedOrderCount: scenario.orderCount,
    plannedUnitCount: result?.scheduledUnitCount || 0,
    waitingUnitCount: result?.waitingUnitCount || 0,
    estimatedDueDate: targetOrderId ? estimatedDueDates[targetOrderId] || null : null,
    totalProductionMinutes: targetOrderId
      ? Number(scenario.orders.find((order: any) => order.orderId === targetOrderId)?.totalProductionMinutes || 0)
      : null,
    totalRequestedQuantity: targetOrderId
      ? Number(scenario.orders.find((order: any) => order.orderId === targetOrderId)?.totalRequestedQuantity || 0)
      : null,
    warning: warnings.length ? warnings.slice(0, 5).join(" ") : null,
  };
}

/** A alteração da forma já foi gravada; problemas no replanejamento viram aviso. */
async function replanAfterPositionChange(db: any, organizationId: string, successMessage: string) {
  try {
    return await replanOpenQueue(db, organizationId);
  } catch (planningError) {
    return {
      committed: false,
      warning: planningError instanceof Error
        ? planningError.message
        : `${successMessage}, mas o calendário não pôde ser recalculado. Atualize o planejamento.`,
    };
  }
}

function positionCodeValue(input: Record<string, unknown>) {
  const code = textValue(input.positionCode || input.code, "a posição", 3, true).toUpperCase();
  if (!/^P0[1-4]$/.test(code)) throw badRequest("Selecione uma posição de P01 a P04.");
  return code;
}

async function moldPreparationEndDate(db: any, organizationId: string, moldId: string, startDate: string) {
  const { data: mold, error } = await db.from("molds").select("preparation_days, status")
    .eq("organization_id", organizationId).eq("id", moldId).maybeSingle();
  if (error) throwDbError(error, "Não foi possível consultar a duração da preparação.");
  if (!mold || mold.status === "retirado") throw badRequest("Forma não encontrada ou retirada nesta unidade.", 404);
  const preparationDays = integerValue(mold.preparation_days, "A duração da preparação", 1);
  if (preparationDays === 7) return addDays(startDate, 6); // Compatibilidade com o fluxo anterior à migration 009.
  return await findWorkingDayCompletionDate({ db, organizationId, startDate, workingDays: preparationDays });
}

async function handler(request: Request) {
  try {
    const method = ensurePost(request);
    if (method === "options") return json({ ok: true });
    const config = getServerConfig();
    const db = createAdminClient(config);
    const input = await readJson(request);
    const action = String(input.action || "bootstrap");
    const organizationId = config.organizationId;

    if (action === "bootstrap") return json({ ok: true, ...(await readOperationsData(db, organizationId)) });

    if (action === "record_production_label_prints") {
      const idempotencyKey = textValue(input.idempotencyKey, "a chave da solicitação", 36, true);
      const actorLabel = textValue(input.printedBy, "o nome de quem está solicitando a impressão", 120, true);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
        throw badRequest("Chave da solicitação inválida.");
      }
      if (!Array.isArray(input.labels) || input.labels.length < 1 || input.labels.length > 5000) {
        throw badRequest("Informe entre 1 e 5.000 etiquetas para registrar.");
      }
      const labels = input.labels.map((row: any) => {
        const productionOrderId = textValue(row?.productionOrderId, "o identificador da unidade", 36, true);
        const versionNumber = integerValue(row?.versionNumber, "a versão da etiqueta", 1);
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(productionOrderId)) {
          throw badRequest("Identificador de unidade inválido.");
        }
        return { productionOrderId, versionNumber };
      });
      if (new Set(labels.map((row: any) => row.productionOrderId)).size !== labels.length) {
        throw badRequest("A lista contém a mesma unidade mais de uma vez.");
      }
      const { data, error } = await db.rpc("record_production_label_prints", {
        p_org_id: organizationId,
        p_labels: labels,
        p_idempotency_key: idempotencyKey,
        p_actor_label: actorLabel,
      });
      if (error) throwDbError(error, "Não foi possível registrar a solicitação de impressão.");
      return json({ ok: true, printRequest: data });
    }

    if (action === "create_order_piece_registration") {
      return json({ ok: true, ...(await createOrderPieceRegistration(db, organizationId, input)) });
    }

    if (action === "create_order_header") {
      return json({ ok: true, ...(await createOrderHeader(db, organizationId, input)) });
    }

    if (action === "add_order_piece_item") {
      return json({ ok: true, ...(await addOrderPieceItem(db, organizationId, input)) });
    }

    if (action === "save_work") {
      const clientId = await resolveClientId(db, organizationId, input);
      const workId = textValue(input.id, "o identificador", 80) || null;
      const record = {
        id: workId,
        workNumber: await stableRegistrationCode(db, organizationId, "works", workId),
        name: textValue(input.name, "o nome da obra", 180, true),
        clientId,
        address: textValue(input.address, "o endereço", 300),
        responsibleName: textValue(input.responsibleName, "o responsável", 180),
        startDate: dateValue(input.startDate, "data de início", true),
        requestedDueDate: null,
        status: enumValue(input.status, WORK_STATUSES, "planejamento", "Status da obra"),
        observations: textValue(input.observations, "as observações", 1000),
      };
      if (record.startDate && record.requestedDueDate && record.requestedDueDate < record.startDate) {
        throw badRequest("A data prevista da obra não pode ser anterior ao início.");
      }
      let previousStartDate: string | null = null;
      let previousDueDate: string | null = null;
      if (record.id) {
        const { data: previousWork, error: previousError } = await db.from("works")
          .select("start_date, requested_due_date").eq("organization_id", organizationId).eq("id", record.id).maybeSingle();
        if (previousError) throwDbError(previousError, "Não foi possível consultar a obra antes da atualização.");
        previousStartDate = previousWork?.start_date || null;
        previousDueDate = previousWork?.requested_due_date || null;
      }
      const startDateChanged = record.id !== null && previousStartDate !== record.startDate;
      // O prazo vem do planejamento. Preserve-o em alterações cadastrais simples;
      // uma mudança de início limpa a previsão antiga para que o motor a recalcule.
      record.requestedDueDate = startDateChanged ? null : previousDueDate;
      if (record.startDate && record.requestedDueDate && record.requestedDueDate < record.startDate) {
        throw badRequest("A data calculada da obra não pode ser anterior ao início.");
      }
      let staleOrderDeadlines: Array<{ id: string; requested_due_date: string }> = [];
      if (startDateChanged && record.startDate) {
        const staleOrdersResult = await db.from("orders").select("id, requested_due_date")
          .eq("organization_id", organizationId).eq("work_id", record.id)
          .lt("requested_due_date", record.startDate);
        if (staleOrdersResult.error) throwDbError(staleOrdersResult.error, "Não foi possível preparar o recálculo do prazo da obra.");
        staleOrderDeadlines = (staleOrdersResult.data || []).filter((order: any) => order.requested_due_date);
        if (staleOrderDeadlines.length) {
          const clearResult = await db.from("orders").update({ requested_due_date: null })
            .eq("organization_id", organizationId).in("id", staleOrderDeadlines.map((order) => order.id));
          if (clearResult.error) throwDbError(clearResult.error, "Não foi possível liberar as previsões antigas da obra.");
        }
      }
      const { data, error } = await db.rpc("save_work_record", { p_org_id: organizationId, p_record: record });
      if (error) {
        if (staleOrderDeadlines.length) {
          await Promise.all(staleOrderDeadlines.map((order) => db.from("orders")
            .update({ requested_due_date: order.requested_due_date })
            .eq("organization_id", organizationId).eq("id", order.id)));
        }
        throwDbError(error, "Não foi possível salvar a obra.");
      }
      let planning: Record<string, unknown> | null = null;
      if (record.id && previousStartDate !== (data?.start_date || null)) {
        try {
          planning = await replanOpenQueue(db, organizationId, [], null, [record.id]);
        } catch {
          planning = { committed: false, warning: "A obra foi salva, mas o calendário não pôde ser recalculado. Atualize o planejamento." };
        }
      }
      return json({ ok: true, work: data, planning });
    }

    if (action === "save_order") {
      const workId = textValue(input.workId, "a obra", 80);
      let clientId: string;
      let inheritedStartDate: string | null = null;
      if (workId) {
        const { data: work, error } = await db.from("works").select("id, client_id, start_date")
          .eq("organization_id", organizationId).eq("id", workId).eq("is_active", true).maybeSingle();
        if (error) throwDbError(error, "Não foi possível localizar a obra.");
        if (!work) throw badRequest("Obra não encontrada ou inativa.", 404);
        if (!work.start_date) throw badRequest("Cadastre a data de início da obra antes de vincular este pedido.");
        clientId = work.client_id;
        inheritedStartDate = work.start_date;
      } else {
        clientId = await resolveClientId(db, organizationId, input);
      }
      const items = Array.isArray(input.items) ? input.items.map((item: any, index: number) => ({
        itemKey: textValue(item?.itemKey, "a chave temporária do item", 80) || `item-${index + 1}`,
        pieceTypeId: textValue(item?.pieceTypeId, "o tipo de peça", 80, true),
        quantity: integerValue(item?.quantity, "A quantidade", 1),
        observations: textValue(item?.observations, "as observações do item", 500),
      })) : [];
      if (!items.length || items.length > 100) {
        throw badRequest("Inclua de 1 a 100 itens com quantidade válida.");
      }
      const order = {
        id: textValue(input.id, "o identificador", 80) || null,
        orderNumber: textValue(input.orderNumber, "o número do pedido", 80),
        workId: workId || null,
        clientId,
        startDate: inheritedStartDate || dateValue(input.startDate, "data de início")!,
        requestedDueDate: null,
        status: enumValue(input.status, ORDER_STATUSES, "orcamento", "Status do pedido"),
        observations: textValue(input.observations, "as observações", 1000),
      };
      if (order.requestedDueDate && order.requestedDueDate < order.startDate) {
        throw badRequest("O prazo do pedido não pode ser anterior ao início.");
      }
      const previousOrderResult = order.id
        ? await db.from("orders").select("status, order_number")
          .eq("organization_id", organizationId).eq("id", order.id).maybeSingle()
        : { data: null, error: null };
      if (previousOrderResult.error) throwDbError(previousOrderResult.error, "Não foi possível conferir o status atual do pedido.");
      // O número identifica o pedido. A edição preserva o valor persistido,
      // mesmo que um cliente modificado tente enviar outro pelo formulário.
      if (order.id && previousOrderResult.data) {
        order.orderNumber = previousOrderResult.data.order_number || order.orderNumber;
      }
      if ((!previousOrderResult.data || previousOrderResult.data.status === "orcamento")
        && ["aprovado", "em_producao", "concluido", "atrasado", "entregue"].includes(order.status)) {
        throw badRequest("A aprovação deve ser feita na área Planejamento, junto com a confirmação da reserva de posições.", 409);
      }
      let data: any;
      let error: any;
      let existingProject: any = null;
      if (order.id) {
        const projectLookup = await db.from("engineering_projects").select("id")
          .eq("organization_id", organizationId).eq("order_id", order.id).maybeSingle();
        if (projectLookup.error && !["42P01", "PGRST205"].includes(projectLookup.error.code)) {
          throwDbError(projectLookup.error, "Não foi possível verificar o projeto de engenharia do pedido.");
        }
        existingProject = projectLookup.data;
      }

      if (existingProject) {
        if (!Array.isArray(input.projectSections) || input.projectSections.length < 1 || input.projectSections.length > 100) {
          throw badRequest("Este pedido já tem projeto. Edite os itens e distribua as quantidades nas seções no mesmo salvamento.");
        }
        const projectSections = input.projectSections.map((section: any, sectionIndex: number) => {
          const sectionItems = Array.isArray(section?.items) ? section.items : [];
          if (sectionItems.length < 1 || sectionItems.length > 500) {
            throw badRequest("Cada seção precisa ter pelo menos um item e pode conter até 500 itens.");
          }
          return {
            sectionName: textValue(section?.sectionName, "o nome da seção", 120, true),
            sortOrder: integerValue(section?.sortOrder ?? sectionIndex + 1, "A ordem da seção", 1),
            items: sectionItems.map((item: any) => ({
              itemKey: textValue(item?.itemKey, "a chave do item da seção", 80, true),
              quantity: integerValue(item?.quantity, "A quantidade na seção", 1),
            })),
          };
        });
        const sectionNames = projectSections.map((section: any) => section.sectionName.toLocaleLowerCase());
        if (new Set(sectionNames).size !== sectionNames.length) {
          throw badRequest("O nome de cada seção precisa ser único dentro do projeto.");
        }
        for (const section of projectSections) {
          const itemKeys = section.items.map((item: any) => item.itemKey);
          if (new Set(itemKeys).size !== itemKeys.length) {
            throw badRequest("Cada item deve aparecer uma única vez em cada seção.");
          }
        }
        const result = await db.rpc("save_order_with_project", {
          p_org_id: organizationId,
          p_order: order,
          p_items: items,
          p_sections: projectSections,
        });
        data = result.data;
        error = result.error;
      } else {
        const result = await db.rpc("save_order_with_items", {
          p_org_id: organizationId,
          p_order: order,
          p_items: items,
        });
        data = result.data;
        error = result.error;
      }
      if (error) throwDbError(error, "Não foi possível salvar o pedido.");

      // O cadastro e a simulação usam transações separadas. A confirmação da
      // fila, porém, grava as reservas e a aprovação dos orçamentos em um só commit.
      let planning: Record<string, unknown> = { committed: false };
      try {
        const savedOrderId = String(data?.id || order.id || "");
        const selectedQuoteIds = data?.status === "orcamento" && savedOrderId ? [savedOrderId] : [];
        planning = {
          ...(await replanOpenQueue(db, organizationId, selectedQuoteIds, savedOrderId || null)),
          simulatedOnly: data.status === "orcamento",
        };
      } catch (planningError) {
        const message = "O pedido foi salvo, mas a fila não pôde ser atualizada. Recarregue o Planejamento e tente novamente.";
        planning = { committed: false, warning: message };
      }
      return json({ ok: true, order: data, planning });
    }

    if (action === "save_engineering_project") {
      const orderId = textValue(input.orderId, "o pedido", 80, true);
      if (!Array.isArray(input.sections) || input.sections.length < 1 || input.sections.length > 100) {
        throw badRequest("Informe de uma a cem seções para o projeto.");
      }
      const sections = input.sections.map((section: any, sectionIndex: number) => {
        const items = Array.isArray(section?.items) ? section.items : [];
        if (items.length < 1 || items.length > 500) throw badRequest("Cada seção precisa ter de um a quinhentos itens.");
        return {
          sectionName: textValue(section?.sectionName, "o nome da seção", 120, true),
          sortOrder: integerValue(section?.sortOrder ?? sectionIndex + 1, "A ordem da seção", 1),
          items: items.map((item: any) => ({
            orderItemId: textValue(item?.orderItemId, "o item do pedido", 80, true),
            quantity: integerValue(item?.quantity, "A quantidade na seção", 1),
          })),
        };
      });
      const sectionNames = sections.map((section: any) => section.sectionName.toLocaleLowerCase());
      if (new Set(sectionNames).size !== sectionNames.length) {
        throw badRequest("O nome de cada seção precisa ser único dentro do projeto.");
      }
      const { data, error } = await db.rpc("save_engineering_project_structure", {
        p_org_id: organizationId,
        p_order_id: orderId,
        p_sections: sections,
      });
      if (error) throwDbError(error, "Não foi possível salvar o projeto de engenharia. Confirme se a migration 009 está aplicada.");
      return json({ ok: true, project: data });
    }

    if (action === "calculate_piece_metrics") {
      const dimensions = {
        x: input.x ?? input.dimensionX ?? input.dimension_x_cm,
        y: input.y ?? input.dimensionY ?? input.dimension_y_cm,
        z: input.z ?? input.dimensionZ ?? input.dimension_z_cm,
      };
      const { parameterVersion, parameters } = await getCurrentEngineeringParameters(db, organizationId);
      const metrics = input.pieceKind === "placa"
        ? calculatePlateMetrics({ ...dimensions, concreteDensityKgM3: parameters.concreteDensityKgM3 })
        : calculatePieceMetrics({ ...dimensions, concreteDensityKgM3: parameters.concreteDensityKgM3 });
      return json({ ok: true, parameterVersion, metrics });
    }

    if (action === "save_delay_adjustment") {
      const record = {
        orderId: textValue(input.orderId, "o pedido", 80, true),
        reason: textValue(input.reason, "o motivo do ajuste", 500, true),
        occurredOn: dateValue(input.occurredOn, "data do ajuste")!,
        adjustedForecastEndDate: dateValue(input.adjustedForecastEndDate, "nova data prevista")!,
        recordedBy: textValue(input.recordedBy, "o responsável", 180) || null,
      };
      const { data, error } = await db.rpc("save_delay_adjustment", {
        p_org_id: organizationId,
        p_order_id: record.orderId,
        p_reason: record.reason,
        p_occurred_on: record.occurredOn,
        p_adjusted_forecast_end: record.adjustedForecastEndDate,
        p_recorded_by: record.recordedBy,
      });
      if (error) throwDbError(error, "Não foi possível registrar o ajuste manual do prazo.");
      return json({ ok: true, adjustment: data });
    }

    if (action === "save_piece_type") {
      const pieceKind = enumValue(input.pieceKind, new Set(["braco", "pilar", "viga"]), "", "Tipo de peça");
      const dimensionXcm = decimalValue(input.dimensionXcm, "A dimensão X");
      const dimensionYcm = decimalValue(input.dimensionYcm, "A dimensão Y");
      const dimensionZcm = decimalValue(input.dimensionZcm, "A dimensão Z");
      if (dimensionXcm === null || dimensionYcm === null || dimensionZcm === null || dimensionXcm <= 0 || dimensionYcm <= 0 || dimensionZcm <= 0) {
        throw badRequest("Informe dimensões X, Y e Z maiores que zero, em centímetros.");
      }
      const { parameters } = await getCurrentEngineeringParameters(db, organizationId);
      calculatePieceMetrics({
        x: dimensionXcm,
        y: dimensionYcm,
        z: dimensionZcm,
        concreteDensityKgM3: parameters.concreteDensityKgM3,
      });
      const castingMinutes = await castingMinutesForLegacyFields(db, organizationId);
      const pieceId = textValue(input.id, "o identificador", 80) || null;
      const record = {
        id: pieceId,
        code: await stableRegistrationCode(db, organizationId, "piece_types", pieceId),
        name: textValue(input.name, "o nome da peça", 180, true),
        pieceKind,
        dimensionXcm,
        dimensionYcm,
        dimensionZcm,
        productionMinutesPerUnit: castingMinutes,
        observations: textValue(input.observations, "as observações", 1000),
      };
      const moldCatalogs = input.moldCatalogs && typeof input.moldCatalogs === "object" ? input.moldCatalogs as Record<string, unknown> : {};
      const requiredRoles = pieceKind === "braco" ? ["braco"] : ["leito", "lateral"];
      const selectedMolds: Record<string, string> = {};
      for (const role of requiredRoles) selectedMolds[role] = textValue(moldCatalogs[role], `o molde ${role.toUpperCase()}`, 40, true);
      if (pieceKind === "braco" && (moldCatalogs.leito || moldCatalogs.lateral)) throw badRequest("Braço usa somente um molde BRAÇO.");
      if (pieceKind !== "braco" && moldCatalogs.braco) throw badRequest("Pilar e Viga usam um molde LEITO e um LATERAL.");
      const { data, error } = await db.rpc("save_piece_type", { p_org_id: organizationId, p_record: record, p_mold_catalogs: selectedMolds });
      if (error) throwDbError(error, "Não foi possível salvar o tipo de peça.");
      let planning: Record<string, unknown>;
      try {
        planning = await replanOpenQueue(db, organizationId);
      } catch (planningError) {
        planning = {
          committed: false,
          warning: planningError instanceof Error
            ? planningError.message
            : "A peça foi salva, mas o calendário não pôde ser recalculado. Atualize o planejamento.",
        };
      }
      return json({ ok: true, pieceType: data, planning });
    }

    if (action === "save_plate_type") {
      const dimensionXcm = decimalValue(input.dimensionXcm, "A área X da placa");
      const dimensionYcm = decimalValue(input.dimensionYcm, "A área Y da placa");
      const dimensionZcm = decimalValue(input.dimensionZcm, "A espessura Z da placa");
      if (dimensionXcm === null || dimensionYcm === null || dimensionZcm === null || dimensionXcm <= 0 || dimensionYcm <= 0 || dimensionZcm <= 0) {
        throw badRequest("Informe X, Y e espessura Z maiores que zero, em centímetros.");
      }
      const { parameters } = await getCurrentEngineeringParameters(db, organizationId);
      calculatePlateMetrics({
        x: dimensionXcm,
        y: dimensionYcm,
        z: dimensionZcm,
        concreteDensityKgM3: parameters.concreteDensityKgM3,
      });
      const castingMinutes = await castingMinutesForLegacyFields(db, organizationId);
      const pieceId = textValue(input.id, "o identificador", 80) || null;
      const record = {
        id: pieceId,
        code: await stableRegistrationCode(db, organizationId, "piece_types", pieceId),
        name: textValue(input.name, "o nome da placa", 180, true),
        dimensionXcm,
        dimensionYcm,
        dimensionZcm,
        productionMinutesPerUnit: castingMinutes,
        observations: textValue(input.observations, "as observações", 1000),
      };
      const { data, error } = await db.rpc("save_plate_type", { p_org_id: organizationId, p_record: record });
      if (error) throwDbError(error, "Não foi possível salvar a placa. Confirme se a migration 009 está aplicada.");
      let planning: Record<string, unknown>;
      try {
        planning = await replanOpenQueue(db, organizationId);
      } catch (planningError) {
        planning = {
          committed: false,
          warning: planningError instanceof Error
            ? planningError.message
            : "A placa foi salva, mas o calendário não pôde ser recalculado. Atualize o planejamento.",
        };
      }
      return json({ ok: true, pieceType: data, planning });
    }

    if (action === "save_mold") {
      const record = {
        id: textValue(input.id, "o identificador", 80) || null,
        catalogCode: textValue(input.catalogCode, "a medida do molde", 40, true),
        cycleMinutesPerUnit: integerValue(input.cycleMinutesPerUnit, "O ciclo do molde", 1, true),
        status: enumValue(input.status, MOLD_STATUSES, "ativo", "Status do molde"),
        observations: textValue(input.observations, "as observações", 1000),
      };
      const { data, error } = await db.rpc("save_mold", { p_org_id: organizationId, p_record: record, p_piece_type_ids: [] });
      if (error) throwDbError(error, "Não foi possível salvar o molde.");
      return json({ ok: true, mold: data });
    }

    if (action === "save_position") {
      const code = textValue(input.code, "a posição", 3, true);
      const status = enumValue(input.status, POSITION_STATUSES, "disponivel", "Status da posição");
      const useKind = enumValue(input.useKind, new Set(["formas", "placa"]), "formas", "Tipo de posição");
      const notes = textValue(input.notes, "as observações", 1000);
      const { data, error } = await db.rpc("save_mold_position", {
        p_org_id: organizationId,
        p_code: code,
        p_status: status,
        // Formas de braço/pilar/viga vêm do pedido. Só a bancada plana para
        // placa continua como característica fixa da posição física.
        p_configuration_kind: useKind === "placa" ? "placa" : null,
        p_braco_catalog_code: null,
        p_leito_catalog_code: null,
        p_lateral_catalog_code: null,
        p_notes: notes || null,
      });
      if (error) throwDbError(error, "Não foi possível salvar a posição.");

      const planning = await replanAfterPositionChange(db, organizationId, "A posição foi salva");
      return json({ ok: true, position: data, planning });
    }

    if (action === "reset_position_form") {
      const code = positionCodeValue(input);
      const { data, error } = await db.rpc("reset_factory_position_form", {
        p_org_id: organizationId,
        p_code: code,
      });
      if (error) throwDbError(error, "Não foi possível desmontar a forma desta posição.");
      const planning = await replanAfterPositionChange(db, organizationId, "A forma foi desmontada");
      return json({ ok: true, position: data, planning });
    }

    if (action === "complete_production_step") {
      const stepId = textValue(input.stepId, "a etapa", 80, true);
      const { data, error } = await db.rpc("complete_production_step", {
        p_org_id: organizationId, p_step_id: stepId,
      });
      if (error) throwDbError(error, "Não foi possível concluir a etapa de produção.");
      return json({ ok: true, production: data });
    }

    if (action === "withdraw_production_unit") {
      const unitId = textValue(input.unitId, "a unidade", 80, true);
      const sectionId = textValue(input.sectionId, "a seção", 80);
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuid.test(unitId) || (sectionId && !uuid.test(sectionId))) throw badRequest("Identificador de unidade ou seção inválido.");
      const { data, error } = await db.rpc("withdraw_production_unit", {
        p_org_id: organizationId, p_unit_id: unitId, p_section_id: sectionId || null,
      });
      if (error?.code === "P0002") throw badRequest(String(error.message), 404);
      if (error) throwDbError(error, "Não foi possível apagar a unidade.");
      const planning = await replanAfterPositionChange(db, organizationId, "A unidade foi retirada do pedido");
      return json({ ok: true, withdrawal: data, planning });
    }

    if (action === "calculate_preparation_end") {
      const moldId = textValue(input.moldId, "a forma", 80, true);
      const startDate = dateValue(input.startDate, "início da preparação")!;
      const endDate = await moldPreparationEndDate(db, organizationId, moldId, startDate);
      return json({ ok: true, endDate });
    }

    if (action === "save_preparation") {
      const moldId = textValue(input.moldId, "o molde", 80, true);
      const startDate = dateValue(input.startDate, "início da preparação")!;
      const endDate = await moldPreparationEndDate(db, organizationId, moldId, startDate);
      const status = enumValue(input.status, PREPARATION_STATUSES, "planejada", "Status da preparação");
      const checklistInput = input.checklist && typeof input.checklist === "object" ? input.checklist as Record<string, unknown> : {};
      const checklist = {
        limpeza: checklistInput.limpeza === true,
        desmoldante: checklistInput.desmoldante === true,
        montagem: checklistInput.montagem === true,
      };
      const approvedBy = textValue(input.approvedBy, "a pessoa aprovadora", 180);
      if (status === "aprovada" && (!checklist.limpeza || !checklist.desmoldante || !checklist.montagem || !approvedBy)) {
        throw badRequest("Para aprovar, conclua limpeza, desmoldante e montagem e informe quem aprovou.");
      }
      const record: Record<string, unknown> = {
        organization_id: organizationId,
        mold_id: moldId,
        start_date: startDate,
        end_date: endDate,
        status,
        checklist,
        approved_by: status === "aprovada" ? approvedBy : null,
        observations: textValue(input.observations, "as observações", 1000) || null,
      };
      const id = textValue(input.id, "o identificador", 80);
      if (id) record.id = id;
      const { data, error } = await db.from("mold_preparations").upsert(record).select("id, mold_id, start_date, end_date, status, checklist, approved_by, approved_at, observations, created_at, updated_at").single();
      if (error) throwDbError(error, "Não foi possível salvar a preparação do molde.");
      return json({ ok: true, preparation: data });
    }

    if (action === "save_allocation") {
      const resourceKind = String(input.resourceKind || "mold");
      if (resourceKind !== "mold" && resourceKind !== "other") throw badRequest("Tipo de recurso inválido.");
      const startDate = dateValue(input.startDate, "data inicial")!;
      const endDate = dateValue(input.endDate, "data final")!;
      if (endDate < startDate) throw badRequest("A data final não pode ser anterior à data inicial.");
      const record: Record<string, unknown> = {
        organization_id: organizationId,
        resource_kind: resourceKind,
        mold_id: resourceKind === "mold" ? textValue(input.moldId, "o molde", 80, true) : null,
        resource_name: resourceKind === "other" ? textValue(input.resourceName, "o nome do recurso", 180, true) : "",
        order_item_id: textValue(input.orderItemId, "o item do pedido", 80, true),
        start_date: startDate,
        end_date: endDate,
        status: enumValue(input.status, ALLOCATION_STATUSES, "planned", "Status da alocação"),
        conflict_reason: textValue(input.conflictReason, "a justificativa", 500) || null,
        conflict_responsible: textValue(input.conflictResponsible, "o responsável pelo conflito", 180) || null,
        observations: textValue(input.observations, "as observações", 1000) || null,
      };
      const id = textValue(input.id, "o identificador", 80);
      if (id) record.id = id;
      const { data, error } = await db.from("resource_allocations").upsert(record).select("id, resource_kind, mold_id, resource_name, order_item_id, start_date, end_date, status, conflict_reason, conflict_responsible, observations, created_at, updated_at").single();
      if (error) throwDbError(error, "Não foi possível salvar a alocação do recurso.");
      return json({ ok: true, allocation: data });
    }

    if (action === "delete_record") {
      const kind = enumValue(input.kind, DELETE_KINDS, "", "Tipo de registro");
      const id = textValue(input.id, "o registro", 80, true);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        throw badRequest("Identificador de registro inválido.");
      }
      const rpcName = kind === "order" ? "delete_order_with_history" : "delete_operation_record";
      const rpcArgs = kind === "order"
        ? { p_org_id: organizationId, p_order_id: id }
        : { p_org_id: organizationId, p_kind: kind, p_id: id };
      const { data, error } = await db.rpc(rpcName, rpcArgs);
      if (error?.code === "P0002") throw badRequest(String(error.message), 404);
      if (error) throwDbError(error, "Não foi possível apagar o registro.");
      const planning = kind === "order" && data?.hadPlan
        ? await replanAfterPositionChange(db, organizationId, "O pedido foi apagado")
        : null;
      return json({ ok: true, deleted: data, planning });
    }

    if (action === "archive") {
      const id = textValue(input.id, "o registro", 80, true);
      const kind = String(input.kind || "");
      let query;
      if (kind === "work") {
        const { data: linkedOrders, error: linkedError } = await db.from("orders").select("id, status")
          .eq("organization_id", organizationId).eq("work_id", id).eq("is_active", true).limit(1000);
        if (linkedError) throwDbError(linkedError, "Não foi possível conferir os pedidos vinculados.");
        if ((linkedOrders || []).length) {
          throw badRequest("A obra está vinculada a pedidos. Mantenha o cadastro para preservar o histórico.", 409);
        }
        query = db.from("works").update({ is_active: false }).eq("id", id).eq("organization_id", organizationId).select("id").maybeSingle();
      }
      else if (kind === "piece_type") {
        const { data: linkedItems, error: linkedError } = await db.from("order_items").select("id")
          .eq("organization_id", organizationId).eq("piece_type_id", id).limit(1);
        if (linkedError) throwDbError(linkedError, "Não foi possível conferir os pedidos que usam esta peça.");
        if (linkedItems?.length) throw badRequest("Este tipo de peça está vinculado a pedidos. Mantenha o cadastro para preservar o histórico.", 409);
        query = db.from("piece_types").update({ is_active: false }).eq("id", id).eq("organization_id", organizationId).select("id").maybeSingle();
      }
      else if (kind === "mold") {
        const [{ data: allocations, error: allocationError }, { data: preparations, error: preparationError }] = await Promise.all([
          db.from("resource_allocations").select("id").eq("organization_id", organizationId).eq("mold_id", id).in("status", ["planned", "in_progress"]).limit(1),
          db.from("mold_preparations").select("id").eq("organization_id", organizationId).eq("mold_id", id).in("status", ["planejada", "em_andamento", "aguardando_aprovacao"]).limit(1),
        ]);
        if (allocationError) throwDbError(allocationError, "Não foi possível conferir as alocações do molde.");
        if (preparationError) throwDbError(preparationError, "Não foi possível conferir as preparações do molde.");
        if (allocations?.length || preparations?.length) throw badRequest("Cancele as alocações e conclua ou cancele as preparações antes de retirar o molde.", 409);
        query = db.from("molds").update({ status: "retirado" }).eq("id", id).eq("organization_id", organizationId).select("id").maybeSingle();
      }
      else throw badRequest("Tipo de cadastro inválido.");
      const { data, error } = await query;
      if (error) throwDbError(error, "Não foi possível arquivar o cadastro.");
      if (!data) throw badRequest("Cadastro não encontrado.", 404);
      return json({ ok: true, archivedId: data.id });
    }

    throw badRequest("Ação de cadastros inválida.");
  } catch (error) {
    return handleError(error);
  }
}

Deno.serve(handler);
