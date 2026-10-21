import { getServerConfig } from "../_shared/env.js";
import { ensurePost, handleError, json, readJson } from "../_shared/http.js";
import { buildOrderPlan, OrderPlanningError } from "../_shared/order-planning.js";
import { createAdminClient } from "../_shared/supabaseClient.js";

async function handler(request: Request) {
  try {
    const method = ensurePost(request);
    if (method === "options") return json({ ok: true });

    const config = getServerConfig();
    const input = await readJson(request);
    const plan = await buildOrderPlan({
      db: createAdminClient(config),
      organizationId: config.organizationId,
      input,
    });

    return json({ ok: true, plan });
  } catch (error) {
    if (error instanceof OrderPlanningError && error.status < 500) {
      return json({ error: error.message, details: error.details }, error.status);
    }
    return handleError(error);
  }
}

Deno.serve(handler);
