(function attachOperationsAdmin(global) {
  const $ = (id) => document.getElementById(id);
  const state = { data: null, tab: "works", loading: false, query: "" };
  const tabs = [
    ["works", "Obras"],
    ["orders", "Pedidos"],
    ["pieces", "Peças"],
    ["molds", "Moldes"],
  ];

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[char]);
  }

  function toast(message) {
    const element = $("toast");
    if (!element) return;
    element.textContent = message;
    element.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => element.classList.remove("show"), 3000);
  }

  function today() {
    const date = new Date();
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  function addDays(value, amount) {
    if (!value) return "";
    const date = new Date(`${value}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + amount);
    return date.toISOString().slice(0, 10);
  }

  function dateBR(value) {
    if (!value) return "—";
    const [year, month, day] = String(value).slice(0, 10).split("-");
    return `${day}/${month}/${year}`;
  }

  function statusLabel(value) {
    const labels = {
      planejamento: "Planejamento", ativa: "Ativa", concluida: "Concluída", cancelada: "Cancelada",
      orcamento: "Orçamento", aprovado: "Aprovado", em_producao: "Em produção", concluido: "Concluído",
      entregue: "Entregue", atrasado: "Atrasado", cancelado: "Cancelado", ativo: "Ativo",
      manutencao: "Manutenção", bloqueado: "Bloqueado", retirado: "Retirado", planejada: "Planejada",
      em_andamento: "Em andamento", aguardando_aprovacao: "Aguardando aprovação", aprovada: "Aprovada",
      reprovada: "Reprovada", planned: "Planejada", in_progress: "Em andamento", done: "Concluída",
      cancelled: "Cancelada",
    };
    return labels[value] || value || "—";
  }

  function badge(value) {
    const tone = ["ativa", "concluida", "aprovado", "em_producao", "concluido", "entregue", "ativo", "aprovada", "done"].includes(value)
      ? "good"
      : ["atrasado", "manutencao", "aguardando_aprovacao", "em_andamento", "in_progress"].includes(value)
        ? "warn"
        : ["cancelada", "cancelado", "bloqueado", "retirado", "reprovada", "cancelled"].includes(value)
          ? "bad" : "";
    return `<span class="ops-badge ${tone}">${escapeHtml(statusLabel(value))}</span>`;
  }

  function showStatus(message, error = false) {
    const element = $("operationsStatus");
    if (!element) return;
    element.textContent = message;
    element.classList.toggle("error", error);
  }

  function shell() {
    $("operationsView").innerHTML = `
      <div class="toolbar operations-toolbar">
        <div><h2>Cadastros de produção</h2><p>Obras e pedidos, catálogo de peças, moldes e preparação para produção.</p></div>
        <div class="actions"><button class="btn" id="operationsRefresh" type="button">Atualizar dados</button><button class="btn primary" id="operationsNew" type="button">Nova obra</button></div>
      </div>
      <div class="metric-grid">
        <div class="card metric-card"><small>Obras ativas</small><strong id="operationsWorksMetric">—</strong><span>cadastros em andamento</span></div>
        <div class="card metric-card"><small>Pedidos abertos</small><strong id="operationsOrdersMetric">—</strong><span>pedidos não entregues ou cancelados</span></div>
        <div class="card metric-card"><small>Tipos de peça</small><strong id="operationsPiecesMetric">—</strong><span>catálogo ativo</span></div>
        <div class="card metric-card"><small>Moldes disponíveis</small><strong id="operationsMoldsMetric">—</strong><span>moldes ativos</span></div>
      </div>
      <div class="operations-status" id="operationsStatus">Carregando cadastros.</div>
      <section class="card operations-panel">
        <nav class="operations-tabs" id="operationsTabs" aria-label="Módulos de cadastro"></nav>
        <div id="operationsTable"></div>
      </section>
      <div class="modal-backdrop operations-modal" id="operationsModal" hidden>
        <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="operationsModalTitle">
          <div class="modal-head"><div><h3 id="operationsModalTitle">Novo cadastro</h3><p id="operationsModalSubtitle"></p></div><button class="close-btn" id="operationsModalClose" type="button" aria-label="Fechar">×</button></div>
          <form id="operationsForm"><div class="operations-modal-body" id="operationsModalBody"></div><div class="ops-modal-status" id="operationsModalStatus"></div><div class="ops-modal-actions"><button class="btn" id="operationsModalCancel" type="button">Cancelar</button><button class="btn primary" id="operationsModalSave" type="submit">Salvar cadastro</button></div></form>
        </div>
      </div>`;
    renderTabs();
    $("operationsRefresh").addEventListener("click", () => refreshData());
    $("operationsNew").addEventListener("click", () => openNew());
    $("operationsTabs").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-operations-tab]");
      if (!button) return;
      state.tab = button.dataset.operationsTab;
      renderTabs();
      renderTable();
    });
    $("operationsTable").addEventListener("click", handleTableClick);
    $("operationsModalClose").addEventListener("click", closeModal);
    $("operationsModalCancel").addEventListener("click", closeModal);
    $("operationsModal").addEventListener("click", (event) => { if (event.target.id === "operationsModal") closeModal(); });
    $("operationsForm").addEventListener("submit", submitForm);
    $("operationsModalBody").addEventListener("change", (event) => {
      if (event.target.id === "allocationResourceKind") updateAllocationFields();
      if (event.target.id === "preparationStartDate") updatePreparationEnd();
      if (event.target.id === "orderWorkId") syncOrderClientHelp();
    });
    $("operationsModalBody").addEventListener("click", (event) => {
      if (event.target.id === "addOrderItem") addOrderItemRow();
      if (event.target.closest("[data-remove-order-item]")) event.target.closest(".ops-item-row")?.remove();
    });
  }

  function renderTabs() {
    $("operationsTabs").innerHTML = tabs.map(([key, label]) =>
      `<button type="button" data-operations-tab="${key}" aria-pressed="${key === state.tab}">${label}</button>`
    ).join("");
    const labels = { works: "Nova obra", orders: "Novo pedido", pieces: "Novo tipo de peça", molds: "Novo molde" };
    $("operationsNew").textContent = labels[state.tab];
  }

  function metric(id, value) { $(id).textContent = String(value); }

  function renderMetrics() {
    const data = state.data;
    if (!data) return;
    metric("operationsWorksMetric", data.works.length);
    metric("operationsOrdersMetric", data.orders.filter((order) => !["entregue", "cancelado"].includes(order.status)).length);
    metric("operationsPiecesMetric", data.pieceTypes.length);
    metric("operationsMoldsMetric", data.molds.filter((mold) => mold.status === "ativo").length);
  }

  function tableHeader(title, description, placeholder, headers) {
    return `<div class="operations-list-head"><div><h3>${title}</h3><p>${description}</p></div><input class="search" id="operationsSearch" value="${escapeHtml(state.query)}" placeholder="${placeholder}" aria-label="Pesquisar ${title.toLowerCase()}" /></div><div class="table-wrap"><table class="operations-table"><thead><tr>${headers.map((header) => `<th>${header}</th>`).join("")}</tr></thead><tbody id="operationsRows"></tbody></table></div>`;
  }

  function actionButton(action, id, label) {
    return `<button class="icon-btn" type="button" data-ops-action="${action}" data-id="${escapeHtml(id)}">${label}</button>`;
  }

  function renderTable(query = state.query) {
    state.query = query;
    if (!state.data) return;
    const filter = query.toLocaleLowerCase().trim();
    const data = state.data;
    if (state.tab === "works") {
      $("operationsTable").innerHTML = tableHeader("Obras", "Cliente, endereço, responsável e prazo da obra.", "Pesquisar obra, cliente ou responsável", ["Obra", "Cliente", "Responsável", "Prazo", "Status", "Ações"]);
      const rows = data.works.filter((work) => `${work.work_number} ${work.name} ${work.client_name} ${work.responsible_name} ${work.address}`.toLocaleLowerCase().includes(filter));
      $("operationsRows").innerHTML = rows.length ? rows.map((work) => `<tr>
        <td>${escapeHtml(work.work_number || work.name)}<span class="muted">${escapeHtml(work.name)}</span></td>
        <td>${escapeHtml(work.client_name || "—")}</td><td>${escapeHtml(work.responsible_name || "—")}</td>
        <td>${dateBR(work.requested_due_date)}</td><td>${badge(work.status)}</td>
        <td><div class="row-actions">${actionButton("edit", work.id, "Editar")}${actionButton("archive", work.id, "Arquivar")}</div></td>
      </tr>`).join("") : `<tr><td colspan="6" class="empty">Nenhuma obra encontrada.</td></tr>`;
    } else if (state.tab === "orders") {
      $("operationsTable").innerHTML = tableHeader("Pedidos", "Itens e quantidades ligados a uma obra e ao calendário de produção.", "Pesquisar pedido, obra ou cliente", ["Pedido", "Obra / cliente", "Itens", "Início", "Prazo", "Status", "Ações"]);
      const rows = data.orders.filter((order) => `${order.order_number} ${order.work_name} ${order.client_name} ${order.status}`.toLocaleLowerCase().includes(filter));
      $("operationsRows").innerHTML = rows.length ? rows.map((order) => `<tr>
        <td>${escapeHtml(order.order_number || "Sem número")}<span class="muted">${order.items.reduce((total, item) => total + Number(item.quantity || 0), 0)} peças</span></td>
        <td>${escapeHtml(order.work_name || "Sem obra")}<span class="muted">${escapeHtml(order.client_name || "—")}</span></td>
        <td>${order.items.map((item) => `${escapeHtml(item.piece_code || item.piece_name)} × ${Number(item.quantity)}`).join("<br>") || "—"}</td>
        <td>${dateBR(order.start_date)}</td><td>${dateBR(order.requested_due_date)}</td><td>${badge(order.status)}</td>
        <td><div class="row-actions">${order.hasResourceAllocation ? '<span class="ops-badge warn" title="Os itens são preservados para manter o histórico das alocações.">Alocação registrada</span>' : actionButton("edit", order.id, "Editar")}</div></td>
      </tr>`).join("") : `<tr><td colspan="7" class="empty">Nenhum pedido encontrado.</td></tr>`;
    } else if (state.tab === "pieces") {
      $("operationsTable").innerHTML = tableHeader("Catálogo de peças", "Dimensões, peso, volume, tempo de produção, estoque mínimo e moldes compatíveis.", "Pesquisar código ou peça", ["Código / peça", "Dimensões", "Peso / volume", "Tempo de produção", "Estoque", "Moldes", "Ações"]);
      const rows = data.pieceTypes.filter((piece) => `${piece.code} ${piece.name} ${piece.dimensions}`.toLocaleLowerCase().includes(filter));
      const moldById = new Map(data.molds.map((mold) => [mold.id, mold.code]));
      $("operationsRows").innerHTML = rows.length ? rows.map((piece) => `<tr>
        <td>${escapeHtml(piece.code)}<span class="muted">${escapeHtml(piece.name)}</span></td>
        <td>${escapeHtml(piece.dimensions || "—")}</td>
        <td>${piece.weight_kg == null ? "Peso não informado" : `${Number(piece.weight_kg)} kg`}<span class="muted">${piece.volume_m3 == null ? "Volume não informado" : `${Number(piece.volume_m3)} m³`}</span></td>
        <td>${Number(piece.production_minutes_per_unit)} min/un.</td>
        <td>${Number(piece.initial_stock_quantity)}<span class="muted">mínimo ${Number(piece.stock_minimum_quantity)}</span></td>
        <td>${(piece.mold_ids || []).map((id) => escapeHtml(moldById.get(id) || "")).filter(Boolean).join(", ") || "—"}</td>
        <td><div class="row-actions">${actionButton("edit", piece.id, "Editar")}${actionButton("archive", piece.id, "Arquivar")}</div></td>
      </tr>`).join("") : `<tr><td colspan="7" class="empty">Nenhum tipo de peça encontrado.</td></tr>`;
    } else {
      renderMolds(filter);
      return;
    }
    $("operationsSearch").addEventListener("input", (event) => { state.query = event.target.value; renderTable(state.query); });
  }

  function renderMolds(filter) {
    const data = state.data;
    const rows = data.molds.filter((mold) => `${mold.code} ${mold.name} ${mold.mold_type} ${mold.dimensions}`.toLocaleLowerCase().includes(filter));
    const moldById = new Map(data.molds.map((mold) => [mold.id, mold.code]));
    const pieceById = new Map(data.pieceTypes.map((piece) => [piece.id, piece.code]));
    const orderItemById = new Map();
    for (const order of data.orders) for (const item of order.items) orderItemById.set(item.id, { item, order });
    const moldRows = rows.length ? rows.map((mold) => `<tr>
      <td>${escapeHtml(mold.code)}<span class="muted">${escapeHtml(mold.name)}</span></td>
      <td>${escapeHtml(mold.mold_type)}<span class="muted">${escapeHtml(mold.dimensions || "Dimensões não informadas")}</span></td>
      <td>${mold.cycle_minutes_per_unit == null ? "Não informado" : `${Number(mold.cycle_minutes_per_unit)} min/un.`}<span class="muted">preparação: 7 dias corridos</span></td>
      <td>${(mold.piece_type_ids || []).map((id) => escapeHtml(pieceById.get(id) || "")).filter(Boolean).join(", ") || "—"}</td>
      <td>${badge(mold.status)}</td>
      <td><div class="row-actions">${actionButton("edit", mold.id, "Editar")}${actionButton("prepare", mold.id, "Preparar")}${actionButton("allocate", mold.id, "Alocar")}${mold.status !== "retirado" ? actionButton("archive", mold.id, "Retirar") : ""}</div></td>
    </tr>`).join("") : `<tr><td colspan="6" class="empty">Nenhum molde cadastrado. Os moldes existentes podem ser incluídos sem importar códigos presumidos.</td></tr>`;
    const preparationRows = data.preparations.map((prep) => `<tr>
      <td>${escapeHtml(moldById.get(prep.mold_id) || "Molde")}</td><td>${dateBR(prep.start_date)} – ${dateBR(prep.end_date)}</td>
      <td>${badge(prep.status)}</td><td>${escapeHtml(prep.approved_by || "—")}</td>
      <td><div class="row-actions">${actionButton("edit-preparation", prep.id, "Editar")}</div></td>
    </tr>`).join("") || `<tr><td colspan="5" class="empty">Nenhuma preparação registrada.</td></tr>`;
    const allocationRows = data.allocations.map((allocation) => {
      const linked = orderItemById.get(allocation.order_item_id);
      const product = linked ? `${linked.order.order_number || "Pedido"} · ${linked.item.piece_code || linked.item.piece_name}` : "Item de produção";
      const resource = allocation.resource_kind === "mold" ? moldById.get(allocation.mold_id) || allocation.resource_name : allocation.resource_name;
      const override = allocation.conflict_reason ? `<span class="muted">Exceção: ${escapeHtml(allocation.conflict_responsible || "responsável não informado")} · ${escapeHtml(allocation.conflict_reason)}</span>` : "";
      return `<tr><td>${escapeHtml(resource)}</td><td>${escapeHtml(product)}${override}</td><td>${dateBR(allocation.start_date)} – ${dateBR(allocation.end_date)}</td><td>${badge(allocation.status)}</td><td><div class="row-actions">${actionButton("edit-allocation", allocation.id, "Editar")}${allocation.status !== "cancelled" ? actionButton("cancel-allocation", allocation.id, "Cancelar") : ""}</div></td></tr>`;
    }).join("") || `<tr><td colspan="5" class="empty">Nenhuma alocação de produção registrada.</td></tr>`;
    $("operationsTable").innerHTML = `
      <div class="operations-list-head"><div><h3>Moldes</h3><p>Compatibilidade, ciclo, preparação e alocação da produção.</p></div><input class="search" id="operationsSearch" value="${escapeHtml(state.query)}" placeholder="Pesquisar molde, tipo ou dimensão" aria-label="Pesquisar moldes" /></div>
      <div class="table-wrap"><table class="operations-table"><thead><tr><th>Código / molde</th><th>Tipo / dimensões</th><th>Ciclo</th><th>Compatibilidade</th><th>Status</th><th>Ações</th></tr></thead><tbody id="moldRows">${moldRows}</tbody></table></div>
      <div class="operations-list-head"><div><h3>Preparações</h3><p>Sete dias corridos; produção depende de checklist aprovado.</p></div><button class="btn" type="button" data-ops-action="new-preparation">Nova preparação</button></div>
      <div class="table-wrap"><table class="operations-table"><thead><tr><th>Molde</th><th>Período contínuo</th><th>Status</th><th>Aprovador</th><th>Ações</th></tr></thead><tbody>${preparationRows}</tbody></table></div>
      <div class="operations-list-head"><div><h3>Alocações</h3><p>O mesmo molde não pode ser reservado em períodos sobrepostos.</p></div><button class="btn" type="button" data-ops-action="new-allocation">Alocar produção</button></div>
      <div class="table-wrap"><table class="operations-table"><thead><tr><th>Recurso</th><th>Pedido / peça</th><th>Período</th><th>Status</th><th>Ações</th></tr></thead><tbody>${allocationRows}</tbody></table></div>
      <p class="operations-help">Preparação: limpeza, aplicação de desmoldante e montagem precisam estar marcadas antes da aprovação. Conflitos de outros recursos só são mantidos com justificativa e responsável registrados.</p>`;
    $("operationsSearch").addEventListener("input", (event) => { state.query = event.target.value; renderTable(state.query); });
  }

  function openModal(title, subtitle, body, kind, record = null) {
    $("operationsModalTitle").textContent = title;
    $("operationsModalSubtitle").textContent = subtitle;
    $("operationsModalBody").innerHTML = body;
    $("operationsModalStatus").textContent = "";
    $("operationsModalStatus").classList.remove("show");
    $("operationsForm").dataset.kind = kind;
    $("operationsForm").dataset.recordId = record?.id || "";
    $("operationsModal").hidden = false;
    $("operationsModalSave").disabled = false;
    $("operationsModalSave").textContent = record ? "Salvar alterações" : "Salvar cadastro";
    $("operationsModalBody").querySelector("input,select,textarea")?.focus();
  }

  function closeModal() {
    $("operationsModal").hidden = true;
    $("operationsForm").reset();
    $("operationsForm").dataset.kind = "";
    $("operationsForm").dataset.recordId = "";
  }

  function inputField(id, label, value = "", type = "text", options = {}) {
    const full = options.full ? " full" : "";
    const required = options.required ? " required" : "";
    const min = options.min != null ? ` min="${escapeHtml(options.min)}"` : "";
    const max = options.max != null ? ` max="${escapeHtml(options.max)}"` : "";
    const step = options.step != null ? ` step="${escapeHtml(options.step)}"` : "";
    const disabled = options.disabled ? " disabled" : "";
    const placeholder = options.placeholder ? ` placeholder="${escapeHtml(options.placeholder)}"` : "";
    return `<div class="field${full}"><label for="${id}">${label}${options.optional ? " <span>opcional</span>" : ""}</label><input class="input" id="${id}" name="${id}" type="${type}" value="${escapeHtml(value)}"${required}${min}${max}${step}${disabled}${placeholder}></div>`;
  }

  function selectField(id, label, value, options, config = {}) {
    const rows = options.map(([key, name]) => `<option value="${escapeHtml(key)}" ${String(value) === String(key) ? "selected" : ""}>${escapeHtml(name)}</option>`).join("");
    return `<div class="field${config.full ? " full" : ""}"><label for="${id}">${label}${config.optional ? " <span>opcional</span>" : ""}</label><select class="select" id="${id}" name="${id}"${config.required ? " required" : ""}>${config.placeholder ? `<option value="">${escapeHtml(config.placeholder)}</option>` : ""}${rows}</select></div>`;
  }

  function multiSelectField(id, label, options, selectedIds, emptyText) {
    const choices = options.length
      ? options.map((item) => `<option value="${escapeHtml(item.id)}" ${(selectedIds || []).includes(item.id) ? "selected" : ""}>${escapeHtml(item.code)} · ${escapeHtml(item.name)}</option>`).join("")
      : `<option disabled>${escapeHtml(emptyText)}</option>`;
    return `<div class="field full"><label for="${id}">${label} <span>Ctrl/Cmd para selecionar mais de um</span></label><select class="select" id="${id}" name="${id}" multiple>${choices}</select></div>`;
  }

  function textareaField(id, label, value = "", full = true) {
    return `<div class="field${full ? " full" : ""}"><label for="${id}">${label} <span>opcional</span></label><textarea class="textarea" id="${id}" name="${id}" maxlength="1000">${escapeHtml(value)}</textarea></div>`;
  }

  function openNew() {
    if (state.tab === "works") return openWorkForm();
    if (state.tab === "orders") return openOrderForm();
    if (state.tab === "pieces") return openPieceForm();
    return openMoldForm();
  }

  function openWorkForm(work = null) {
    const body = `<div class="ops-form-grid">
      ${inputField("workNumber", "Número da obra", work?.work_number || "", "text", { optional: true })}
      ${inputField("name", "Nome da obra", work?.name || "", "text", { required: true })}
      ${inputField("clientName", "Cliente", work?.client_name || "", "text", { required: true, placeholder: "Nome do cliente" })}
      ${inputField("responsibleName", "Responsável", work?.responsible_name || "", "text", { optional: true })}
      ${inputField("address", "Endereço da obra", work?.address || "", "text", { full: true, optional: true })}
      ${inputField("startDate", "Data de início", work?.start_date || "", "date", { optional: true })}
      ${inputField("requestedDueDate", "Prazo previsto", work?.requested_due_date || "", "date", { optional: true })}
      ${selectField("status", "Status", work?.status || "planejamento", [["planejamento", "Planejamento"], ["ativa", "Ativa"], ["concluida", "Concluída"], ["cancelada", "Cancelada"]])}
      ${textareaField("observations", "Observações", work?.observations || "")}
    </div>`;
    openModal(work ? "Editar obra" : "Nova obra", "Cliente, endereço, responsável e datas para organizar os pedidos.", body, "work", work);
  }

  function orderItemRow(item = {}) {
    const typeOptions = state.data.pieceTypes.map((piece) => `<option value="${escapeHtml(piece.id)}" ${item.piece_type_id === piece.id ? "selected" : ""}>${escapeHtml(piece.code)} · ${escapeHtml(piece.name)} (${Number(piece.production_minutes_per_unit)} min/un.)</option>`).join("");
    return `<div class="ops-item-row">
      <select class="select" data-item-piece required><option value="">Selecione a peça</option>${typeOptions}</select>
      <input class="input" data-item-quantity type="number" min="1" step="1" value="${escapeHtml(item.quantity || 1)}" required aria-label="Quantidade" />
      <input class="input ops-item-observations" data-item-observations value="${escapeHtml(item.observations || "")}" maxlength="500" placeholder="Observação do item" aria-label="Observação do item" />
      <button class="ops-item-remove" type="button" data-remove-order-item aria-label="Remover item">×</button>
    </div>`;
  }

  function openOrderForm(order = null) {
    const workOptions = state.data.works.map((work) => [work.id, `${work.work_number ? `${work.work_number} · ` : ""}${work.name}`]);
    const statusOptions = [["orcamento", "Orçamento"], ["aprovado", "Aprovado"], ["em_producao", "Em produção"], ["concluido", "Concluído"], ["entregue", "Entregue"], ["atrasado", "Atrasado"], ["cancelado", "Cancelado"]];
    const items = order?.items?.length ? order.items : [{}];
    const body = `<div class="ops-form-grid">
      ${inputField("orderNumber", "Número do pedido", order?.order_number || "", "text", { optional: true })}
      ${selectField("orderWorkId", "Obra", order?.work_id || "", workOptions, { optional: true, placeholder: "Pedido sem obra vinculada" })}
      ${inputField("clientName", "Cliente (quando não houver obra)", order?.client_name || "", "text", { placeholder: "Cliente do pedido" })}
      <div class="ops-form-hint full" id="orderClientHelp">Ao escolher uma obra, o pedido usa automaticamente o cliente cadastrado nela.</div>
      ${inputField("startDate", "Data de início", order?.start_date || today(), "date", { required: true })}
      ${inputField("requestedDueDate", "Prazo solicitado", order?.requested_due_date || "", "date", { optional: true })}
      ${selectField("status", "Status", order?.status || "orcamento", statusOptions)}
      <div class="field full"><label>Itens do pedido <span>o tempo de produção é copiado do catálogo no salvamento</span></label><div class="ops-items" id="orderItems">${items.map(orderItemRow).join("")}</div><div class="ops-inline-actions"><button class="btn" type="button" id="addOrderItem">Adicionar item</button></div></div>
      ${textareaField("observations", "Observações", order?.observations || "")}
    </div>`;
    openModal(order ? "Editar pedido" : "Novo pedido", "O pedido será ligado à obra escolhida e poderá ser planejado no calendário.", body, "order", order);
    syncOrderClientHelp();
  }

  function addOrderItemRow() {
    $("orderItems").insertAdjacentHTML("beforeend", orderItemRow());
  }

  function syncOrderClientHelp() {
    const workSelect = $("orderWorkId");
    const clientInput = $("clientName");
    const help = $("orderClientHelp");
    if (!workSelect || !clientInput || !help) return;
    const work = state.data.works.find((item) => item.id === workSelect.value);
    clientInput.disabled = Boolean(work);
    clientInput.required = !work;
    if (work) clientInput.value = work.client_name || "";
    help.textContent = work
      ? `Cliente da obra: ${work.client_name || "não informado"}.`
      : "Sem obra vinculada, informe o cliente do pedido.";
  }

  function openPieceForm(piece = null) {
    const body = `<div class="ops-form-grid">
      ${inputField("code", "Código / tipo", piece?.code || "", "text", { required: true })}
      ${inputField("name", "Nome", piece?.name || "", "text", { required: true })}
      ${inputField("dimensions", "Dimensões", piece?.dimensions || "", "text", { placeholder: "Ex.: 1,20 × 0,30 × 0,25 m" })}
      ${inputField("weightKg", "Peso (kg)", piece?.weight_kg ?? "", "number", { min: 0, step: "0.001" })}
      ${inputField("volumeM3", "Volume (m³)", piece?.volume_m3 ?? "", "number", { min: 0, step: "0.000001" })}
      ${inputField("productionMinutesPerUnit", "Tempo de produção (min/un.)", piece?.production_minutes_per_unit ?? "", "number", { min: 1, step: 1, required: true })}
      ${inputField("initialStockQuantity", "Estoque inicial", piece?.initial_stock_quantity ?? 0, "number", { min: 0, step: 1 })}
      ${inputField("stockMinimumQuantity", "Estoque mínimo", piece?.stock_minimum_quantity ?? 0, "number", { min: 0, step: 1 })}
      ${multiSelectField("pieceMolds", "Moldes compatíveis", state.data.molds.filter((mold) => mold.status !== "retirado"), piece?.mold_ids || [], "Cadastre um molde primeiro")}
      ${textareaField("observations", "Observações", piece?.observations || "")}
    </div>`;
    openModal(piece ? "Editar tipo de peça" : "Novo tipo de peça", "O tempo de produção e as dimensões ficam no catálogo usado pelos pedidos.", body, "piece", piece);
  }

  function openMoldForm(mold = null) {
    const body = `<div class="ops-form-grid">
      ${inputField("code", "Código do molde", mold?.code || "", "text", { required: true })}
      ${inputField("name", "Nome", mold?.name || "", "text", { required: true })}
      ${inputField("moldType", "Tipo / configuração", mold?.mold_type || "", "text", { required: true, placeholder: "Ex.: pilar, viga, braço" })}
      ${inputField("dimensions", "Dimensões", mold?.dimensions || "", "text", { placeholder: "Dimensões úteis do molde" })}
      ${inputField("cycleMinutesPerUnit", "Ciclo (min/un.)", mold?.cycle_minutes_per_unit ?? "", "number", { min: 1, step: 1, required: true })}
      ${selectField("status", "Status", mold?.status || "ativo", [["ativo", "Ativo"], ["manutencao", "Manutenção"], ["bloqueado", "Bloqueado"], ["retirado", "Retirado"]])}
      ${multiSelectField("moldPieces", "Peças compatíveis", state.data.pieceTypes, mold?.piece_type_ids || [], "Cadastre um tipo de peça primeiro")}
      <div class="ops-form-hint">A preparação tem duração fixa de sete dias corridos e precisa ser aprovada antes da produção.</div>
      ${textareaField("observations", "Observações", mold?.observations || "")}
    </div>`;
    openModal(mold ? "Editar molde" : "Novo molde", "Cadastre somente moldes reais da unidade e associe as peças compatíveis.", body, "mold", mold);
  }

  function openPreparationForm(mold, preparation = null) {
    const moldOptions = state.data.molds.filter((item) => item.status !== "retirado").map((item) => [item.id, `${item.code} · ${item.name}`]);
    const checklist = preparation?.checklist || {};
    const startDate = preparation?.start_date || today();
    const statuses = [["planejada", "Planejada"], ["em_andamento", "Em andamento"], ["aguardando_aprovacao", "Aguardando aprovação"], ["aprovada", "Aprovada"], ["reprovada", "Reprovada"], ["cancelada", "Cancelada"]];
    const body = `<div class="ops-form-grid">
      ${selectField("preparationMoldId", "Molde", preparation?.mold_id || mold?.id || "", moldOptions, { required: true })}
      ${inputField("preparationStartDate", "Início da preparação", startDate, "date", { required: true })}
      ${inputField("preparationEndDate", "Conclusão prevista", addDays(startDate, 6), "date", { disabled: true })}
      ${selectField("status", "Status", preparation?.status || "planejada", statuses)}
      <div class="field full"><label>Checklist obrigatório</label><div class="ops-checklist">
        <label><input type="checkbox" name="limpeza" ${checklist.limpeza ? "checked" : ""}> Limpeza</label>
        <label><input type="checkbox" name="desmoldante" ${checklist.desmoldante ? "checked" : ""}> Desmoldante</label>
        <label><input type="checkbox" name="montagem" ${checklist.montagem ? "checked" : ""}> Montagem</label>
      </div></div>
      ${inputField("approvedBy", "Aprovado por", preparation?.approved_by || "", "text", { optional: true })}
      ${textareaField("observations", "Observações", preparation?.observations || "")}
    </div>`;
    openModal(preparation ? "Editar preparação" : "Preparar molde", "A data final é calculada como o sétimo dia corrido, contando o primeiro dia.", body, "preparation", preparation);
    updatePreparationEnd();
  }

  function updatePreparationEnd() {
    const start = $("preparationStartDate");
    const end = $("preparationEndDate");
    if (start && end) end.value = addDays(start.value, 6);
  }

  function openAllocationForm(mold = null, allocation = null) {
    const moldOptions = state.data.molds.filter((item) => item.status === "ativo").map((item) => [item.id, `${item.code} · ${item.name}`]);
    const orderItemOptions = [];
    for (const order of state.data.orders.filter((item) => !["concluido", "entregue", "cancelado"].includes(item.status))) {
      for (const item of order.items) orderItemOptions.push([item.id, `${order.order_number || "Pedido"} · ${item.piece_code || item.piece_name} × ${item.quantity}`]);
    }
    const resourceKind = allocation?.resource_kind || (mold ? "mold" : "mold");
    const body = `<div class="ops-form-grid">
      ${selectField("allocationResourceKind", "Tipo de recurso", resourceKind, [["mold", "Molde"], ["other", "Outro recurso"]])}
      ${selectField("allocationMoldId", "Molde", allocation?.mold_id || mold?.id || "", moldOptions, { required: true, placeholder: "Selecione" })}
      <div class="field full" id="allocationOtherResourceField" hidden><label for="allocationResourceName">Nome do recurso</label><input class="input" id="allocationResourceName" name="allocationResourceName" value="${escapeHtml(allocation?.resource_kind === "other" ? allocation.resource_name : "")}" placeholder="Ex.: equipamento, equipe, linha"></div>
      ${selectField("allocationOrderItemId", "Pedido / peça", allocation?.order_item_id || "", orderItemOptions, { required: true, placeholder: "Selecione o item que será produzido" })}
      ${inputField("startDate", "Início", allocation?.start_date || today(), "date", { required: true })}
      ${inputField("endDate", "Fim", allocation?.end_date || today(), "date", { required: true })}
      ${selectField("status", "Status", allocation?.status || "planned", [["planned", "Planejada"], ["in_progress", "Em andamento"], ["done", "Concluída"], ["cancelled", "Cancelada"]])}
      <div class="field full ops-conflict-fields" id="allocationConflictFields" hidden><label>Conflito de outro recurso <span>obrigatório quando houver sobreposição</span></label><div class="ops-form-grid">
        ${inputField("conflictResponsible", "Responsável pela exceção", allocation?.conflict_responsible || "", "text", { optional: true })}
        ${inputField("conflictReason", "Justificativa", allocation?.conflict_reason || "", "text", { optional: true })}
      </div></div>
      ${textareaField("observations", "Observações", allocation?.observations || "")}
    </div>`;
    openModal(allocation ? "Editar alocação" : "Alocar produção", "Associe um molde e um item do pedido às datas de produção.", body, "allocation", allocation);
    updateAllocationFields();
  }

  function updateAllocationFields() {
    const kind = $("allocationResourceKind")?.value;
    const moldField = $("allocationMoldId")?.closest(".field");
    const otherField = $("allocationOtherResourceField");
    const conflictField = $("allocationConflictFields");
    const moldSelect = $("allocationMoldId");
    const otherName = $("allocationResourceName");
    if (!kind || !moldField || !otherField || !conflictField) return;
    const isMold = kind === "mold";
    moldField.hidden = !isMold;
    if (moldSelect) moldSelect.required = isMold;
    otherField.hidden = isMold;
    if (otherName) otherName.required = !isMold;
    conflictField.hidden = isMold;
  }

  async function handleTableClick(event) {
    const button = event.target.closest("[data-ops-action]");
    if (!button) return;
    const { opsAction: action, id } = button.dataset;
    const data = state.data;
    if (action === "new-preparation") return openPreparationForm(null);
    if (action === "new-allocation") return openAllocationForm();
    if (action === "edit") {
      if (state.tab === "works") return openWorkForm(data.works.find((item) => item.id === id));
      if (state.tab === "orders") return openOrderForm(data.orders.find((item) => item.id === id));
      if (state.tab === "pieces") return openPieceForm(data.pieceTypes.find((item) => item.id === id));
      return openMoldForm(data.molds.find((item) => item.id === id));
    }
    if (action === "prepare") return openPreparationForm(data.molds.find((item) => item.id === id));
    if (action === "allocate") return openAllocationForm(data.molds.find((item) => item.id === id));
    if (action === "edit-preparation") return openPreparationForm(null, data.preparations.find((item) => item.id === id));
    if (action === "edit-allocation") return openAllocationForm(null, data.allocations.find((item) => item.id === id));
    if (action === "cancel-allocation") {
      const allocation = data.allocations.find((item) => item.id === id);
      if (!allocation || !confirm("Cancelar esta alocação de recurso?")) return;
      try {
        await global.PRELUX_API.saveResourceAllocation({
          id: allocation.id,
          resourceKind: allocation.resource_kind,
          moldId: allocation.mold_id,
          resourceName: allocation.resource_name,
          orderItemId: allocation.order_item_id,
          startDate: allocation.start_date,
          endDate: allocation.end_date,
          status: "cancelled",
          conflictReason: allocation.conflict_reason,
          conflictResponsible: allocation.conflict_responsible,
          observations: allocation.observations,
        });
        toast("Alocação cancelada.");
        await refreshData(true);
      } catch (error) { showStatus(error.message || "Não foi possível cancelar a alocação.", true); }
      return;
    }
    if (action === "archive") {
      const labels = { works: "obra", pieces: "tipo de peça", molds: "molde" };
      if (!confirm(`Arquivar este ${labels[state.tab] || "cadastro"}?`)) return;
      const kind = state.tab === "works" ? "work" : state.tab === "pieces" ? "piece_type" : "mold";
      try {
        await global.PRELUX_API.archiveOperationRecord(kind, id);
        toast("Cadastro arquivado.");
        await refreshData(true);
      } catch (error) { showStatus(error.message || "Não foi possível arquivar o cadastro.", true); }
    }
  }

  function formValue(form, name) {
    const value = new FormData(form).get(name);
    return value == null ? "" : String(value).trim();
  }

  function showModalError(message) {
    const element = $("operationsModalStatus");
    element.textContent = message;
    element.classList.add("show");
  }

  async function submitForm(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const kind = form.dataset.kind;
    const id = form.dataset.recordId || "";
    const save = $("operationsModalSave");
    let savedNotice = "Cadastro salvo.";
    save.disabled = true;
    save.textContent = "Salvando…";
    try {
      if (kind === "work") {
        await global.PRELUX_API.saveWork({
          id,
          workNumber: formValue(form, "workNumber"),
          name: formValue(form, "name"),
          clientName: formValue(form, "clientName"),
          address: formValue(form, "address"),
          responsibleName: formValue(form, "responsibleName"),
          startDate: formValue(form, "startDate"),
          requestedDueDate: formValue(form, "requestedDueDate"),
          status: formValue(form, "status"),
          observations: formValue(form, "observations"),
        });
      } else if (kind === "order") {
        const workId = formValue(form, "orderWorkId");
        const clientName = formValue(form, "clientName");
        if (!workId && !clientName) throw new Error("Informe o cliente ou vincule o pedido a uma obra.");
        const items = [...form.querySelectorAll(".ops-item-row")].map((row) => ({
          pieceTypeId: row.querySelector("[data-item-piece]").value,
          quantity: Number(row.querySelector("[data-item-quantity]").value),
          observations: row.querySelector("[data-item-observations]").value.trim(),
        }));
        if (items.some((item) => !item.pieceTypeId || !Number.isInteger(item.quantity) || item.quantity < 1)) throw new Error("Confira o tipo e a quantidade de cada item do pedido.");
        const response = await global.PRELUX_API.saveOrder({
          id,
          orderNumber: formValue(form, "orderNumber"),
          workId,
          clientName,
          startDate: formValue(form, "startDate"),
          requestedDueDate: formValue(form, "requestedDueDate"),
          status: formValue(form, "status"),
          observations: formValue(form, "observations"),
          items,
        });
        if (response?.planning?.warning) {
          savedNotice = `Pedido salvo. ${response.planning.warning}`;
        } else if (response?.planning?.removedFromPlan) {
          savedNotice = "Pedido atualizado e fila de produção recalculada.";
        } else if (response?.planning?.committed) {
          savedNotice = "Pedido salvo e incluído automaticamente no planejamento.";
        }
      } else if (kind === "piece") {
        const moldSelect = $("pieceMolds");
        await global.PRELUX_API.savePieceType({
          id,
          code: formValue(form, "code"),
          name: formValue(form, "name"),
          dimensions: formValue(form, "dimensions"),
          weightKg: formValue(form, "weightKg"),
          volumeM3: formValue(form, "volumeM3"),
          productionMinutesPerUnit: Number(formValue(form, "productionMinutesPerUnit")),
          initialStockQuantity: Number(formValue(form, "initialStockQuantity") || 0),
          stockMinimumQuantity: Number(formValue(form, "stockMinimumQuantity") || 0),
          observations: formValue(form, "observations"),
          moldIds: moldSelect ? [...moldSelect.selectedOptions].map((option) => option.value) : [],
        });
      } else if (kind === "mold") {
        const pieceSelect = $("moldPieces");
        await global.PRELUX_API.saveMold({
          id,
          code: formValue(form, "code"),
          name: formValue(form, "name"),
          moldType: formValue(form, "moldType"),
          dimensions: formValue(form, "dimensions"),
          cycleMinutesPerUnit: Number(formValue(form, "cycleMinutesPerUnit")),
          status: formValue(form, "status"),
          observations: formValue(form, "observations"),
          pieceTypeIds: pieceSelect ? [...pieceSelect.selectedOptions].map((option) => option.value) : [],
        });
      } else if (kind === "preparation") {
        await global.PRELUX_API.saveMoldPreparation({
          id,
          moldId: formValue(form, "preparationMoldId"),
          startDate: formValue(form, "preparationStartDate"),
          status: formValue(form, "status"),
          checklist: {
            limpeza: form.querySelector('[name="limpeza"]').checked,
            desmoldante: form.querySelector('[name="desmoldante"]').checked,
            montagem: form.querySelector('[name="montagem"]').checked,
          },
          approvedBy: formValue(form, "approvedBy"),
          observations: formValue(form, "observations"),
        });
      } else if (kind === "allocation") {
        const resourceKind = formValue(form, "allocationResourceKind");
        await global.PRELUX_API.saveResourceAllocation({
          id,
          resourceKind,
          moldId: resourceKind === "mold" ? formValue(form, "allocationMoldId") : "",
          resourceName: resourceKind === "other" ? formValue(form, "allocationResourceName") : "",
          orderItemId: formValue(form, "allocationOrderItemId"),
          startDate: formValue(form, "startDate"),
          endDate: formValue(form, "endDate"),
          status: formValue(form, "status"),
          conflictResponsible: formValue(form, "conflictResponsible"),
          conflictReason: formValue(form, "conflictReason"),
          observations: formValue(form, "observations"),
        });
      }
      closeModal();
      toast(savedNotice);
      if (kind === "work" || kind === "order") {
        global.dispatchEvent(new CustomEvent("prelux:operations:changed", { detail: { kind, id } }));
      }
      await refreshData(true);
    } catch (error) {
      showModalError(error.message || "Não foi possível salvar o cadastro.");
      save.disabled = false;
      save.textContent = id ? "Salvar alterações" : "Salvar cadastro";
    }
  }

  async function refreshData(silent = false) {
    if (state.loading) return;
    state.loading = true;
    if (!silent) showStatus("Atualizando cadastros…");
    try {
      const response = await global.PRELUX_API.getOperationsData();
      state.data = response;
      renderMetrics();
      state.query = $("operationsSearch")?.value || state.query;
      renderTable(state.query);
      showStatus("Cadastros conectados ao banco PRELUX.");
    } catch (error) {
      showStatus(error.message || "Não foi possível carregar os cadastros. Confira a configuração do backend e aplique a migração 004.", true);
      if (!state.data) $("operationsTable").innerHTML = `<div class="calendar-placeholder"><div><strong>Cadastros indisponíveis</strong><p>${escapeHtml(error.message || "Confira o backend e a migração de dados desta etapa.")}</p></div></div>`;
    } finally {
      state.loading = false;
    }
  }

  shell();
  global.addEventListener("prelux:operations:open", () => refreshData());
})(window);
