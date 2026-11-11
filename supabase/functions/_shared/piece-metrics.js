/*
 * Cálculos reutilizados pelo cadastro e pelas Edge Functions de peças.
 * Dimensões de entrada estão em centímetros; os valores derivados são
 * preservados com precisão e formatados apenas quando enviados à interface.
 */
import { PlannerError } from "./planner.js";

const DENSITY_G_CM3 = 2.5;
const MAX_GEOMETRY_PARTS = 100;

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

function componentVolumeCm3(component, index) {
  const prefix = `Parte ${index + 1}`;
  const shape = String(component?.shape || "rectangular_prism");
  const operation = String(component?.operation || "add");
  const x = positiveDimension(component?.x, `${prefix} · dimensão X`);
  const y = positiveDimension(component?.y, `${prefix} · dimensão Y`);
  const z = positiveDimension(component?.z, `${prefix} · dimensão Z`);
  const quantity = Number(component?.quantity ?? 1);

  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) {
    throw new PlannerError(`${prefix}: informe uma quantidade inteira entre 1 e 1.000.`);
  }
  if (!["rectangular_prism", "triangular_prism"].includes(shape)) {
    throw new PlannerError(`${prefix}: forma geométrica inválida.`);
  }
  if (!["add", "subtract"].includes(operation)) {
    throw new PlannerError(`${prefix}: escolha somar ou subtrair o volume.`);
  }

  const shapeFactor = shape === "triangular_prism" ? 0.5 : 1;
  const direction = operation === "subtract" ? -1 : 1;
  return direction * x * y * z * shapeFactor * quantity;
}

/** Calcula volume e peso a partir de dimensões em cm, sem arredondar o cálculo. */
export function calculatePieceMetrics({ x, y, z, dimensionX, dimensionY, dimensionZ, geometryParts } = {}) {
  const dimensionsCm = {
    x: positiveDimension(x ?? dimensionX, "Dimensão X"),
    y: positiveDimension(y ?? dimensionY, "Dimensão Y"),
    z: positiveDimension(z ?? dimensionZ, "Dimensão Z"),
  };
  let volumeCm3;
  if (geometryParts == null || (Array.isArray(geometryParts) && geometryParts.length === 0)) {
    // Peças prismáticas mantêm exatamente a fórmula legada X × Y × Z.
    volumeCm3 = dimensionsCm.x * dimensionsCm.y * dimensionsCm.z;
  } else {
    if (!Array.isArray(geometryParts) || geometryParts.length > MAX_GEOMETRY_PARTS) {
      throw new PlannerError(`A composição geométrica deve conter de 1 a ${MAX_GEOMETRY_PARTS} partes.`);
    }
    volumeCm3 = geometryParts.reduce((total, component, index) => total + componentVolumeCm3(component, index), 0);
    if (!Number.isFinite(volumeCm3) || volumeCm3 <= 0) {
      throw new PlannerError("A soma dos volumes das partes deve ser maior que zero.");
    }
  }
  const volumeM3 = volumeCm3 / 1_000_000;
  const weightKg = (volumeCm3 * DENSITY_G_CM3) / 1_000;

  if (![volumeCm3, volumeM3, weightKg].every(Number.isFinite)) {
    throw new PlannerError("As dimensões excedem o intervalo de cálculo aceito.");
  }

  return {
    dimensionsCm,
    geometryParts: Array.isArray(geometryParts) ? geometryParts : [],
    volumeCm3,
    volumeM3,
    weightKg,
    densityGPerCm3: DENSITY_G_CM3,
  };
}
