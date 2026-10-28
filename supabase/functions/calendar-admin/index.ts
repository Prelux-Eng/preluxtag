import { buildCalendarDays } from "../_shared/calendar.js";
import { getServerConfig } from "../_shared/env.js";
import { ensurePost, handleError, json, readJson } from "../_shared/http.js";
import { addDays, normalizeDate } from "../_shared/planner.js";
import { createAdminClient } from "../_shared/supabaseClient.js";

const BATCH_SIZE = 500;
const KINDS = new Set([
  "feriado",
  "dia_extra",
  "parada",
  "manutencao",
  "folga_coletiva",
  "personalizada",
]);

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function badRequest(message: string) {
  return Object.assign(new Error(message), { status: 422 });
}

function booleanValue(value: unknown, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["true", "1", "sim", "yes"].includes(String(value).toLowerCase());
}

function nonNegativeInteger(value: unknown, label: string, fallback = 0) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw badRequest(`${label} deve ser um número inteiro maior ou igual a zero.`);
  return number;
}

function rangeFromPayload(payload: Record<string, unknown>, fallbackStart = todayUTC()) {
  const startDate = normalizeDate(payload.startDate || fallbackStart, "data inicial");
  const endDate = normalizeDate(payload.endDate || startDate, "data final");
  if (endDate < startDate) throw badRequest("A data final não pode ser anterior à data inicial.");
  if (endDate > addDays(startDate, 730)) throw badRequest("O intervalo máximo para o calendário é de 730 dias.");
  return { startDate, endDate };
}

async function regenerate(db: ReturnType<typeof createAdminClient>, organizationId: string, startDate: string, endDate: string) {
  const [{ data: settings, error: settingsError }, { data: rules, error: rulesError }, { data: exceptions, error: exceptionsError }] = await Promise.all([
    db.from("calendar_settings").select("default_capacity_minutes, planning_horizon_days").eq("organization_id", organizationId).maybeSingle(),
    db.from("calendar_working_rules").select("weekday, is_working, capacity_minutes").eq("organization_id", organizationId),
    db.from("calendar_exceptions").select("id, name, kind, start_date, end_date, is_working, capacity_minutes, priority, notes, is_active, updated_at").eq("organization_id", organizationId).eq("is_active", true).lte("start_date", endDate).gte("end_date", startDate),
  ]);
  if (settingsError) throw settingsError;
  if (rulesError) throw rulesError;
  if (exceptionsError) throw exceptionsError;

  const days = buildCalendarDays({ startDate, endDate, settings: settings || {}, rules: rules || [], exceptions: exceptions || [] });
  const records = days.map((day) => ({ organization_id: organizationId, ...day, generated_at: new Date().toISOString() }));
  for (const batch of chunks(records, BATCH_SIZE)) {
    const { error } = await db.from("calendar_days").upsert(batch, { onConflict: "organization_id,date" });
    if (error) throw error;
  }
  return records.length;
}

async function readCalendar(db: ReturnType<typeof createAdminClient>, organizationId: string, startDate: string, endDate: string) {
  const [{ data: days, error: daysError }, { data: exceptions, error: exceptionsError }, { data: capacity, error: capacityError }] = await Promise.all([
    db.from("calendar_days").select("date, is_working, capacity_minutes, source, exception_id, note, generated_at").eq("organization_id", organizationId).gte("date", startDate).lte("date", endDate).order("date"),
    db.from("calendar_exceptions").select("id, name, kind, start_date, end_date, is_working, capacity_minutes, priority, notes, is_active, created_at, updated_at").eq("organization_id", organizationId).eq("is_active", true).lte("start_date", endDate).gte("end_date", startDate).order("start_date").order("priority", { ascending: false }),
    db.from("v_capacity_daily").select("date, is_working, capacity_minutes, planned_minutes, actual_quantity, occupancy_percent").eq("organization_id", organizationId).gte("date", startDate).lte("date", endDate).order("date"),
  ]);
  if (daysError) throw daysError;
  if (exceptionsError) throw exceptionsError;
  if (capacityError) throw capacityError;
  return { days: days || [], exceptions: exceptions || [], capacity: capacity || [] };
}

function validateActivity(payload: Record<string, unknown>) {
  const name = String(payload.name || "").trim();
  if (!name) throw badRequest("Informe o nome da atividade.");
  if (name.length > 160) throw badRequest("O nome da atividade deve ter no máximo 160 caracteres.");
  const kind = String(payload.kind || "personalizada");
  if (!KINDS.has(kind)) throw badRequest("Tipo de atividade inválido.");
  const startDate = normalizeDate(payload.startDate, "data inicial");
  const endDate = normalizeDate(payload.endDate || startDate, "data final");
  if (endDate < startDate) throw badRequest("A data final não pode ser anterior à data inicial.");
  const isWorking = booleanValue(payload.isWorking, false);
  const capacityMinutes = nonNegativeInteger(payload.capacityMinutes, "capacidade", isWorking ? 480 : 0);
  return {
    name,
    kind,
    start_date: startDate,
    end_date: endDate,
    is_working: isWorking,
    capacity_minutes: isWorking ? capacityMinutes : 0,
    priority: nonNegativeInteger(payload.priority, "prioridade", kind === "personalizada" ? 10 : 20),
    notes: String(payload.notes || "").trim().slice(0, 500) || null,
  };
}

