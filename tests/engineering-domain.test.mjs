import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMoldOptions,
  calculatePieceMetrics,
  calculatePlateMetrics,
  EngineeringValidationError,
  validateEngineeringParameters,
  validateMoldSelection,
} from "../supabase/functions/_shared/engineering-domain.js";
import {
  calculateEngineeringPieceMetrics,
  getEngineeringConfiguration,
} from "../supabase/functions/_shared/engineering-service.js";
import { listPieceMoldOptions } from "../dist/js/domain/mold-compatibility.js";

const moldCatalog = [
  ...[20, 25, 30, 35, 40, 50, 60].map((measure, index) => ({
    code: `LEITO_${measure}`,
    mold_type: "LEITO",
    measure_label: String(measure),
    sort_order: index + 1,
  })),
  ...[25, 30, 40, 50, 60].map((measure, index) => ({
    code: `LATERAL_${measure}`,
    mold_type: "LATERAL",
    measure_label: String(measure),
    sort_order: index + 8,
  })),
  ...["25x35", "25x52", "30x60"].map((measure, index) => ({
    code: `BRACO_${measure.replace("x", "X")}`,
    mold_type: "BRACO",
    measure_label: measure,
    sort_order: index + 13,
  })),
];

const parameterRow = {
  version_number: 3,
  preparation_workdays: 5,
  casting_workdays: 1,
  curing_calendar_days: 2,
  finishing_workdays: 1,
  max_castings_per_workday: 4,
  maximum_order_calendar_days: 90,
  casting_start_time: "08:00:00",
  concrete_density_kg_m3: "2400.000",
};

const engineeringRepositoryMock = {
  async getCurrentParameters() { return { data: parameterRow, error: null }; },
  async getMoldCatalog() { return { data: moldCatalog, error: null }; },
  async getPositions() { return { data: [{ code: "P01", version: 2 }], error: null }; },
};

test("peças prismáticas preservam volume e peso pela densidade de 2.500 kg/m³", () => {
  const metrics = calculatePieceMetrics({ x: 100, y: 200, z: 300 });

  assert.equal(metrics.volumeCm3, 6_000_000);
  assert.equal(metrics.volumeM3, 6);
  assert.equal(metrics.weightKg, 15_000);
  assert.equal(metrics.densityKgM3, 2_500);
});

test("a densidade usada no cálculo vem dos parâmetros recebidos", () => {
  const metrics = calculatePieceMetrics({ x: 200, y: 300, z: 10, concreteDensityKgM3: 2_400 });

  assert.equal(metrics.volumeM3, 0.6);
  assert.equal(metrics.weightKg, 1_440);
});

test("placa usa X×Y como área e Z como espessura", () => {
  const metrics = calculatePlateMetrics({ x: 200, y: 300, z: 10 });

  assert.equal(metrics.areaM2, 6);
  assert.equal(metrics.volumeCm3, 600_000);
  assert.equal(metrics.volumeM3, 0.6);
  assert.equal(metrics.weightKg, 1_500);
});

test("as dimensões precisam ser positivas e numéricas", () => {
  for (const dimensions of [
    { x: 0, y: 10, z: 2 },
    { x: 10, y: -1, z: 2 },
    { x: "x", y: 10, z: 2 },
  ]) {
    assert.throws(() => calculatePieceMetrics(dimensions), EngineeringValidationError);
  }
});

test("pilar e viga recebem todas as 35 combinações LEITO×LATERAL", () => {
  for (const kind of ["pilar", "viga"]) {
    const options = buildMoldOptions(kind, moldCatalog);
    assert.equal(options.length, 35);
    assert.equal(new Set(options.map((option) => option.key)).size, 35);
    assert.ok(options.every((option) => option.requiredCodes.length === 2));
    assert.ok(options.every((option) => option.configurationKind === "pilar_viga"));
  }
});

test("braço recebe somente os três moldes fixos de braço", () => {
  const options = buildMoldOptions("braco", moldCatalog);

  assert.deepEqual(options.map((option) => option.key), [
    "BRACO_25X35",
    "BRACO_25X52",
    "BRACO_30X60",
  ]);
  assert.ok(options.every((option) => option.requiredCodes.length === 1));
});

