import { getServerConfig } from "../_shared/env.js";
import { ensurePost, handleError, json, readJson } from "../_shared/http.js";
import { buildPlanningQueue, OrderPlanningError } from "../_shared/order-planning.js";
import { calculatePieceMetrics } from "../_shared/piece-metrics.js";
import { createAdminClient } from "../_shared/supabaseClient.js";

const WORK_STATUSES = new Set(["planejamento", "ativa", "concluida", "cancelada"]);
const ORDER_STATUSES = new Set(["orcamento", "aprovado", "em_producao", "concluido", "entregue", "atrasado", "cancelado"]);
const MOLD_STATUSES = new Set(["ativo", "manutencao", "bloqueado", "retirado"]);
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
  const [clientsResult, worksResult, ordersResult, piecesResult, moldsResult, compatResult, preparationsResult, allocationsResult] = await Promise.all([
    db.from("clients").select("id, name, document, contact_name, phone, email, address, is_active")
      .eq("organization_id", organizationId).eq("is_active", true).order("name").limit(1000),
    db.from("works").select("id, work_number, name, client_id, address, responsible_name, start_date, requested_due_date, status, observations, is_active, created_at, updated_at")
      .eq("organization_id", organizationId).eq("is_active", true).order("name").limit(1000),
    db.from("orders").select("id, order_number, work_id, client_id, start_date, requested_due_date, planned_end_date, status, observations, is_active, created_at, updated_at")
      .eq("organization_id", organizationId).eq("is_active", true).order("start_date", { ascending: false }).limit(1000),
    db.from("piece_types").select("id, category_id, code, name, dimensions, weight_kg, volume_m3, production_minutes_per_unit, initial_stock_quantity, stock_minimum_quantity, observations, is_active")
      .eq("organization_id", organizationId).order("code").limit(1000),
    db.from("molds").select("id, code, name, mold_type, dimensions, cycle_minutes_per_unit, preparation_days, status, observations, created_at, updated_at")
      .eq("organization_id", organizationId).order("code").limit(1000),
    db.from("mold_piece_types").select("mold_id, piece_type_id")
      .eq("organization_id", organizationId).limit(5000),
    db.from("mold_preparations").select("id, mold_id, start_date, end_date, status, checklist, approved_by, approved_at, observations, created_at, updated_at")
      .eq("organization_id", organizationId).order("start_date", { ascending: false }).limit(1000),
    db.from("resource_allocations").select("id, resource_kind, mold_id, resource_name, order_item_id, start_date, end_date, status, conflict_reason, conflict_responsible, observations, created_at, updated_at")
      .eq("organization_id", organizationId).order("start_date", { ascending: false }).limit(2000),
  ]);
  const results = [clientsResult, worksResult, ordersResult, piecesResult, moldsResult, compatResult, preparationsResult, allocationsResult];
  const labels = ["clientes", "obras", "pedidos", "tipos de peça", "moldes", "compatibilidades", "preparações", "alocações"];
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
  return {
    clients,
    works: works.map((work: any) => ({ ...work, client_name: clientById.get(work.client_id) || "" })),
    orders: (ordersResult.data || []).map((order: any) => ({
      ...order,
      client_name: clientById.get(order.client_id) || "",
      work_name: workById.get(order.work_id) || "",
      items: itemsByOrder.get(order.id) || [],
      hasResourceAllocation: (itemsByOrder.get(order.id) || []).some((item) => allocatedItemIds.has(item.id)),
    })),
    pieceTypes: activePieces.map((piece: any) => ({ ...piece, mold_ids: moldIdsByPiece.get(piece.id) || [] })),
    molds: molds.map((mold: any) => ({ ...mold, piece_type_ids: pieceIdsByMold.get(mold.id) || [] })),
    preparations: preparationsResult.data || [],
    allocations: allocationsResult.data || [],
  };
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
      const record = {
        id: textValue(input.id, "o identificador", 80) || null,
        code: textValue(input.code, "o código da peça", 60, true),
        name: textValue(input.name, "o nome da peça", 180, true),
        dimensions: textValue(input.dimensions, "as dimensões", 180),
        weightKg: decimalValue(input.weightKg, "O peso", true),
        volumeM3: decimalValue(input.volumeM3, "O volume", true),
        productionMinutesPerUnit: integerValue(input.productionMinutesPerUnit, "O tempo de produção", 1),
        initialStockQuantity: integerValue(input.initialStockQuantity ?? 0, "O estoque inicial", 0),
        stockMinimumQuantity: integerValue(input.stockMinimumQuantity ?? 0, "O estoque mínimo", 0),
        observations: textValue(input.observations, "as observações", 1000),
      };
      const moldIds = Array.isArray(input.moldIds) ? input.moldIds.map((id: unknown) => textValue(id, "o molde", 80, true)) : [];
      const { data, error } = await db.rpc("save_piece_type", { p_org_id: organizationId, p_record: record, p_mold_ids: moldIds });
      if (error) throwDbError(error, "Não foi possível salvar o tipo de peça.");
      return json({ ok: true, pieceType: data });
    }

    if (action === "save_mold") {
      const record = {
        id: textValue(input.id, "o identificador", 80) || null,
        code: textValue(input.code, "o código do molde", 60, true),
        name: textValue(input.name, "o nome do molde", 180, true),
        moldType: textValue(input.moldType, "o tipo do molde", 120, true),
        dimensions: textValue(input.dimensions, "as dimensões", 180),
        cycleMinutesPerUnit: integerValue(input.cycleMinutesPerUnit, "O ciclo do molde", 1, true),
        status: enumValue(input.status, MOLD_STATUSES, "ativo", "Status do molde"),
        observations: textValue(input.observations, "as observações", 1000),
      };
      const pieceTypeIds = Array.isArray(input.pieceTypeIds) ? input.pieceTypeIds.map((id: unknown) => textValue(id, "a peça compatível", 80, true)) : [];
      const { data, error } = await db.rpc("save_mold", { p_org_id: organizationId, p_record: record, p_piece_type_ids: pieceTypeIds });
      if (error) throwDbError(error, "Não foi possível salvar o molde.");
      return json({ ok: true, mold: data });
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
