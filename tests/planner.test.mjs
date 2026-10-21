import assert from "node:assert/strict";
import test from "node:test";

import { buildCalendarDays } from "../supabase/functions/_shared/calendar.js";
import { planOrder } from "../supabase/functions/_shared/planner.js";

const calendar = [
  { date: "2026-01-05", is_working: true, capacity_minutes: 480 },
  { date: "2026-01-06", is_working: true, capacity_minutes: 480 },
  { date: "2026-01-07", is_working: false, capacity_minutes: 0 },
];

test("distribui a produção entre dias e desconta a capacidade já ocupada", () => {
  const result = planOrder({
    calendarDays: calendar,
    startDate: "2026-01-05",
    dueDate: "2026-01-06",
    existingSchedules: [
      { work_date: "2026-01-05", planned_minutes: 120, status: "planned" },
    ],
    items: [
      {
        itemId: "item-1",
        pieceTypeId: "piece-1",
        quantity: 10,
        productionMinutesSnapshot: 60,
        stockAvailable: 0,
      },
    ],
  });

  assert.equal(result.feasible, true);
  assert.equal(result.totalPlannedQuantity, 10);
  assert.equal(result.totalPlannedMinutes, 600);
  assert.deepEqual(
    result.schedules.map((schedule) => [schedule.workDate, schedule.plannedQuantity]),
    [
      ["2026-01-05", 6],
      ["2026-01-06", 4],
    ],
  );
});

test("usa o estoque antes de criar necessidade de produção", () => {
  const result = planOrder({
    calendarDays: [{ date: "2026-01-05", is_working: true, capacity_minutes: 120 }],
    startDate: "2026-01-05",
    dueDate: "2026-01-05",
    items: [
      {
        itemId: "item-1",
        pieceTypeId: "piece-1",
        quantity: 5,
        productionMinutesSnapshot: 60,
        stockAvailable: 3,
      },
    ],
  });

  assert.equal(result.totalStockQuantity, 3);
  assert.equal(result.totalToProduce, 2);
  assert.equal(result.totalPlannedQuantity, 2);
  assert.equal(result.feasible, true);
});

test("retorna conflito quando o prazo não comporta a quantidade", () => {
  const result = planOrder({
    calendarDays: [{ date: "2026-01-07", is_working: false, capacity_minutes: 0 }],
    startDate: "2026-01-07",
    dueDate: "2026-01-07",
    items: [
      {
        itemId: "item-1",
        pieceTypeId: "piece-1",
        quantity: 1,
        productionMinutesSnapshot: 60,
        stockAvailable: 0,
      },
    ],
  });

  assert.equal(result.feasible, false);
  assert.equal(result.totalRemainingQuantity, 1);
  assert.equal(result.conflicts.some((conflict) => conflict.type === "deadline"), true);
});

test("exceção de calendário substitui a regra semanal", () => {
  const days = buildCalendarDays({
    startDate: "2026-01-05",
    endDate: "2026-01-07",
    settings: { default_capacity_minutes: 480 },
    rules: [
      { weekday: 1, is_working: true, capacity_minutes: 480 },
      { weekday: 2, is_working: true, capacity_minutes: 480 },
      { weekday: 3, is_working: true, capacity_minutes: 480 },
    ],
    exceptions: [
      {
        id: "holiday-1",
        name: "Manutenção",
        start_date: "2026-01-06",
        end_date: "2026-01-06",
        is_working: false,
        capacity_minutes: null,
        priority: 10,
      },
    ],
  });

  assert.equal(days[0].is_working, true);
  assert.equal(days[1].is_working, false);
  assert.equal(days[1].capacity_minutes, 0);
  assert.equal(days[1].source, "excecao");
});
