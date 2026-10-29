/* Endpoint simples para confirmar que a API PRELUX está respondendo. */
import { ensurePost, handleError, json } from "../_shared/http.js";

async function handler(request: Request) {
  try {
    const method = ensurePost(request);
    if (method === "options") return json({ ok: true });

    return json({
      ok: true,
      service: "prelux-production-api",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return handleError(error);
  }
}

Deno.serve(handler);
