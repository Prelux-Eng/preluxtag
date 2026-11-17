/*
 * API de leitura para as telas futuras de Engenharia.
 * As gravações de parâmetros permanecem restritas à migration/RPC de serviço
 * enquanto a aplicação ainda não tem autenticação por perfil.
 */
import { getServerConfig } from "../_shared/env.js";
import { EngineeringValidationError } from "../_shared/engineering-domain.js";
import {
  calculateEngineeringPieceMetrics,
  getCompatibleMoldOptions,
  getEngineeringConfiguration,
} from "../_shared/engineering-service.js";
import { ensurePost, handleError, json, readJson } from "../_shared/http.js";
import { createAdminClient } from "../_shared/supabaseClient.js";

function badRequest(message: string) {
  return Object.assign(new Error(message), { status: 400 });
}

async function handler(request: Request): Promise<Response> {
  try {
    const method = ensurePost(request);
    if (method === "options") return json({ ok: true });

    const input = await readJson(request);
    const action = String(input.action || "").trim();
    const config = getServerConfig();
    const db = createAdminClient(config);

    if (action === "get_configuration") {
      const engineering = await getEngineeringConfiguration(db, config.organizationId);
      return json({ ok: true, engineering });
    }

    if (action === "list_mold_options") {
      const pieceKind = String(input.pieceKind || "").trim();
      const options = await getCompatibleMoldOptions(db, pieceKind);
      return json({ ok: true, pieceKind, options });
    }

    if (action === "calculate_piece_metrics") {
      if (!input.dimensions || typeof input.dimensions !== "object" || Array.isArray(input.dimensions)) {
        throw badRequest("Envie as dimensões X, Y e Z em centímetros.");
      }
      const metrics = await calculateEngineeringPieceMetrics(db, config.organizationId, {
        pieceKind: input.pieceKind,
        dimensions: input.dimensions,
      });
      return json({ ok: true, metrics });
    }

    // Não há identidade de usuário nesta fase; não expor escrita administrativa
    // usando service_role em uma rota acessível pela chave pública do navegador.
    if (action === "create_parameter_version") {
      return json({
        error: "A alteração de parâmetros exige autenticação de Engenharia.",
        code: "ENGINEERING_AUTH_REQUIRED",
      }, 403);
    }

    throw badRequest("Ação de Engenharia inválida.");
  } catch (error) {
    if (error instanceof EngineeringValidationError) {
      return json({ error: error.message }, error.status);
    }
    return handleError(error);
  }
}

Deno.serve(handler);
