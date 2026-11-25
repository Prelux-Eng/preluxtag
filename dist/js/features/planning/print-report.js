/*
 * Calendário exclusivo do PDF de Planejamento.
 * Datas de produção vêm da previsão calculada ou do plano de pedidos iniciados;
 * datas informadas no cadastro não substituem uma programação ausente.
 */

const plannedStatuses = new Set(["aprovado", "em_producao", "atrasado"]);
const colors = 6;
const weekdays = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? value : null;
}

function addDays(value, amount) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function formatDate(value) {
  return value ? `${value.slice(8, 10)}/${value.slice(5, 7)}/${value.slice(0, 4)}` : "—";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function scenarioPeriod(scenario) {
  const units = Array.isArray(scenario?.units) ? scenario.units : [];
  const starts = units.map((unit) => validDate(unit.castDate)).filter(Boolean).sort();
  const startDate = starts[0] || null;
  const requested = Number(scenario?.totalRequestedQuantity);
  const planned = Number(scenario?.totalPlannedQuantity);
  const complete = Number.isInteger(requested) && requested > 0 && Number.isInteger(planned) && planned >= requested;
  const forecastEnd = complete ? validDate(scenario?.forecastEndDate) : null;
  return { startDate, endDate: startDate && forecastEnd >= startDate ? forecastEnd : null };
}

function storedPeriod(order) {
  const startDate = validDate(order?.planned_start_date);
  const forecastEnd = validDate(order?.forecast_end_date);
  const plannedEnd = validDate(order?.planned_end_date);
  const endDate = startDate && [forecastEnd, plannedEnd].find((date) => date && date >= startDate) || null;
  return { startDate, endDate };
}

function productionPeriod(period) {
  const startDate = validDate(period?.planned_start_date);
  const forecastEnd = period?.complete === true ? validDate(period?.forecast_end_date) : null;
  return { startDate, endDate: startDate && forecastEnd >= startDate ? forecastEnd : null };
}

function monthKey(date) {
  return date.slice(0, 7);
}

function createMonth(key, entries) {
  const [year, month] = key.split("-").map(Number);
  const first = `${key}-01`;
  const next = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;
  const last = addDays(next, -1);
  const weekday = (new Date(`${first}T00:00:00.000Z`).getUTCDay() + 6) % 7;
  const gridStart = addDays(first, -weekday);
  const monthEntries = entries.filter((entry) =>
    entry.startDate && entry.startDate <= last && (entry.endDate || entry.startDate) >= first
  );
  const weeks = [];
  for (let weekStart = gridStart; weekStart <= last; weekStart = addDays(weekStart, 7)) {
    weeks.push(Array.from({ length: 7 }, (_, offset) => {
      const date = addDays(weekStart, offset);
      return {
        date,
        inMonth: monthKey(date) === key,
        entries: monthKey(date) === key
          ? monthEntries.filter((entry) => entry.startDate <= date && date <= (entry.endDate || entry.startDate))
          : [],
      };
    }));
  }
  return {
    key,
    label: (() => {
      const label = new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" })
        .format(new Date(`${first}T00:00:00.000Z`));
      return label[0].toUpperCase() + label.slice(1);
    })(),
    entries: monthEntries,
    weeks,
  };
}

/** Produz períodos e meses completos a partir da fila vigente, sem inventar prazos. */
export function buildPlanningPrintReport(input = {}) {
  const { orders = [], scenarioOrders = [], startedOrderIds = [], productionPeriods } = input;
  const hasProductionPeriods = Object.hasOwn(input, "productionPeriods");
  const started = new Set(startedOrderIds);
  const baseOrders = new Map((orders || []).filter((order) => order?.id).map((order) => [order.id, order]));
  const scenarios = new Map((scenarioOrders || []).filter((order) => order?.orderId)
    .map((order) => [order.orderId, order]));
  const periods = new Map((Array.isArray(productionPeriods) ? productionPeriods : [])
    .filter((period) => period?.order_id).map((period) => [period.order_id, period]));
  const ids = new Set([
    ...[...baseOrders.values()].filter((order) => plannedStatuses.has(order.status)).map((order) => order.id),
    ...[...scenarios.values()].filter((order) => order.status === "orcamento" || plannedStatuses.has(order.status))
      .map((order) => order.orderId),
  ]);

  const entries = [...ids].flatMap((id) => {
    const order = baseOrders.get(id) || {};
    const scenario = scenarios.get(id);
    const status = order.status || scenario?.status;
    if (status === "orcamento" && scenario?.status !== "orcamento") return [];
    if (!plannedStatuses.has(status) && status !== "orcamento") return [];
    const isQuote = status === "orcamento";
    const isStarted = !isQuote && (started.has(id) || status === "em_producao");
    const period = isStarted
      ? hasProductionPeriods ? productionPeriod(periods.get(id)) : storedPeriod(order)
      : scenarioPeriod(scenario);
    return [{
      id,
      number: order.order_number || scenario?.orderNumber || "Pedido sem número",
      kind: isQuote ? "quote" : isStarted ? "started" : "forecast",
      startDate: period.startDate,
      endDate: period.endDate,
    }];
  }).sort((left, right) =>
    (left.startDate || "9999-12-31").localeCompare(right.startDate || "9999-12-31")
    || left.number.localeCompare(right.number, "pt-BR")
  ).map((entry, index) => ({ ...entry, color: index % colors + 1 }));

  const dated = entries.filter((entry) => entry.startDate);
  const first = dated.map((entry) => entry.startDate).sort()[0];
  const last = dated.map((entry) => entry.endDate || entry.startDate).sort().at(-1);
  const months = [];
  if (first && last) {
    let year = Number(first.slice(0, 4));
    let month = Number(first.slice(5, 7));
    while (`${year}-${String(month).padStart(2, "0")}` <= monthKey(last)) {
      if (months.length >= 60) throw new RangeError("A programação ultrapassa cinco anos. Revise as datas antes de gerar o PDF.");
      months.push(createMonth(`${year}-${String(month).padStart(2, "0")}`, entries));
      month += 1;
      if (month === 13) { year += 1; month = 1; }
    }
  }
  return { entries, months, pending: entries.filter((entry) => !entry.startDate) };
}

function renderDay(day) {
  const chips = day.entries.map((entry) => {
    const marker = entry.startDate === day.date && entry.endDate === day.date ? "início e fim"
      : entry.startDate === day.date ? "início"
        : entry.endDate === day.date ? "fim" : "";
    return `<span class="planning-print-order color-${entry.color}${entry.kind === "quote" ? " quote" : ""}">`+
      `${escapeHtml(entry.number)}${marker ? `<small class="planning-print-marker">${marker}</small>` : ""}</span>`;
  }).join("");
  return `<div class="planning-print-day${day.inMonth ? "" : " outside"}">`+
    `<span class="planning-print-day-number">${Number(day.date.slice(-2))}</span><div class="planning-print-day-orders">${chips}</div></div>`;
}

function renderPeriod(entry) {
  const state = entry.kind === "quote" ? "Orçamento simulado" : entry.kind === "started" ? "Em produção" : "Previsão";
  const start = entry.startDate ? `Início da concretagem ${formatDate(entry.startDate)}` : "Início pendente";
  const end = entry.endDate ? `Conclusão prevista ${formatDate(entry.endDate)}` : "Conclusão aguardando programação";
  return `<div class="planning-print-period color-${entry.color}${entry.kind === "quote" ? " quote" : ""}">`+
    `<strong>${escapeHtml(entry.number)}</strong><span>${start} · ${end}</span><small>${state}</small></div>`;
}

/** HTML do PDF: somente calendário mensal e datas de cada pedido. */
export function renderPlanningPrintReport(report, { generatedAt = "" } = {}) {
  const meta = generatedAt ? `<small>Gerado em ${escapeHtml(generatedAt)}</small>` : "";
  const reportMonths = report?.months || [];
  const months = reportMonths.map((month, index) => `<section class="planning-print-month${index === reportMonths.length - 1 ? " last-month" : ""}" style="--planning-week-count:${month.weeks.length}"><img class="planning-print-page-background" src="./assets/planning-pdf-background.png" alt="" aria-hidden="true" />`+
    `<header class="planning-print-heading"><div><span>PLANEJAMENTO</span><h2>Calendário de produção</h2></div><div><strong>${escapeHtml(month.label)}</strong>${meta}</div></header>`+
    `<div class="planning-print-calendar"><div class="planning-print-weekdays">${weekdays.map((day) => `<span>${day}</span>`).join("")}</div>`+
    `${month.weeks.map((week) => `<div class="planning-print-week">${week.map(renderDay).join("")}</div>`).join("")}</div>`+
    `<div class="planning-print-periods">${month.entries.map(renderPeriod).join("")}</div>`+
    `</section>`).join("");
  const pending = report?.pending?.length
    ? `<section class="planning-print-pending-page"><img class="planning-print-page-background" src="./assets/planning-pdf-background.png" alt="" aria-hidden="true" /><div class="planning-print-pending"><h3>Pedidos sem início previsto</h3>${report.pending.map(renderPeriod).join("")}</div></section>`
    : "";
  return `<div class="planning-print-report-inner">${months}${pending}</div>`;
}
