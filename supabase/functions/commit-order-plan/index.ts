/*
 * Confirma no banco uma simulação aprovada pela tela de Planejamento.
 * A função valida novamente os dados no servidor antes de persistir a fila.
 */
import { getServerConfig } from "../_shared/env.js";
import { ensurePost, handleError, json, readJson } from "../_shared/http.js";
import { buildPlanningQueue, OrderPlanningError } from "../_shared/order-planning.js";
import { createAdminClient } from "../_shared/supabaseClient.js";

async function handler(request: Request) {
  try {
    const method = ensurePost(request);
    if (method === "options") return json({ ok: true });

    const config = getServerConfig();
    const input = await readJson(request);
    const db = createAdminClient(config);
    const queuePlan = await buildPlanningQueue({
      db,
      organizationId: config.organizationId,
      input: {
        orderId: input.orderId,
        startDate: input.startDate,
        requestedDueDate: input.requestedDueDate,
      },
    });

    if (queuePlan.queue.infeasibleOrderIds.length && input.allowInfeasible !== true) {
      return json(
        {
          error: "Um ou mais pedidos da fila não cabem nos prazos solicitados.",
          code: "INFEASIBLE_PLAN",
          plan: queuePlan.targetPlan,
          queue: queuePlan.queue,
        },
        409,
      );
    }

    const { data: result, error } = await db.rpc("commit_planning_queue", {
      p_org_id: config.organizationId,
      p_plans: queuePlan.plans.map((entry) => ({ orderId: entry.orderId, plan: entry.plan })),
    });
    if (error) throw error;

    return json({ ok: true, result, plan: queuePlan.targetPlan, queue: queuePlan.queue });
  } catch (error) {
    if (error instanceof OrderPlanningError && error.status < 500) {
      return json({ error: error.message, details: error.details }, error.status);
    }
    return handleError(error);
  }
}

Deno.serve(handler);
