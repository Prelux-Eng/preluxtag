/*
 * Repositório de cadastros e operações.
 *
 * Mantém juntas as chamadas de leitura e gravação de obras, pedidos, peças,
 * moldes, posições, preparações e alocações de recursos.
 */
(function attachOperationsRepository(global) {
  const api = global.PRELUX_API;
  const operation = (action, input = {}) => api.invoke("operations-admin", { action, ...input });

  global.PRELUX_REPOSITORIES ||= {};
  global.PRELUX_REPOSITORIES.operations = Object.freeze({
    calculatePieceMetrics: (input) => operation("calculate_piece_metrics", input),
    saveDelayAdjustment: (input) => operation("save_delay_adjustment", input),
    getOperationsData: () => operation("bootstrap"),
    saveWork: (input) => operation("save_work", input),
    saveOrder: (input) => operation("save_order", input),
    savePieceType: (input) => operation("save_piece_type", input),
    saveMold: (input) => operation("save_mold", input),
    saveMoldPosition: (input) => operation("save_position", input),
    saveMoldPreparation: (input) => operation("save_preparation", input),
    saveResourceAllocation: (input) => operation("save_allocation", input),
    archiveOperationRecord: (kind, id) => operation("archive", { kind, id }),
  });
})(window);
