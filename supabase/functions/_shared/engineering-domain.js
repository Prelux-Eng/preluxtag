/*
 * Regras puras da Engenharia PRELUX.
 *
 * Este módulo não acessa Supabase, HTTP, navegador ou relógio. Recebe medidas,
 * catálogo e parâmetros já carregados e devolve validações/cálculos repetíveis.
 */

const MAX_DIMENSION_CM = 1_000_000;
const DEFAULT_CONCRETE_DENSITY_KG_M3 = 2_500;
const PIECE_KINDS = new Set(["braco", "pilar", "viga", "placa"]);

export class EngineeringValidationError extends Error {
  constructor(message, status = 422) {
    super(message);
    this.name = "EngineeringValidationError";
    this.status = status;
  }
}

function positiveNumber(value, label, max = Number.MAX_VALUE) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > max) {
    throw new EngineeringValidationError(`${label} deve ser maior que zero e estar dentro do intervalo aceito.`);
  }
  return number;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new EngineeringValidationError(`${label} deve ser um inteiro maior que zero.`);
  }
  return number;
}

function dimension(value, key, label = `Dimensão ${key.toUpperCase()}`) {
  return positiveNumber(value, `${label}, em centímetros`, MAX_DIMENSION_CM);
}

/** Valida a configuração versionada antes de enviá-la ao banco. */
export function validateEngineeringParameters(input = {}) {
  const castingStartTime = String(input.castingStartTime ?? "").trim();
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(castingStartTime)) {
    throw new EngineeringValidationError("O início do turno deve estar no formato HH:mm.");
  }

  const castingWorkdays = positiveInteger(input.castingWorkdays, "A concretagem");
  const finishingWorkdays = positiveInteger(input.finishingWorkdays, "O acabamento");
  if (castingWorkdays !== 1 || finishingWorkdays !== 1) {
    throw new EngineeringValidationError(
      "A concretagem e o acabamento precisam ocupar um dia útil cada, conforme o processo e as etapas de produção já existentes.",
    );
  }

  return {
    preparationWorkdays: positiveInteger(input.preparationWorkdays, "A preparação"),
    castingWorkdays,
    curingCalendarDays: positiveInteger(input.curingCalendarDays, "A cura"),
    finishingWorkdays,
    maxCastingsPerWorkday: positiveInteger(input.maxCastingsPerWorkday, "A capacidade diária"),
    maximumOrderCalendarDays: positiveInteger(input.maximumOrderCalendarDays, "O limite do pedido"),
    castingStartTime,
    concreteDensityKgM3: positiveNumber(input.concreteDensityKgM3, "A densidade do concreto"),
  };
}

/** Calcula volume e peso de um prisma, mantendo as dimensões em centímetros. */
export function calculatePieceMetrics({
  x,
  y,
  z,
  dimensionX,
  dimensionY,
  dimensionZ,
  concreteDensityKgM3 = DEFAULT_CONCRETE_DENSITY_KG_M3,
} = {}) {
  const dimensionsCm = {
    x: dimension(x ?? dimensionX, "x"),
    y: dimension(y ?? dimensionY, "y"),
    z: dimension(z ?? dimensionZ, "z"),
  };
  const densityKgM3 = positiveNumber(concreteDensityKgM3, "A densidade do concreto");
  const volumeCm3 = dimensionsCm.x * dimensionsCm.y * dimensionsCm.z;
  const volumeM3 = volumeCm3 / 1_000_000;
  const weightKg = volumeM3 * densityKgM3;

  if (![volumeCm3, volumeM3, weightKg].every(Number.isFinite)) {
    throw new EngineeringValidationError("As dimensões excedem o intervalo de cálculo aceito.");
  }

  return {
    dimensionsCm,
    volumeCm3,
    volumeM3,
    weightKg,
    densityKgM3,
    densityGPerCm3: densityKgM3 / 1_000,
  };
}

/** A placa usa X×Y como área e Z como espessura. */
export function calculatePlateMetrics(input = {}) {
  const result = calculatePieceMetrics({ ...input, z: input.z ?? input.dimensionZ });
  const areaM2 = (result.dimensionsCm.x * result.dimensionsCm.y) / 10_000;
  if (!Number.isFinite(areaM2)) {
    throw new EngineeringValidationError("As dimensões da placa excedem o intervalo de cálculo aceito.");
  }
  return { ...result, areaM2 };
}

