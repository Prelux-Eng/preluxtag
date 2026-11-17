/*
 * Adaptador de compatibilidade para chamadores do planejador.
 * O cálculo oficial fica no domínio de Engenharia e pode ser usado sem
 * importar o planejador, o banco ou qualquer transporte.
 */
import { PlannerError } from "./planner.js";
import {
  calculatePieceMetrics as calculateEngineeringPieceMetrics,
  EngineeringValidationError,
} from "./engineering-domain.js";

export function calculatePieceMetrics(input) {
  try {
    return calculateEngineeringPieceMetrics(input);
  } catch (error) {
    if (error instanceof EngineeringValidationError) {
      throw new PlannerError(error.message, error.status);
    }
    throw error;
  }
}
