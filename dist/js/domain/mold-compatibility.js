/*
 * Regras puras de compatibilidade entre tipo de peça e molde.
 *
 * Braço usa os moldes fixos BRACO. Pilar e Viga usam o produto cartesiano
 * LEITO × LATERAL. O catálogo retornado pela base é preferido; o produto
 * cartesiano local é o fallback quando a view ainda não está disponível.
 */
const strategies = {
  braco: {
    options({ catalog }) {
      return catalog
        .filter((item) => item.mold_type === "BRACO")
        .map((item) => [item.code, `BRAÇO ${item.measure_label} cm`]);
    },
  },
  pilar: { options: variableMoldOptions },
  viga: { options: variableMoldOptions },
};

function variableMoldOptions({ catalog, combinations }, pieceKind) {
  const validRows = combinations.filter((item) =>
    item.piece_kind === pieceKind && item.configuration_kind === "pilar_viga");
  if (validRows.length) {
    return validRows.map((item) => [item.option_key || item.key, item.label]);
  }

  const beds = catalog.filter((item) => item.mold_type === "LEITO");
  const sides = catalog.filter((item) => item.mold_type === "LATERAL");
  return beds.flatMap((bed) => sides.map((side) => [
    `${bed.code}|${side.code}`,
    `LEITO ${bed.measure_label} cm × LATERAL ${side.measure_label} cm`,
  ]));
}

/** Retorna opções de molde adequadas ao tipo de peça selecionado. */
export function listPieceMoldOptions(pieceKind, source = {}) {
  const strategy = strategies[pieceKind];
  if (!strategy) return [];

  const catalog = Array.isArray(source.catalog) ? source.catalog : [];
  const combinations = Array.isArray(source.combinations) ? source.combinations : [];
  return strategy.options({ catalog, combinations }, pieceKind);
}
