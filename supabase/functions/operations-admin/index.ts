import { getServerConfig } from "../_shared/env.js";
import { ensurePost, handleError, json, readJson } from "../_shared/http.js";
import { buildPlanningQueue, OrderPlanningError } from "../_shared/order-planning.js";
import { calculatePieceMetrics } from "../_shared/piece-metrics.js";
import { createAdminClient } from "../_shared/supabaseClient.js";

const WORK_STATUSES = new Set(["planejamento", "ativa", "concluida", "cancelada"]);
const ORDER_STATUSES = new Set(["orcamento", "aprovado", "em_producao", "concluido", "entregue", "atrasado", "cancelado"]);
const MOLD_STATUSES = new Set(["ativo", "manutencao", "bloqueado", "retirado"]);
const POSITION_STATUSES = new Set(["disponivel", "em_preparacao", "em_producao", "em_manutencao"]);
const PREPARATION_STATUSES = new Set(["planejada", "em_andamento", "aguardando_aprovacao", "aprovada", "reprovada", "cancelada"]);
const ALLOCATION_STATUSES = new Set(["planned", "in_progress", "done", "cancelled"]);

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

async function readOperationsData(db: any, organizationId: string) {
  const [clientsResult, worksResult, ordersResult, piecesResult, moldsResult, compatResult, preparationsResult, allocationsResult, catalogResult, pieceMoldsResult, positionsResult] = await Promise.all([
    db.from("clients").select("id, name, document, contact_name, phone, email, address, is_active")
      .eq("organization_id", organizationId).eq("is_active", true).order("name").limit(1000),
    db.from("works").select("id, work_number, name, client_id, address, responsible_name, start_date, requested_due_date, status, observations, is_active, created_at, updated_at")
      .eq("organization_id", organizationId).eq("is_active", true).order("name").limit(1000),
    db.from("orders").select("id, order_number, work_id, client_id, start_date, requested_due_date, planned_end_date, status, observations, is_active, created_at, updated_at")
      .eq("organization_id", organizationId).eq("is_active", true).order("start_date", { ascending: false }).limit(1000),
    db.from("piece_types").select("id, category_id, code, name, piece_kind, dimension_x_cm, dimension_y_cm, dimension_z_cm, dimensions, volume_cm3, weight_kg, volume_m3, production_minutes_per_unit, initial_stock_quantity, stock_minimum_quantity, observations, is_active")
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

  const orderIds = (ordersResult.data || []).map((order: any) => order.id);
  const itemsResult = orderIds.length
    ? await db.from("order_items").select("id, order_id, piece_type_id, quantity, production_minutes_snapshot, sequence, observations")
      .eq("organization_id", organizationId).in("order_id", orderIds).order("sequence")
    : { data: [], error: null };
  if (itemsResult.error) throwDbError(itemsResult.error, "Não foi possível carregar os itens dos pedidos.");

  const clients = clientsResult.data || [];
  const works = worksResult.data || [];
  const pieces = piecesResult.data || [];
  const activePieces = pieces.filter((piece: any) => piece.is_active);
  const molds = moldsResult.data || [];
  const clientById = new Map(clients.map((client: any) => [client.id, client.name]));
  const workById = new Map(works.map((work: any) => [work.id, work.name]));
  const pieceById = new Map(pieces.map((piece: any) => [piece.id, piece]));
  const allocatedItemIds = new Set((allocationsResult.data || []).map((allocation: any) => allocation.order_item_id));
  const itemsByOrder = new Map<string, any[]>();
  for (const item of itemsResult.data || []) {
    const list = itemsByOrder.get(item.order_id) || [];
    const piece: any = pieceById.get(item.piece_type_id);
    list.push({ ...item, piece_code: piece?.code || "", piece_name: piece?.name || "" });
    itemsByOrder.set(item.order_id, list);
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
  return {
    schemaVersion: 4,
    clients,
    works: works.map((work: any) => ({ ...work, client_name: clientById.get(work.client_id) || "" })),
    orders: (ordersResult.data || []).map((order: any) => ({
      ...order,
      client_name: clientById.get(order.client_id) || "",
      work_name: workById.get(order.work_id) || "",
      items: itemsByOrder.get(order.id) || [],
      hasResourceAllocation: (itemsByOrder.get(order.id) || []).some((item) => allocatedItemIds.has(item.id)),
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
    positions: positionsResult.data || [],
    preparations: preparationsResult.data || [],
    allocations: allocationsResult.data || [],
  };
}

async function replanOpenQueue(db: any, organizationId: string) {
  const { data: openOrders, error: orderError } = await db.from("orders")
    .select("id, status")
    .eq("organization_id", organizationId).eq("is_active", true)
    .order("start_date", { ascending: true }).order("created_at", { ascending: true }).limit(1000);
  if (orderError) throwDbError(orderError, "Não foi possível localizar pedidos para replanejar.");
  const targetOrder = (openOrders || []).find((order: any) => !["cancelado", "entregue", "concluido"].includes(order.status));
  if (!targetOrder) return { committed: true, warning: null };

  const queuePlan = await buildPlanningQueue({ db, organizationId, input: { orderId: targetOrder.id } });
  const { error: commitError } = await db.rpc("commit_planning_queue", {
    p_org_id: organizationId,
    p_plans: queuePlan.plans.map((entry) => ({ orderId: entry.orderId, plan: entry.plan })),
  });
  if (commitError) throwDbError(commitError, "Não foi possível recalcular o calendário após a alteração do cadastro.");
  const warnings = queuePlan.plans.flatMap(({ orderId, plan: queuedPlan }) => queuedPlan.feasible ? [] : queuedPlan.conflicts.map((conflict: any) => `Pedido ${queuedPlan.order?.orderNumber || orderId}: ${conflict.message}`));
  return { committed: true, warning: warnings.length ? warnings.slice(0, 5).join(" ") : null };
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

    if (action === "save_work") {
      const clientId = await resolveClientId(db, organizationId, input);
      const record = {
        id: textValue(input.id, "o identificador", 80) || null,
        workNumber: textValue(input.workNumber, "o número da obra", 80),
        name: textValue(input.name, "o nome da obra", 180, true),
        clientId,
        address: textValue(input.address, "o endereço", 300),
        responsibleName: textValue(input.responsibleName, "o responsável", 180),
        startDate: dateValue(input.startDate, "data de início", true),
        requestedDueDate: dateValue(input.requestedDueDate, "data prevista", true),
        status: enumValue(input.status, WORK_STATUSES, "planejamento", "Status da obra"),
        observations: textValue(input.observations, "as observações", 1000),
      };
      if (record.startDate && record.requestedDueDate && record.requestedDueDate < record.startDate) {
        throw badRequest("A data prevista da obra não pode ser anterior ao início.");
      }
      const { data, error } = await db.rpc("save_work_record", { p_org_id: organizationId, p_record: record });
      if (error) throwDbError(error, "Não foi possível salvar a obra.");
      return json({ ok: true, work: data });
    }

    if (action === "save_order") {
      const workId = textValue(input.workId, "a obra", 80);
      let clientId: string;
      if (workId) {
        const { data: work, error } = await db.from("works").select("id, client_id")
          .eq("organization_id", organizationId).eq("id", workId).eq("is_active", true).maybeSingle();
        if (error) throwDbError(error, "Não foi possível localizar a obra.");
        if (!work) throw badRequest("Obra não encontrada ou inativa.", 404);
        clientId = work.client_id;
      } else {
        clientId = await resolveClientId(db, organizationId, input);
      }
      const items = Array.isArray(input.items) ? input.items.map((item: any) => ({
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
        startDate: dateValue(input.startDate, "data de início")!,
        requestedDueDate: dateValue(input.requestedDueDate, "prazo", true),
        status: enumValue(input.status, ORDER_STATUSES, "orcamento", "Status do pedido"),
        observations: textValue(input.observations, "as observações", 1000),
      };
      if (order.requestedDueDate && order.requestedDueDate < order.startDate) {
        throw badRequest("O prazo do pedido não pode ser anterior ao início.");
      }
      const { data, error } = await db.rpc("save_order_with_items", {
        p_org_id: organizationId,
        p_order: order,
        p_items: items,
      });
      if (error) throwDbError(error, "Não foi possível salvar o pedido.");

      // O cadastro e a programação usam transações separadas porque o motor
      // é calculado em JavaScript. Se houver falha, o pedido permanece salvo
      // e a resposta informa claramente que a programação precisa ser revista.
      let planning: Record<string, unknown> = { committed: false };
      try {
        const { error: clearPlanError } = await db.from("orders")
          .update({ planned_start_date: null, planned_end_date: null, forecast_end_date: null })
          .eq("organization_id", organizationId)
          .eq("id", data.id);
        if (clearPlanError) throw clearPlanError;

        const queuePlan = await buildPlanningQueue({
          db,
          organizationId,
          input: {
            orderId: data.id,
            allowClosedTarget: ["cancelado", "entregue", "concluido"].includes(data.status),
          },
        });
        const { data: committed, error: commitError } = await db.rpc("commit_planning_queue", {
          p_org_id: organizationId,
          p_plans: queuePlan.plans.map((entry) => ({ orderId: entry.orderId, plan: entry.plan })),
        });
        if (commitError) throwDbError(commitError, "Não foi possível atualizar o calendário do pedido.");
        const warningMessages = queuePlan.plans.flatMap(({ orderId, plan: queuedPlan }) =>
          queuedPlan.feasible
            ? []
            : queuedPlan.conflicts.map((conflict: any) =>
              `Pedido ${queuedPlan.order?.orderNumber || orderId}: ${conflict.message}`
            )
        );
        planning = {
          committed: true,
          feasible: queuePlan.targetPlan?.feasible ?? true,
          queueFeasible: queuePlan.queue.infeasibleOrderIds.length === 0,
          replanOrderCount: queuePlan.queue.replanOrderCount,
          removedFromPlan: queuePlan.removedTargetFromPlan,
          plannedStartDate: queuePlan.targetPlan?.effectiveStartDate ?? null,
          plannedEndDate: queuePlan.targetPlan?.plannedEndDate ?? null,
          suggestedDueDate: queuePlan.targetPlan?.suggestedDueDate ?? null,
          totalPlannedQuantity: queuePlan.targetPlan?.totalPlannedQuantity ?? 0,
          totalRemainingQuantity: queuePlan.targetPlan?.totalRemainingQuantity ?? 0,
          commit: committed,
          warning: warningMessages.length ? warningMessages.slice(0, 5).join(" ") : null,
        };
      } catch (planningError) {
        const message = planningError instanceof OrderPlanningError
          ? planningError.message
          : "O pedido foi salvo, mas o calendário não pôde ser atualizado. Atualize o planejamento para tentar novamente.";
        planning = { committed: false, warning: message };
      }
      return json({ ok: true, order: data, planning });
    }

    if (action === "calculate_piece_metrics") {
      const metrics = calculatePieceMetrics({
        x: input.x ?? input.dimensionX ?? input.dimension_x_cm,
        y: input.y ?? input.dimensionY ?? input.dimension_y_cm,
        z: input.z ?? input.dimensionZ ?? input.dimension_z_cm,
      });
      return json({ ok: true, metrics });
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
      calculatePieceMetrics({ x: dimensionXcm, y: dimensionYcm, z: dimensionZcm });
      const record = {
        id: textValue(input.id, "o identificador", 80) || null,
        code: textValue(input.code, "o código da peça", 60, true),
        name: textValue(input.name, "o nome da peça", 180, true),
        pieceKind,
        dimensionXcm,
        dimensionYcm,
        dimensionZcm,
        productionMinutesPerUnit: integerValue(input.productionMinutesPerUnit, "O tempo de produção", 1),
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
          warning: planningError instanceof OrderPlanningError
            ? planningError.message
            : "A peça foi salva, mas o calendário não pôde ser recalculado. Atualize o planejamento.",
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
      const configurationKind = enumValue(input.configurationKind, new Set(["braco", "pilar_viga"]), "", "Configuração da posição");
      const bracoCatalogCode = textValue(input.bracoCatalogCode, "o molde BRAÇO", 40);
      const leitoCatalogCode = textValue(input.leitoCatalogCode, "o molde LEITO", 40);
      const lateralCatalogCode = textValue(input.lateralCatalogCode, "o molde LATERAL", 40);
      const notes = textValue(input.notes, "as observações", 1000);
      if (configurationKind === "braco" && (!bracoCatalogCode || leitoCatalogCode || lateralCatalogCode)) {
        throw badRequest("Configure a posição com uma medida BRAÇO.");
      }
      if (configurationKind === "pilar_viga" && (bracoCatalogCode || !leitoCatalogCode || !lateralCatalogCode)) {
        throw badRequest("Configure a posição com uma medida LEITO e uma LATERAL.");
      }
      const { data, error } = await db.rpc("save_mold_position", {
        p_org_id: organizationId,
        p_code: code,
        p_status: status,
        p_configuration_kind: configurationKind,
        p_braco_catalog_code: bracoCatalogCode || null,
        p_leito_catalog_code: leitoCatalogCode || null,
        p_lateral_catalog_code: lateralCatalogCode || null,
        p_notes: notes || null,
      });
      if (error) throwDbError(error, "Não foi possível salvar a configuração da posição.");

      let planning: Record<string, unknown>;
      try {
        planning = await replanOpenQueue(db, organizationId);
      } catch (planningError) {
        planning = {
          committed: false,
          warning: planningError instanceof OrderPlanningError
            ? planningError.message
            : "A posição foi salva, mas o calendário não pôde ser recalculado. Atualize o planejamento.",
        };
      }
      return json({ ok: true, position: data, planning });
    }

    if (action === "save_preparation") {
      const moldId = textValue(input.moldId, "o molde", 80, true);
      const startDate = dateValue(input.startDate, "início da preparação")!;
      const endDate = addDays(startDate, 6);
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
