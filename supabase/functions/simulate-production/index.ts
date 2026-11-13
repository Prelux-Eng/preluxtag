/*
 * Simula um ou mais pedidos junto com a fila aprovada da fábrica.
 * Esta rota faz somente leituras: confirmação e reserva são outra operação.
 */
import { getServerConfig } from "../_shared/env.js";
import { ensurePost, handleError, json, readJson } from "../_shared/http.js";
import { FactorySimulationError, simulateProductionOrders } from "../_shared/factory-simulation-service.js";
import { PlannerError } from "../_shared/planner.js";
import { createAdminClient } from "../_shared/supabaseClient.js";

async function handler(request: Request) {
  try {
    const method = ensurePost(request);
    if (method === "options") return json({ ok: true });
    const config = getServerConfig();
    const input = await readJson(request);
    const scenario = await simulateProductionOrders({
      db: createAdminClient(config),
      organizationId: config.organizationId,
      input: { ...input, allowEmpty: true },
    });
    const { commitContext: _internalContext, ...publicScenario } = scenario;
    return json({ ok: true, scenario: publicScenario });
  } catch (error) {
    if (error instanceof FactorySimulationError || error instanceof PlannerError) {
      return json({ error: error.message, details: error.details ?? null }, error.status ?? 422);
    }
    return handleError(error);
  }
}

Deno.serve(handler);
