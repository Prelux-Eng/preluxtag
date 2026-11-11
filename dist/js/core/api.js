/*
 * Transporte HTTP compartilhado da aplicação.
 *
 * Este módulo conhece somente a configuração pública e o formato das chamadas
 * para Edge Functions. As telas usam repositórios e nunca montam URLs ou
 * cabeçalhos por conta própria. A chave service_role não pode entrar no app.
 */

export class PreluxApiError extends Error {
  constructor(message, status, details = null) {
    super(message);
    this.name = "PreluxApiError";
    this.status = status;
    this.details = details;
  }
}

/** Envia uma ação para uma Supabase Edge Function e normaliza a resposta. */
export async function invoke(functionName, payload = {}) {
  const current = window.PRELUX_CONFIG || {};
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
