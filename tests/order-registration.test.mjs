import assert from "node:assert/strict";
import test from "node:test";

import { calculatePieceMetrics } from "../supabase/functions/_shared/piece-metrics.js";
import { buildPlanningQueue } from "../supabase/functions/_shared/order-planning.js";
import { resolveCatalogMolds } from "../supabase/functions/_shared/registration-service.js";
import { listPieceMoldOptions } from "../dist/js/domain/mold-compatibility.js";
import {
  addCalendarDays,
  previewNextOrderNumber,
  resolveRequestedDueDate,
} from "../supabase/functions/_shared/registration-rules.js";

test("prazo automático soma 90 dias corridos, incluindo a passagem de ano", () => {
  assert.equal(addCalendarDays("2026-11-04", 90), "2027-02-02");
  assert.equal(resolveRequestedDueDate({ startDate: "2024-02-01" }), "2024-05-01");
});

test("prazo manual é mantido e não pode anteceder o início", () => {
  assert.equal(resolveRequestedDueDate({
    startDate: "2026-11-04",
    manualDate: "2027-01-15",
    manuallyEdited: true,
  }), "2027-01-15");
  assert.throws(() => resolveRequestedDueDate({
    startDate: "2026-11-04",
    manualDate: "2026-11-03",
    manuallyEdited: true,
  }), /anterior ao início/);
});

test("prévia do pedido usa o próximo sequencial PED-0001", () => {
  assert.equal(previewNextOrderNumber([]), "PED-0001");
  assert.equal(previewNextOrderNumber(["PED-0001", "PED-0009", "O.0000"]), "PED-0010");
});

test("compatibilidade gera produto cartesiano para pilar/viga e mantém braço fixo", () => {
  const catalog = [
    { code: "LEITO_25", mold_type: "LEITO", measure_label: "25" },
    { code: "LEITO_30", mold_type: "LEITO", measure_label: "30" },
    { code: "LATERAL_40", mold_type: "LATERAL", measure_label: "40" },
    { code: "LATERAL_50", mold_type: "LATERAL", measure_label: "50" },
    { code: "BRACO_25X35", mold_type: "BRACO", measure_label: "25x35" },
  ];
  const variable = listPieceMoldOptions("viga", { catalog });
  assert.equal(variable.length, 4);
  assert.deepEqual(variable.map(([key]) => key), [
    "LEITO_25|LATERAL_40", "LEITO_25|LATERAL_50", "LEITO_30|LATERAL_40", "LEITO_30|LATERAL_50",
  ]);
  assert.deepEqual(listPieceMoldOptions("braco", { catalog }).map(([key]) => key), ["BRACO_25X35"]);
});

test("moldes de pilar/viga usam X e Z; Y permanece como comprimento", () => {
  const catalog = [
    { code: "LEITO_20", mold_type: "LEITO", measure_label: "20" },
    { code: "LATERAL_30", mold_type: "LATERAL", measure_label: "30" },
    { code: "BRACO_20X30", mold_type: "BRACO", measure_label: "20x30" },
  ];
  assert.deepEqual(resolveCatalogMolds("viga", 20, 30, catalog), [
    { role: "leito", catalogCode: "LEITO_20" },
    { role: "lateral", catalogCode: "LATERAL_30" },
  ]);
  assert.deepEqual(resolveCatalogMolds("braco", 20, 30, catalog), [
    { role: "braco", catalogCode: "BRACO_20X30" },
  ]);
});

function registrationMockDb(positions) {
  const tables = {
    orders: [], calendar_settings: [{ organization_id: "org-1", planning_horizon_days: 10, default_capacity_minutes: 480 }],
    calendar_working_rules: [], calendar_exceptions: [], mold_positions: positions,
    order_items: [], piece_types: [], piece_type_molds: [], production_orders: [], production_schedules: [], allocations: [],
  };
  class Query {
    constructor(table) { this.table = table; this.filters = []; this.sorts = []; this.maxRows = Infinity; }
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
      for (const { column, ascending } of this.sorts.slice().reverse()) rows.sort((a, b) => String(a[column] ?? "").localeCompare(String(b[column] ?? "")) * (ascending ? 1 : -1));
      rows = rows.slice(0, this.maxRows);
      return Promise.resolve({ data: single ? rows[0] || null : rows, error: null });
    }
  }
  return { from: (table) => new Query(table) };
}

const draftRegistration = {
  order: { id: "order-new", order_number: "", client_id: null, start_date: "2026-01-05", requested_due_date: "2026-04-05", status: "orcamento", created_at: "2026-01-01T00:00:00Z", is_active: true },
  item: { id: "item-new", order_id: "order-new", piece_type_id: "piece-new", quantity: 1, production_minutes_snapshot: 30, sequence: 1 },
  piece: { id: "piece-new", organization_id: "org-1", code: "V-01", name: "Viga", piece_kind: "viga", production_minutes_per_unit: 30 },
  requiredMoldCodes: ["LEITO_25", "LATERAL_40"],
};

test("planeja registro e associa os moldes do pedido a uma posição física livre", async () => {
  const positions = [
    { id: "p1", organization_id: "org-1", code: "P01", status: "disponivel", configuration_kind: "braco", braco_catalog_code: "BRACO_25X35" },
    ...["P02", "P03", "P04"].map((code) => ({ id: code, organization_id: "org-1", code, status: "disponivel", configuration_kind: null })),
  ];
  const result = await buildPlanningQueue({ db: registrationMockDb(positions), organizationId: "org-1", input: { draft: draftRegistration } });
  assert.equal(result.targetPlan.feasible, true);
  assert.equal(result.targetPlan.units[0].positionCode, "P01");
});

test("registro sem posição livre fica na fila sem alocação prevista", async () => {
  const positions = ["P01", "P02", "P03", "P04"].map((code) => ({
    id: code, organization_id: "org-1", code, status: "em_manutencao", configuration_kind: "braco", braco_catalog_code: "BRACO_25X35",
  }));
  const result = await buildPlanningQueue({ db: registrationMockDb(positions), organizationId: "org-1", input: { draft: draftRegistration } });
  assert.equal(result.targetPlan.feasible, false);
  assert.equal(result.targetPlan.units.length, 0);
  assert.equal(result.targetPlan.totalRemainingQuantity, 1);
});
