/*
 * Cliente HTTP mínimo para as Edge Functions da PRELUX.
 *
 * Defina window.PRELUX_CONFIG antes deste arquivo ser carregado:
 * {
 *   supabaseUrl: "https://SEU-PROJETO.supabase.co",
 *   supabaseAnonKey: "SUA_CHAVE_ANON",
 *   organizationId: "11111111-1111-4111-8111-111111111111"
 * }
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

  global.PRELUX_API = {
    invoke,
    health: () => invoke("health"),
    rebuildCalendar: (startDate, endDate) =>
      invoke("rebuild-calendar", { startDate, endDate }),
    getCalendar: (startDate, endDate) =>
      invoke("calendar-admin", { action: "get", startDate, endDate }),
    getPlanningData: (startDate, endDate) =>
      invoke("calendar-admin", { action: "planning_data", startDate, endDate }),
    getCalendarSettings: () => invoke("calendar-admin", { action: "get_settings" }),
    saveCalendarSettings: (input) =>
      invoke("calendar-admin", { action: "save_settings", ...input }),
    saveCalendarActivity: (input) =>
      invoke("calendar-admin", { action: "save_activity", ...input }),
    saveCalendarDay: (input) =>
      invoke("calendar-admin", { action: "save_day", ...input }),
    deleteCalendarActivity: (id, startDate, endDate) =>
      invoke("calendar-admin", { action: "delete_activity", id, startDate, endDate }),
    planOrder: (input) => invoke("plan-order", input),
    commitOrderPlan: (input) => invoke("commit-order-plan", input),
    getOperationsData: () => invoke("operations-admin", { action: "bootstrap" }),
    saveWork: (input) => invoke("operations-admin", { action: "save_work", ...input }),
    saveOrder: (input) => invoke("operations-admin", { action: "save_order", ...input }),
    savePieceType: (input) => invoke("operations-admin", { action: "save_piece_type", ...input }),
    saveMold: (input) => invoke("operations-admin", { action: "save_mold", ...input }),
    saveMoldPreparation: (input) => invoke("operations-admin", { action: "save_preparation", ...input }),
    saveResourceAllocation: (input) => invoke("operations-admin", { action: "save_allocation", ...input }),
    archiveOperationRecord: (kind, id) => invoke("operations-admin", { action: "archive", kind, id }),
    PreluxApiError,
  };
})(window);
