import assert from "node:assert/strict";
import test from "node:test";

import { calculatePlateMetrics } from "../supabase/functions/_shared/plate-metrics.js";
import { buildProductionPhases } from "../supabase/functions/_shared/production-phases.js";
import { planOrder } from "../supabase/functions/_shared/planner.js";
import { buildCalendarDays } from "../supabase/functions/_shared/calendar.js";

test("placa usa X × Y para área e Z para espessura e volume", () => {
  const metrics = calculatePlateMetrics({ x: 200, y: 300, z: 10 });

  assert.equal(metrics.areaM2, 6);
  assert.equal(metrics.volumeCm3, 600_000);
  assert.equal(metrics.volumeM3, 0.6);
  assert.equal(metrics.weightKg, 1_500);
});

test("placa recusa dimensões ausentes, negativas ou não numéricas", () => {
  for (const dimensions of [{ x: 0, y: 10, z: 2 }, { x: 10, y: -1, z: 2 }, { x: "x", y: 10, z: 2 }]) {
    assert.throws(() => calculatePlateMetrics(dimensions), /maior que zero/);
  }
});

test("horários exatos usam fuso da unidade e reservam posição até o fim da cura", () => {
  const phases = buildProductionPhases({
    castDate: "2026-02-02",
    castStartTime: "08:00",
    timeZone: "America/Sao_Paulo",
    castingDurationMinutes: 120,
    curingDurationHours: 12,
  });

  assert.equal(phases.occupiedFromAt, "2026-02-02T11:00:00.000Z");
  assert.equal(phases.steps[0].plannedEndAt, "2026-02-02T13:00:00.000Z");
  assert.equal(phases.steps[1].plannedEndAt, "2026-02-03T01:00:00.000Z");
  assert.equal(phases.cureEndDate, "2026-02-02");
  assert.equal(phases.occupiedUntilAt, phases.steps[1].plannedEndAt);
  assert.deepEqual(phases.steps.slice(2).map((step) => step.durationMinutes), [null, null, null]);
});

test("duração conhecida alimenta data de liberação sem mudar a cura legada quando ausente", () => {
  const calendarDays = buildCalendarDays({
    startDate: "2026-02-02",
    endDate: "2026-02-08",
    settings: { default_capacity_minutes: 480 },
    rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, is_working: true, capacity_minutes: 480 })),
  });
  const [legacy] = planOrder({
    calendarDays,
    startDate: "2026-02-02",
    planningHorizonDays: 2,
    items: [{ itemId: "i1", pieceTypeId: "p1", quantity: 1, curingDays: 2 }],
  }).units;
  const [timed] = planOrder({
    calendarDays,
    startDate: "2026-02-02",
    planningHorizonDays: 2,
    items: [{ itemId: "i1", pieceTypeId: "p1", quantity: 1, pieceKind: "placa", requiresMoldConfig: true }],
    positions: [{ code: "P01", status: "disponivel", configuration_kind: "placa" }],
    productionTiming: { castStartTime: "08:00", timeZone: "America/Sao_Paulo", castingDurationMinutes: 120, curingDurationHours: 12 },
  }).units;

  assert.equal(legacy.cureEndDate, "2026-02-04");
  assert.equal(timed.cureEndDate, "2026-02-02");
  assert.equal(timed.finishDate, "2026-02-03");
  assert.equal(timed.steps.length, 5);
  assert.equal(timed.occupiedFromAt, timed.steps[0].plannedStartAt);
  assert.equal(timed.occupiedUntilAt, timed.steps[1].plannedEndAt);
});

test("posição plana só recebe placa e não aceita braço ou pilar/viga", () => {
  const calendarDays = buildCalendarDays({
    startDate: "2026-02-02",
    endDate: "2026-02-08",
    settings: { default_capacity_minutes: 480 },
    rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, is_working: true, capacity_minutes: 480 })),
  });
  const result = planOrder({
    calendarDays,
    startDate: "2026-02-02",
    planningHorizonDays: 2,
    positions: [{ code: "P01", status: "disponivel", configuration_kind: "placa" }],
    items: [{ itemId: "i1", pieceTypeId: "p1", quantity: 1, pieceKind: "viga", requiredMoldCodes: ["LEITO_25", "LATERAL_30"], requiresMoldConfig: true }],
  });

  assert.equal(result.units.length, 0);
  assert.equal(result.conflicts.some((conflict) => conflict.type === "mold_configuration"), true);
});

