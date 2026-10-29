/*
 * Regras puras de compatibilidade entre tipo de peça e molde.
 *
 * Strategy: cada tipo de peça escolhe sua própria estratégia. Braço usa um
 * molde fixo BRACO; Pilar e Viga usam as combinações LEITO × LATERAL. A função
 * também gera o produto cartesiano como fallback se a view não estiver disponível.
 */
(function attachMoldCompatibility(global) {
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

    // Fallback local equivalente à view piece_mold_combinations do Supabase.
    const beds = catalog.filter((item) => item.mold_type === "LEITO");
    const sides = catalog.filter((item) => item.mold_type === "LATERAL");
    return beds.flatMap((bed) => sides.map((side) => [
      `${bed.code}|${side.code}`,
      `LEITO ${bed.measure_label} cm × LATERAL ${side.measure_label} cm`,
    ]));
  }

  function listPieceMoldOptions(pieceKind, source = {}) {
    const strategy = strategies[pieceKind];
    if (!strategy) return [];

    const catalog = Array.isArray(source.catalog) ? source.catalog : [];
    const combinations = Array.isArray(source.combinations) ? source.combinations : [];
    return strategy.options({ catalog, combinations }, pieceKind);
  }

  global.PRELUX_DOMAIN ||= {};
  global.PRELUX_DOMAIN.moldCompatibility = Object.freeze({ listPieceMoldOptions });
})(window);
