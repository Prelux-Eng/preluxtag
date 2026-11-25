import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPlanningPrintReport,
  renderPlanningPrintReport,
} from "../dist/js/features/planning/print-report.js";

function scenario(orderId, castDate, forecastEndDate, status = "aprovado") {
  return {
    orderId,
    orderNumber: orderId,
    status,
    totalRequestedQuantity: 1,
    totalPlannedQuantity: 1,
    forecastEndDate,
    units: [{ castDate }],
  };
}

test("PDF mostra quando um pedido termina e o seguinte começa, mesmo entre meses", () => {
  const report = buildPlanningPrintReport({
    orders: [
      { id: "PED-0001", status: "aprovado" },
      { id: "PED-0002", status: "aprovado" },
    ],
    scenarioOrders: [
      scenario("PED-0001", "2026-12-28", "2027-01-04"),
      scenario("PED-0002", "2027-01-05", "2027-01-12"),
    ],
  });
  assert.deepEqual(report.entries.map(({ number, startDate, endDate }) => [number, startDate, endDate]), [
    ["PED-0001", "2026-12-28", "2027-01-04"],
    ["PED-0002", "2027-01-05", "2027-01-12"],
  ]);
  assert.deepEqual(report.months.map((month) => month.key), ["2026-12", "2027-01"]);
  const html = renderPlanningPrintReport(report);
  assert.match(html, /Início da concretagem 28\/12\/2026 · Conclusão prevista 04\/01\/2027/);
  assert.match(html, /Início da concretagem 05\/01\/2027 · Conclusão prevista 12\/01\/2027/);
});

test("calendário mantém pedidos simultâneos no mesmo dia", () => {
  const report = buildPlanningPrintReport({
    scenarioOrders: [
      scenario("PED-A", "2026-11-03", "2026-11-12"),
      scenario("PED-B", "2026-11-07", "2026-11-15"),
    ],
  });
  const day = report.months[0].weeks.flat().find((item) => item.date === "2026-11-08");
  assert.deepEqual(day.entries.map((entry) => entry.number), ["PED-A", "PED-B"]);
  assert.match(renderPlanningPrintReport(report), /planning-print-weekdays/);
});

test("pedido iniciado usa datas agregadas da produção, nunca prazo solicitado", () => {
  const report = buildPlanningPrintReport({
    orders: [{
      id: "PED-ATIVO", order_number: "PED-ATIVO", status: "em_producao",
      start_date: "2026-01-01", requested_due_date: "2026-02-01",
      planned_start_date: "2026-01-12", planned_end_date: "2026-01-18",
      forecast_end_date: "2026-01-20",
    }],
    startedOrderIds: ["PED-ATIVO"],
  });
  assert.equal(report.entries[0].startDate, "2026-01-12");
  assert.equal(report.entries[0].endDate, "2026-01-20");
  assert.equal(report.entries[0].kind, "started");
});

test("período consultado substitui datas antigas do pedido iniciado e exige programação completa", () => {
  const order = {
    id: "PED-INICIADO", status: "em_producao",
    planned_start_date: "2026-01-02", forecast_end_date: "2026-01-08",
  };
  const partial = buildPlanningPrintReport({
    orders: [order],
    productionPeriods: [{
      order_id: "PED-INICIADO", planned_start_date: "2026-02-03",
      forecast_end_date: "2026-02-20", complete: false,
    }],
  });
  assert.equal(partial.entries[0].startDate, "2026-02-03");
  assert.equal(partial.entries[0].endDate, null);
  assert.match(renderPlanningPrintReport(partial), /Conclusão aguardando programação/);

  const complete = buildPlanningPrintReport({
    orders: [order],
    productionPeriods: [{
      order_id: "PED-INICIADO", planned_start_date: "2026-02-03",
      forecast_end_date: "2026-02-20", complete: true,
    }],
  });
  assert.equal(complete.entries[0].endDate, "2026-02-20");

  const missing = buildPlanningPrintReport({ orders: [order], productionPeriods: [] });
  assert.equal(missing.entries[0].startDate, null);
  assert.equal(missing.entries[0].endDate, null);
});

test("previsão parcial informa pendência sem declarar conclusão", () => {
  const incomplete = {
    ...scenario("PED-PARCIAL", "2026-04-07", "2026-04-30"),
    totalRequestedQuantity: 3,
    totalPlannedQuantity: 1,
  };
  const report = buildPlanningPrintReport({ scenarioOrders: [incomplete] });
  assert.equal(report.entries[0].startDate, "2026-04-07");
  assert.equal(report.entries[0].endDate, null);
  assert.match(renderPlanningPrintReport(report), /Conclusão aguardando programação/);
  assert.equal(report.months.length, 1);
});

test("orçamento só entra quando selecionado na simulação e fica identificado", () => {
  const order = { id: "ORC-1", status: "orcamento", order_number: "ORC-1" };
  assert.equal(buildPlanningPrintReport({ orders: [order] }).entries.length, 0);
  const report = buildPlanningPrintReport({
    orders: [order],
    scenarioOrders: [scenario("ORC-1", "2026-05-04", "2026-05-08", "orcamento")],
  });
  assert.equal(report.entries[0].kind, "quote");
  assert.match(renderPlanningPrintReport(report), /Orçamento simulado/);
});

test("pedido sem programação aparece como pendente e texto de usuário é escapado", () => {
  const report = buildPlanningPrintReport({ orders: [{
    id: "pendente", status: "aprovado", order_number: "PED <script>",
    start_date: "2026-02-01", requested_due_date: "2026-02-20",
  }] });
  assert.equal(report.months.length, 0);
  assert.equal(report.pending.length, 1);
  const html = renderPlanningPrintReport(report);
  assert.match(html, /PED &lt;script&gt;/);
  assert.doesNotMatch(html, /PED <script>/);
  assert.match(html, /Início pendente/);
});
