/*
 * Portas de acesso ao planejamento.
 *
 * Este repositório traduz operações da tela em nomes de Edge Functions e
 * ações. Assim, a interface não depende do contrato HTTP do Supabase.
 */
import { invoke } from "../core/api.js";

const calendar = (action, input = {}) => invoke("calendar-admin", { action, ...input });

export const planningRepository = Object.freeze({
  rebuildCalendar: (startDate, endDate) => invoke("rebuild-calendar", { startDate, endDate }),
  getCalendar: (startDate, endDate) => calendar("get", { startDate, endDate }),
  getPlanningData: (startDate, endDate) => calendar("planning_data", { startDate, endDate }),
  getCalendarSettings: () => calendar("get_settings"),
  saveCalendarSettings: (input) => calendar("save_settings", input),
  saveCalendarActivity: (input) => calendar("save_activity", input),
  saveCalendarDay: (input) => calendar("save_day", input),
  deleteCalendarActivity: (id, startDate, endDate) =>
    calendar("delete_activity", { id, startDate, endDate }),
  simulateProduction: (orderIds = []) => invoke("simulate-production", { orderIds }),
  planOrder: (input) => invoke("plan-order", input),
  commitOrderPlan: (input) => invoke("commit-order-plan", input),
});