test("placa não recebe molde e valida apenas uma posição plana", () => {
  const options = buildMoldOptions("placa", moldCatalog);

  assert.equal(options.length, 1);
  assert.equal(options[0].configurationKind, "placa");
  assert.deepEqual(validateMoldSelection("placa", [], moldCatalog).requiredCodes, []);
  assert.throws(() => validateMoldSelection("placa", ["LEITO_20"], moldCatalog), /não pode exigir molde/);
});

test("validação do molde exige o formato adequado para cada tipo", () => {
  assert.deepEqual(
    validateMoldSelection("braco", ["BRACO_25X35"], moldCatalog).requiredCodes,
    ["BRACO_25X35"],
  );
  assert.deepEqual(
    validateMoldSelection("pilar", ["LATERAL_30", "LEITO_25"], moldCatalog).requiredCodes,
    ["LEITO_25", "LATERAL_30"],
  );
  assert.throws(() => validateMoldSelection("braco", ["LEITO_20"], moldCatalog), /uma única forma BRAÇO/);
  assert.throws(() => validateMoldSelection("viga", ["LEITO_20"], moldCatalog), /exatamente um LEITO e uma LATERAL/);
});

test("a lista da interface continua coerente com a regra pura da Engenharia", () => {
  const backendCount = buildMoldOptions("pilar", moldCatalog).length;
  const interfaceCount = listPieceMoldOptions("pilar", { catalog: moldCatalog }).length;

  assert.equal(interfaceCount, backendCount);
  assert.equal(interfaceCount, 35);
});

test("a configuração técnica valida todos os parâmetros obrigatórios", () => {
  const parameters = validateEngineeringParameters({
    preparationWorkdays: 5,
    castingWorkdays: 1,
    curingCalendarDays: 2,
    finishingWorkdays: 1,
    maxCastingsPerWorkday: 4,
    maximumOrderCalendarDays: 90,
    castingStartTime: "08:00",
    concreteDensityKgM3: 2_500,
  });

  assert.equal(parameters.preparationWorkdays, 5);
  assert.equal(parameters.maximumOrderCalendarDays, 90);
  assert.equal(parameters.concreteDensityKgM3, 2_500);
});

test("serviço de Engenharia devolve a versão, catálogo e posições atuais", async () => {
  const configuration = await getEngineeringConfiguration({}, "org-1", engineeringRepositoryMock);

  assert.equal(configuration.parameterVersion, 3);
  assert.equal(configuration.parameters.concreteDensityKgM3, 2_400);
  assert.equal(configuration.moldOptions.pilar.length, 35);
  assert.equal(configuration.positions[0].code, "P01");
});

test("serviço calcula métricas usando a densidade da versão vigente", async () => {
  const result = await calculateEngineeringPieceMetrics({}, "org-1", {
    pieceKind: "placa",
    dimensions: { x: 200, y: 300, z: 10 },
  }, engineeringRepositoryMock);

  assert.equal(result.parameterVersion, 3);
  assert.equal(result.areaM2, 6);
  assert.equal(result.weightKg, 1_440);
});

test("parâmetros incompletos, fracionários ou com horário inválido são recusados", () => {
  assert.throws(() => validateEngineeringParameters({}), EngineeringValidationError);
  assert.throws(() => validateEngineeringParameters({
    preparationWorkdays: 5.5,
    castingWorkdays: 1,
    curingCalendarDays: 2,
    finishingWorkdays: 1,
    maxCastingsPerWorkday: 4,
    maximumOrderCalendarDays: 90,
    castingStartTime: "08:00",
    concreteDensityKgM3: 2_500,
  }), /inteiro maior que zero/);
  assert.throws(() => validateEngineeringParameters({
    preparationWorkdays: 5,
    castingWorkdays: 1,
    curingCalendarDays: 2,
    finishingWorkdays: 1,
    maxCastingsPerWorkday: 4,
    maximumOrderCalendarDays: 90,
    castingStartTime: "24:00",
    concreteDensityKgM3: 2_500,
  }), /formato HH:mm/);
  assert.throws(() => validateEngineeringParameters({
    preparationWorkdays: 5,
    castingWorkdays: 2,
    curingCalendarDays: 2,
    finishingWorkdays: 1,
    maxCastingsPerWorkday: 4,
    maximumOrderCalendarDays: 90,
    castingStartTime: "08:00",
    concreteDensityKgM3: 2_500,
  }), /precisam ocupar um dia útil cada/);
});
