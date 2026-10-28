import { PlannerError } from "./planner.js";

const DENSITY_G_CM3 = 2.5;

function positiveDimension(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new PlannerError(`${label} deve ser maior que zero e informado em centímetros.`);
  }
  if (number > 1_000_000) {
    throw new PlannerError(`${label} está fora do intervalo aceito.`);
  }
  return number;
}

/** Calcula volume e peso a partir de dimensões em cm, sem arredondar o cálculo. */
export function calculatePieceMetrics({ x, y, z, dimensionX, dimensionY, dimensionZ } = {}) {
  const dimensionsCm = {
    x: positiveDimension(x ?? dimensionX, "Dimensão X"),
    y: positiveDimension(y ?? dimensionY, "Dimensão Y"),
    z: positiveDimension(z ?? dimensionZ, "Dimensão Z"),
  };
  const volumeCm3 = dimensionsCm.x * dimensionsCm.y * dimensionsCm.z;
  const volumeM3 = volumeCm3 / 1_000_000;
  const weightKg = (volumeCm3 * DENSITY_G_CM3) / 1_000;

  if (![volumeCm3, volumeM3, weightKg].every(Number.isFinite)) {
    throw new PlannerError("As dimensões excedem o intervalo de cálculo aceito.");
  }

  return {
    dimensionsCm,
    volumeCm3,
    volumeM3,
    weightKg,
    densityGPerCm3: DENSITY_G_CM3,
  };
}
