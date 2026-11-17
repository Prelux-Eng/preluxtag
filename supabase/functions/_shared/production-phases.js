/*
 * Gera os marcos horários que acompanham cada unidade programada.
 *
 * O horário-base é uma configuração operacional, enquanto duração de
 * concretagem e cura vêm do catálogo de constantes da organização. O módulo
 * não consulta Supabase para poder ser exercitado isoladamente em Node.js.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function fail(message) {
  const error = new Error(message);
  error.name = "ProductionPhaseError";
  throw error;
}

function parsePositiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) fail(`${label} deve ser maior que zero.`);
  return number;
}

function dateTimeFormatter(timeZone) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    fail(`Fuso horário inválido: ${timeZone}.`);
  }
}

function zonedDateTimeToUtc(date, time, timeZone) {
  if (!DATE_RE.test(date) || !TIME_RE.test(time)) fail("Data ou hora de concretagem inválida.");
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const formatter = dateTimeFormatter(timeZone);
  let candidate = target;

  // Ajusta o instante UTC até que sua representação no fuso da fábrica
  // coincida com a data e a hora informadas pelo operador.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(candidate))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]));
    const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const difference = target - represented;
    if (difference === 0) return new Date(candidate).toISOString();
    candidate += difference;
  }
  fail("O horário local escolhido não existe nesse fuso horário.");
}

function dateInTimeZone(instant, timeZone) {
  const parts = Object.fromEntries(dateTimeFormatter(timeZone).formatToParts(new Date(instant))
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addMinutes(instant, minutes) {
  return new Date(Date.parse(instant) + minutes * 60_000).toISOString();
}

function capacityForDate(calendarDays, date) {
  const day = calendarDays.find((entry) => entry.date === date);
  const capacity = Number(day?.capacity_minutes ?? day?.capacityMinutes ?? 0);
  if (!day || !(day.is_working ?? day.isWorking) || !Number.isInteger(capacity) || capacity <= 0) {
    fail(`A data ${date} não tem capacidade de produção no calendário.`);
  }
  return capacity;
}

/** Gera as etapas diárias e reserva a posição somente até o fim da concretagem. */
export function buildDailyProductionSteps({
  castDate,
  finishDate,
  preparationDates = [],
  calendarDays = [],
  curingDays = 2,
  timeZone = "America/Sao_Paulo",
  castStartTime = "08:00",
  preparationWorkdays = 5,
} = {}) {
  if (!DATE_RE.test(castDate || "") || !DATE_RE.test(finishDate || "")) {
    fail("Informe datas válidas para concretagem e acabamento.");
  }
  const cureDays = Number(curingDays);
  if (!Number.isInteger(cureDays) || cureDays < 1 || cureDays > 365) {
    fail("A cura precisa ter de 1 a 365 dias corridos.");
  }
  const prepDates = [...preparationDates];
  const expectedPreparationDays = Number(preparationWorkdays);
  if (!Number.isInteger(expectedPreparationDays) || expectedPreparationDays < 1) {
    fail("A preparação precisa ter uma quantidade válida de dias úteis.");
  }
  if (prepDates.length && prepDates.length !== expectedPreparationDays) {
    fail(`A preparação da forma precisa ocupar ${expectedPreparationDays} dias úteis.`);
  }
  for (const date of prepDates) capacityForDate(calendarDays, date);
  const castCapacity = capacityForDate(calendarDays, castDate);
  const finishCapacity = capacityForDate(calendarDays, finishDate);
  const castingStartAt = zonedDateTimeToUtc(castDate, castStartTime, timeZone);
  const castingEndAt = addMinutes(castingStartAt, castCapacity);
  const curingEndAt = addMinutes(castingEndAt, cureDays * 24 * 60);
  const finishingStartAt = zonedDateTimeToUtc(finishDate, castStartTime, timeZone);
  const finishingEndAt = addMinutes(finishingStartAt, finishCapacity);
  const steps = [];

  if (prepDates.length) {
    const startDate = prepDates[0];
    const endDate = prepDates.at(-1);
    const endCapacity = capacityForDate(calendarDays, endDate);
    const preparationStartAt = zonedDateTimeToUtc(startDate, castStartTime, timeZone);
    const preparationEndAt = addMinutes(zonedDateTimeToUtc(endDate, castStartTime, timeZone), endCapacity);
    if (preparationEndAt > castingStartAt) fail("A preparação precisa terminar antes da concretagem.");
    steps.push({
      stepKind: "preparacao",
      sequence: steps.length + 1,
      durationMinutes: null,
      plannedStartAt: preparationStartAt,
      plannedEndAt: preparationEndAt,
      status: "planned",
    });
  }

  steps.push(
    {
      stepKind: "concretagem",
      sequence: steps.length + 1,
      durationMinutes: castCapacity,
      plannedStartAt: castingStartAt,
      plannedEndAt: castingEndAt,
      status: "planned",
    },
    {
      stepKind: "cura",
      sequence: steps.length + 2,
      durationMinutes: cureDays * 24 * 60,
      plannedStartAt: castingEndAt,
      plannedEndAt: curingEndAt,
      status: "planned",
    },
    {
      stepKind: "acabamento",
      sequence: steps.length + 3,
      durationMinutes: finishCapacity,
      plannedStartAt: finishingStartAt,
      plannedEndAt: finishingEndAt,
      status: "planned",
    },
  );

  return {
    occupiedFromAt: steps[0].stepKind === "preparacao" ? steps[0].plannedStartAt : castingStartAt,
    occupiedUntilAt: castingEndAt,
    cureStartDate: dateInTimeZone(castingEndAt, timeZone),
    cureEndDate: dateInTimeZone(curingEndAt, timeZone),
    steps,
  };
}

