import assert from "node:assert/strict";
import test from "node:test";

import { buildCalendarDays } from "../supabase/functions/_shared/calendar.js";
import { FACTORY_RULES, simulateFactory } from "../supabase/functions/_shared/factory-simulator.js";
import { simulateProductionOrders } from "../supabase/functions/_shared/factory-simulation-service.js";

function calendar(startDate = "2026-01-05", endDate = "2026-07-31", exceptions = []) {
  return buildCalendarDays({
    startDate,
    endDate,
    settings: { default_capacity_minutes: 480 },
    exceptions,
  });
}

function position(code, config = {}) {
  return { code, status: "disponivel", ...config };
}

function viga(quantity = 1) {
  return {
    id: "item-viga",
    pieceTypeId: "piece-viga",
    pieceKind: "viga",
    requiredMoldCodes: ["LEITO_20", "LATERAL_25"],
    dimensionXcm: 20,
    dimensionYcm: 100,
    dimensionZcm: 25,
    quantity,
    sequence: 1,
  };
}

function order(id, quantity = 1, status = "aprovado", approvedAt = "2026-01-01T08:00:00Z") {
  return {
    id,
    orderNumber: id,
    status,
    approvedAt,
    createdAt: approvedAt,
    startDate: "2026-01-05",
    requestedDueDate: "2026-04-05",
    items: [viga(quantity)],
  };
}

const ready = {
  configurationKind: "pilar_viga",
  leitoCatalogCode: "LEITO_20",
  lateralCatalogCode: "LATERAL_25",
};

test("pedido isolado: quatro posições prontas concretam quatro peças por dia útil", () => {
  const result = simulateFactory({
    calendarDays: calendar(),
    positions: ["P01", "P02", "P03", "P04"].map((code) => position(code, ready)),
    orders: [order("PED-0001", 5)],
  });
  const plan = result.orders[0];
  assert.equal(plan.totalPlannedQuantity, 5);
  assert.equal(plan.units.filter((unit) => unit.castDate === "2026-01-05").length, 4);
  assert.equal(plan.units[4].castDate, "2026-01-06");
  assert.equal(plan.plannedEndDate, "2026-01-09");
  assert.equal(plan.feasible, true);
  assert.equal(plan.totalVolumeM3, 0.25);
  assert.equal(plan.totalWeightKg, 625);
});

test("forma já pronta dispensa preparação; a cura libera a posição para a próxima concretagem", () => {
  const result = simulateFactory({
    calendarDays: calendar(),
    positions: [position("P01", ready)],
    orders: [order("PED-0001", 2)],
  });
  assert.deepEqual(result.orders[0].units.map((unit) => [
    unit.preparationStartDate, unit.castDate, unit.cureEndDate, unit.finishDate,
  ]), [
    [null, "2026-01-05", "2026-01-07", "2026-01-08"],
    [null, "2026-01-06", "2026-01-08", "2026-01-09"],
  ]);
  assert.equal(result.positionUsage[0].preparationDays, 0);
});

test("forma não pronta ocupa a posição por cinco dias úteis antes da concretagem", () => {
  const result = simulateFactory({
    calendarDays: calendar(),
    positions: [position("P01")],
    orders: [order("PED-0001")],
  });
  const unit = result.orders[0].units[0];
  assert.deepEqual([
    unit.preparationStartDate, unit.preparationEndDate, unit.castDate,
    unit.cureEndDate, unit.finishDate,
  ], ["2026-01-05", "2026-01-09", "2026-01-12", "2026-01-14", "2026-01-15"]);
  assert.equal(result.positionUsage[0].occupiedDays, 6);
});

test("pedido antigo começa a programação hoje sem mudar o prazo contratual", () => {
  const result = simulateFactory({
    calendarDays: calendar(),
    positions: [position("P01", ready)],
    orders: [order("PED-0001")],
    earliestSchedulingDate: "2026-01-07",
  });
  assert.equal(result.orders[0].units[0].castDate, "2026-01-07");
  assert.equal(result.orders[0].startDate, "2026-01-05");
  assert.equal(result.orders[0].maximumDueDate, "2026-04-05");
});

test("forma concluída dispensa preparação, mas desmontagem descarta o estado antigo", () => {
  const mounted = simulateFactory({
    calendarDays: calendar(),
    positions: [position("P01", { installedMoldCatalogCodes: ["LEITO_20", "LATERAL_25"] })],
    orders: [order("PED-0001")],
  });
  assert.equal(mounted.orders[0].units[0].preparationStartDate, null);

  const dismantled = simulateFactory({
    calendarDays: calendar(),
    positions: [position("P01", {
      ...ready,
      formResetAt: "2026-01-05T12:00:00.000Z",
      formResetLocalDate: "2026-01-05",
    })],
    existingReservations: [{
      positionCode: "P01", status: "done", startDate: "2026-01-02", endDate: "2026-01-02",
      occupiedUntilAt: "2026-01-02T20:00:00.000Z",
      moldCatalogCodes: ["LEITO_20", "LATERAL_25"],
    }],
    orders: [order("PED-0001")],
  });
  assert.equal(dismantled.orders[0].units[0].preparationStartDate, "2026-01-05");
  assert.equal(dismantled.orders[0].units[0].castDate, "2026-01-12");
});

