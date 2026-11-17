/**
 * Adapta a resposta do simulador para as três visões do calendário.
 * A resposta é uma previsão: nenhum destes registros é uma reserva gravada.
 */
export function calendarUnitsFromScenario(scenario, orders = []) {
  const itemLabels = new Map(orders.flatMap((order) =>
    (order.items || []).map((item) => [item.id, item.piece_code || item.piece_name || "Peça"])
  ));
  return (scenario?.orders || []).flatMap((order) => (order.units || []).map((unit) => ({
    order_id: order.orderId,
    order_item_id: unit.itemId,
    piece_type_id: unit.pieceTypeId,
    piece_code: itemLabels.get(unit.itemId) || "Peça",
    position_code: unit.positionCode,
    planned_cast_date: unit.castDate,
    planned_cure_start_date: unit.cureStartDate,
    planned_cure_end_date: unit.cureEndDate,
    planned_finish_date: unit.finishDate,
    preparation_start_date: unit.preparationStartDate,
    preparation_end_date: unit.preparationEndDate,
    preparation_required: unit.preparationRequired,
    preparation_reason: unit.preparationReason,
    position_selection_reason: unit.positionSelectionReason,
    unit_sequence: unit.unitSequence,
    forecast_kind: order.status === "orcamento" ? "quote" : "approved",
    status: "forecast",
  })));
}

/** Preparação e concretagem ocupam; cura e acabamento não ocupam a posição. */
export function occupiedPositionCodes(units, date) {
  return new Set(occupyingUnits(units, date).map((unit) => unit.position_code));
}

function occupyingUnits(units, date) {
  return units.filter((unit) => unit.position_code &&
    (unit.planned_cast_date === date ||
      (unit.preparation_start_date && date >= unit.preparation_start_date && date <= unit.preparation_end_date)));
}

/** Conta sobreposição de unidades na mesma posição e no mesmo dia. */
export function positionConflictCount(units, date) {
  const use = occupyingUnits(units, date);
  return use.length - new Set(use.map((unit) => unit.position_code)).size;
}

export function visibleCalendarUnits(scenarioUnits, persistedUnits, startedOrderIds) {
  const started = new Set(startedOrderIds);
  // Apenas unidades de pedidos iniciados vêm do plano persistido. Os demais
  // vêm do motor novo para impedir datas duplicadas ou obsoletas na previsão.
  return [...persistedUnits.filter((unit) => started.has(unit.order_id)), ...(scenarioUnits || [])];
}
