/*
 * Portas de acesso ao planejamento.
 *
 * Este repositório traduz operações da tela em nomes de Edge Functions e
 * ações. Assim, a interface não depende do contrato HTTP do Supabase.
 */
import { invoke } from "../core/api.js";

const calendar = (action, input = {}) => invoke("calendar-admin", { action, ...input });
const CONFIRMATION_KEY_STORAGE = "prelux:pending-plan-confirmation";
let inMemoryConfirmation = null;

function newIdempotencyKey() {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function readPendingConfirmation() {
  try {
    const stored = globalThis.sessionStorage?.getItem(CONFIRMATION_KEY_STORAGE);
    return stored ? JSON.parse(stored) : inMemoryConfirmation;
  } catch {
    return inMemoryConfirmation;
  }
}

function savePendingConfirmation(value) {
  inMemoryConfirmation = value;
  try { globalThis.sessionStorage?.setItem(CONFIRMATION_KEY_STORAGE, JSON.stringify(value)); } catch { /* armazenamento opcional */ }
}

function clearPendingConfirmation(key) {
  if (inMemoryConfirmation?.key === key) inMemoryConfirmation = null;
  try {
    const current = readPendingConfirmation();
    if (current?.key === key) globalThis.sessionStorage?.removeItem(CONFIRMATION_KEY_STORAGE);
  } catch { /* armazenamento opcional */ }
}

async function confirmProductionPlan(orderIds = []) {
  const ids = [...new Set(orderIds.map((id) => String(id).trim()))];
  const fingerprint = JSON.stringify([...ids].sort());
  let pending = readPendingConfirmation();
  if (!pending || pending.fingerprint !== fingerprint || !pending.key) {
    pending = { fingerprint, key: newIdempotencyKey() };
    savePendingConfirmation(pending);
  }

  try {
    const response = await invoke("confirm-production-plan", {
      confirmScenario: true,
      orderIds: ids,
      idempotencyKey: pending.key,
    });
    clearPendingConfirmation(pending.key);
    return response;
  } catch (error) {
    // Em falha de rede, conserva a chave. Repetir a solicitação devolve o
    // recibo do servidor, mesmo que o primeiro commit já tenha sido concluído.
    throw error;
  }
}

export const planningRepository = Object.freeze({
  rebuildCalendar: (startDate, endDate) => invoke("rebuild-calendar", { startDate, endDate }),
  getCalendar: (startDate, endDate) => calendar("get", { startDate, endDate }),
  getPlanningData: (startDate, endDate) => calendar("planning_data", { startDate, endDate }),
  getPlanningPeriods: (orderIds) => calendar("planning_periods", { orderIds }),
  getCalendarSettings: () => calendar("get_settings"),
  saveCalendarSettings: (input) => calendar("save_settings", input),
  saveCalendarActivity: (input) => calendar("save_activity", input),
  saveCalendarDay: (input) => calendar("save_day", input),
  deleteCalendarActivity: (id, startDate, endDate) =>
    calendar("delete_activity", { id, startDate, endDate }),
  simulateProduction: (orderIds = []) => invoke("simulate-production", { orderIds }),
  confirmProductionPlan,
  planOrder: (input) => invoke("plan-order", input),
  commitOrderPlan: (input) => invoke("commit-order-plan", input),
});
