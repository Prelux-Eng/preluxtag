import assert from "node:assert/strict";
import test from "node:test";

import { buildCalendarDays } from "../supabase/functions/_shared/calendar.js";
import { buildPlanningQueue } from "../supabase/functions/_shared/order-planning.js";
import { calculatePieceMetrics } from "../supabase/functions/_shared/piece-metrics.js";
import { planOrder } from "../supabase/functions/_shared/planner.js";

function calendar(startDate, endDate, exceptions = []) {
  return buildCalendarDays({
    startDate,
    endDate,
    settings: { default_capacity_minutes: 480 },
    exceptions,
  });
}

function item({ quantity, minutes = 30, curingDays = 2, id = "item-1" }) {
  return {
    itemId: id,
    pieceTypeId: "piece-1",
    quantity,
    productionMinutesSnapshot: minutes,
    curingDays,
  };
}

function mockDb(tables) {
  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this.sorts = [];
      this.maxRows = Infinity;
    }

    select() { return this; }
    eq(column, value) { this.filters.push((row) => row[column] === value); return this; }
    in(column, values) { this.filters.push((row) => values.includes(row[column])); return this; }
    gte(column, value) { this.filters.push((row) => row[column] >= value); return this; }
    lte(column, value) { this.filters.push((row) => row[column] <= value); return this; }
    order(column, { ascending = true } = {}) { this.sorts.push({ column, ascending }); return this; }
    limit(value) { this.maxRows = value; return this; }
    upsert() { return Promise.resolve({ data: null, error: null }); }
    maybeSingle() { return this.resolve(true); }
    then(resolve, reject) { return this.resolve().then(resolve, reject); }

    resolve(single = false) {
      let rows = [...(tables[this.table] || [])].filter((row) => this.filters.every((filter) => filter(row)));
      for (const { column, ascending } of this.sorts.slice().reverse()) {
        rows.sort((left, right) => String(left[column] ?? "").localeCompare(String(right[column] ?? "")) * (ascending ? 1 : -1));
      }
      rows = rows.slice(0, this.maxRows);
      return Promise.resolve({ data: single ? rows[0] || null : rows, error: null });
    }
  }

  return { from: (table) => new Query(table) };
}

test("avança início não útil, distribui até quatro concretagens por dia e ignora minutos na capacidade", () => {
  const days = calendar("2026-01-10", "2026-01-24");
  const first = planOrder({ calendarDays: days, startDate: "2026-01-10", planningHorizonDays: 10, items: [item({ quantity: 5, minutes: 10 })] });
  const second = planOrder({ calendarDays: days, startDate: "2026-01-10", planningHorizonDays: 10, items: [item({ quantity: 5, minutes: 900 })] });

  assert.equal(first.effectiveStartDate, "2026-01-12");
  assert.equal(first.totalPlannedQuantity, 5);
  assert.equal(first.units.filter((unit) => unit.castDate === "2026-01-12").length, 4);
  assert.equal(first.units.filter((unit) => unit.castDate === "2026-01-13").length, 1);
  assert.deepEqual(first.units.map((unit) => [unit.castDate, unit.positionCode]), second.units.map((unit) => [unit.castDate, unit.positionCode]));
  assert.equal(first.plannedEndDate, "2026-01-16");
});

test("cura conta fim de semana e acabamento ocorre no próximo dia útil", () => {
  const result = planOrder({
    calendarDays: calendar("2026-01-09", "2026-01-20"),
    startDate: "2026-01-09",
    planningHorizonDays: 5,
    items: [item({ quantity: 1 })],
  });

  assert.equal(result.units[0].castDate, "2026-01-09");
  assert.equal(result.units[0].cureStartDate, "2026-01-10");
  assert.equal(result.units[0].cureEndDate, "2026-01-11");
  assert.equal(result.units[0].finishDate, "2026-01-12");
});

test("prazo inviável retorna programação completa e sugere a data viável mais próxima", () => {
  const result = planOrder({
    calendarDays: calendar("2026-01-05", "2026-01-20"),
    startDate: "2026-01-05",
    dueDate: "2026-01-08",
    planningHorizonDays: 12,
    items: [item({ quantity: 5 })],
  });

  assert.equal(result.totalRemainingQuantity, 0);
  assert.equal(result.feasible, false);
  assert.equal(result.suggestedDueDate, "2026-01-09");
  assert.equal(result.conflicts.some((conflict) => conflict.type === "deadline"), true);
});

test("alocação existente ocupa somente a posição e o dia informados", () => {
  const result = planOrder({
    calendarDays: calendar("2026-01-05", "2026-01-12"),
    startDate: "2026-01-05",
    planningHorizonDays: 3,
    existingAllocations: [
      { scheduled_date: "2026-01-05", position_code: "P01", status: "planned", order_id: "old-order" },
    ],
    items: [item({ quantity: 4 })],
  });

  assert.deepEqual(result.units.slice(0, 3).map((unit) => unit.positionCode), ["P02", "P03", "P04"]);
  assert.equal(result.units[3].castDate, "2026-01-06");
  assert.equal(result.units[3].positionCode, "P01");
});