test("posição em produção volta à fila após a reserva e conserva a forma", () => {
  const result = simulateFactory({
    calendarDays: calendar(),
    positions: [position("P01", { status: "em_producao" })],
    existingReservations: [{
      positionCode: "P01", status: "in_progress", startDate: "2026-01-05", endDate: "2026-01-05",
      occupiedUntilAt: "2026-01-05T20:00:00.000Z",
      moldCatalogCodes: ["LEITO_20", "LATERAL_25"],
    }],
    orders: [order("PED-0001")],
    earliestSchedulingDate: "2026-01-05",
  });
  assert.equal(result.orders[0].units[0].castDate, "2026-01-06");
  assert.equal(result.orders[0].units[0].preparationStartDate, null);
});

test("prazo acima de 90 dias informa excesso e quantidade que cabe no limite", () => {
  const result = simulateFactory({
    calendarDays: calendar(),
    positions: [position("P01", ready)],
    orders: [order("PED-0001", 70)],
  });
  const plan = result.orders[0];
  assert.equal(plan.maximumDueDate, "2026-04-05");
  assert.equal(plan.totalPlannedQuantity, 70);
  assert.equal(plan.plannedEndDate, "2026-04-13");
  assert.equal(plan.overLimitDays, 8);
  assert.equal(plan.maximumQuantityWithin90Days, 62);
  assert.equal(plan.feasible, false);
  assert.equal(plan.suggestedDueDate, plan.forecastEndDate);
});

test("dois pedidos simultâneos disputam a mesma posição por ordem de aprovação", () => {
  const result = simulateFactory({
    calendarDays: calendar(),
    positions: [position("P01", ready)],
    orders: [
      order("ORC-0002", 1, "orcamento", "2026-01-01T07:00:00Z"),
      order("PED-0001", 1, "aprovado", "2026-01-02T08:00:00Z"),
    ],
  });
  assert.deepEqual(result.orders.map((entry) => [entry.orderId, entry.units[0].castDate]), [
    ["PED-0001", "2026-01-05"],
    ["ORC-0002", "2026-01-06"],
  ]);
  assert.equal(result.orders[0].reservesCapacityOnConfirmation, true);
  assert.equal(result.orders[1].reservesCapacityOnConfirmation, false);
});

test("pedido seguinte troca a forma e ocupa cinco dias úteis antes de concretar", () => {
  const next = order("PED-0002", 1, "aprovado", "2026-01-03T08:00:00Z");
  next.items = [{
    ...viga(1),
    id: "item-viga-30",
    requiredMoldCodes: ["LEITO_30", "LATERAL_40"],
    dimensionXcm: 30,
    dimensionZcm: 40,
  }];
  const result = simulateFactory({
    calendarDays: calendar(),
    positions: [position("P01", ready)],
    orders: [next, order("PED-0001", 1, "aprovado", "2026-01-02T08:00:00Z")],
  });
  assert.deepEqual(result.orders.map((entry) => [
    entry.orderId, entry.units[0].preparationStartDate,
    entry.units[0].preparationEndDate, entry.units[0].castDate,
  ]), [
    ["PED-0001", null, null, "2026-01-05"],
    ["PED-0002", "2026-01-06", "2026-01-12", "2026-01-13"],
  ]);
});

test("feriado não prolonga a cura em dias corridos, mas adia o acabamento", () => {
  const result = simulateFactory({
    calendarDays: calendar("2026-01-05", "2026-01-20", [{
      id: "feriado", name: "Feriado", start_date: "2026-01-08", end_date: "2026-01-08",
      is_working: false, priority: 10,
    }]),
    positions: [position("P01", ready)],
    orders: [order("PED-0001")],
  });
  assert.equal(result.orders[0].units[0].cureEndDate, "2026-01-07");
  assert.equal(result.orders[0].units[0].finishDate, "2026-01-09");
});

test("placa usa a bancada plana sem moldes e preserva volume e peso pelas três dimensões", () => {
  const placa = {
    id: "item-placa", pieceTypeId: "piece-placa", pieceKind: "placa",
    requiredMoldCodes: [], dimensionXcm: 100, dimensionYcm: 200, dimensionZcm: 10,
    quantity: 1,
  };
  const result = simulateFactory({
    calendarDays: calendar(),
    positions: [position("P01", { configurationKind: "placa" })],
    orders: [{ ...order("PED-0001"), items: [placa] }],
  });
  assert.equal(result.orders[0].units[0].preparationStartDate, null);
  assert.equal(result.orders[0].totalVolumeM3, 0.2);
  assert.equal(result.orders[0].totalWeightKg, 500);
});

