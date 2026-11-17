/*
 * Casos de uso de leitura da Engenharia.
 * A camada compõe repositório e domínio, sem conhecer Request/Response.
 */
import {
  buildMoldOptions,
  calculatePieceMetrics,
  calculatePlateMetrics,
  EngineeringValidationError,
  validateEngineeringParameters,
} from "./engineering-domain.js";
import { engineeringRepository } from "./engineering-repository.js";

function fail(message, status = 500) {
  throw Object.assign(new Error(message), { status });
}

function assertQuery(result, fallback) {
  if (result?.error) {
    const error = new Error(fallback);
    error.status = 500;
    throw error;
  }
  return result?.data;
}

function toDomainParameters(row) {
  if (!row) return null;
  return validateEngineeringParameters({
    preparationWorkdays: row.preparation_workdays,
    castingWorkdays: row.casting_workdays,
    curingCalendarDays: row.curing_calendar_days,
    finishingWorkdays: row.finishing_workdays,
    maxCastingsPerWorkday: row.max_castings_per_workday,
    maximumOrderCalendarDays: row.maximum_order_calendar_days,
    castingStartTime: String(row.casting_start_time).slice(0, 5),
    concreteDensityKgM3: row.concrete_density_kg_m3,
  });
}

export async function getCurrentEngineeringParameters(
  db,
  organizationId,
  repository = engineeringRepository,
) {
  const result = await repository.getCurrentParameters(db, organizationId);
  const row = assertQuery(result, "Não foi possível ler os parâmetros de Engenharia.");
  if (!row) fail("Os parâmetros de Engenharia ainda não foram configurados.", 409);
  return { parameterVersion: row.version_number, parameters: toDomainParameters(row) };
}

export async function getEngineeringConfiguration(
  db,
  organizationId,
  repository = engineeringRepository,
) {
  const [parameterResult, catalogResult, positionResult] = await Promise.all([
    repository.getCurrentParameters(db, organizationId),
    repository.getMoldCatalog(db),
    repository.getPositions(db, organizationId),
  ]);

  const parameterRow = assertQuery(parameterResult, "Não foi possível ler os parâmetros de Engenharia.");
  const moldCatalog = assertQuery(catalogResult, "Não foi possível ler o catálogo de moldes.") || [];
  const positions = assertQuery(positionResult, "Não foi possível ler as posições.") || [];
  if (!parameterRow) fail("Os parâmetros de Engenharia ainda não foram configurados.", 409);

  const parameters = toDomainParameters(parameterRow);
  const moldOptions = Object.fromEntries(
    ["braco", "pilar", "viga", "placa"].map((pieceKind) => [
      pieceKind,
      buildMoldOptions(pieceKind, moldCatalog),
    ]),
  );

  return {
    parameterVersion: parameterRow.version_number,
    parameters,
    moldCatalog,
    moldOptions,
    positions,
  };
}

export async function calculateEngineeringPieceMetrics(
  db,
  organizationId,
  { pieceKind, dimensions },
  repository = engineeringRepository,
) {
  const { parameterVersion, parameters } = await getCurrentEngineeringParameters(db, organizationId, repository);
  const kind = String(pieceKind ?? "").trim().toLocaleLowerCase("pt-BR");
  if (!["braco", "pilar", "viga", "placa"].includes(kind)) {
    throw new EngineeringValidationError("Selecione braço, pilar, viga ou placa.", 400);
  }

  const metrics = kind === "placa"
    ? calculatePlateMetrics({ ...dimensions, concreteDensityKgM3: parameters.concreteDensityKgM3 })
    : calculatePieceMetrics({ ...dimensions, concreteDensityKgM3: parameters.concreteDensityKgM3 });

  return { parameterVersion, pieceKind: kind, ...metrics };
}

export async function getCompatibleMoldOptions(
  db,
  pieceKind,
  repository = engineeringRepository,
) {
  const result = await repository.getMoldCatalog(db);
  const moldCatalog = assertQuery(result, "Não foi possível ler o catálogo de moldes.") || [];
  return buildMoldOptions(pieceKind, moldCatalog);
}
