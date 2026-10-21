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
    const db = createAdminClient(config);
    const plan = await buildOrderPlan({
      db,
      organizationId: config.organizationId,
      input,
    });

    if (!plan.feasible && input.allowInfeasible !== true) {
      return json(
        {
          error: "O plano não cabe no prazo solicitado.",
          code: "INFEASIBLE_PLAN",
          plan,
        },
        409,
      );
    }

    const { data: result, error } = await db.rpc("commit_order_plan", {
      p_org_id: config.organizationId,
      p_order_id: input.orderId,
      p_plan: plan,
    });
    if (error) throw error;

    return json({ ok: true, result, plan });
  } catch (error) {
    if (error instanceof OrderPlanningError && error.status < 500) {
      return json({ error: error.message, details: error.details }, error.status);
    }
    return handleError(error);
  }
}

Deno.serve(handler);
