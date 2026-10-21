export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, ...extraHeaders },
  });
}

export function fail(message, status = 500, details = null) {
  return json(
    {
      error: message,
      ...(details ? { details } : {}),
    },
    status,
  );
}

export async function readJson(request) {
  try {
    const payload = await request.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("O corpo da requisição deve ser um objeto JSON.");
    }
    return payload;
  } catch (error) {
    throw Object.assign(new Error(error.message || "JSON inválido."), { status: 400 });
  }
}

export function ensurePost(request) {
  if (request.method === "OPTIONS") return "options";
  if (request.method !== "POST") {
    throw Object.assign(new Error("Método não permitido. Use POST."), { status: 405 });
  }
  return "post";
}

export function handleError(error) {
  const status = Number(error?.status) || 500;
  const safeStatus = status >= 400 && status <= 599 ? status : 500;
  return fail(
    safeStatus >= 500 ? "Erro interno ao processar a operação." : error.message,
    safeStatus,
    safeStatus >= 500 ? null : error.details ?? null,
  );
}
