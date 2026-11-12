import test from "node:test";
import assert from "node:assert/strict";
import {
  calendarUnitsFromScenario,
  occupiedPositionCodes,
  positionConflictCount,
  visibleCalendarUnits,
} from "../dist/js/features/planning/scenario-calendar.js";

test("calendário mostra preparação e concretagem como ocupação, sem contar a cura", () => {
  const scenario = {
    orders: [{
      orderId: "pedido-1", status: "orcamento", units: [{
        itemId: "item-1", positionCode: "P01", unitSequence: 1,
        preparationStartDate: "2026-01-05", preparationEndDate: "2026-01-09",
        castDate: "2026-01-12", cureStartDate: "2026-01-13",
        cureEndDate: "2026-01-14", finishDate: "2026-01-15",
      }],
    }],
  };
  const units = calendarUnitsFromScenario(scenario, [{
    id: "pedido-1", items: [{ id: "item-1", piece_code: "VIGA-20" }],
  }]);
  assert.equal(units[0].piece_code, "VIGA-20");
  assert.equal(units[0].forecast_kind, "quote");
  assert.deepEqual([...occupiedPositionCodes(units, "2026-01-08")], ["P01"]);
  assert.deepEqual([...occupiedPositionCodes(units, "2026-01-12")], ["P01"]);
  assert.equal(occupiedPositionCodes(units, "2026-01-13").size, 0);
  assert.equal(occupiedPositionCodes(units, "2026-01-15").size, 0);
  assert.equal(positionConflictCount(units, "2026-01-13"), 0);
  assert.equal(positionConflictCount([...units, { ...units[0], order_id: "pedido-2" }], "2026-01-12"), 1);
});

test("previsão substitui plano antigo pendente e conserva apenas pedidos iniciados", () => {
  const forecast = [{ order_id: "novo", planned_cast_date: "2026-01-12" }];
  const persisted = [
    { order_id: "novo", planned_cast_date: "2026-01-05" },
    { order_id: "iniciado", planned_cast_date: "2026-01-06" },
  ];
  assert.deepEqual(visibleCalendarUnits(forecast, persisted, ["iniciado"]), [persisted[1], forecast[0]]);
  assert.deepEqual(visibleCalendarUnits(null, persisted, ["iniciado"]), [persisted[1]]);
});
