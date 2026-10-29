/*
 * Repositório de planejamento.
 *
 * Reúne os endpoints usados pelo calendário e pelo planejador de pedidos.
 * A interface chama estas funções; só este arquivo conhece os nomes das
 * Edge Functions e das ações aceitas pelo calendar-admin.
 */
(function attachPlanningRepository(global) {
  const api = global.PRELUX_API;
  const calendar = (action, input = {}) => api.invoke("calendar-admin", { action, ...input });

  global.PRELUX_REPOSITORIES ||= {};
  global.PRELUX_REPOSITORIES.planning = Object.freeze({
    rebuildCalendar: (startDate, endDate) => api.invoke("rebuild-calendar", { startDate, endDate }),
    getCalendar: (startDate, endDate) => calendar("get", { startDate, endDate }),
    getPlanningData: (startDate, endDate) => calendar("planning_data", { startDate, endDate }),
    getCalendarSettings: () => calendar("get_settings"),
    saveCalendarSettings: (input) => calendar("save_settings", input),
    saveCalendarActivity: (input) => calendar("save_activity", input),
    saveCalendarDay: (input) => calendar("save_day", input),
    deleteCalendarActivity: (id, startDate, endDate) =>
      calendar("delete_activity", { id, startDate, endDate }),
    planOrder: (input) => api.invoke("plan-order", input),
    commitOrderPlan: (input) => api.invoke("commit-order-plan", input),
  });
})(window);
