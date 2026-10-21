import { dateRange, normalizeDate } from "./planner.js";

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function matchingException(exceptions, date) {
  return exceptions
    .filter((exception) => {
      const start = normalizeDate(exception.start_date, "início da exceção");
      const end = normalizeDate(exception.end_date, "fim da exceção");
      return exception.is_active !== false && date >= start && date <= end;
    })
    .sort((left, right) => {
      const priorityDifference = Number(right.priority || 0) - Number(left.priority || 0);
      if (priorityDifference !== 0) return priorityDifference;
      return String(right.updated_at || "").localeCompare(String(left.updated_at || ""));
    })[0] || null;
}

/** Gera linhas de calendar_days a partir das regras semanais e exceções. */
export function buildCalendarDays({
  startDate,
  endDate,
  settings = {},
  rules = [],
  exceptions = [],
}) {
  const defaultCapacity = Math.max(
    0,
    numberOrZero(settings.default_capacity_minutes ?? settings.defaultCapacityMinutes ?? 0),
  );
  const ruleByWeekday = new Map(
    rules.map((rule) => [Number(rule.weekday), rule]),
  );

  return dateRange(startDate, endDate).map((date) => {
    const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
    const rule = ruleByWeekday.get(weekday);
    const baseWorking = rule ? Boolean(rule.is_working) : weekday >= 1 && weekday <= 5;
    const baseCapacity = rule?.capacity_minutes ?? defaultCapacity;
    const exception = matchingException(exceptions, date);
    const isWorking = exception ? Boolean(exception.is_working) : baseWorking;
    const capacityMinutes = isWorking
      ? Math.max(0, numberOrZero(exception?.capacity_minutes ?? baseCapacity))
      : 0;

    return {
      date,
      is_working: isWorking,
      capacity_minutes: capacityMinutes,
      source: exception ? "excecao" : "regra",
      exception_id: exception?.id ?? null,
      note: exception?.name ?? null,
    };
  });
}
