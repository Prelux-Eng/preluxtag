/*
 * Camada de transporte HTTP do Prelux.
 *
 * Defina window.PRELUX_CONFIG antes deste arquivo ser carregado:
 * {
 *   supabaseUrl: "https://SEU-PROJETO.supabase.co",
 *   supabaseAnonKey: "SUA_CHAVE_ANON",
 *   organizationId: "11111111-1111-4111-8111-111111111111"
 * }
 *
 * Este módulo só sabe enviar uma requisição a uma Edge Function e converter
 * respostas HTTP em dados ou erros. Os repositórios conhecem os endpoints de
 * cada área; as telas não montam URLs nem cabeçalhos.
 *
 * A chave service_role nunca deve aparecer aqui.
 */
(function attachPreluxApi(global) {
  class PreluxApiError extends Error {
    constructor(message, status, details = null) {
      super(message);
      this.name = "PreluxApiError";
      this.status = status;
      this.details = details;
    }
  }

  function config() {
    return global.PRELUX_CONFIG || {};
  }

  async function invoke(functionName, payload = {}) {
    const current = config();
    if (!current.supabaseUrl || !current.supabaseAnonKey) {
      throw new PreluxApiError(
        "API PRELUX ainda não configurada. Defina PRELUX_CONFIG.supabaseUrl e supabaseAnonKey.",
        0,
      );
    }

    const baseUrl = String(current.supabaseUrl).replace(/\/$/, "");
    const response = await fetch(`${baseUrl}/functions/v1/${functionName}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: current.supabaseAnonKey,
        Authorization: `Bearer ${current.supabaseAnonKey}`,
      },
      body: JSON.stringify({
        ...payload,
        ...(current.organizationId ? { organizationId: current.organizationId } : {}),
      }),
    });

    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    if (!response.ok) {
      throw new PreluxApiError(
        body?.error || `A API retornou HTTP ${response.status}.`,
        response.status,
        body?.details || body?.plan || null,
      );
    }
    return body;
  }

  // API global mantida pequena de propósito: é o cliente de transporte comum.
  global.PRELUX_API = { invoke, PreluxApiError };
})(window);