function byDisplayOrder(a, b) {
  return Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0) ||
    String(a.measure_label ?? "").localeCompare(String(b.measure_label ?? ""), "pt-BR", { numeric: true });
}

/**
 * Lista as formas válidas a partir do catálogo recebido.
 * Braço usa uma medida fixa; pilar/viga usam o produto LEITO×LATERAL;
 * placa usa uma posição plana e não consome forma.
 */
export function buildMoldOptions(pieceKind, moldCatalog = []) {
  const kind = String(pieceKind ?? "").trim().toLocaleLowerCase("pt-BR");
  if (!PIECE_KINDS.has(kind)) return [];
  const catalog = Array.isArray(moldCatalog) ? moldCatalog : [];

  if (kind === "placa") {
    return [{
      key: "placa",
      label: "Bancada plana",
      pieceKind: kind,
      configurationKind: "placa",
      requiredCodes: [],
      requiresMold: false,
    }];
  }

  if (kind === "braco") {
    return catalog
      .filter((entry) => entry.mold_type === "BRACO")
      .sort(byDisplayOrder)
      .map((entry) => ({
        key: entry.code,
        label: `BRAÇO ${entry.measure_label} cm`,
        pieceKind: kind,
        configurationKind: "braco",
        requiredCodes: [entry.code],
        requiresMold: true,
      }));
  }

  const beds = catalog.filter((entry) => entry.mold_type === "LEITO").sort(byDisplayOrder);
  const sides = catalog.filter((entry) => entry.mold_type === "LATERAL").sort(byDisplayOrder);
  return beds.flatMap((bed) => sides.map((side) => ({
    key: `${bed.code}|${side.code}`,
    label: `LEITO ${bed.measure_label} cm × LATERAL ${side.measure_label} cm`,
    pieceKind: kind,
    configurationKind: "pilar_viga",
    requiredCodes: [bed.code, side.code],
    requiresMold: true,
  })));
}

/** Impede salvar combinações que não correspondam ao tipo da peça. */
export function validateMoldSelection(pieceKind, moldCodes, moldCatalog = []) {
  const kind = String(pieceKind ?? "").trim().toLocaleLowerCase("pt-BR");
  if (!PIECE_KINDS.has(kind)) {
    throw new EngineeringValidationError("Selecione um tipo de peça cadastrado.");
  }
  const codes = Array.isArray(moldCodes) ? moldCodes.map((value) => String(value).trim()).filter(Boolean) : [];
  const byCode = new Map((Array.isArray(moldCatalog) ? moldCatalog : []).map((entry) => [entry.code, entry]));

  if (kind === "placa") {
    if (codes.length) throw new EngineeringValidationError("Placa usa posição plana e não pode exigir molde.");
    return { pieceKind: kind, configurationKind: "placa", requiredCodes: [] };
  }

  const selected = codes.map((code) => byCode.get(code));
  if (selected.some((entry) => !entry)) {
    throw new EngineeringValidationError("A forma selecionada não existe no catálogo atual.");
  }

  if (kind === "braco") {
    if (selected.length !== 1 || selected[0].mold_type !== "BRACO") {
      throw new EngineeringValidationError("Braço precisa de uma única forma BRAÇO do catálogo.");
    }
    return { pieceKind: kind, configurationKind: "braco", requiredCodes: [selected[0].code] };
  }

  const selectedTypes = selected.map((entry) => entry.mold_type).sort();
  if (selected.length !== 2 || selectedTypes[0] !== "LATERAL" || selectedTypes[1] !== "LEITO") {
    throw new EngineeringValidationError("Pilar e viga precisam de exatamente um LEITO e uma LATERAL.");
  }
  const bed = selected.find((entry) => entry.mold_type === "LEITO");
  const side = selected.find((entry) => entry.mold_type === "LATERAL");
  return { pieceKind: kind, configurationKind: "pilar_viga", requiredCodes: [bed.code, side.code] };
}