async function saveActivity(db: ReturnType<typeof createAdminClient>, organizationId: string, payload: Record<string, unknown>, manualDay = false) {
  const activity = validateActivity({ ...payload, ...(manualDay ? { kind: "personalizada", priority: 100 } : {}) });
  const id = String(payload.id || "").trim();
  let query;
  if (id) {
    query = db.from("calendar_exceptions").update({ ...activity, updated_at: new Date().toISOString(), is_active: true }).eq("id", id).eq("organization_id", organizationId).select("id, name, kind, start_date, end_date, is_working, capacity_minutes, priority, notes, is_active, created_at, updated_at").single();
  } else {
    query = db.from("calendar_exceptions").insert({ organization_id: organizationId, ...activity }).select("id, name, kind, start_date, end_date, is_working, capacity_minutes, priority, notes, is_active, created_at, updated_at").single();
  }
  const { data, error } = await query;
  if (error) throw error;
  const range = rangeFromPayload(payload, activity.start_date);
  await regenerate(db, organizationId, range.startDate, range.endDate);
  return { saved: data, range, ...(await readCalendar(db, organizationId, range.startDate, range.endDate)) };
}

async function deleteActivity(db: ReturnType<typeof createAdminClient>, organizationId: string, payload: Record<string, unknown>) {
  const id = String(payload.id || "").trim();
  if (!id) throw badRequest("Atividade não informada.");
  const { data: current, error: readError } = await db.from("calendar_exceptions").select("id, start_date, end_date").eq("id", id).eq("organization_id", organizationId).maybeSingle();
  if (readError) throw readError;
  if (!current) throw Object.assign(new Error("Atividade não encontrada."), { status: 404 });
  const { error } = await db.from("calendar_exceptions").update({ is_active: false, updated_at: new Date().toISOString() }).eq("id", id).eq("organization_id", organizationId);
  if (error) throw error;
  const range = rangeFromPayload(payload, current.start_date);
  if (!payload.endDate) range.endDate = current.end_date;
  await regenerate(db, organizationId, range.startDate, range.endDate);
  return { deletedId: id, range, ...(await readCalendar(db, organizationId, range.startDate, range.endDate)) };
}

