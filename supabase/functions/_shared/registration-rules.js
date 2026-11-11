/*
 * Regras puras do cadastro único Pedido + Peça.
 * O banco continua sendo a autoridade para reservar o próximo número do pedido.
 */

export class RegistrationRuleError extends Error {
  constructor(message, status = 422) {
    super(message);
    this.name = "RegistrationRuleError";
    this.status = status;
  }
}

/** Soma dias corridos a uma data ISO sem depender do fuso horário do servidor. */
export function addCalendarDays(value, amount) {
  const dateText = String(value ?? "").trim();
  const days = Number(amount);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText) || !Number.isInteger(days)) {
    throw new RegistrationRuleError("Informe uma data válida e uma quantidade inteira de dias.");
  }
  const date = new Date(`${dateText}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== dateText) {
    throw new RegistrationRuleError("Informe uma data válida.");
  }
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Usa +90 dias corridos até o usuário editar manualmente o prazo. */
export function resolveRequestedDueDate({ startDate, manualDate = "", manuallyEdited = false, days = 90 } = {}) {
  const start = String(startDate ?? "").trim();
  const due = manuallyEdited ? String(manualDate ?? "").trim() : addCalendarDays(start, days);
  if (!due) throw new RegistrationRuleError("Informe o prazo previsto.");
  if (due < start) throw new RegistrationRuleError("A data prevista não pode ser anterior ao início.");
  return due;
}

/** Mostra uma prévia sequencial; a RPC gera o valor definitivo sob bloqueio transacional. */
export function previewNextOrderNumber(orderNumbers = []) {
  const maxExisting = (Array.isArray(orderNumbers) ? orderNumbers : []).reduce((currentMax, value) => {
    const match = String(value ?? "").trim().match(/^PED-(\d+)$/i);
    return match ? Math.max(currentMax, Number(match[1])) : currentMax;
  }, 0);
  return `PED-${String(maxExisting + 1).padStart(4, "0")}`;
}

/** Exige o tempo configurado para o tipo de peça antes de abrir um cadastro. */
export function productionMinutesForKind(pieceKind, configuredMinutes = {}) {
  const kind = String(pieceKind ?? "").trim();
  if (!["braco", "pilar", "viga"].includes(kind)) {
    throw new RegistrationRuleError("Selecione braço, pilar ou viga.");
  }
  const minutes = Number(configuredMinutes?.[kind]);
  if (!Number.isInteger(minutes) || minutes <= 0) {
    throw new RegistrationRuleError(`Configure o tempo padrão de ${kind} em minutos por unidade antes de cadastrar esta peça.`, 409);
  }
  return minutes;
}
