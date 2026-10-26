(function productionCalendarModule() {
  const $ = (id) => document.getElementById(id);
  const state = {
    mode: "month",
    days: [],
    exceptions: [],
    capacity: [],
    orders: [],
    works: [],
    schedules: [],
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

  function minutesLabel(value) {
    const minutes = Math.max(0, Number(value) || 0);
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours && rest) return `${hours} h ${rest} min`;
    if (hours) return `${hours} h`;
    return `${rest} min`;
  }

  function formatOrder(order) {
    const reference = order?.order_number || "Pedido sem número";
    return [reference, order?.work_name, order?.client_name].filter(Boolean).join(" · ");
  }

  function orderById(orderId) {
    return state.orders.find((order) => order.id === orderId) || null;
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

  function getCapacity(date) {
    return state.capacity.find((day) => day.date === date) || null;
  }

  function exceptionsForDate(date) {
    return state.exceptions
      .filter((item) => item.start_date <= date && item.end_date >= date)
      .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0));
  }

  function schedulesForDate(date) {
    return state.schedules.filter((schedule) => schedule.work_date === date);
  }

  function showStatus(id, message, isError = false) {
    const element = $(id);
    element.textContent = message;
    element.classList.toggle("show", Boolean(message));
    element.classList.toggle("error", Boolean(isError));
  }

  function renderDay(date, options = {}) {
    const day = getDay(date) || { is_working: false, capacity_minutes: 0 };
    const capacity = getCapacity(date) || {};
    const occupancy = Math.max(0, Number(capacity.occupancy_percent) || 0);
    const width = Math.min(100, occupancy);
    const occupancyClass = occupancy > 100 ? "over" : occupancy >= 80 ? "high" : "";
    const activities = exceptionsForDate(date);
    const note = activities[0]?.name || day.note || "";
    const todayClass = date === localToday() ? "today" : "";
    const selectedClass = date === state.selectedDate ? "selected" : "";
    const nonWorkingClass = day.is_working ? "" : "non-working";
    const activityLabel = note ? `<span class="calendar-day-activity" title="${escapeHtml(note)}">${escapeHtml(note)}</span>` : "";
    const eventLimit = options.week ? 8 : 3;
    const eventRows = schedulesForDate(date).slice(0, eventLimit).map((schedule) => {
      const order = orderById(schedule.order_id);
      const canDrag = schedule.status === "planned" && !state.startedOrderIds.includes(schedule.order_id);
      const statusClass = schedule.status === "in_progress" ? "in-progress" : schedule.status === "done" ? "done" : "";
      return `<button class="calendar-event ${statusClass}" type="button" data-order-event="${escapeHtml(schedule.order_id)}" data-work-date="${date}" title="${escapeHtml(scheduleLabel(schedule))}"${canDrag ? ' draggable="true"' : ""}>${escapeHtml(formatOrder(order))} · ${escapeHtml(schedule.piece_code || "produção")} · ${Number(schedule.planned_quantity)} un.</button>`;
    }).join("");
    const remainingEvents = schedulesForDate(date).length - eventLimit;
    return `<div class="calendar-day ${nonWorkingClass} ${todayClass} ${selectedClass}" role="button" tabindex="0" data-calendar-date="${date}" title="Abrir ajustes de ${formatDateBR(date)}"><span class="calendar-day-head"><span class="calendar-day-number">${Number(date.slice(-2))}</span><span class="calendar-day-status">${day.is_working ? "útil" : "parado"}</span></span><span class="calendar-day-capacity">${day.is_working ? minutesLabel(day.capacity_minutes) : "Sem produção"}${capacity.planned_minutes ? ` · ${minutesLabel(capacity.planned_minutes)} programados` : ""}</span>${activityLabel}<span class="calendar-day-occupancy"><i class="${occupancyClass}" style="width:${width}%"></i></span><div class="calendar-events">${eventRows}${remainingEvents > 0 ? `<span class="calendar-event-more">+${remainingEvents} programações</span>` : ""}</div></div>`;
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
    const ordersWithSchedules = state.orders.filter((order) => state.schedules.some((item) => item.order_id === order.id));
    const columnCount = count + 1;
    const template = `--gantt-days:${count}`;
    const headings = Array.from({ length: count }, (_, index) => {
      const date = addDays(start, index);
      const day = getDay(date) || { is_working: false };
      return `<div class="gantt-cell ${day.is_working ? "" : "off"}" data-calendar-date="${date}" title="${formatDateBR(date)} · ${day.is_working ? minutesLabel(day.capacity_minutes) : "sem produção"}"><span>${Number(date.slice(-2))}</span><small>${day.is_working ? `${Math.round(Number(day.capacity_minutes || 0) / 60)}h` : "—"}</small></div>`;
    }).join("");
    let rows = "";
    for (const order of ordersWithSchedules) {
      rows += `<div class="gantt-label" title="${escapeHtml(formatOrder(order))}">${escapeHtml(formatOrder(order))}</div>`;
      for (let index = 0; index < count; index += 1) {
        const date = addDays(start, index);
        const day = getDay(date) || { is_working: false };
        const capacity = getCapacity(date) || {};
        const items = schedulesForDate(date).filter((schedule) => schedule.order_id === order.id);
        const work = items.map((schedule) => {
          const draggable = schedule.status === "planned" && !state.startedOrderIds.includes(order.id);
          const statusClass = schedule.status === "in_progress" ? "in-progress" : schedule.status === "done" ? "done" : "";
          return `<button class="gantt-work ${statusClass}" type="button" data-order-event="${escapeHtml(order.id)}" data-work-date="${date}" title="${escapeHtml(scheduleLabel(schedule))}"${draggable ? ' draggable="true"' : ""}>${escapeHtml(schedule.piece_code || "produção")}</button>`;
        }).join("");
        const over = Number(capacity.occupancy_percent || 0) > 100;
        rows += `<div class="gantt-cell ${day.is_working ? "" : "off"} ${over ? "over" : ""}" data-calendar-date="${date}" title="${formatDateBR(date)} · ${minutesLabel(capacity.planned_minutes || 0)} / ${minutesLabel(day.capacity_minutes || 0)}">${work}</div>`;
      }
    }
    const empty = ordersWithSchedules.length ? "" : '<div class="gantt-empty">Nenhuma programação de pedido neste mês.</div>';
    $('planningCalendarState').className = "calendar-state calendar-gantt-view";
    $('planningCalendarState').innerHTML = `<div class="gantt-wrap"><div class="gantt-group"><div class="gantt-resource">Produção<span>Recurso: capacidade agregada PRELUX · ${count} dias · arraste um bloco para replanejar</span></div><div class="gantt-timeline gantt-head" style="${template}"><div class="gantt-label">Pedido</div>${headings}</div>${ordersWithSchedules.length ? `<div class="gantt-timeline" style="${template}">${rows}</div>` : empty}</div></div>`;
    $('planningCalendarHeading').textContent = `Gantt · ${new Date(`${start}T00:00:00.000Z`).toLocaleDateString("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" })}`;
  }

  function renderSummary() {
    const workingDays = state.days.filter((day) => day.is_working);
    const totalCapacity = workingDays.reduce((sum, day) => sum + Number(day.capacity_minutes || 0), 0);
    const totalPlanned = state.capacity.reduce((sum, day) => sum + Number(day.planned_minutes || 0), 0);
    const occupancy = totalCapacity ? Math.round(totalPlanned / totalCapacity * 100) : 0;
    const alertDays = state.capacity.filter((day) => Number(day.occupancy_percent || 0) > 100).length;
    const activeOrders = state.orders.filter((order) => activeStatuses.has(order.status)).length;
    const today = getDay(localToday());
    const exceptionCount = state.exceptions.length;
    const eventCount = state.schedules.length;
    $('planningCalendarSummary').textContent = `${workingDays.length} dias úteis · ${minutesLabel(totalCapacity)} disponíveis · ${eventCount} programações · ${exceptionCount} atividade${exceptionCount === 1 ? "" : "s"} ativa${exceptionCount === 1 ? "" : "s"}. Arraste uma programação para simular a mudança e revisar o impacto.`;
    $('planningOrdersKpi').textContent = String(activeOrders);
    $('planningOccupancyKpi').textContent = `${occupancy}%`;
    $('planningCapacityKpi').textContent = today ? minutesLabel(today.capacity_minutes || 0) : "—";
    $('planningAlertsKpi').textContent = String(alertDays);
    const weekdayNames = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
    const workingWeekdays = state.settings.rules.length
      ? state.settings.rules.filter((rule) => rule.is_working).map((rule) => Number(rule.weekday))
      : [1, 2, 3, 4, 5];
    $('planningWorkdaysSummary').textContent = workingWeekdays.length
      ? workingWeekdays.map((weekday) => weekdayNames[weekday]).join(", ")
      : "Sem dias definidos";
    $('planningDefaultCapacitySummary').textContent = minutesLabel(state.settings.default_capacity_minutes);
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
    const scheduledOrderIds = new Set(state.schedules.map((schedule) => schedule.order_id));
    return state.orders.filter((order) =>
      activeStatuses.has(order.status)
      && !terminalStatuses.has(order.status)
      && !order.planned_end_date
      && !state.startedOrderIds.includes(order.id)
      && !scheduledOrderIds.has(order.id)
    );
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
      const details = [
        order.status ? `Status: ${order.status}` : "",
        order.start_date ? `Início: ${formatDateBR(order.start_date)}` : "",
        order.requested_due_date ? `Prazo: ${formatDateBR(order.requested_due_date)}` : "",
      ].filter(Boolean).join(" · ");
      return `<article class="planning-backlog-item"><div class="planning-backlog-item-main"><strong>${escapeHtml(formatOrder(order))}</strong><span>${escapeHtml(details || "Sem programação registrada")}</span></div><button class="btn" type="button" data-plan-order-id="${escapeHtml(order.id)}">Planejar</button></article>`;
    }).join("") : `<p class="planning-backlog-empty">${state.orders.length ? "Nenhum pedido aguardando programação. Os pedidos ativos já têm programação ou estão em produção." : "Nenhum pedido ativo cadastrado. Ao salvar um pedido em Cadastros, ele aparecerá aqui automaticamente."}</p>`;
    const works = $('planningBacklogWorks');
    works.hidden = !waitingWorks.length;
    works.innerHTML = waitingWorks.length
      ? `<h4>Obras sem pedido de produção</h4>${waitingWorks.map((work) => {
        const details = [work.status === "ativa" ? "Ativa" : "Planejamento", work.start_date ? `Início: ${formatDateBR(work.start_date)}` : "", work.requested_due_date ? `Prazo: ${formatDateBR(work.requested_due_date)}` : ""].filter(Boolean).join(" · ");
        return `<div class="planning-backlog-work"><span><strong>${escapeHtml(work.work_number || work.name)}</strong>${work.work_number ? ` · ${escapeHtml(work.name)}` : ""}</span><span>${escapeHtml(details)} · vincule um pedido para programar a produção</span></div>`;
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
      : "Calcule o prazo e a ocupação antes de gravar a programação.";
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
    const statusText = plan.feasible ? "Cabe no prazo solicitado" : "Plano inviável no prazo atual";
    const itemRows = (plan.items || []).map((item) => `<li>${escapeHtml(item.code || item.name || "Item")}: ${Number(item.plannedQuantity || 0)} un. programadas · ${Number(item.stockQuantityUsed || 0)} un. cobertas por estoque${Number(item.remainingQuantity || 0) ? ` · <strong>${Number(item.remainingQuantity)} un. sem data</strong>` : ""}</li>`).join("");
    const conflictText = (plan.conflicts || []).map((conflict) => conflict.message || (conflict.type === "deadline" ? `${Number(conflict.remainingQuantity || 0)} unidades excedem a capacidade até o prazo.` : `Capacidade excedida em ${formatDateBR(conflict.date)}.`)).join(" ");
    const previousEnd = order?.planned_end_date ? formatDateBR(order.planned_end_date) : "sem programação";
    const nextEnd = plan.plannedEndDate ? formatDateBR(plan.plannedEndDate) : "sem data calculada";
    const shift = state.dragContext
      ? `<p>Data da atividade: ${formatDateBR(state.dragContext.sourceDate)} → ${formatDateBR(state.dragContext.targetDate)}. Início do pedido: ${formatDateBR(order?.start_date)} → ${formatDateBR(plan.startDate)}; prazo: ${order?.requested_due_date ? formatDateBR(order.requested_due_date) : "sem prazo"} → ${plan.dueDate ? formatDateBR(plan.dueDate) : "sem prazo"}; fim planejado: ${previousEnd} → ${nextEnd}.</p>`
      : `<p>Fim estimado: ${nextEnd}${plan.dueDate ? ` · prazo solicitado ${formatDateBR(plan.dueDate)}` : " · sem prazo solicitado"}.</p>`;
    $('orderPlanPreview').innerHTML = `<h4>${escapeHtml(statusText)}</h4><div class="plan-summary-grid"><div><strong>${Number(plan.totalRequestedQuantity || 0)}</strong><span>unidades no pedido</span></div><div><strong>${Number(plan.totalPlannedQuantity || 0)}</strong><span>unidades programadas</span></div><div><strong>${minutesLabel(plan.totalPlannedMinutes || 0)}</strong><span>tempo alocado</span></div></div><p>${escapeHtml(formatOrder(order))}</p>${shift}<ul>${itemRows || "<li>Nenhuma linha de produção necessária; o pedido será atendido pelo estoque.</li>"}</ul>${!plan.feasible ? `<div class="plan-warning">${escapeHtml(conflictText || "A capacidade não atende ao pedido dentro do período calculado.")} Se confirmar, o pedido ficará parcialmente programado.</div>` : ""}`;
    $('orderPlanPreview').hidden = false;
    $('infeasibleChoice').hidden = Boolean(plan.feasible);
    $('allowInfeasiblePlan').checked = false;
    $('commitOrderPlan').textContent = plan.feasible ? "Confirmar programação" : "Confirmar plano incompleto";
    $('commitOrderPlan').disabled = !plan.feasible;
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
    showStatus("orderPlanStatus", "Atualizando os dias necessários e calculando capacidade, estoque e prazo.");
    try {
      const rangeEnd = requestedDueDate || addDays(startDate, 365);
      await window.PRELUX_API.rebuildCalendar(startDate, rangeEnd);
      const result = await window.PRELUX_API.planOrder({ orderId, startDate, requestedDueDate });
      const plan = result.plan || result;
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
    $('commitOrderPlan').disabled = !plan || (!plan.feasible && !$('allowInfeasiblePlan').checked);
  }

  async function commitOrderPlan() {
    const plan = state.pendingPlan;
    const orderId = state.pendingOrderId;
    if (!plan || !orderId) return;
    if (!plan.feasible && !$('allowInfeasiblePlan').checked) return showStatus("orderPlanStatus", "Marque a confirmação do plano incompleto para continuar.", true);
    const button = $('commitOrderPlan');
    const oldText = button.textContent;
    button.disabled = true;
    button.textContent = "Gravando…";
    try {
      await window.PRELUX_API.commitOrderPlan({
        orderId,
        startDate: $('planningOrderStart').value,
        requestedDueDate: $('planningOrderDue').value || null,
        allowInfeasible: !plan.feasible,
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
    $('dayCapacity').value = Number(day.capacity_minutes || 0);
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
    container.innerHTML = `<h4>Atividades neste dia</h4>${activities.map((activity) => `<div class="activity-item"><div class="activity-item-main"><strong>${escapeHtml(activity.name)}</strong><span>${escapeHtml(activityKindLabels[activity.kind] || activity.kind)} · ${formatDateBR(activity.start_date)}${activity.end_date !== activity.start_date ? ` até ${formatDateBR(activity.end_date)}` : ""} · ${activity.is_working ? `produção · ${minutesLabel(activity.capacity_minutes)}` : "sem produção"}</span></div><div class="activity-item-actions"><button class="icon-btn" type="button" data-day-action="edit" data-activity-id="${escapeHtml(activity.id)}">Editar</button><button class="icon-btn" type="button" data-day-action="delete" data-activity-id="${escapeHtml(activity.id)}">Excluir</button></div></div>`).join("")}`;
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
    $('activityCapacity').value = Number(activity?.capacity_minutes || 480);
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
      $('defaultCapacityMinutes').value = Number(settings.default_capacity_minutes || 480);
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
    const defaultCapacityMinutes = Number($('defaultCapacityMinutes').value);
    if (!Number.isInteger(defaultCapacityMinutes) || defaultCapacityMinutes < 0 || defaultCapacityMinutes > 1440) {
      return showStatus("calendarSettingsStatus", "A capacidade diária deve ficar entre 0 e 1440 minutos.", true);
    }
    const rules = [...document.querySelectorAll("[data-weekday]")].map((input) => ({
      weekday: Number(input.dataset.weekday),
      isWorking: input.checked,
      capacityMinutes: input.checked ? defaultCapacityMinutes : 0,
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
      state.capacity = calendar.capacity || [];
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
      state.startedOrderIds = planning.startedOrderIds || [];
      state.settings = settings.settings ? { ...settings.settings, rules: settings.rules || [] } : state.settings;
      renderCalendar();
      connection.innerHTML = '<span class="dot" style="background:var(--green)"></span><span>Backend conectado. Pedidos, capacidade e atividades carregados.</span>';
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
        capacityMinutes: Number($('dayCapacity').value) || 0,
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
        capacityMinutes: Number($('activityCapacity').value) || 0,
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
  $('activityWorking').addEventListener("change", () => { if (!$('activityWorking').checked && !$('activityCapacity').value) $('activityCapacity').value = 0; });
  $('closeCalendarSettings').addEventListener("click", closeCalendarSettings);
  $('cancelCalendarSettings').addEventListener("click", closeCalendarSettings);
  $('calendarSettingsModal').addEventListener("click", (event) => { if (event.target.id === "calendarSettingsModal") closeCalendarSettings(); });
  $('calendarSettingsForm').addEventListener("submit", saveCalendarSettings);
})();