async function readPlanningData(db: ReturnType<typeof createAdminClient>, organizationId: string, startDate: string, endDate: string) {
  const [{ data: orders, error: ordersError }, { data: schedules, error: schedulesError }, { data: units, error: unitsError }, { data: positions, error: positionsError }] = await Promise.all([
    db.from("orders")
      .select("id, order_number, work_id, client_id, start_date, planned_start_date, requested_due_date, planned_end_date, forecast_end_date, status")
      .eq("organization_id", organizationId)
      .eq("is_active", true)
      .order("start_date")
      .limit(1000),
    db.from("production_schedules")
      .select("id, order_id, order_item_id, piece_type_id, work_date, planned_quantity, planned_minutes, actual_quantity, status")
      .eq("organization_id", organizationId)
      .neq("status", "cancelled")
      .gte("work_date", startDate)
      .lte("work_date", endDate)
      .order("work_date"),
    db.from("production_orders")
      .select("id, order_id, order_item_id, unit_sequence, planned_cast_date, planned_cure_start_date, planned_cure_end_date, planned_finish_date, planned_end_date, forecast_end_date, curing_days, production_minutes_snapshot, status")
      .eq("organization_id", organizationId)
      .in("status", ["planned", "in_progress", "done"])
      .lte("planned_cast_date", endDate)
      .gte("planned_end_date", startDate)
      .order("planned_cast_date")
      .limit(10000),
    db.from("mold_positions")
      .select("id, code, status")
      .eq("organization_id", organizationId)
      .order("code"),
  ]);
  if (ordersError) throw ordersError;
  if (schedulesError) throw schedulesError;
  if (unitsError) throw unitsError;
  if (positionsError) throw positionsError;

  const clientIds = [...new Set((orders || []).map((order) => order.client_id).filter(Boolean))];
  const workIds = [...new Set((orders || []).map((order) => order.work_id).filter(Boolean))];
  const unitIds = (units || []).map((unit) => unit.id);
  const orderItemIds = [...new Set([
    ...(schedules || []).map((schedule) => schedule.order_item_id),
    ...(units || []).map((unit) => unit.order_item_id),
  ].filter(Boolean))];
  const orderIds = (orders || []).map((order) => order.id);
  const [clientsResult, worksResult, itemsResult, allocationsResult, legacyStartedResult, unitStartedResult] = await Promise.all([
    clientIds.length
      ? db.from("clients").select("id, name").eq("organization_id", organizationId).in("id", clientIds)
      : Promise.resolve({ data: [], error: null }),
    workIds.length
      ? db.from("works").select("id, name").eq("organization_id", organizationId).in("id", workIds)
      : Promise.resolve({ data: [], error: null }),
    orderItemIds.length
      ? db.from("order_items").select("id, order_id, piece_type_id, sequence").eq("organization_id", organizationId).in("id", orderItemIds)
      : Promise.resolve({ data: [], error: null }),
    unitIds.length
      ? db.from("allocations").select("production_order_id, mold_position_id, scheduled_date, status").eq("organization_id", organizationId).in("production_order_id", unitIds).in("status", ["planned", "in_progress", "done"]).limit(10000)
      : Promise.resolve({ data: [], error: null }),
    orderIds.length
      ? db.from("production_schedules").select("order_id").eq("organization_id", organizationId).in("order_id", orderIds).in("status", ["in_progress", "done"]).limit(10000)
      : Promise.resolve({ data: [], error: null }),
    orderIds.length
      ? db.from("production_orders").select("order_id").eq("organization_id", organizationId).in("order_id", orderIds).in("status", ["in_progress", "done", "scrapped"]).limit(10000)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (clientsResult.error) throw clientsResult.error;
  if (worksResult.error) throw worksResult.error;
  if (itemsResult.error) throw itemsResult.error;
  if (allocationsResult.error) throw allocationsResult.error;
  if (legacyStartedResult.error) throw legacyStartedResult.error;
  if (unitStartedResult.error) throw unitStartedResult.error;

  const pieceTypeIds = [...new Set((itemsResult.data || []).map((item) => item.piece_type_id).filter(Boolean))];
  const itemPositions = [...new Set((allocationsResult.data || []).map((allocation) => allocation.mold_position_id).filter(Boolean))];
  const [pieceTypesResult, allocatedPositionsResult] = await Promise.all([
    pieceTypeIds.length
      ? db.from("piece_types").select("id, code, name").eq("organization_id", organizationId).in("id", pieceTypeIds)
      : Promise.resolve({ data: [], error: null }),
    itemPositions.length
      ? db.from("mold_positions").select("id, code").eq("organization_id", organizationId).in("id", itemPositions)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (pieceTypesResult.error) throw pieceTypesResult.error;
  if (allocatedPositionsResult.error) throw allocatedPositionsResult.error;

  const clientById = new Map((clientsResult.data || []).map((client) => [client.id, client.name]));
  const workById = new Map((worksResult.data || []).map((work) => [work.id, work.name]));
  const pieceById = new Map((pieceTypesResult.data || []).map((piece) => [piece.id, piece]));
  const itemById = new Map((itemsResult.data || []).map((item) => [item.id, item]));
  const positionById = new Map((allocatedPositionsResult.data || []).map((position) => [position.id, position.code]));
  const allocationByUnit = new Map((allocationsResult.data || []).map((allocation) => [allocation.production_order_id, allocation]));
  const activePositionCount = (positions || []).filter((position) => position.status !== "em_manutencao").length;
  const occupancyByDate = new Map<string, Set<string>>();
  const productionOrders = (units || []).map((unit) => {
    const item = itemById.get(unit.order_item_id);
    const piece = pieceById.get(item?.piece_type_id);
    const allocation = allocationByUnit.get(unit.id);
    const positionCode = positionById.get(allocation?.mold_position_id) || null;
    if (unit.planned_cast_date >= startDate && unit.planned_cast_date <= endDate && positionCode) {
      const occupied = occupancyByDate.get(unit.planned_cast_date) || new Set<string>();
      occupied.add(positionCode);
      occupancyByDate.set(unit.planned_cast_date, occupied);
    }
    return {
      ...unit,
      piece_type_id: item?.piece_type_id || null,
      sequence: item?.sequence || null,
      piece_code: piece?.code || "",
      piece_name: piece?.name || "",
      position_code: positionCode,
      allocation_status: allocation?.status || null,
      scheduled_date: allocation?.scheduled_date || unit.planned_cast_date,
    };
  });
  const capacityByPositions = [...occupancyByDate.entries()].map(([date, occupied]) => ({
    date,
    capacity_positions: activePositionCount,
    occupied_positions: occupied.size,
    available_positions: Math.max(0, activePositionCount - occupied.size),
    occupancy_percent: activePositionCount ? Math.round((occupied.size / activePositionCount) * 100) : 0,
  })).sort((a, b) => a.date.localeCompare(b.date));
  return {
    orders: (orders || []).map((order) => ({
      ...order,
      work_name: workById.get(order.work_id) || "",
      client_name: clientById.get(order.client_id) || "",
    })),
    schedules: (schedules || []).map((schedule) => ({
      ...schedule,
      piece_code: pieceById.get(schedule.piece_type_id)?.code || "",
      piece_name: pieceById.get(schedule.piece_type_id)?.name || "",
    })),
    productionOrders,
    capacityByPositions,
    positions: positions || [],
    startedOrderIds: [...new Set([
      ...(legacyStartedResult.data || []).map((schedule) => schedule.order_id),
      ...(unitStartedResult.data || []).map((unit) => unit.order_id),
    ])],
  };
}

async function readCalendarSettings(db: ReturnType<typeof createAdminClient>, organizationId: string) {
  const [{ data: settings, error: settingsError }, { data: rules, error: rulesError }] = await Promise.all([
    db.from("calendar_settings").select("default_capacity_minutes, planning_horizon_days").eq("organization_id", organizationId).maybeSingle(),
    db.from("calendar_working_rules").select("weekday, is_working, capacity_minutes").eq("organization_id", organizationId).order("weekday"),
  ]);
  if (settingsError) throw settingsError;
  if (rulesError) throw rulesError;
  return { settings: settings || { default_capacity_minutes: 480, planning_horizon_days: 365 }, rules: rules || [] };
}

async function saveCalendarSettings(db: ReturnType<typeof createAdminClient>, organizationId: string, payload: Record<string, unknown>) {
  const defaultCapacityMinutes = nonNegativeInteger(payload.defaultCapacityMinutes, "capacidade padrão", 480);
  if (defaultCapacityMinutes > 1440) throw badRequest("A capacidade padrão não pode ultrapassar 1440 minutos por dia.");
  if (!Array.isArray(payload.rules) || payload.rules.length !== 7) throw badRequest("Informe a regra de trabalho para cada dia da semana.");
  const seenWeekdays = new Set<number>();
  const rules = payload.rules.map((value) => {
    if (!value || typeof value !== "object") throw badRequest("Regra semanal inválida.");
    const rule = value as Record<string, unknown>;
    const weekday = Number(rule.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6 || seenWeekdays.has(weekday)) throw badRequest("Cada dia da semana deve aparecer uma única vez.");
    seenWeekdays.add(weekday);
    const isWorking = booleanValue(rule.isWorking, false);
    const capacityMinutes = nonNegativeInteger(rule.capacityMinutes, "capacidade do dia", defaultCapacityMinutes);
    if (capacityMinutes > 1440) throw badRequest("A capacidade diária não pode ultrapassar 1440 minutos.");
    return {
      organization_id: organizationId,
      weekday,
      is_working: isWorking,
      capacity_minutes: isWorking ? capacityMinutes : 0,
    };
  });
  const [{ error: settingsError }, { error: rulesError }] = await Promise.all([
    db.from("calendar_settings").upsert({ organization_id: organizationId, default_capacity_minutes: defaultCapacityMinutes }, { onConflict: "organization_id" }),
    db.from("calendar_working_rules").upsert(rules, { onConflict: "organization_id,weekday" }),
  ]);
  if (settingsError) throw settingsError;
  if (rulesError) throw rulesError;
  return readCalendarSettings(db, organizationId);
}

async function handler(request: Request) {
  try {
    const method = ensurePost(request);
    if (method === "options") return json({ ok: true });
    const config = getServerConfig();
    const payload = await readJson(request);
    const db = createAdminClient(config);
    const action = String(payload.action || "get");
    if (action === "get") {
      const range = rangeFromPayload(payload);
      return json({ ok: true, range, ...(await readCalendar(db, config.organizationId, range.startDate, range.endDate)) });
    }
    if (action === "planning_data") {
      const range = rangeFromPayload(payload);
      return json({ ok: true, range, ...(await readPlanningData(db, config.organizationId, range.startDate, range.endDate)) });
    }
    if (action === "get_settings") {
      return json({ ok: true, ...(await readCalendarSettings(db, config.organizationId)) });
    }
    if (action === "save_settings") {
      return json({ ok: true, ...(await saveCalendarSettings(db, config.organizationId, payload)) });
    }
    if (action === "save_activity" || action === "save_day") {
      return json({ ok: true, ...(await saveActivity(db, config.organizationId, payload, action === "save_day")) });
    }
    if (action === "delete_activity") {
      return json({ ok: true, ...(await deleteActivity(db, config.organizationId, payload)) });
    }
    throw badRequest("Ação de calendário inválida.");
  } catch (error) {
    return handleError(error);
  }
}

Deno.serve(handler);
