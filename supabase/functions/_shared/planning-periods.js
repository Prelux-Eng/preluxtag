/* Consolida as datas das unidades gravadas para o calendário impresso. */
const activeUnitStatuses = new Set(["planned", "in_progress", "done", "pronta"]);

function dateOnly(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

export function summarizePlanningPeriods(orderIds, items, units) {
  const periods = new Map(orderIds.map((orderId) => [orderId, {
    order_id: orderId,
    requested: 0,
    scheduled: 0,
    planned_start_date: null,
    forecast_end_date: null,
    dates_complete: true,
  }]));

  for (const item of items) {
    const period = periods.get(item.order_id);
    if (period) period.requested += Math.max(0, Number(item.quantity) || 0);
  }
  for (const unit of units) {
    const period = periods.get(unit.order_id);
    if (!period || !activeUnitStatuses.has(unit.status)) continue;
    const start = dateOnly(unit.planned_cast_date);
    const end = dateOnly(unit.forecast_end_date);
    period.scheduled += 1;
    if (!start || !end || end < start) period.dates_complete = false;
    if (start && (!period.planned_start_date || start < period.planned_start_date)) {
      period.planned_start_date = start;
    }
    if (end && (!period.forecast_end_date || end > period.forecast_end_date)) {
      period.forecast_end_date = end;
    }
  }

  return [...periods.values()].map((period) => {
    const complete = period.requested > 0 && period.scheduled >= period.requested
      && period.dates_complete && Boolean(period.planned_start_date && period.forecast_end_date);
    return {
      order_id: period.order_id,
      planned_start_date: period.planned_start_date,
      forecast_end_date: complete ? period.forecast_end_date : null,
      complete,
    };
  });
}