test("regras do cenário ficam explícitas na resposta", () => {
  assert.equal(FACTORY_RULES.preparationWorkingDays, 5);
  assert.equal(FACTORY_RULES.curingCalendarDays, 2);
  assert.equal(FACTORY_RULES.finishingWorkingDays, 1);
  assert.equal(FACTORY_RULES.maximumCalendarDays, 90);
});

test("API de simulação lê pedidos aprovados e orçamento selecionado sem gravar no banco", async () => {
  const tables = {
    orders: [
      { id: "approved", order_number: "PED-0001", status: "aprovado", start_date: "2026-01-05", requested_due_date: "2026-04-05", approved_at: "2026-01-02T08:00:00Z", created_at: "2026-01-01T08:00:00Z", organization_id: "org", is_active: true },
      { id: "quoted", order_number: "PED-0002", status: "orcamento", start_date: "2026-01-05", requested_due_date: "2026-04-05", created_at: "2026-01-01T07:00:00Z", organization_id: "org", is_active: true },
      { id: "unselected", order_number: "PED-0003", status: "orcamento", start_date: "2026-01-05", requested_due_date: "2026-04-05", created_at: "2026-01-01T06:00:00Z", organization_id: "org", is_active: true },
    ],
    mold_positions: ["P01", "P02", "P03", "P04"].map((code, index) => ({
      id: code, code, organization_id: "org", status: index ? "em_manutencao" : "disponivel",
      configuration_kind: "pilar_viga", leito_catalog_code: "LEITO_20", lateral_catalog_code: "LATERAL_25",
    })),
    calendar_settings: [{ organization_id: "org", default_capacity_minutes: 480, planning_horizon_days: 365 }],
    calendar_working_rules: [],
    organizations: [{ id: "org", timezone: "America/Sao_Paulo" }],
    production_orders: [],
    allocations: [],
    order_items: ["approved", "quoted", "unselected"].map((id) => ({
      id: "item-" + id, order_id: id, piece_type_id: "piece-viga",
      quantity: 1, sequence: 1, organization_id: "org",
    })),
    piece_types: [{
      id: "piece-viga", organization_id: "org", piece_kind: "viga",
      dimension_x_cm: 20, dimension_y_cm: 100, dimension_z_cm: 25,
    }],
    piece_type_molds: [
      { piece_type_id: "piece-viga", role: "leito", catalog_code: "LEITO_20", organization_id: "org" },
      { piece_type_id: "piece-viga", role: "lateral", catalog_code: "LATERAL_25", organization_id: "org" },
    ],
    calendar_exceptions: [],
    delay_adjustments: [],
    factory_plan_revisions: [{ organization_id: "org", revision: 1 }],
  };
  let writes = 0;
  class Query {
    constructor(name) { this.name = name; this.filters = []; this.maxRows = Infinity; }
    select() { return this; }
    eq(key, value) { this.filters.push((row) => row[key] === value); return this; }
    in(key, values) { this.filters.push((row) => values.includes(row[key])); return this; }
    lte(key, value) { this.filters.push((row) => row[key] <= value); return this; }
    gte(key, value) { this.filters.push((row) => row[key] >= value); return this; }
    order() { return this; }
    limit(count) { this.maxRows = count; return this; }
    maybeSingle() { return this.result(true); }
    insert() { writes += 1; throw new Error("A simulação tentou gravar."); }
    update() { writes += 1; throw new Error("A simulação tentou gravar."); }
    upsert() { writes += 1; throw new Error("A simulação tentou gravar."); }
    then(resolve, reject) { return this.result().then(resolve, reject); }
    result(single = false) {
      const rows = (tables[this.name] || []).filter((row) => this.filters.every((filter) => filter(row))).slice(0, this.maxRows);
      return Promise.resolve({ data: single ? rows[0] ?? null : rows, error: null });
    }
  }
  const db = {
    from: (name) => new Query(name),
    rpc: (name) => name === "factory_installed_form_by_position"
      ? Promise.resolve({ data: [], error: null })
      : Promise.reject(new Error(`RPC inesperada: ${name}`)),
  };
  const result = await simulateProductionOrders({
    db, organizationId: "org", input: { orderIds: ["quoted"] },
    now: new Date("2026-01-05T12:00:00.000Z"),
  });
  assert.equal(writes, 0);
  assert.deepEqual(result.orders.map((entry) => [entry.orderId, entry.units[0].castDate]), [
    ["approved", "2026-01-05"], ["quoted", "2026-01-06"],
  ]);
  assert.equal(result.selectedOrderIds[0], "quoted");
});
