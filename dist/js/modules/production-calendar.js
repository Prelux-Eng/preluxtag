(function productionCalendarModule() {
  const $ = (id) => document.getElementById(id);
  const state = {
    mode: "month",
    days: [],
    exceptions: [],
    orders: [],
    works: [],
    schedules: [],
    productionOrders: [],
    positions: [],
    capacityByPositions: [],
    unitPlanningAvailable: false,
    startedOrderIds: [],
    settings: { default_capacity_minutes: 480, rules: [] },
    selectedDate: null,
    editingActivityId: null,
    pendingPlan: null,
    pendingOrderId: null,
    dragContext: null,
    refreshPromise: null,
    refreshPending: false,
  };
  const activeStatuses = new Set(["orcamento", "aprovado", "em_producao", "atrasado"]);
  const terminalStatuses = new Set(["concluido", "entregue", "cancelado"]);
  const activityKindLabels = {
    feriado: "Feriado",
    dia_extra: "Dia extra",
    parada: "Parada",
    manutencao: "Manutenção",
    folga_coletiva: "Folga coletiva",
    personalizada: "Personalizada",
  };

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[character]);
  }

  function localToday() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  }

  function anchorDate() {
    if (!$('planningAnchor').value) $('planningAnchor').value = localToday();
    return $('planningAnchor').value;
  }

  function isoDate(date) {
    return date.toISOString().slice(0, 10);
  }

  function addDays(value, amount) {
    const date = new Date(`${value}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + amount);
    return isoDate(date);
  }

  function dateDistance(start, end) {
    return Math.round((new Date(`${end}T00:00:00.000Z`) - new Date(`${start}T00:00:00.000Z`)) / 86400000);
  }

  function monthBounds(value = anchorDate()) {
    const [year, month] = value.split("-").map(Number);
    return {
      start: `${year}-${String(month).padStart(2, "0")}-01`,
      end: isoDate(new Date(Date.UTC(year, month, 0))),
    };
  }

  function weekBounds(value = anchorDate()) {
    const weekday = new Date(`${value}T00:00:00.000Z`).getUTCDay();
    const mondayOffset = (weekday + 6) % 7;
    const start = addDays(value, -mondayOffset);
    return { start, end: addDays(start, 6) };
  }

  function visibleBounds() {
    return state.mode === "week" ? weekBounds() : monthBounds();
  }

  function formatDateBR(value) {
    const [year, month, day] = String(value || "").split("-");
    return day && month && year ? `${day}/${month}/${year}` : "—";
  }

  function formatOrder(order) {
    const reference = order?.order_number || "Pedido sem número";
    return [reference, order?.work_name, order?.client_name].filter(Boolean).join(" · ");
  }

  function orderById(orderId) {
    return state.orders.find((order) => order.id === orderId) || null;
  }

  function dateSpan(record) {
    const start = record?.start_date || record?.requested_due_date;
    const end = record?.requested_due_date || record?.start_date;
    if (!start || !end) return null;
    return start <= end ? { start, end } : { start: end, end: start };
  }

  function spanContains(record, date) {
    const span = dateSpan(record);
    return Boolean(span && date >= span.start && date <= span.end);
  }

  function spanOverlaps(record, start, end) {
    const span = dateSpan(record);
    return Boolean(span && span.start <= end && span.end >= start);
  }

  function activeCalendarOrders() {
    return state.orders.filter((order) => activeStatuses.has(order.status) && !terminalStatuses.has(order.status));
  }

  function activeCalendarWorks() {
    return state.works.filter((work) => ["planejamento", "ativa"].includes(work.status));
  }

  function orderWindowLabel(order) {
    const span = dateSpan(order);
    const period = span
      ? `${formatDateBR(span.start)}${span.end !== span.start ? ` a ${formatDateBR(span.end)}` : ""}`
      : "sem datas cadastradas";
    return `Pedido · ${formatOrder(order)} · ${period}`;
  }

  function workWindowLabel(work) {
    const span = dateSpan(work);
    const period = span
      ? `${formatDateBR(span.start)}${span.end !== span.start ? ` a ${formatDateBR(span.end)}` : ""}`
      : "sem datas cadastradas";
    return `Obra · ${work.work_number || work.name}${work.work_number ? ` · ${work.name}` : ""} · ${period}`;
  }

  function orderSchedules(orderId) {
    return state.schedules.filter((schedule) => schedule.order_id === orderId);
  }

  function scheduleLabel(schedule) {
    const order = orderById(schedule.order_id);
    const piece = [schedule.piece_code, schedule.piece_name].filter(Boolean).join(" · ");
    return `${formatOrder(order)}${piece ? ` · ${piece}` : ""} · ${schedule.planned_quantity} un.`;
  }

  function getDay(date) {
    return state.days.find((day) => day.date === date) || null;
  }

  function exceptionsForDate(date) {
    return state.exceptions
      .filter((item) => item.start_date <= date && item.end_date >= date)
      .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0));
  }

  function schedulesForDate(date) {
    return state.schedules.filter((schedule) => schedule.work_date === date);
  }

  const DEFAULT_POSITION_CODES = ["P01", "P02", "P03", "P04"];

  function activePositionCount() {
    const unavailable = new Set(state.positions
      .filter((position) => position.status === "em_manutencao")
      .map((position) => position.code));
    return DEFAULT_POSITION_CODES.filter((code) => !unavailable.has(code)).length;
  }

  function productionUnitsForDate(date) {
    return state.productionOrders.filter((unit) => unit.planned_cast_date === date);
  }

  function useLegacyScheduleView() {
    return !state.unitPlanningAvailable || (!state.productionOrders.length && state.schedules.length > 0);
  }

  function positionStats(date) {
    const day = getDay(date) || { is_working: false };
    const positionCount = activePositionCount();
    const capacity = state.capacityByPositions.find((item) => item.date === date);
    const plannedUnits = !useLegacyScheduleView()
      ? productionUnitsForDate(date).length
      : schedulesForDate(date).reduce((sum, schedule) => sum + Math.max(0, Number(schedule.planned_quantity) || 0), 0);
    const assignedPositions = !useLegacyScheduleView()
      ? new Set(productionUnitsForDate(date).map((unit) => unit.position_code).filter(Boolean)).size
      : schedulesForDate(date).reduce((sum, schedule) => sum + Math.max(0, Number(schedule.planned_quantity) || 0), 0);
    const occupied = Math.max(Number(capacity?.occupied_positions) || 0, assignedPositions, plannedUnits);
    const available = day.is_working ? positionCount : 0;
    return {
      positionCount,
      plannedUnits,
      occupied,
      available,
      overCapacity: occupied > available,
    };
  }

  function unitOrder(unit) {
    return unit.order_id || "";
  }

  function unitPieceLabel(unit) {
    return unit.piece_code || unit.piece_name || "Peça";
  }

  function phaseEventsForDate(date) {
    if (useLegacyScheduleView()) {
      return schedulesForDate(date).map((schedule) => ({ kind: "casting", value: schedule, quantity: Number(schedule.planned_quantity) || 0 }));
    }
    const units = state.productionOrders;
    const result = [];
    const groups = new Map();
    const addGroup = (kind, unit, keyPart = "") => {
      const orderId = unitOrder(unit);
      const key = `${kind}|${orderId}|${unitPieceLabel(unit)}|${keyPart}`;
      const group = groups.get(key) || { kind, value: unit, quantity: 0 };
      group.quantity += 1;
      groups.set(key, group);
    };
    for (const unit of units) {
      if (unit.planned_cast_date === date) addGroup("casting", unit, unit.position_code || "unallocated");
      if (unit.planned_cure_start_date && unit.planned_cure_end_date && date >= unit.planned_cure_start_date && date <= unit.planned_cure_end_date) {
        addGroup("curing", unit);
      }
      if (unit.planned_finish_date === date) addGroup("finish", unit);
    }
    result.push(...groups.values());
    return result;
  }

  function phaseEventLabel(event) {
    const value = event.value;
    const order = orderById(unitOrder(value));
    const reference = order?.order_number || "Pedido";
    const piece = value.piece_code || value.piece_name || "Peça";
    if (event.kind === "casting") {
      const position = value.position_code || "sem posição";
      return `${position} · ${reference} · ${piece}${event.quantity > 1 ? ` ×${event.quantity}` : ""}`;
    }
    return `${event.kind === "curing" ? "Cura" : "Acabamento"} · ${reference} · ${piece}${event.quantity > 1 ? ` ×${event.quantity}` : ""}`;
  }

  function showStatus(id, message, isError = false) {
    const element = $(id);
    element.textContent = message;
    element.classList.toggle("show", Boolean(message));
    element.classList.toggle("error", Boolean(isError));
  }

  function renderDay(date, options = {}) {
    const day = getDay(date) || { is_working: false, capacity_minutes: 0 };
    const stats = positionStats(date);
    const occupancy = stats.positionCount ? Math.round(stats.occupied / stats.positionCount * 100) : 0;
    const width = Math.min(100, occupancy);
    const occupancyClass = stats.overCapacity ? "over" : occupancy >= 75 ? "high" : "";
    const activities = exceptionsForDate(date);
    const note = activities[0]?.name || day.note || "";
    const todayClass = date === localToday() ? "today" : "";
    const selectedClass = date === state.selectedDate ? "selected" : "";
    const nonWorkingClass = day.is_working ? "" : "non-working";
    const activityLabel = note ? `<span class="calendar-day-activity" title="${escapeHtml(note)}">${escapeHtml(note)}</span>` : "";
    const datePhases = phaseEventsForDate(date);
    const scheduledOrderIds = new Set(datePhases.map((event) => unitOrder(event.value)).filter(Boolean));
    const dateOrders = activeCalendarOrders().filter((order) =>
      spanContains(order, date) && !scheduledOrderIds.has(order.id)
    );
    const dateWorks = activeCalendarWorks().filter((work) => spanContains(work, date));
    const events = [
      ...datePhases,
      ...dateOrders.map((order) => ({ kind: "order", value: order })),
      ...dateWorks.map((work) => ({ kind: "work", value: work })),
    ];
    const eventLimit = options.week ? 8 : 3;
    const eventRows = events.slice(0, eventLimit).map((event) => {
      if (event.kind === "order") {
        return `<span class="calendar-window-event order-window" title="${escapeHtml(orderWindowLabel(event.value))}">Pedido · ${escapeHtml(event.value.order_number || "Sem número")}</span>`;
      }
      if (event.kind === "work") {
        const work = event.value;
        return `<span class="calendar-window-event work-window" title="${escapeHtml(workWindowLabel(work))}">Obra · ${escapeHtml(work.work_number || work.name)}</span>`;
      }
      const value = event.value;
      const orderId = unitOrder(value);
      const order = orderById(orderId);
      const isCasting = event.kind === "casting";
      const statusClass = value.status === "in_progress" ? "in-progress" : value.status === "done" ? "done" : "";
      const canDrag = isCasting && value.status === "planned" && orderId && !state.startedOrderIds.includes(orderId);
      const className = event.kind === "casting" ? "casting-event" : event.kind === "curing" ? "curing-event" : "finish-event";
      const title = `${phaseEventLabel(event)} · ${formatDateBR(date)}${event.kind === "curing" ? " · cura não ocupa posição" : ""}`;
      const label = !useLegacyScheduleView() ? phaseEventLabel(event) : `${formatOrder(order)} · ${value.piece_code || "produção"} · ${Number(value.planned_quantity)} un.`;
      return `<button class="calendar-event ${className} ${statusClass}" type="button" data-order-event="${escapeHtml(orderId)}" data-work-date="${date}" title="${escapeHtml(title)}"${canDrag ? ' draggable="true"' : ""}>${escapeHtml(label)}</button>`;
    }).join("");
    const remainingEvents = events.length - eventLimit;
    const positionLabel = day.is_working
      ? `${stats.occupied}/${stats.positionCount} posições${stats.overCapacity ? " · conflito" : ""}`
      : stats.plannedUnits ? `Sem produção · ${stats.plannedUnits} concretagem(ns)` : "Sem produção";
    return `<div class="calendar-day ${nonWorkingClass} ${todayClass} ${selectedClass}" role="button" tabindex="0" data-calendar-date="${date}" title="Abrir ajustes de ${formatDateBR(date)}"><span class="calendar-day-head"><span class="calendar-day-number">${Number(date.slice(-2))}</span><span class="calendar-day-status">${day.is_working ? "útil" : "parado"}</span></span><span class="calendar-day-capacity ${stats.overCapacity ? "position-conflict" : ""}">${positionLabel}</span>${activityLabel}<span class="calendar-day-occupancy"><i class="${occupancyClass}" style="width:${width}%"></i></span><div class="calendar-events">${eventRows}${remainingEvents > 0 ? `<span class="calendar-event-more">+${remainingEvents} etapas</span>` : ""}</div></div>`;
  }

  function renderMonth() {
    const { start, end } = monthBounds();
    const firstWeekday = (new Date(`${start}T00:00:00.000Z`).getUTCDay() + 6) % 7;
    const daysCount = dateDistance(start, end) + 1;
    const weekdays = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];
    let html = weekdays.map((day) => `<div class="calendar-weekday">${day}</div>`).join("");
    html += Array.from({ length: firstWeekday }, () => '<div class="calendar-empty"></div>').join("");
    for (let offset = 0; offset < daysCount; offset += 1) html += renderDay(addDays(start, offset));
    const trailing = (7 - ((firstWeekday + daysCount) % 7)) % 7;
    html += Array.from({ length: trailing }, () => '<div class="calendar-empty"></div>').join("");
    $('planningCalendarState').className = "calendar-state calendar-month-view";
    $('planningCalendarState').innerHTML = `<div class="calendar-grid">${html}</div>`;
    $('planningCalendarHeading').textContent = new Date(`${start}T00:00:00.000Z`).toLocaleDateString("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" });
  }

  function renderWeek() {
    const { start, end } = weekBounds();
    const weekdays = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];
    let html = weekdays.map((day) => `<div class="calendar-weekday">${day}</div>`).join("");
    for (let offset = 0; offset < 7; offset += 1) html += renderDay(addDays(start, offset), { week: true });
    $('planningCalendarState').className = "calendar-state calendar-week-view";
    $('planningCalendarState').innerHTML = `<div class="calendar-grid">${html}</div>`;
    $('planningCalendarHeading').textContent = `Semana de ${formatDateBR(start)} a ${formatDateBR(end)}`;
  }

  function renderGantt() {
    const { start, end } = monthBounds();
    const count = dateDistance(start, end) + 1;
    const unitsInRange = state.productionOrders.filter((unit) =>
      (unit.planned_cast_date >= start && unit.planned_cast_date <= end)
      || (unit.planned_cure_start_date && unit.planned_cure_start_date <= end && unit.planned_cure_end_date >= start)
      || (unit.planned_finish_date >= start && unit.planned_finish_date <= end)
    );
    const ordersWithDates = activeCalendarOrders().filter((order) =>
      spanOverlaps(order, start, end)
      || unitsInRange.some((unit) => unit.order_id === order.id)
      || state.schedules.some((item) => item.order_id === order.id && item.work_date >= start && item.work_date <= end)
    );
    const worksWithDates = activeCalendarWorks().filter((work) => spanOverlaps(work, start, end));
    const template = `--gantt-days:${count}`;
    const headings = Array.from({ length: count }, (_, index) => {
      const date = addDays(start, index);
      const day = getDay(date) || { is_working: false };
      const stats = positionStats(date);
      return `<div class="gantt-cell ${day.is_working ? "" : "off"}" data-calendar-date="${date}" title="${formatDateBR(date)} · ${day.is_working ? `${stats.occupied}/${stats.positionCount} posições` : "sem produção"}"><span>${Number(date.slice(-2))}</span><small>${day.is_working ? `${stats.occupied}/${stats.positionCount}` : "—"}</small></div>`;
    }).join("");
    let rows = "";
    const appendRow = (label, getContent, rowClass = "") => {
      rows += `<div class="gantt-label ${rowClass}">${escapeHtml(label)}</div>`;
      for (let index = 0; index < count; index += 1) {
        const date = addDays(start, index);
        const day = getDay(date) || { is_working: false };
        const stats = positionStats(date);
        rows += `<div class="gantt-cell ${day.is_working ? "" : "off"} ${stats.overCapacity ? "over" : ""}" data-calendar-date="${date}" title="${formatDateBR(date)} · ${day.is_working ? `${stats.occupied}/${stats.positionCount} posições` : "sem produção"}">${getContent(date)}</div>`;
      }
    };
    const ganttUnitsFor = (date, kind, positionCode = null) => unitsInRange.filter((unit) => {
      if (kind === "casting") return unit.planned_cast_date === date && (!positionCode || unit.position_code === positionCode);
      if (kind === "curing") return unit.planned_cure_start_date && unit.planned_cure_end_date && date >= unit.planned_cure_start_date && date <= unit.planned_cure_end_date;
      return unit.planned_finish_date === date;
    });
    const positionMeta = new Map(state.positions.map((position) => [position.code, position]));
    const positionCodes = [...new Set([...DEFAULT_POSITION_CODES, ...state.positions.map((position) => position.code)])].sort();
    rows += `<div class="gantt-stage-heading">Concretagem · ocupa uma posição somente no dia marcado</div>`;
    for (const code of positionCodes) {
      const position = positionMeta.get(code);
      const unavailable = position?.status === "em_manutencao";
      appendRow(`${code}${unavailable ? " · manutenção" : ""}`, (date) => {
        if (!useLegacyScheduleView()) {
          return ganttUnitsFor(date, "casting", code).map((unit) => {
            const orderId = unit.order_id;
            const order = orderById(orderId);
            const draggable = unit.status === "planned" && orderId && !state.startedOrderIds.includes(orderId);
            const label = `${escapeHtml(order?.order_number || "Pedido")} · ${escapeHtml(unitPieceLabel(unit))}`;
            return `<button class="gantt-work casting-work" type="button" data-order-event="${escapeHtml(orderId)}" data-work-date="${date}" title="${escapeHtml(phaseEventLabel({ kind: "casting", value: unit, quantity: 1 }))}"${draggable ? ' draggable="true"' : ""}>${label}</button>`;
          }).join("");
        }
        return "";
      }, unavailable ? "position-unavailable" : "position-label");
    }
    if (!useLegacyScheduleView()) {
      const unallocatedUnits = unitsInRange.filter((unit) => unit.planned_cast_date >= start && unit.planned_cast_date <= end && !unit.position_code);
      if (unallocatedUnits.length) {
        appendRow("Sem posição alocada", (date) => unallocatedUnits.filter((unit) => unit.planned_cast_date === date).map((unit) => {
          const order = orderById(unit.order_id);
          return `<span class="gantt-work unallocated-work" title="Concretagem sem posição atribuída">${escapeHtml(order?.order_number || "Pedido")} · ${escapeHtml(unitPieceLabel(unit))}</span>`;
        }).join(""), "position-unavailable");
      }
    } else {
      appendRow("Programação resumida · sem posição individual", (date) => schedulesForDate(date).map((schedule) => {
        const order = orderById(schedule.order_id);
        return `<button class="gantt-work casting-work" type="button" data-order-event="${escapeHtml(schedule.order_id)}" data-work-date="${date}" title="${escapeHtml(scheduleLabel(schedule))}">${escapeHtml(order?.order_number || "Pedido")} · ${escapeHtml(schedule.piece_code || "produção")} ×${Number(schedule.planned_quantity) || 0}</button>`;
      }).join(""), "position-unavailable");
    }
    rows += `<div class="gantt-stage-heading">Cura · intervalo corrido, sem ocupar posição</div>`;
    appendRow("Cura", (date) => ganttUnitsFor(date, "curing").map((unit) => {
      const order = orderById(unit.order_id);
      return `<span class="gantt-work curing-work" title="${escapeHtml(order?.order_number || "Pedido")} · ${escapeHtml(unitPieceLabel(unit))} · cura de ${formatDateBR(unit.planned_cure_start_date)} a ${formatDateBR(unit.planned_cure_end_date)}">${escapeHtml(order?.order_number || "Pedido")} · ${escapeHtml(unitPieceLabel(unit))}</span>`;
    }).join(""), "phase-label curing-label");
    rows += `<div class="gantt-stage-heading">Acabamento · primeiro dia útil após a cura</div>`;
    appendRow("Acabamento", (date) => ganttUnitsFor(date, "finish").map((unit) => {
      const order = orderById(unit.order_id);
      return `<button class="gantt-work finish-work" type="button" data-order-event="${escapeHtml(unit.order_id)}" data-work-date="${date}" title="${escapeHtml(order?.order_number || "Pedido")} · ${escapeHtml(unitPieceLabel(unit))} · acabamento">${escapeHtml(order?.order_number || "Pedido")} · ${escapeHtml(unitPieceLabel(unit))}</button>`;
    }).join(""), "phase-label finish-label");
    rows += `<div class="gantt-stage-heading">Datas dos pedidos e das obras cadastradas</div>`;
    for (const order of ordersWithDates) {
      appendRow(`Pedido · ${order.order_number || "Sem número"}`, (date) => spanContains(order, date) ? '<span class="gantt-order-window" aria-hidden="true"></span>' : "", "order-label");
    }
    for (const work of worksWithDates) {
      appendRow(`Obra · ${work.work_number || work.name}`, (date) => spanContains(work, date) ? '<span class="gantt-work-window" aria-hidden="true"></span>' : "", "work-label");
    }
    const hasRows = ordersWithDates.length > 0 || worksWithDates.length > 0;
    const hasPhaseEvents = !useLegacyScheduleView() ? unitsInRange.length > 0 : state.schedules.length > 0;
    const empty = hasRows || hasPhaseEvents ? "" : '<div class="gantt-empty">Nenhuma concretagem, etapa, pedido ou obra neste mês.</div>';
    $('planningCalendarState').className = "calendar-state calendar-gantt-view";
    $('planningCalendarState').innerHTML = `<div class="gantt-wrap"><div class="gantt-group"><div class="gantt-resource">Etapas e posições de produção<span>${count} dias · quatro posições físicas · a cura não ocupa posição</span></div><div class="gantt-timeline gantt-head" style="${template}"><div class="gantt-label">Etapa / recurso</div>${headings}</div><div class="gantt-timeline" style="${template}">${rows}${empty}</div></div></div>`;
    $('planningCalendarHeading').textContent = `Gantt · ${new Date(`${start}T00:00:00.000Z`).toLocaleDateString("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" })}`;
  }

  function renderSummary() {
    const workingDays = state.days.filter((day) => day.is_working);
    const capacityPositions = workingDays.reduce((sum) => sum + activePositionCount(), 0);
    const plannedPositions = workingDays.reduce((sum, day) => sum + positionStats(day.date).plannedUnits, 0);
    const occupancy = capacityPositions ? Math.round(plannedPositions / capacityPositions * 100) : 0;
    const alertDays = state.days.filter((day) => positionStats(day.date).overCapacity).length;
    const activeOrders = state.orders.filter((order) => activeStatuses.has(order.status)).length;
    const today = getDay(localToday());
    const todayStats = today ? positionStats(today.date) : null;
    const bounds = visibleBounds();
    const exceptionCount = state.exceptions.length;
    const eventCount = !useLegacyScheduleView()
      ? state.productionOrders.filter((unit) => unit.planned_cast_date >= bounds.start && unit.planned_cast_date <= bounds.end).length
      : state.schedules.reduce((sum, schedule) => sum + (Number(schedule.planned_quantity) || 0), 0);
    const datedOrders = activeCalendarOrders().filter((order) => spanOverlaps(order, bounds.start, bounds.end)).length;
    const datedWorks = activeCalendarWorks().filter((work) => spanOverlaps(work, bounds.start, bounds.end)).length;
    $('planningCalendarSummary').textContent = `${workingDays.length} dias úteis · ${eventCount} ${eventCount === 1 ? "concretagem" : "concretagens"} no período · ${datedOrders} pedido${datedOrders === 1 ? "" : "s"} e ${datedWorks} obra${datedWorks === 1 ? "" : "s"} no período · ${exceptionCount} atividade${exceptionCount === 1 ? "" : "s"} de calendário.`;
    $('planningOrdersKpi').textContent = String(activeOrders);
    $('planningOccupancyKpi').textContent = `${occupancy}%`;
    $('planningCapacityKpi').textContent = todayStats ? `${todayStats.occupied}/${todayStats.positionCount}` : "—";
    $('planningAlertsKpi').textContent = String(alertDays);
    const weekdayNames = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
    const workingWeekdays = state.settings.rules.length
      ? state.settings.rules.filter((rule) => rule.is_working).map((rule) => Number(rule.weekday))
      : [1, 2, 3, 4, 5];
    $('planningWorkdaysSummary').textContent = workingWeekdays.length
      ? workingWeekdays.map((weekday) => weekdayNames[weekday]).join(", ")
      : "Sem dias definidos";
    $('planningDefaultCapacitySummary').textContent = `${activePositionCount()} posições por dia útil`;
  }

  function renderCalendar() {
    renderPlanningBacklog();
    if (!state.days.length) {
      $('planningCalendarState').className = "calendar-placeholder";
      $('planningCalendarState').innerHTML = '<div><strong>Calendário sem dados para este período</strong><p>Atualize o calendário para gerar os dias e habilitar os ajustes e a programação.</p></div>';
      return;
    }
    if (state.mode === "week") renderWeek();
    else if (state.mode === "gantt") renderGantt();
    else renderMonth();
    renderSummary();
  }

  function pendingOrders() {
    return state.orders.filter((order) =>
      activeStatuses.has(order.status)
      && !terminalStatuses.has(order.status)
      && !order.planned_end_date
      && !state.startedOrderIds.includes(order.id)
    );
  }

  function scheduledCountInVisibleRange(orderId) {
    if (!useLegacyScheduleView()) {
      return state.productionOrders.filter((unit) => unit.order_id === orderId).length;
    }
    return state.schedules
      .filter((schedule) => schedule.order_id === orderId)
      .reduce((sum, schedule) => sum + (Number(schedule.planned_quantity) || 0), 0);
  }

  function renderPlanningBacklog() {
    const list = $('planningBacklogList');
    if (!list) return;
    const pending = pendingOrders();
    const activeOrderWorkIds = new Set(state.orders
      .filter((order) => activeStatuses.has(order.status) && order.work_id)
      .map((order) => order.work_id));
    const waitingWorks = state.works.filter((work) =>
      ["planejamento", "ativa"].includes(work.status) && !activeOrderWorkIds.has(work.id)
    );
    $('planningBacklogCount').textContent = String(pending.length);
    list.innerHTML = pending.length ? pending.map((order) => {
      const visibleScheduled = scheduledCountInVisibleRange(order.id);
      const total = (order.items || []).reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
      const details = [
        order.status ? `Status: ${order.status}` : "",
        order.start_date ? `Início: ${formatDateBR(order.start_date)}` : "",
        order.requested_due_date ? `Prazo: ${formatDateBR(order.requested_due_date)}` : "",
        visibleScheduled ? `${visibleScheduled}${total ? ` de ${total}` : ""} un. programadas no período visível` : "",
      ].filter(Boolean).join(" · ");
      const explanation = visibleScheduled ? `Programação parcial ou sem término calculado: ${visibleScheduled} unidade(s) aparecem no intervalo selecionado.` : "Sem programação registrada para o pedido.";
      return `<article class="planning-backlog-item"><div class="planning-backlog-item-main"><strong>${escapeHtml(formatOrder(order))}</strong><span>${escapeHtml(details || "Sem datas cadastradas")}</span><small>${escapeHtml(explanation)}</small></div><button class="btn" type="button" data-plan-order-id="${escapeHtml(order.id)}">Planejar</button></article>`;
    }).join("") : `<p class="planning-backlog-empty">${state.orders.length ? "Nenhum pedido aguardando programação. Os pedidos ativos já têm data de término ou estão em produção." : "Nenhum pedido ativo cadastrado. Ao salvar um pedido em Cadastros, ele aparecerá aqui automaticamente."}</p>`;
    const works = $('planningBacklogWorks');
    works.hidden = !waitingWorks.length;
    works.innerHTML = waitingWorks.length
      ? `<h4>Obras sem pedido de produção</h4>${waitingWorks.map((work) => {
        const details = [work.status === "ativa" ? "Ativa" : "Planejamento", work.start_date ? `Início: ${formatDateBR(work.start_date)}` : "", work.requested_due_date ? `Prazo: ${formatDateBR(work.requested_due_date)}` : ""].filter(Boolean).join(" · ");
        return `<div class="planning-backlog-work"><span><strong>${escapeHtml(work.work_number || work.name)}</strong>${work.work_number ? ` · ${escapeHtml(work.name)}` : ""}</span><span>${escapeHtml(details)} · a obra aparece nas datas do calendário; vincule um pedido para programar as peças</span></div>`;
      }).join("")}`
      : "";
  }

  function populateOrderSelect(selectedId = "") {
    const eligible = state.orders.filter((order) => !terminalStatuses.has(order.status) && !state.startedOrderIds.includes(order.id));
    $('planningOrderSelect').innerHTML = eligible.length
      ? eligible.map((order) => `<option value="${escapeHtml(order.id)}">${escapeHtml(formatOrder(order))} · ${escapeHtml(order.status)}</option>`).join("")
      : '<option value="">Nenhum pedido disponível</option>';
    $('planningOrderSelect').disabled = eligible.length === 0;
    if (selectedId && eligible.some((order) => order.id === selectedId)) $('planningOrderSelect').value = selectedId;
    return eligible;
  }

  function resetPlanPreview() {
    state.pendingPlan = null;
    state.pendingOrderId = null;
    $('orderPlanPreview').hidden = true;
    $('orderPlanPreview').innerHTML = "";
    $('infeasibleChoice').hidden = true;
    $('allowInfeasiblePlan').checked = false;
    $('commitOrderPlan').disabled = true;
    showStatus("orderPlanStatus", "");
  }

  function openOrderPlanner(orderId = "", move = null) {
    resetPlanPreview();
    state.dragContext = move;
    const eligible = populateOrderSelect(orderId);
    const selected = orderById($('planningOrderSelect').value) || eligible[0] || null;
    $('planningOrderSelect').disabled = Boolean(move) || eligible.length === 0;
    if (selected) {
      $('planningOrderStart').value = move?.startDate || selected.start_date || localToday();
      $('planningOrderDue').value = move?.dueDate || selected.requested_due_date || "";
    } else {
      $('planningOrderStart').value = localToday();
      $('planningOrderDue').value = "";
    }
    $('orderPlanTitle').textContent = move ? "Reprogramar pedido" : "Planejar pedido";
    $('orderPlanSubtitle').textContent = move
      ? `Movendo uma programação de ${formatDateBR(move.sourceDate)} para ${formatDateBR(move.targetDate)}. Revise o novo plano antes de gravar.`
      : "Defina as datas e confira a capacidade antes de gravar a programação.";
    $('orderPlanModal').hidden = false;
    if (!eligible.length) showStatus("orderPlanStatus", "Não há pedidos disponíveis para planejar.");
    if (move && selected) calculateOrderPlan();
    else setTimeout(() => $('planningOrderSelect').focus(), 0);
  }

  function closeOrderPlanner() {
    $('orderPlanModal').hidden = true;
    state.dragContext = null;
    resetPlanPreview();
  }

  function renderPlan(plan, order) {
    const queueMessages = (plan.queueWarnings || []).flatMap((entry) =>
      (entry.conflicts || []).map((conflict) => `Pedido ${entry.orderNumber || entry.orderId}: ${conflict.message}`)
    ).slice(0, 5);
    const requiresConfirmation = !plan.feasible || queueMessages.length > 0;
    const statusText = plan.feasible
      ? queueMessages.length ? "A fila tem outros pedidos com prazo inviável" : "Cabe no prazo solicitado"
      : "Plano inviável no prazo atual";
    const itemRows = (plan.items || []).map((item) => `<li>${escapeHtml(item.code || item.name || "Item")}: ${Number(item.plannedQuantity || 0)} un. programadas${Number(item.remainingQuantity || 0) ? ` · <strong>${Number(item.remainingQuantity)} un. sem data</strong>` : ""}</li>`).join("");
    const conflictText = [
      ...(plan.conflicts || []).map((conflict) => conflict.message || (conflict.type === "deadline" ? `${Number(conflict.remainingQuantity || 0)} unidades excedem a capacidade até o prazo.` : `Capacidade excedida em ${formatDateBR(conflict.date)}.`)),
      ...queueMessages,
    ].join(" ");
    const previousEnd = order?.planned_end_date ? formatDateBR(order.planned_end_date) : "sem programação";
    const nextEnd = plan.plannedEndDate ? formatDateBR(plan.plannedEndDate) : "sem data calculada";
    const shift = state.dragContext
      ? `<p>Data da atividade: ${formatDateBR(state.dragContext.sourceDate)} → ${formatDateBR(state.dragContext.targetDate)}. Início do pedido: ${formatDateBR(order?.start_date)} → ${formatDateBR(plan.startDate)}; prazo: ${order?.requested_due_date ? formatDateBR(order.requested_due_date) : "sem prazo"} → ${plan.dueDate ? formatDateBR(plan.dueDate) : "sem prazo"}; fim planejado: ${previousEnd} → ${nextEnd}.</p>`
      : `<p>Fim estimado: ${nextEnd}${plan.dueDate ? ` · prazo solicitado ${formatDateBR(plan.dueDate)}` : " · sem prazo solicitado"}.</p>`;
    $('orderPlanPreview').innerHTML = `<h4>${escapeHtml(statusText)}</h4><div class="plan-summary-grid"><div><strong>${Number(plan.totalRequestedQuantity || 0)}</strong><span>unidades solicitadas</span></div><div><strong>${Number(plan.totalPlannedQuantity || 0)}</strong><span>unidades programadas</span></div><div><strong>${escapeHtml(plan.plannedEndDate ? formatDateBR(plan.plannedEndDate) : "—")}</strong><span>fim estimado</span></div></div><p>${escapeHtml(formatOrder(order))}</p>${shift}<ul>${itemRows || "<li>Não há itens para programar neste pedido.</li>"}</ul>${requiresConfirmation ? `<div class="plan-warning">${escapeHtml(conflictText || "A capacidade não atende ao pedido dentro do período calculado.")} Se confirmar, o sistema gravará as programações possíveis da fila.</div>` : ""}`;
    $('orderPlanPreview').hidden = false;
    $('infeasibleChoice').hidden = !requiresConfirmation;
    $('allowInfeasiblePlan').checked = false;
    $('commitOrderPlan').textContent = requiresConfirmation ? "Confirmar programação da fila" : "Confirmar programação";
    $('commitOrderPlan').disabled = requiresConfirmation;
  }

  async function calculateOrderPlan(event) {
    event?.preventDefault();
    const orderId = $('planningOrderSelect').value;
    const startDate = $('planningOrderStart').value;
    const requestedDueDate = $('planningOrderDue').value || null;
    const button = $('previewOrderPlan');
    if (!orderId) return showStatus("orderPlanStatus", "Selecione um pedido.", true);
    if (!startDate || (requestedDueDate && requestedDueDate < startDate)) return showStatus("orderPlanStatus", "Informe um início e um prazo válido.", true);
    button.disabled = true;
    button.textContent = "Calculando…";
    resetPlanPreview();
    showStatus("orderPlanStatus", "Atualizando as datas do calendário e calculando capacidade e prazo.");
    try {
      const rangeEnd = requestedDueDate || addDays(startDate, 365);
      await window.PRELUX_API.rebuildCalendar(startDate, rangeEnd);
      const result = await window.PRELUX_API.planOrder({ orderId, startDate, requestedDueDate });
      const plan = result.plan || result;
      if (result.queueWarnings?.length) {
        plan.queueWarnings = result.queueWarnings;
      }
      state.pendingPlan = plan;
      state.pendingOrderId = orderId;
      renderPlan(plan, orderById(orderId));
      showStatus("orderPlanStatus", "Prévia calculada no servidor. Confirme para gravar o novo plano.");
      syncCommitButton();
    } catch (error) {
      const detailPlan = error.details?.schedules ? error.details : error.details?.plan;
      if (detailPlan) {
        state.pendingPlan = detailPlan;
        state.pendingOrderId = orderId;
        renderPlan(detailPlan, orderById(orderId));
        showStatus("orderPlanStatus", error.message || "A prévia encontrou um conflito.", true);
        syncCommitButton();
      } else {
        showStatus("orderPlanStatus", error.message || "Não foi possível calcular o plano.", true);
      }
    } finally {
      button.disabled = false;
      button.textContent = "Calcular prévia";
    }
  }

  function syncCommitButton() {
    const plan = state.pendingPlan;
    const requiresConfirmation = Boolean(plan && (!plan.feasible || plan.queueWarnings?.length));
    $('commitOrderPlan').disabled = !plan || (requiresConfirmation && !$('allowInfeasiblePlan').checked);
  }

  async function commitOrderPlan() {
    const plan = state.pendingPlan;
    const orderId = state.pendingOrderId;
    if (!plan || !orderId) return;
    if ((!plan.feasible || plan.queueWarnings?.length) && !$('allowInfeasiblePlan').checked) return showStatus("orderPlanStatus", "Marque a confirmação para gravar as programações possíveis da fila.", true);
    const button = $('commitOrderPlan');
    const oldText = button.textContent;
    button.disabled = true;
    button.textContent = "Gravando…";
    try {
      await window.PRELUX_API.commitOrderPlan({
        orderId,
        startDate: $('planningOrderStart').value,
        requestedDueDate: $('planningOrderDue').value || null,
        allowInfeasible: !plan.feasible || Boolean(plan.queueWarnings?.length),
      });
      closeOrderPlanner();
      await refreshPlanning();
      showToast("Programação do pedido atualizada.");
    } catch (error) {
      showStatus("orderPlanStatus", error.message || "Não foi possível gravar a programação.", true);
    } finally {
      button.textContent = oldText;
      syncCommitButton();
    }
  }

  function openCalendarDay(date) {
    state.selectedDate = date;
    const day = getDay(date) || { is_working: false, capacity_minutes: 0 };
    const manual = state.exceptions.find((item) => item.kind === "personalizada" && item.start_date === date && item.end_date === date && Number(item.priority || 0) >= 100);
    $('calendarDayTitle').textContent = `Ajustar ${formatDateBR(date)}`;
    $('dayDate').value = date;
    $('dayWorking').checked = Boolean(day.is_working);
    $('dayCapacity').value = day.is_working ? 480 : 0;
    $('dayNote').value = manual?.notes || "";
    $('restoreCalendarDay').hidden = !manual;
    $('restoreCalendarDay').dataset.activityId = manual?.id || "";
    showStatus("calendarDayStatus", "");
    renderDayActivities(date);
    $('calendarDayModal').hidden = false;
    renderCalendar();
  }

  function renderDayActivities(date) {
    const activities = exceptionsForDate(date);
    const container = $('calendarDayActivities');
    if (!activities.length) {
      container.innerHTML = '<p class="form-help">Nenhuma atividade cadastrada para este dia.</p>';
      return;
    }
    container.innerHTML = `<h4>Atividades neste dia</h4>${activities.map((activity) => `<div class="activity-item"><div class="activity-item-main"><strong>${escapeHtml(activity.name)}</strong><span>${escapeHtml(activityKindLabels[activity.kind] || activity.kind)} · ${formatDateBR(activity.start_date)}${activity.end_date !== activity.start_date ? ` até ${formatDateBR(activity.end_date)}` : ""} · ${activity.is_working ? "concretagem liberada · até quatro posições" : "sem concretagem"}</span></div><div class="activity-item-actions"><button class="icon-btn" type="button" data-day-action="edit" data-activity-id="${escapeHtml(activity.id)}">Editar</button><button class="icon-btn" type="button" data-day-action="delete" data-activity-id="${escapeHtml(activity.id)}">Excluir</button></div></div>`).join("")}`;
  }

  function closeCalendarDay() {
    $('calendarDayModal').hidden = true;
    showStatus("calendarDayStatus", "");
  }

  function openCalendarActivity(activity = null, presetDate = state.selectedDate) {
    state.editingActivityId = activity?.id || null;
    $('calendarActivityTitle').textContent = activity ? "Editar atividade" : "Nova atividade";
    $('activityName').value = activity?.name || "";
    $('activityKind').value = activity?.kind || "personalizada";
    $('activityStart').value = activity?.start_date || presetDate || visibleBounds().start;
    $('activityEnd').value = activity?.end_date || presetDate || visibleBounds().start;
    $('activityWorking').checked = Boolean(activity?.is_working);
    $('activityCapacity').value = activity?.is_working ? 480 : 0;
    $('activityNotes').value = activity?.notes || "";
    $('deleteCalendarActivity').hidden = !activity;
    showStatus("calendarActivityStatus", "");
    $('calendarActivityModal').hidden = false;
    setTimeout(() => $('activityName').focus(), 0);
  }

  function closeCalendarActivity() {
    $('calendarActivityModal').hidden = true;
    state.editingActivityId = null;
    showStatus("calendarActivityStatus", "");
  }

  async function openCalendarSettings() {
    $('calendarSettingsModal').hidden = false;
    showStatus("calendarSettingsStatus", "Carregando regra semanal…");
    try {
      const result = await window.PRELUX_API.getCalendarSettings();
      state.settings = result.settings ? { ...result.settings, rules: result.rules || [] } : state.settings;
      const settings = result.settings || {};
      const rules = new Map((result.rules || []).map((rule) => [Number(rule.weekday), rule]));
      $('defaultCapacityMinutes').value = 480;
      document.querySelectorAll("[data-weekday]").forEach((input) => {
        const weekday = Number(input.dataset.weekday);
        const rule = rules.get(weekday);
        input.checked = rule ? Boolean(rule.is_working) : weekday >= 1 && weekday <= 5;
      });
      showStatus("calendarSettingsStatus", "");
    } catch (error) {
      showStatus("calendarSettingsStatus", error.message || "Não foi possível carregar a regra semanal.", true);
    }
  }

  function closeCalendarSettings() {
    $('calendarSettingsModal').hidden = true;
    showStatus("calendarSettingsStatus", "");
  }

  async function saveCalendarSettings(event) {
    event.preventDefault();
    const defaultCapacityMinutes = 480;
    const rules = [...document.querySelectorAll("[data-weekday]")].map((input) => ({
      weekday: Number(input.dataset.weekday),
      isWorking: input.checked,
      capacityMinutes: input.checked ? 480 : 0,
    }));
    const button = $('saveCalendarSettings');
    const oldText = button.textContent;
    button.disabled = true;
    button.textContent = "Salvando…";
    try {
      await window.PRELUX_API.saveCalendarSettings({ defaultCapacityMinutes, rules });
      closeCalendarSettings();
      await refreshPlanning();
      showToast("Semana padrão atualizada.");
    } catch (error) {
      showStatus("calendarSettingsStatus", error.message || "Não foi possível salvar a regra semanal.", true);
    } finally {
      button.disabled = false;
      button.textContent = oldText;
    }
  }

  function refreshPlanning() {
    if (state.refreshPromise) {
      state.refreshPending = true;
      return state.refreshPromise;
    }
    state.refreshPromise = (async () => {
      do {
        state.refreshPending = false;
        await refreshPlanningNow();
      } while (state.refreshPending);
    })().finally(() => { state.refreshPromise = null; });
    return state.refreshPromise;
  }

  async function refreshPlanningNow() {
    const stateContainer = $('planningCalendarState');
    const connection = $('planningConnectionState');
    const config = window.PRELUX_CONFIG || {};
    if (!config.supabaseUrl || !config.supabaseAnonKey) {
      stateContainer.className = "calendar-placeholder";
      stateContainer.innerHTML = '<div><strong>Calendário visual preparado</strong><p>Configure o acesso ao backend para carregar dias úteis, pedidos e programações.</p></div>';
      connection.innerHTML = '<span class="dot"></span><span>Backend ainda não configurado. O emissor de etiquetas funciona localmente.</span>';
      return;
    }
    const range = visibleBounds();
    stateContainer.className = "calendar-placeholder";
    stateContainer.innerHTML = '<div><strong>Carregando calendário…</strong><p>Buscando capacidade, exceções e programações.</p></div>';
    try {
      await window.PRELUX_API.rebuildCalendar(range.start, range.end);
      const [calendar, planning, settings, operations] = await Promise.all([
        window.PRELUX_API.getCalendar(range.start, range.end),
        window.PRELUX_API.getPlanningData(range.start, range.end),
        window.PRELUX_API.getCalendarSettings(),
        window.PRELUX_API.getOperationsData().catch(() => null),
      ]);
      state.days = calendar.days || [];
      state.exceptions = calendar.exceptions || [];
      const operationOrders = operations?.orders || [];
      const operationOrderById = new Map(operationOrders.map((order) => [order.id, order]));
      const planningOrders = planning.orders || [];
      const planningOrderIds = new Set(planningOrders.map((order) => order.id));
      state.orders = [
        ...planningOrders.map((order) => {
          const operationOrder = operationOrderById.get(order.id) || {};
          return { ...operationOrder, ...order, work_id: order.work_id || operationOrder.work_id, work_name: order.work_name || operationOrder.work_name || "", client_name: order.client_name || operationOrder.client_name || "" };
        }),
        ...operationOrders.filter((order) => !planningOrderIds.has(order.id)),
      ];
      state.works = operations?.works || [];
      state.schedules = planning.schedules || [];
      state.unitPlanningAvailable = Array.isArray(planning.productionOrders);
      state.productionOrders = planning.productionOrders || [];
      state.positions = planning.positions || [];
      state.capacityByPositions = planning.capacityByPositions || [];
      state.startedOrderIds = planning.startedOrderIds || [];
      state.settings = settings.settings ? { ...settings.settings, rules: settings.rules || [] } : state.settings;
      renderCalendar();
      connection.innerHTML = !useLegacyScheduleView()
        ? '<span class="dot" style="background:var(--green)"></span><span>Backend conectado. Concretagem, cura, acabamento e posições carregados.</span>'
        : '<span class="dot" style="background:#d58a1e"></span><span>Backend conectado com programação resumida. Posições, cura e acabamento ainda não estão disponíveis na integração.</span>';
    } catch (error) {
      stateContainer.className = "calendar-placeholder";
      stateContainer.innerHTML = `<div><strong>Não foi possível carregar o calendário</strong><p>${escapeHtml(error.message || "Verifique a configuração da API.")}</p></div>`;
      $('planningBacklogCount').textContent = "—";
      $('planningBacklogList').innerHTML = `<p class="planning-backlog-empty">Não foi possível carregar os pedidos do cadastro: ${escapeHtml(error.message || "verifique a conexão e tente atualizar")}</p>`;
      $('planningBacklogWorks').hidden = true;
      connection.innerHTML = '<span class="dot"></span><span>Backend configurado, mas a chamada não respondeu corretamente.</span>';
      showToast("Falha ao atualizar o calendário.");
    }
  }

  async function saveCalendarDay(event) {
    event.preventDefault();
    const date = $('dayDate').value;
    if (!date) return;
    const button = $('saveCalendarDay');
    const oldText = button.textContent;
    button.disabled = true;
    button.textContent = "Salvando…";
    try {
      await window.PRELUX_API.saveCalendarDay({
        id: $('restoreCalendarDay').dataset.activityId || undefined,
        startDate: date,
        endDate: date,
        name: $('dayNote').value.trim() || `Ajuste manual de ${formatDateBR(date)}`,
        isWorking: $('dayWorking').checked,
        capacityMinutes: $('dayWorking').checked ? 480 : 0,
        notes: $('dayNote').value.trim(),
      });
      closeCalendarDay();
      await refreshPlanning();
      showToast("Ajuste do dia salvo.");
    } catch (error) {
      showStatus("calendarDayStatus", error.message || "Não foi possível salvar o ajuste.", true);
    } finally {
      button.disabled = false;
      button.textContent = oldText;
    }
  }

  async function saveCalendarActivity(event) {
    event.preventDefault();
    const startDate = $('activityStart').value;
    const endDate = $('activityEnd').value;
    if (!startDate || !endDate || endDate < startDate) return showStatus("calendarActivityStatus", "Informe um período válido.", true);
    const button = $('saveCalendarActivity');
    const oldText = button.textContent;
    const wasEditing = Boolean(state.editingActivityId);
    button.disabled = true;
    button.textContent = "Salvando…";
    try {
      await window.PRELUX_API.saveCalendarActivity({
        id: state.editingActivityId || undefined,
        name: $('activityName').value.trim(),
        kind: $('activityKind').value,
        startDate,
        endDate,
        isWorking: $('activityWorking').checked,
        capacityMinutes: $('activityWorking').checked ? 480 : 0,
        notes: $('activityNotes').value.trim(),
      });
      closeCalendarActivity();
      await refreshPlanning();
      showToast(wasEditing ? "Atividade atualizada." : "Atividade adicionada.");
    } catch (error) {
      showStatus("calendarActivityStatus", error.message || "Não foi possível salvar a atividade.", true);
    } finally {
      button.disabled = false;
      button.textContent = oldText;
    }
  }

  async function deleteCalendarActivity(id, closeDay = false) {
    if (!id || !confirm("Excluir esta atividade do calendário?")) return;
    try {
      const bounds = visibleBounds();
      await window.PRELUX_API.deleteCalendarActivity(id, bounds.start, bounds.end);
      if (closeDay) closeCalendarDay();
      else closeCalendarActivity();
      await refreshPlanning();
      showToast("Atividade excluída.");
    } catch (error) {
      showToast(error.message || "Não foi possível excluir a atividade.");
    }
  }

  function changePeriod(direction) {
    const date = new Date(`${anchorDate()}T00:00:00.000Z`);
    if (state.mode === "week") date.setUTCDate(date.getUTCDate() + direction * 7);
    else date.setUTCMonth(date.getUTCMonth() + direction);
    $('planningAnchor').value = isoDate(date);
    refreshPlanning();
  }

  function setCalendarMode(mode) {
    state.mode = mode;
    document.querySelectorAll("[data-calendar-mode]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.calendarMode === mode));
    });
    refreshPlanning();
  }

  function setAppView(view) {
    const planning = view === "planejamento";
    const operations = view === "cadastros";
    $('emissorView').hidden = planning || operations;
    $('planningView').hidden = !planning;
    if ($('operationsView')) $('operationsView').hidden = !operations;
    document.querySelectorAll("[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
    if (planning) {
      window.scrollTo({ top: 0, behavior: "smooth" });
      refreshPlanning();
      return;
    }
    if (operations) {
      window.dispatchEvent(new CustomEvent("prelux:operations:open"));
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    if (view === "historico") $('historyCard').scrollIntoView({ behavior: "smooth", block: "start" });
    else window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function handleCalendarClick(event) {
    const orderEvent = event.target.closest("[data-order-event]");
    if (orderEvent) {
      event.preventDefault();
      if (state.startedOrderIds.includes(orderEvent.dataset.orderEvent)) {
        showToast("Este pedido já tem produção iniciada ou concluída e não pode ser replanejado.");
        return;
      }
      openOrderPlanner(orderEvent.dataset.orderEvent);
      return;
    }
    const activityButton = event.target.closest("[data-day-action]");
    if (activityButton) {
      const activity = state.exceptions.find((item) => item.id === activityButton.dataset.activityId);
      if (activityButton.dataset.dayAction === "edit" && activity) {
        closeCalendarDay();
        openCalendarActivity(activity);
      } else if (activityButton.dataset.dayAction === "delete") deleteCalendarActivity(activity?.id, true);
      return;
    }
    const day = event.target.closest("[data-calendar-date]");
    if (day) openCalendarDay(day.dataset.calendarDate);
  }

  function handleDragStart(event) {
    const item = event.target.closest('[data-order-event][draggable="true"]');
    if (!item) return;
    const { orderEvent, workDate } = item.dataset;
    const payload = JSON.stringify({ orderId: orderEvent, sourceDate: workDate });
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", payload);
  }

  function handleDragOver(event) {
    const day = event.target.closest("[data-calendar-date]");
    if (!day) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    day.classList.add("drag-over");
  }

  function handleDragLeave(event) {
    const day = event.target.closest("[data-calendar-date]");
    if (day && !day.contains(event.relatedTarget)) day.classList.remove("drag-over");
  }

  async function handleDrop(event) {
    const day = event.target.closest("[data-calendar-date]");
    if (!day) return;
    event.preventDefault();
    day.classList.remove("drag-over");
    let dropped;
    try { dropped = JSON.parse(event.dataTransfer.getData("text/plain")); } catch { return; }
    if (!dropped.orderId || !dropped.sourceDate || dropped.sourceDate === day.dataset.calendarDate) return;
    const order = orderById(dropped.orderId);
    if (!order) return showToast("O pedido não está disponível neste período.");
    if (state.startedOrderIds.includes(dropped.orderId)) return showToast("Este pedido já tem produção iniciada ou concluída e não pode ser replanejado.");
    const delta = dateDistance(dropped.sourceDate, day.dataset.calendarDate);
    const newStart = addDays(order.start_date, delta);
    const newDue = order.requested_due_date ? addDays(order.requested_due_date, delta) : "";
    openOrderPlanner(dropped.orderId, {
      sourceDate: dropped.sourceDate,
      targetDate: day.dataset.calendarDate,
      startDate: newStart,
      dueDate: newDue,
    });
  }

  document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => setAppView(button.dataset.view)));
  document.querySelectorAll("[data-calendar-mode]").forEach((button) => button.addEventListener("click", () => setCalendarMode(button.dataset.calendarMode)));
  $('planningAnchor').value = localToday();
  $('planningRefreshBtn').addEventListener("click", refreshPlanning);
  $('planningAnchor').addEventListener("change", refreshPlanning);
  $('planningPrevious').addEventListener("click", () => changePeriod(-1));
  $('planningNextPeriod').addEventListener("click", () => changePeriod(1));
  $('planningNextBtn').addEventListener("click", () => setAppView("emissor"));
  $('planningActivityBtn').addEventListener("click", () => openCalendarActivity());
  $('planningSettingsBtn').addEventListener("click", openCalendarSettings);
  $('planningOrderBtn').addEventListener("click", async () => {
    await refreshPlanning();
    openOrderPlanner();
  });
  $('planningBacklogList').addEventListener("click", async (event) => {
    const button = event.target.closest("[data-plan-order-id]");
    if (!button) return;
    const orderId = button.dataset.planOrderId;
    await refreshPlanning();
    openOrderPlanner(orderId);
  });
  $('planningCalendarState').addEventListener("click", handleCalendarClick);
  $('planningCalendarState').addEventListener("keydown", (event) => {
    if ((event.key === "Enter" || event.key === " ") && event.target.matches("[data-calendar-date]")) {
      event.preventDefault();
      openCalendarDay(event.target.dataset.calendarDate);
    }
  });
  $('planningCalendarState').addEventListener("dragstart", handleDragStart);
  $('planningCalendarState').addEventListener("dragover", handleDragOver);
  $('planningCalendarState').addEventListener("dragleave", handleDragLeave);
  $('planningCalendarState').addEventListener("drop", handleDrop);
  $('planningOrderSelect').addEventListener("change", () => {
    const order = orderById($('planningOrderSelect').value);
    resetPlanPreview();
    if (order) {
      $('planningOrderStart').value = order.start_date || localToday();
      $('planningOrderDue').value = order.requested_due_date || "";
    }
  });
  $('orderPlanForm').addEventListener("submit", calculateOrderPlan);
  $('commitOrderPlan').addEventListener("click", commitOrderPlan);
  $('allowInfeasiblePlan').addEventListener("change", syncCommitButton);
  $('closeOrderPlan').addEventListener("click", closeOrderPlanner);
  $('cancelOrderPlan').addEventListener("click", closeOrderPlanner);
  $('orderPlanModal').addEventListener("click", (event) => { if (event.target.id === "orderPlanModal") closeOrderPlanner(); });
  window.addEventListener("prelux:operations:changed", () => {
    if (!$('planningView').hidden) refreshPlanning();
  });
  $('closeCalendarDay').addEventListener("click", closeCalendarDay);
  $('cancelCalendarDay').addEventListener("click", closeCalendarDay);
  $('calendarDayModal').addEventListener("click", (event) => { if (event.target.id === "calendarDayModal") closeCalendarDay(); });
  $('calendarDayForm').addEventListener("submit", saveCalendarDay);
  $('restoreCalendarDay').addEventListener("click", () => deleteCalendarActivity($('restoreCalendarDay').dataset.activityId, true));
  $('closeCalendarActivity').addEventListener("click", closeCalendarActivity);
  $('cancelCalendarActivity').addEventListener("click", closeCalendarActivity);
  $('calendarActivityModal').addEventListener("click", (event) => { if (event.target.id === "calendarActivityModal") closeCalendarActivity(); });
  $('calendarActivityForm').addEventListener("submit", saveCalendarActivity);
  $('deleteCalendarActivity').addEventListener("click", () => deleteCalendarActivity(state.editingActivityId));
  $('calendarDayActivities').addEventListener("click", handleCalendarClick);
  $('activityWorking').addEventListener("change", () => { $('activityCapacity').value = $('activityWorking').checked ? 480 : 0; });
  $('closeCalendarSettings').addEventListener("click", closeCalendarSettings);
  $('cancelCalendarSettings').addEventListener("click", closeCalendarSettings);
  $('calendarSettingsModal').addEventListener("click", (event) => { if (event.target.id === "calendarSettingsModal") closeCalendarSettings(); });
  $('calendarSettingsForm').addEventListener("submit", saveCalendarSettings);
})();