test("conflito de posição já existente é sinalizado como plano não viável", () => {
  const result = planOrder({
    calendarDays: calendar("2026-01-05", "2026-01-12"),
    startDate: "2026-01-05",
    planningHorizonDays: 3,
    existingAllocations: [
      { scheduled_date: "2026-01-05", position_code: "P01", order_id: "old-1" },
      { scheduled_date: "2026-01-05", position_code: "P01", order_id: "old-2" },
    ],
    items: [item({ quantity: 1 })],
  });

  assert.equal(result.feasible, false);
  assert.equal(result.conflicts.some((conflict) => conflict.type === "position"), true);
});

test("posição em manutenção reduz a capacidade daquele conjunto de posições", () => {
  const positions = [
    { code: "P01", status: "em_manutencao" },
    { code: "P02", status: "disponivel" },
    { code: "P03", status: "disponivel" },
    { code: "P04", status: "disponivel" },
  ];
  const result = planOrder({
    calendarDays: calendar("2026-01-05", "2026-01-12"),
    startDate: "2026-01-05",
    planningHorizonDays: 3,
    positions,
    items: [item({ quantity: 4 })],
  });

  assert.equal(result.capacityPerWorkingDay, 3);
  assert.equal(result.units.filter((unit) => unit.castDate === "2026-01-05").length, 3);
  assert.equal(result.units.some((unit) => unit.positionCode === "P01"), false);
});

test("fila global ordena pedidos por início e depois pela ordem de cadastro", async () => {
  const db = mockDb({
    orders: [
      { id: "order-newer", organization_id: "org-1", is_active: true, start_date: "2026-01-05", requested_due_date: null, status: "aprovado", created_at: "2026-01-05T10:00:00Z" },
      { id: "order-earlier-date", organization_id: "org-1", is_active: true, start_date: "2026-01-04", requested_due_date: null, status: "aprovado", created_at: "2026-01-05T11:00:00Z" },
      { id: "order-same-date-later", organization_id: "org-1", is_active: true, start_date: "2026-01-05", requested_due_date: null, status: "aprovado", created_at: "2026-01-05T12:00:00Z" },
    ],
    calendar_settings: [{ organization_id: "org-1", planning_horizon_days: 5, default_capacity_minutes: 480 }],
    mold_positions: ["P01", "P02", "P03", "P04"].map((code) => ({ id: code, organization_id: "org-1", code, status: "disponivel" })),
    order_items: [
      { id: "item-newer", organization_id: "org-1", order_id: "order-newer", piece_type_id: "piece-1", quantity: 5, production_minutes_snapshot: 900, sequence: 1 },
      { id: "item-earlier-date", organization_id: "org-1", order_id: "order-earlier-date", piece_type_id: "piece-1", quantity: 1, production_minutes_snapshot: 10, sequence: 1 },
      { id: "item-same-date-later", organization_id: "org-1", order_id: "order-same-date-later", piece_type_id: "piece-1", quantity: 1, production_minutes_snapshot: 1, sequence: 1 },
    ],
    piece_types: [{ id: "piece-1", organization_id: "org-1", code: "VIGA", name: "Viga", production_minutes_per_unit: 30, curing_days: 14 }],
    production_orders: [],
    production_schedules: [],
    allocations: [],
  });

  const result = await buildPlanningQueue({ db, organizationId: "org-1", input: { orderId: "order-newer" } });
  assert.deepEqual(result.plans.map((entry) => entry.orderId), ["order-earlier-date", "order-newer", "order-same-date-later"]);
  assert.equal(result.plans[0].plan.units[0].castDate, "2026-01-05");
  assert.equal(result.plans[1].plan.units[0].castDate, "2026-01-05");
  assert.equal(result.plans[1].plan.units.at(-1).castDate, "2026-01-06");
  assert.equal(result.plans[2].plan.units[0].castDate, "2026-01-06");
  assert.equal(result.targetPlan.order.id, "order-newer");
  assert.equal(result.targetPlan.units[0].curingDays, 2);
});

test("exceção de calendário afeta concretagem e acabamento, mas não a cura", () => {
  const days = calendar("2026-01-05", "2026-01-16", [{
    id: "holiday-1",
    name: "Feriado",
    start_date: "2026-01-06",
    end_date: "2026-01-06",
    is_working: false,
    priority: 10,
  }]);
  const result = planOrder({ calendarDays: days, startDate: "2026-01-05", planningHorizonDays: 5, items: [item({ quantity: 1 })] });

  assert.equal(result.units[0].castDate, "2026-01-05");
  assert.equal(result.units[0].cureStartDate, "2026-01-06");
  assert.equal(result.units[0].cureEndDate, "2026-01-07");
  assert.equal(result.units[0].finishDate, "2026-01-08");
});

test("volume e peso usam dimensões em cm e densidade de 2,5 g/cm³", () => {
  const result = calculatePieceMetrics({ x: 100, y: 200, z: 300 });
  assert.equal(result.volumeCm3, 6_000_000);
  assert.equal(result.volumeM3, 6);
  assert.equal(result.weightKg, 15_000);
  assert.equal(result.densityGPerCm3, 2.5);
});

test("dimensões nulas, negativas ou não numéricas são recusadas", () => {
  assert.throws(() => calculatePieceMetrics({ x: 0, y: 20, z: 30 }), /Dimensão X/);
  assert.throws(() => calculatePieceMetrics({ x: 10, y: -1, z: 30 }), /Dimensão Y/);
  assert.throws(() => calculatePieceMetrics({ x: 10, y: 20, z: "abc" }), /Dimensão Z/);
});
