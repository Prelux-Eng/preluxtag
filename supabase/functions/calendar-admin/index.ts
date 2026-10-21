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
