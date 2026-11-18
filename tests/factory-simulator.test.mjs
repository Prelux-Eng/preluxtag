import assert from "node:assert/strict";
import test from "node:test";

import { buildCalendarDays } from "../supabase/functions/_shared/calendar.js";
import { FACTORY_RULES, simulateProject } from "../supabase/functions/_shared/project-domain.js";
import { simulateProductionOrders } from "../supabase/functions/_shared/factory-simulation-service.js";

function calendar(startDate = "2026-01-05", endDate = "2026-07-31", exceptions = [], capacityMinutes = 480) {
  return buildCalendarDays({
    startDate,
    endDate,
    settings: { default_capacity_minutes: capacityMinutes },
    exceptions,
  });
}

function position(code, config = {}) {
  return { code, status: "disponivel", ...config };
}

function viga(quantity = 1, productionMinutesSnapshot = 120) {
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
    productionMinutesSnapshot,
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
  const result = simulateProject({
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
  assert.equal(plan.totalProductionMinutes, 600);
  assert.deepEqual(result.dailyCapacityUsage.slice(0, 2).map((day) => [day.date, day.minutesUsed, day.capacityMinutes]), [
    ["2026-01-05", 480, 480],
    ["2026-01-06", 120, 480],
  ]);
});

test("minutos de concretagem limitam quantas unidades cabem em cada dia", () => {
  const result = simulateProject({
    calendarDays: calendar("2026-01-05", "2026-01-12", [], 300),
    positions: ["P01", "P02", "P03", "P04"].map((code) => position(code, ready)),
    orders: [order("PED-0001", 5)],
  });

  assert.deepEqual(result.orders[0].units.map((unit) => unit.castDate), [
    "2026-01-05", "2026-01-05", "2026-01-06", "2026-01-06", "2026-01-07",
  ]);
  assert.deepEqual(result.dailyCapacityUsage.slice(0, 3).map((day) => [day.minutesUsed, day.remainingMinutes]), [
    [240, 60], [240, 60], [120, 180],
  ]);
});

test("minutos de dois tipos diferentes são somados antes de reservar a data", () => {
  const mixedOrder = order("PED-0001", 1);
  mixedOrder.items = [
    { ...viga(1, 300), id: "item-300", sequence: 1 },
    { ...viga(1, 200), id: "item-200", sequence: 2 },
  ];

  const result = simulateProject({
    calendarDays: calendar(),
    positions: [position("P01", ready), position("P02", ready)],
    orders: [mixedOrder],
  });

  assert.deepEqual(result.orders[0].units.map((unit) => [unit.productionMinutesSnapshot, unit.castDate]), [
    [300, "2026-01-05"], [200, "2026-01-06"],
  ]);
});

test("carga de uma unidade maior que qualquer capacidade diária gera conflito claro", () => {
  const oversizedOrder = order("PED-0001", 1);
  oversizedOrder.items = [viga(1, 301)];
  const result = simulateProject({
    calendarDays: calendar("2026-01-05", "2026-01-12", [], 300),
    positions: [position("P01", ready)],
    orders: [oversizedOrder],
  });

  assert.equal(result.orders[0].totalPlannedQuantity, 0);
  assert.equal(result.orders[0].conflicts[0].type, "capacity");
  assert.match(result.orders[0].conflicts[0].message, /301 minutos/);
});

test("reservas já existentes descontam a capacidade de concretagem do dia", () => {
  const result = simulateProject({
    calendarDays: calendar(),
    positions: ["P01", "P02", "P03", "P04"].map((code) => position(code, ready)),
    existingReservations: [{
      positionCode: "P04",
      status: "done",
      scheduledDate: "2026-01-05",
      startDate: "2026-01-05",
      endDate: "2026-01-05",
      productionMinutesSnapshot: 300,
      moldCatalogCodes: ["LEITO_20", "LATERAL_25"],
    }],
    orders: [order("PED-0001", 2)],
  });

  assert.deepEqual(result.orders[0].units.map((unit) => unit.castDate), ["2026-01-05", "2026-01-06"]);
  assert.equal(result.dailyCapacityUsage[0].minutesUsed, 420);
});

test("forma já pronta dispensa preparação; a cura libera a posição para a próxima concretagem", () => {
  const result = simulateProject({
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
  const result = simulateProject({
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
  const result = simulateProject({
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
  const mounted = simulateProject({
    calendarDays: calendar(),
    positions: [position("P01", { installedMoldCatalogCodes: ["LEITO_20", "LATERAL_25"] })],
    orders: [order("PED-0001")],
  });
  assert.equal(mounted.orders[0].units[0].preparationStartDate, null);

  const dismantled = simulateProject({
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
  const result = simulateProject({
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
  const result = simulateProject({
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
  const result = simulateProject({
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

test("ajuste externo mantém a previsão-base e recalcula a data final com motivo rastreável", () => {
  const result = simulateProject({
    calendarDays: calendar(),
    positions: [position("P01", ready)],
    orders: [{
      ...order("PED-AJUSTE"),
      delayAdjustments: [{
        reason: "Interrupção por manutenção elétrica",
        occurredOn: "2026-01-06",
        impactDays: 3,
      }],
    }],
  });
  const plan = result.orders[0];
  assert.equal(plan.plannedEndDate, "2026-01-08");
  assert.equal(plan.forecastEndDate, "2026-01-11");
  assert.equal(plan.totalExternalAdjustmentDays, 3);
  assert.deepEqual(plan.externalAdjustments, [{
    reason: "Interrupção por manutenção elétrica",
    occurredOn: "2026-01-06",
    impactDays: 3,
  }]);
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
  const result = simulateProject({
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
  const result = simulateProject({
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
    quantity: 1, productionMinutesSnapshot: 120,
  };
  const result = simulateProject({
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
  assert.equal(FACTORY_RULES.castingWorkingDays, 1);
  assert.equal(FACTORY_RULES.curingCalendarDays, 2);
  assert.equal(FACTORY_RULES.finishingWorkingDays, 1);
  assert.equal(FACTORY_RULES.maxCastingsPerWorkday, 4);
  assert.equal(FACTORY_RULES.maximumCalendarDays, 90);
});

test("Projeto aplica os parâmetros versionados de preparação, cura, capacidade, prazo e densidade", () => {
  const engineeringParameters = {
    preparationWorkdays: 3,
    castingWorkdays: 1,
    curingCalendarDays: 3,
    finishingWorkdays: 1,
    maxCastingsPerWorkday: 2,
    maximumOrderCalendarDays: 30,
    castingStartTime: "07:30",
    concreteDensityKgM3: 3_000,
  };
  const result = simulateProject({
    calendarDays: calendar(),
    positions: ["P01", "P02", "P03", "P04"].map((code) => position(code, ready)),
    orders: [{
      ...order("PED-VERSAO", 5),
      engineeringParameterVersionId: "version-2",
      engineeringParameterVersion: 2,
      engineeringParameters,
    }],
  });
  const plan = result.orders[0];
  assert.equal(plan.engineeringParameterVersionId, "version-2");
  assert.equal(plan.maximumDueDate, "2026-02-04");
  assert.equal(plan.totalWeightKg, 750);
  assert.deepEqual(plan.units.map((unit) => unit.castDate), [
    "2026-01-05", "2026-01-05", "2026-01-06", "2026-01-06", "2026-01-07",
  ]);
  assert.equal(plan.units[0].cureEndDate, "2026-01-08");
  assert.equal(plan.units[0].finishDate, "2026-01-09");
  assert.equal(plan.units[0].castingStartTime, "07:30");
});

test("preparação usa a duração da versão de Engenharia e explica a montagem necessária", () => {
  const result = simulateProject({
    calendarDays: calendar(),
    positions: [position("P01")],
    orders: [{
      ...order("PED-PREPARACAO"),
      engineeringParameters: {
        preparationWorkdays: 3,
        castingWorkdays: 1,
        curingCalendarDays: 2,
        finishingWorkdays: 1,
        maxCastingsPerWorkday: 4,
        maximumOrderCalendarDays: 90,
        castingStartTime: "08:00",
        concreteDensityKgM3: 2_500,
      },
    }],
  });
  const unit = result.orders[0].units[0];
  assert.deepEqual(unit.preparationDates, ["2026-01-05", "2026-01-06", "2026-01-07"]);
  assert.equal(unit.castDate, "2026-01-08");
  assert.equal(unit.preparationRequired, true);
  assert.match(unit.preparationReason, /não tinha/);
});

test("API de simulação não grava e respeita concretagem de unidade retirada", async () => {
  const tables = {
    orders: [
      { id: "approved", order_number: "PED-0001", status: "aprovado", start_date: "2026-01-05", requested_due_date: "2026-04-05", approved_at: "2026-01-02T08:00:00Z", created_at: "2026-01-01T08:00:00Z", organization_id: "org", is_active: true, engineering_parameter_version_id: "engineering-v1" },
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
    withdrawn_unit_form_events: [],
    order_items: ["approved", "quoted", "unselected"].map((id) => ({
      id: "item-" + id, order_id: id, piece_type_id: "piece-viga",
      quantity: 1, sequence: 1, organization_id: "org",
    })),
    piece_types: [{
      id: "piece-viga", organization_id: "org", piece_kind: "viga",
      dimension_x_cm: 20, dimension_y_cm: 100, dimension_z_cm: 25,
      production_minutes_per_unit: 30,
    }],
    piece_type_molds: [
      { piece_type_id: "piece-viga", role: "leito", catalog_code: "LEITO_20", organization_id: "org" },
      { piece_type_id: "piece-viga", role: "lateral", catalog_code: "LATERAL_25", organization_id: "org" },
    ],
    calendar_exceptions: [],
    delay_adjustments: [{
      organization_id: "org",
      order_id: "approved",
      reason: "Manutenção elétrica",
      occurred_on: "2026-01-02",
      impact_days: 2,
    }],
    factory_plan_revisions: [{ organization_id: "org", revision: 1 }],
    engineering_parameter_versions: [
      { id: "engineering-v2", version_number: 2, preparation_workdays: 5, casting_workdays: 1, curing_calendar_days: 2, finishing_workdays: 1, max_castings_per_workday: 4, maximum_order_calendar_days: 90, casting_start_time: "08:00:00", concrete_density_kg_m3: 2500, organization_id: "org" },
      { id: "engineering-v1", version_number: 1, preparation_workdays: 5, casting_workdays: 1, curing_calendar_days: 2, finishing_workdays: 1, max_castings_per_workday: 4, maximum_order_calendar_days: 90, casting_start_time: "07:30:00", concrete_density_kg_m3: 3000, organization_id: "org" },
    ],
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
  assert.deepEqual(result.orders.map((entry) => entry.engineeringParameterVersion), [1, 2]);
  assert.deepEqual(result.orders.map((entry) => entry.totalWeightKg), [150, 125]);
  assert.equal(result.orders[0].units[0].steps[0].plannedStartAt, "2026-01-05T10:30:00.000Z");
  assert.equal(result.orders[0].units[0].productionMinutesSnapshot, 30);
  assert.equal(result.orders[0].units[0].steps[0].durationMinutes, 30);
  assert.equal(result.orders[0].units[0].steps[0].plannedEndAt, "2026-01-05T11:00:00.000Z");
  assert.equal(result.orders[0].units[0].occupiedUntilAt, "2026-01-05T11:00:00.000Z");
  assert.equal(result.orders[0].units[0].steps[1].plannedStartAt, "2026-01-05T11:00:00.000Z");
  assert.equal(result.orders[0].units[0].steps[1].durationMinutes, 2 * 24 * 60);
  assert.equal(result.orders[0].units[0].steps[2].plannedStartAt, "2026-01-08T10:30:00.000Z");
  assert.deepEqual(result.orders[0].externalAdjustments, [{
    reason: "Manutenção elétrica",
    occurredOn: "2026-01-02",
    impactDays: 2,
  }]);
  assert.equal(result.selectedOrderIds[0], "quoted");

  // A última unidade foi retirada do pedido, mas sua concretagem já ocupou P01.
  tables.withdrawn_unit_form_events.push({
    organization_id: "org", source_allocation_id: "removed-cast", casting_completed: true,
    mold_position_id: "P01", scheduled_date: "2026-01-05",
    occupied_from_at: "2026-01-05T11:00:00.000Z", occupied_until_at: "2026-01-05T19:00:00.000Z",
    mold_catalog_codes: ["LEITO_20", "LATERAL_25"],
  });
  const withRemovedCast = await simulateProductionOrders({
    db, organizationId: "org", input: { orderIds: ["quoted"] },
    now: new Date("2026-01-05T12:00:00.000Z"),
  });
  assert.deepEqual(withRemovedCast.orders.map((entry) => [entry.orderId, entry.units[0].castDate]), [
    ["approved", "2026-01-06"], ["quoted", "2026-01-07"],
  ]);
  assert.equal(writes, 0);
});
