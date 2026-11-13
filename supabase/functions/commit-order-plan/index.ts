/*
 * Endpoint legado desativado.
 * A confirmação válida agora ocorre em confirm-production-plan, que recalcula
 * o cenário e aprova orçamentos e reservas na mesma transação do banco.
 */
import { ensurePost, json } from "../_shared/http.js";

async function handler(request: Request) {
  const method = ensurePost(request);
  if (method === "options") return json({ ok: true });
  return json({
    error: "Esta rota de confirmação foi substituída. Atualize a simulação e confirme a fila na área Planejamento.",
  }, 410);
}

Deno.serve(handler);