/** Cria horários exatos e o intervalo em que a posição fica reservada. */
export function buildProductionPhases({
  castDate,
  timeZone = "America/Sao_Paulo",
  castStartTime = "08:00",
  castingDurationMinutes = 120,
  curingDurationHours = 12,
} = {}) {
  const castingMinutes = parsePositiveNumber(castingDurationMinutes, "A duração da concretagem");
  const curingHours = parsePositiveNumber(curingDurationHours, "A duração da cura");
  if (!Number.isInteger(castingMinutes) || !Number.isInteger(curingHours)) {
    fail("As durações de concretagem e cura precisam ser números inteiros.");
  }

  const castingStartAt = zonedDateTimeToUtc(castDate, castStartTime, timeZone);
  const castingEndAt = addMinutes(castingStartAt, castingMinutes);
  const curingEndAt = addMinutes(castingEndAt, curingHours * 60);

  return {
    occupiedFromAt: castingStartAt,
    occupiedUntilAt: curingEndAt,
    cureStartDate: dateInTimeZone(castingEndAt, timeZone),
    cureEndDate: dateInTimeZone(curingEndAt, timeZone),
    steps: [
      {
        stepKind: "concretagem",
        sequence: 1,
        durationMinutes: castingMinutes,
        plannedStartAt: castingStartAt,
        plannedEndAt: castingEndAt,
        status: "planned",
      },
      {
        stepKind: "cura",
        sequence: 2,
        durationMinutes: curingHours * 60,
        plannedStartAt: castingEndAt,
        plannedEndAt: curingEndAt,
        status: "planned",
      },
      // A engenharia ainda não informou duração para estas três etapas.
      // Os registros existem para mostrar a sequência e receber a definição.
      ...["acabamento", "inspecao", "liberacao"].map((stepKind, index) => ({
        stepKind,
        sequence: index + 3,
        durationMinutes: null,
        plannedStartAt: null,
        plannedEndAt: null,
        status: "planned",
      })),
    ],
  };
}

