/* Recalcula no servidor e confirma a fila em uma única transação do banco. */
import { getServerConfig } from "../_shared/env.js";
import { ensurePost, handleError, json, readJson } from "../_shared/http.js";
import { FactorySimulationError } from "../_shared/factory-simulation-service.js";
import { confirmFactoryPlan } from "../_shared/factory-plan-service.js";
import { createAdminClient } from "../_shared/supabaseClient.js";

async function handler(request: Request) {
  try {
    const method = ensurePost(request);
    if (method === "options") return json({ ok: true });

    const input = await readJson(request);
    if (input.confirmScenario !== true) {
      throw new FactorySimulationError("Confirme explicitamente a fila antes de gravar as reservas.", 400);
    }
    const config = getServerConfig();
    const confirmation = await confirmFactoryPlan({
      db: createAdminClient(config),
      organizationId: config.organizationId,
      orderIds: input.orderIds ?? [],
      idempotencyKey: input.idempotencyKey,
    });
    return json({ ok: true, ...confirmation });
  } catch (error) {
    if (error instanceof FactorySimulationError) {
      return json({ error: error.message }, error.status);
    }
    return handleError(error);
  }
}

Deno.serve(handler);
