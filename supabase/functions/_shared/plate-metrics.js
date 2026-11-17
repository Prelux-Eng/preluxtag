/*
 * Adaptador da regra de placa para os chamadores existentes.
 * X×Y é a área; Z é a espessura e participa do volume e do peso.
 */
import {
  calculatePlateMetrics as calculateEngineeringPlateMetrics,
  EngineeringValidationError,
} from "./engineering-domain.js";

export function calculatePlateMetrics(input) {
  try {
    return calculateEngineeringPlateMetrics(input);
  } catch (error) {
    if (error instanceof EngineeringValidationError) {
      const plateError = new Error(error.message);
      plateError.name = "PlateMetricsError";
      plateError.status = error.status;
      throw plateError;
    }
    throw error;
  }
}
