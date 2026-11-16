/*
 * Portas de acesso aos cadastros de produção.
 *
 * As telas chamam métodos por assunto; somente este arquivo conhece o endpoint
 * operations-admin e as ações usadas para persistir os registros.
 */
import { invoke } from "../core/api.js";

const operation = (action, input = {}) => invoke("operations-admin", { action, ...input });

export const operationsRepository = Object.freeze({
  calculatePieceMetrics: (input) => operation("calculate_piece_metrics", input),
  saveDelayAdjustment: (input) => operation("save_delay_adjustment", input),
  getOperationsData: () => operation("bootstrap"),
  saveWork: (input) => operation("save_work", input),
  saveOrder: (input) => operation("save_order", input),
  createOrderHeader: (input) => operation("create_order_header", input),
  addOrderPieceItem: (input) => operation("add_order_piece_item", input),
  createOrderPieceRegistration: (input) => operation("create_order_piece_registration", input),
  saveEngineeringProject: (input) => operation("save_engineering_project", input),
  savePieceType: (input) => operation("save_piece_type", input),
  savePlateType: (input) => operation("save_plate_type", input),
  saveMold: (input) => operation("save_mold", input),
  saveMoldPosition: (input) => operation("save_position", input),
  resetPositionForm: (input) => operation("reset_position_form", input),
  completeProductionStep: (input) => operation("complete_production_step", input),
  withdrawProductionUnit: (input) => operation("withdraw_production_unit", input),
  saveMoldPreparation: (input) => operation("save_preparation", input),
  calculateMoldPreparationEnd: (input) => operation("calculate_preparation_end", input),
  saveResourceAllocation: (input) => operation("save_allocation", input),
  archiveOperationRecord: (kind, id) => operation("archive", { kind, id }),
  deleteOperationRecord: (kind, id) => operation("delete_record", { kind, id }),
});
