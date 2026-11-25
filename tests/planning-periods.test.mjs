import test from "node:test";
import assert from "node:assert/strict";
import { summarizePlanningPeriods } from "../supabase/functions/_shared/planning-periods.js";

test("período do pedido vai da primeira concretagem ao último fim previsto", () => {
  const periods = summarizePlanningPeriods(
    ["pedido-1"],
    [{ order_id: "pedido-1", quantity: 2 }],
    [
      { order_id: "pedido-1", status: "done", planned_cast_date: "2026-12-08", forecast_end_date: "2026-12-15" },
      { order_id: "pedido-1", status: "planned", planned_cast_date: "2026-12-03", forecast_end_date: "2026-12-18" },
    ],
  );
  assert.deepEqual(periods, [{
    order_id: "pedido-1", planned_start_date: "2026-12-03",
    forecast_end_date: "2026-12-18", complete: true,
  }]);
});

test("pedido incompleto não declara conclusão e unidade descartada não conta", () => {
  const periods = summarizePlanningPeriods(
    ["pedido-1"],
    [{ order_id: "pedido-1", quantity: 3 }],
    [
      { order_id: "pedido-1", status: "in_progress", planned_cast_date: "2026-12-03", forecast_end_date: "2026-12-10" },
      { order_id: "pedido-1", status: "scrapped", planned_cast_date: "2026-12-04", forecast_end_date: "2026-12-11" },
    ],
  );
  assert.deepEqual(periods, [{
    order_id: "pedido-1", planned_start_date: "2026-12-03",
    forecast_end_date: null, complete: false,
  }]);
});
