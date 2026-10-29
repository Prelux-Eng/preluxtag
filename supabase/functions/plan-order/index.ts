/*
 * Simula datas e etapas de um pedido sem confirmar sua programação.
 * A mesma fila compartilhada é usada depois pela função de confirmação.
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
    const queuePlan = await buildPlanningQueue({
      db: createAdminClient(config),
      organizationId: config.organizationId,
      input: {
        orderId: input.orderId,
        startDate: input.startDate,
        requestedDueDate: input.requestedDueDate,
      },
    });

    const queueWarnings = queuePlan.plans.flatMap(({ orderId, plan }) =>
      plan.feasible || orderId === input.orderId
        ? []
        : [{ orderId, orderNumber: plan.order?.orderNumber || null, conflicts: plan.conflicts }]
    ).slice(0, 20);
    return json({ ok: true, plan: queuePlan.targetPlan, queue: queuePlan.queue, queueWarnings });
  } catch (error) {
    if (error instanceof OrderPlanningError && error.status < 500) {
      return json({ error: error.message, details: error.details }, error.status);
    }
    return handleError(error);
  }
}

Deno.serve(handler);
