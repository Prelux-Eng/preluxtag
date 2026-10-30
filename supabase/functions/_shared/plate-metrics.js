/*
 * Métricas de placas de concreto.
 *
 * X × Y representa a área da placa e Z é a espessura. Volume e peso seguem a
 * mesma densidade e as mesmas unidades usadas por piece-metrics.js.
 */

const CONCRETE_DENSITY_G_CM3 = 2.5;

function dimension(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 1_000_000) {
    const error = new Error(`${label} deve ser maior que zero e informado em centímetros.`);
    error.name = "PlateMetricsError";
    throw error;
  }
  return number;
}

export function calculatePlateMetrics({ x, y, z, dimensionX, dimensionY, dimensionZ } = {}) {
  const dimensionsCm = {
    x: dimension(x ?? dimensionX, "Dimensão X"),
    y: dimension(y ?? dimensionY, "Dimensão Y"),
    z: dimension(z ?? dimensionZ, "Espessura Z"),
  };
  const areaM2 = (dimensionsCm.x * dimensionsCm.y) / 10_000;
  const volumeCm3 = dimensionsCm.x * dimensionsCm.y * dimensionsCm.z;
  const volumeM3 = volumeCm3 / 1_000_000;
  const weightKg = (volumeCm3 * CONCRETE_DENSITY_G_CM3) / 1_000;
  if (![areaM2, volumeCm3, volumeM3, weightKg].every(Number.isFinite)) {
    const error = new Error("As dimensões da placa excedem o intervalo de cálculo aceito.");
    error.name = "PlateMetricsError";
    throw error;
  }
  return {
    dimensionsCm,
    areaM2,
    volumeCm3,
    volumeM3,
    weightKg,
    densityGPerCm3: CONCRETE_DENSITY_G_CM3,
  };
}

