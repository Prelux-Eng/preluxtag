import { buildCalendarDays } from "../_shared/calendar.js";
import { getServerConfig } from "../_shared/env.js";
import { ensurePost, handleError, json, readJson } from "../_shared/http.js";
import { addDays, normalizeDate } from "../_shared/planner.js";
import { createAdminClient } from "../_shared/supabaseClient.js";

const BATCH_SIZE = 500;

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

async function handler(request: Request) {
  try {
    const method = ensurePost(request);
    if (method === "options") return json({ ok: true });

    const config = getServerConfig();
    const payload = await readJson(request);
    const db = createAdminClient(config);

    const { data: settings, error: settingsError } = await db
      .from("calendar_settings")
      .select("default_capacity_minutes, planning_horizon_days")
      .eq("organization_id", config.organizationId)
      .maybeSingle();
    if (settingsError) throw settingsError;

    const startDate = normalizeDate(payload.startDate || todayUTC(), "data inicial");
    const defaultEndDate = addDays(
      startDate,
      Math.min(730, Math.max(1, Number(settings?.planning_horizon_days || 365))),
    );
    const endDate = normalizeDate(payload.endDate || defaultEndDate, "data final");
    if (endDate < startDate) {
      throw Object.assign(new Error("A data final não pode ser anterior à data inicial."), {
        status: 422,
      });
    }
    if (endDate > addDays(startDate, 730)) {
      throw Object.assign(new Error("O intervalo máximo para reconstrução é de 730 dias."), {
        status: 422,
      });
    }

    const [{ data: rules, error: rulesError }, { data: exceptions, error: exceptionsError }] =
      await Promise.all([
        db
          .from("calendar_working_rules")
          .select("weekday, is_working, capacity_minutes")
          .eq("organization_id", config.organizationId),
        db
          .from("calendar_exceptions")
          .select("id, name, start_date, end_date, is_working, capacity_minutes, priority, is_active, updated_at")
          .eq("organization_id", config.organizationId)
          .eq("is_active", true)
          .lte("start_date", endDate)
          .gte("end_date", startDate),
      ]);
    if (rulesError) throw rulesError;
    if (exceptionsError) throw exceptionsError;

    const days = buildCalendarDays({
      startDate,
      endDate,
      settings: settings || {},
      rules: rules || [],
      exceptions: exceptions || [],
    });
    const records = days.map((day) => ({
      organization_id: config.organizationId,
      ...day,
      generated_at: new Date().toISOString(),
    }));

    for (const batch of chunks(records, BATCH_SIZE)) {
      const { error } = await db
        .from("calendar_days")
        .upsert(batch, { onConflict: "organization_id,date" });
      if (error) throw error;
    }

    return json({
      ok: true,
      startDate,
      endDate,
      daysGenerated: records.length,
    });
  } catch (error) {
    return handleError(error);
  }
}

Deno.serve(handler);
