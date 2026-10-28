(function attachOperationsAdmin(global) {
  const $ = (id) => document.getElementById(id);
  const state = { data: null, tab: "works", loading: false, query: "", supportsStage4: false };
  const tabs = [
    ["works", "Obras"],
    ["orders", "Pedidos"],
    ["pieces", "Peças"],
    ["molds", "Moldes"],
    ["positions", "Posições"],
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
      disponivel: "Disponível", em_preparacao: "Em preparação", em_manutencao: "Em manutenção",
      em_andamento: "Em andamento", aguardando_aprovacao: "Aguardando aprovação", aprovada: "Aprovada",
      reprovada: "Reprovada", planned: "Planejada", in_progress: "Em andamento", done: "Concluída",
      cancelled: "Cancelada",
    };
    return labels[value] || value || "—";
  }

  function badge(value) {
    const tone = ["ativa", "concluida", "aprovado", "em_producao", "concluido", "entregue", "ativo", "aprovada", "done", "disponivel"].includes(value)
      ? "good"
      : ["atrasado", "manutencao", "em_manutencao", "em_preparacao", "aguardando_aprovacao", "em_andamento", "in_progress"].includes(value)
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
        <div><h2>Cadastros de produção</h2><p>Obras, pedidos, catálogo de peças, moldes e quatro posições de produção.</p></div>
        <div class="actions"><button class="btn" id="operationsRefresh" type="button">Atualizar dados</button><button class="btn primary" id="operationsNew" type="button">Nova obra</button></div>
      </div>
      <div class="metric-grid">
        <div class="card metric-card"><small>Obras ativas</small><strong id="operationsWorksMetric">—</strong><span>cadastros em andamento</span></div>
        <div class="card metric-card"><small>Pedidos abertos</small><strong id="operationsOrdersMetric">—</strong><span>pedidos não entregues ou cancelados</span></div>
        <div class="card metric-card"><small>Tipos de peça</small><strong id="operationsPiecesMetric">—</strong><span>catálogo ativo</span></div>
        <div class="card metric-card"><small>Moldes disponíveis</small><strong id="operationsMoldsMetric">—</strong><span>moldes ativos</span></div>
        <div class="card metric-card"><small>Posições configuradas</small><strong id="operationsPositionsMetric">—</strong><span>de 4 posições físicas</span></div>
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
      if (event.target.id === "pieceKind") updatePieceMoldFields();
      if (event.target.id === "pieceMoldPair") syncPieceMoldPair();
      if (event.target.id === "positionConfigurationKind") updatePositionConfigFields();
    });
    $("operationsModalBody").addEventListener("input", (event) => {
      if (["dimensionXcm", "dimensionYcm", "dimensionZcm"].includes(event.target.id)) updatePieceMetrics();
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
    const labels = { works: "Nova obra", orders: "Novo pedido", pieces: "Nova peça", molds: "Novo molde", positions: "Gerenciar posições" };
    $("operationsNew").textContent = labels[state.tab];
    $("operationsNew").hidden = state.tab === "positions";
  }

  function metric(id, value) { $(id).textContent = String(value); }

  function renderMetrics() {
    const data = state.data;
    if (!data) return;
    metric("operationsWorksMetric", data.works.length);
    metric("operationsOrdersMetric", data.orders.filter((order) => !["entregue", "cancelado"].includes(order.status)).length);
    metric("operationsPiecesMetric", data.pieceTypes.length);
    metric("operationsMoldsMetric", data.molds.filter((mold) => mold.status === "ativo").length);
    metric("operationsPositionsMetric", state.supportsStage4 ? data.positions.filter((position) => Boolean(position.configuration_kind)).length : "—");
  }

  function tableHeader(title, description, placeholder, headers) {
    return `<div class="operations-list-head"><div><h3>${title}</h3><p>${description}</p></div><input class="search" id="operationsSearch" value="${escapeHtml(state.query)}" placeholder="${placeholder}" aria-label="Pesquisar ${title.toLowerCase()}" /></div><div class="table-wrap"><table class="operations-table"><thead><tr>${headers.map((header) => `<th>${header}</th>`).join("")}</tr></thead><tbody id="operationsRows"></tbody></table></div>`;
  }

  function actionButton(action, id, label) {
    return `<button class="icon-btn" type="button" data-ops-action="${action}" data-id="${escapeHtml(id)}">${label}</button>`;
  }

  function formatNumber(value, digits = 2) {
    const number = Number(value);
    return Number.isFinite(number) ? new Intl.NumberFormat("pt-BR", { maximumFractionDigits: digits }).format(number) : "—";
  }

  function pieceTypeLabel(value) {
    return ({ braco: "Braço", pilar: "Pilar", viga: "Viga" })[value] || "Tipo pendente";
  }

  function catalogLabel(code) {
    const item = (state.data?.moldCatalog || []).find((row) => row.code === code);
    return item ? `${item.mold_type === "BRACO" ? "BRAÇO" : item.mold_type} ${item.measure_label} cm` : "Molde não informado";
  }

  function pieceMoldSummary(piece) {
    const molds = piece.mold_catalogs || {};
    if (molds.braco) return escapeHtml(catalogLabel(molds.braco));
    if (molds.leito || molds.lateral) return `${escapeHtml(catalogLabel(molds.leito))}<span class="muted">+ ${escapeHtml(catalogLabel(molds.lateral))}</span>`;
    return "Configuração pendente";
  }

  function calculatedVolumeCm3(piece) {
    if (piece.volume_cm3 != null) return Number(piece.volume_cm3);
    const dimensions = [piece.dimension_x_cm, piece.dimension_y_cm, piece.dimension_z_cm].map(Number);
    return dimensions.every((value) => Number.isFinite(value) && value > 0) ? dimensions.reduce((total, value) => total * value, 1) : null;
  }

  function pieceMetricsLabel(piece) {
    const volumeCm3 = calculatedVolumeCm3(piece);
    if (volumeCm3 == null) {
      return '<td>Dimensões pendentes<span class="muted">Revise X, Y e Z para calcular volume e peso</span></td>';
    }
    const volumeM3 = piece.volume_m3 == null ? volumeCm3 / 1_000_000 : Number(piece.volume_m3);
    const weightKg = piece.weight_kg == null ? volumeCm3 * 2.5 / 1000 : Number(piece.weight_kg);
    return `<td>${formatNumber(volumeCm3, 3)} cm³<span class="muted">${formatNumber(volumeM3, 6)} m³ · ${formatNumber(weightKg, 3)} kg</span></td>`;
  }

  function positionConfigLabel(position) {
    if (position.configuration_kind === "braco" && position.braco_catalog_code) return catalogLabel(position.braco_catalog_code);
    if (position.configuration_kind === "pilar_viga" && position.leito_catalog_code && position.lateral_catalog_code) {
      return `${catalogLabel(position.leito_catalog_code)} + ${catalogLabel(position.lateral_catalog_code)}`;
    }
    return "Configuração pendente";
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
      $("operationsTable").innerHTML = tableHeader("Catálogo de peças", "Tipos fixos, dimensões em centímetros e métricas calculadas automaticamente.", "Pesquisar código ou peça", ["Código / peça", "Tipo", "Dimensões X × Y × Z", "Volume / peso", "Tempo registrado", "Moldes", "Ações"]);
      const rows = data.pieceTypes.filter((piece) => `${piece.code} ${piece.name} ${piece.piece_kind || ""} ${piece.dimensions}`.toLocaleLowerCase().includes(filter));
      $("operationsRows").innerHTML = rows.length ? rows.map((piece) => `<tr>
        <td>${escapeHtml(piece.code)}<span class="muted">${escapeHtml(piece.name)}</span></td>
        <td>${escapeHtml(pieceTypeLabel(piece.piece_kind))}</td>
        <td>${piece.dimension_x_cm == null ? escapeHtml(piece.dimensions || "Não informado") : `${Number(piece.dimension_x_cm)} × ${Number(piece.dimension_y_cm)} × ${Number(piece.dimension_z_cm)} cm`}</td>
        ${pieceMetricsLabel(piece)}
        <td>${Number(piece.production_minutes_per_unit)} min/un.<span class="muted">apenas registro</span></td>
        <td>${pieceMoldSummary(piece)}</td>
        <td><div class="row-actions">${actionButton("edit", piece.id, "Editar")}${actionButton("archive", piece.id, "Arquivar")}</div></td>
      </tr>`).join("") : `<tr><td colspan="7" class="empty">Nenhuma peça encontrada.</td></tr>`;
    } else {
      if (state.tab === "positions") {
        renderPositions(filter);
        return;
      }
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
      <td>${escapeHtml(mold.catalog_code ? catalogLabel(mold.catalog_code) : (mold.catalog_label || mold.name || "Molde legado"))}</td>
      <td>${escapeHtml(mold.code)}<span class="muted">${mold.catalog_code ? "identificador gerado" : "cadastro legado"}</span></td>
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
      <div class="operations-list-head"><div><h3>Moldes</h3><p>Catálogo fixo de medidas, ciclo opcional e preparação de sete dias corridos.</p></div><input class="search" id="operationsSearch" value="${escapeHtml(state.query)}" placeholder="Pesquisar molde ou medida" aria-label="Pesquisar moldes" /></div>
      <div class="table-wrap"><table class="operations-table"><thead><tr><th>Molde</th><th>Identificador</th><th>Ciclo</th><th>Compatibilidade</th><th>Status</th><th>Ações</th></tr></thead><tbody id="moldRows">${moldRows}</tbody></table></div>
      <div class="operations-list-head"><div><h3>Preparações</h3><p>Sete dias corridos; produção depende de checklist aprovado.</p></div><button class="btn" type="button" data-ops-action="new-preparation">Nova preparação</button></div>
      <div class="table-wrap"><table class="operations-table"><thead><tr><th>Molde</th><th>Período contínuo</th><th>Status</th><th>Aprovador</th><th>Ações</th></tr></thead><tbody>${preparationRows}</tbody></table></div>
      <div class="operations-list-head"><div><h3>Alocações</h3><p>O mesmo molde não pode ser reservado em períodos sobrepostos.</p></div><button class="btn" type="button" data-ops-action="new-allocation">Alocar produção</button></div>
      <div class="table-wrap"><table class="operations-table"><thead><tr><th>Recurso</th><th>Pedido / peça</th><th>Período</th><th>Status</th><th>Ações</th></tr></thead><tbody>${allocationRows}</tbody></table></div>
      <p class="operations-help">Preparação: limpeza, aplicação de desmoldante e montagem precisam estar marcadas antes da aprovação. Conflitos de outros recursos só são mantidos com justificativa e responsável registrados.</p>`;
    $("operationsSearch").addEventListener("input", (event) => { state.query = event.target.value; renderTable(state.query); });
  }

  function renderPositions(filter) {
    const positions = state.data.positions || [];
    const rows = positions.filter((position) => `${position.code} ${position.status} ${positionConfigLabel(position)}`.toLocaleLowerCase().includes(filter));
    const positionRows = rows.map((position) => `<tr>
      <td>${escapeHtml(position.code)}</td>
      <td>${escapeHtml(positionConfigLabel(position))}<span class="muted">${position.configuration_kind === "pilar_viga" ? "LEITO e LATERAL na mesma posição" : position.configuration_kind === "braco" ? "Molde único" : "Selecione a configuração"}</span></td>
      <td>${badge(position.status)}</td>
      <td>${escapeHtml(position.notes || "—")}</td>
      <td><div class="row-actions">${actionButton("edit-position", position.id, "Configurar")}</div></td>
    </tr>`).join("") || `<tr><td colspan="5" class="empty">Nenhuma posição encontrada.</td></tr>`;
    const setupStatus = state.supportsStage4 ? "" : `<div class="ops-form-hint full">Para configurar posições e moldes, aplique database/007_stage4_piece_catalog_positions.sql e publique a Edge Function operations-admin atualizada.</div>`;
    $("operationsTable").innerHTML = `<div class="operations-list-head"><div><h3>Posições físicas de molde</h3><p>Quatro posições fixas. Cada concretagem ocupa uma posição por um dia útil e a configuração seleciona a quais peças ela atende.</p></div><input class="search" id="operationsSearch" value="${escapeHtml(state.query)}" placeholder="Pesquisar posição ou molde" aria-label="Pesquisar posições" /></div>
      ${setupStatus}
      <div class="table-wrap"><table class="operations-table"><thead><tr><th>Posição</th><th>Configuração</th><th>Status</th><th>Observações</th><th>Ações</th></tr></thead><tbody>${positionRows}</tbody></table></div>
      <p class="operations-help">Braço usa uma medida BRAÇO. Pilar e Viga usam um LEITO e um LATERAL na mesma posição. Tempo de setup permanece sem valor informado.</p>`;
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
    const readonly = options.readonly ? " readonly" : "";
    const placeholder = options.placeholder ? ` placeholder="${escapeHtml(options.placeholder)}"` : "";
    return `<div class="field${full}"><label for="${id}">${label}${options.optional ? " <span>opcional</span>" : ""}</label><input class="input" id="${id}" name="${id}" type="${type}" value="${escapeHtml(value)}"${required}${min}${max}${step}${disabled}${readonly}${placeholder}></div>`;
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
    if (["pieces", "molds", "positions"].includes(state.tab) && !ensureStage4()) return;
    if (state.tab === "works") return openWorkForm();
    if (state.tab === "orders") return openOrderForm();
    if (state.tab === "pieces") return openPieceForm();
    if (state.tab === "molds") return openMoldForm();
  }

  function ensureStage4() {
    if (state.supportsStage4) return true;
    const message = "Os cadastros novos da Etapa 4 aguardam a migração 007 e a Edge Function operations-admin atualizada no Supabase.";
    showStatus(message, true);
    toast("Aplique a migração 007 no Supabase para continuar.");
    return false;
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
      ${inputField("startDate", "Data de início", order?.start_date || today(), "date", { required: true, readonly: Boolean(order?.work_id) })}
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
    const startDateInput = $("startDate");
    const help = $("orderClientHelp");
    if (!workSelect || !clientInput || !startDateInput || !help) return;
    const work = state.data.works.find((item) => item.id === workSelect.value);
    clientInput.disabled = Boolean(work);
    clientInput.required = !work;
    startDateInput.readOnly = Boolean(work);
    startDateInput.required = true;
    if (work) {
      clientInput.value = work.client_name || "";
      startDateInput.value = work.start_date || "";
      help.textContent = work.start_date
        ? `Cliente e data de início herdados da obra (${dateBR(work.start_date)}).`
        : "Cadastre a data de início da obra antes de vincular este pedido.";
    } else {
      help.textContent = "Sem obra vinculada, informe o cliente e a data de início do pedido.";
    }
  }

  function openPieceForm(piece = null) {
    if (!ensureStage4()) return;
    const molds = piece?.mold_catalogs || {};
    const typeOptions = [["braco", "Braço"], ["pilar", "Pilar"], ["viga", "Viga"]];
    const armOptions = catalogChoices("BRACO");
    const combinations = moldCombinationsFor("pilar");
    const selectedPair = molds.leito && molds.lateral ? `${molds.leito}|${molds.lateral}` : "";
    const body = `<div class="ops-form-grid">
      ${inputField("code", "Código da peça", piece?.code || "", "text", { required: true })}
      ${inputField("name", "Nome da peça", piece?.name || "", "text", { required: true })}
      ${selectField("pieceKind", "Tipo fixo", piece?.piece_kind || "", typeOptions, { required: true, placeholder: "Selecione Braço, Pilar ou Viga" })}
      ${inputField("dimensionXcm", "Dimensão X (cm)", piece?.dimension_x_cm ?? "", "number", { min: 0.001, step: "0.001", required: true })}
      ${inputField("dimensionYcm", "Dimensão Y (cm)", piece?.dimension_y_cm ?? "", "number", { min: 0.001, step: "0.001", required: true })}
      ${inputField("dimensionZcm", "Dimensão Z (cm)", piece?.dimension_z_cm ?? "", "number", { min: 0.001, step: "0.001", required: true })}
      <div class="ops-computed-metrics full" aria-live="polite">
        <div><small>Volume</small><strong id="pieceVolumeCm3">—</strong><span>cm³</span></div>
        <div><small>Volume</small><strong id="pieceVolumeM3">—</strong><span>m³</span></div>
        <div><small>Peso estimado</small><strong id="pieceWeightKg">—</strong><span>kg</span></div>
      </div>
      ${inputField("productionMinutesPerUnit", "Tempo de produção (min/un.)", piece?.production_minutes_per_unit ?? "", "number", { min: 1, step: 1, required: true })}
      <div class="ops-form-hint">O tempo fica registrado no cadastro e não limita a capacidade do planejamento.</div>
      ${selectField("pieceMoldBraco", "Molde BRAÇO", molds.braco || "", armOptions, { required: true, placeholder: "Selecione uma medida" })}
      ${selectField("pieceMoldPair", "Combinação de moldes LEITO × LATERAL", selectedPair, combinations, { required: true, placeholder: "Selecione uma combinação" })}
      <input type="hidden" id="pieceMoldLeito" name="pieceMoldLeito" value="${escapeHtml(molds.leito || "")}" />
      <input type="hidden" id="pieceMoldLateral" name="pieceMoldLateral" value="${escapeHtml(molds.lateral || "")}" />
      ${textareaField("observations", "Observações", piece?.observations || "")}
    </div>`;
    openModal(piece ? "Editar peça" : "Nova peça", "Dimensões em centímetros; volume e peso são calculados ao informar X, Y e Z.", body, "piece", piece);
    updatePieceMoldFields();
    updatePieceMetrics();
  }

  function openMoldForm(mold = null) {
    if (!ensureStage4()) return;
    const moldOptions = (state.data.moldCatalog || []).map((item) => [item.code, `${item.mold_type === "BRACO" ? "BRAÇO" : item.mold_type} ${item.measure_label} cm`]);
    const body = `<div class="ops-form-grid">
      ${selectField("catalogCode", "Molde do catálogo fixo", mold?.catalog_code || "", moldOptions, { required: true, placeholder: "Selecione tipo e medida" })}
      ${inputField("cycleMinutesPerUnit", "Ciclo (min/un.)", mold?.cycle_minutes_per_unit ?? "", "number", { min: 1, step: 1, optional: true })}
      ${selectField("status", "Status", mold?.status || "ativo", [["ativo", "Ativo"], ["manutencao", "Manutenção"], ["bloqueado", "Bloqueado"], ["retirado", "Retirado"]])}
      <div class="ops-form-hint">A preparação tem duração fixa de sete dias corridos e precisa ser aprovada antes da produção.</div>
      ${textareaField("observations", "Observações", mold?.observations || "")}
    </div>`;
    openModal(mold ? "Editar molde" : "Novo molde", "Tipo e medida vêm do catálogo fixo; o identificador é gerado pelo sistema.", body, "mold", mold);
  }

  function openPositionForm(position) {
    if (!ensureStage4()) return;
    const typeOptions = [["braco", "Braço"], ["pilar_viga", "Pilar / Viga"]];
    const armOptions = catalogChoices("BRACO");
    const bedOptions = catalogChoices("LEITO");
    const sideOptions = catalogChoices("LATERAL");
    const body = `<div class="ops-form-grid">
      <input type="hidden" id="positionCode" name="positionCode" value="${escapeHtml(position.code)}" />
      <div class="field"><label>Posição física</label><input class="input" value="${escapeHtml(position.code)}" disabled /></div>
      ${selectField("status", "Status", position.status || "disponivel", [["disponivel", "Disponível"], ["em_preparacao", "Em preparação"], ["em_producao", "Em produção"], ["em_manutencao", "Em manutenção"]])}
      ${selectField("positionConfigurationKind", "Configuração da posição", position.configuration_kind || "", typeOptions, { required: true, placeholder: "Selecione a configuração" })}
      ${selectField("positionMoldBraco", "Molde BRAÇO", position.braco_catalog_code || "", armOptions, { required: true, placeholder: "Selecione uma medida" })}
      ${selectField("positionMoldLeito", "Molde LEITO", position.leito_catalog_code || "", bedOptions, { required: true, placeholder: "Selecione uma medida" })}
      ${selectField("positionMoldLateral", "Molde LATERAL", position.lateral_catalog_code || "", sideOptions, { required: true, placeholder: "Selecione uma medida" })}
      ${textareaField("positionNotes", "Observações", position.notes || "")}
      <div class="ops-form-hint full">A configuração vale para os pedidos compatíveis e a fila de planejamento será recalculada ao salvar. Tempo de setup permanece sem valor informado.</div>
    </div>`;
    openModal(`Configurar posição ${position.code}`, "Defina o conjunto fixo de moldes instalado nesta posição.", body, "position", position);
    updatePositionConfigFields();
  }

  function catalogChoices(moldType) {
    return (state.data?.moldCatalog || []).filter((item) => item.mold_type === moldType)
      .map((item) => [item.code, `${moldType === "BRACO" ? "BRAÇO" : moldType} ${item.measure_label} cm`]);
  }

  function moldCombinationsFor(pieceKind) {
    const combinations = state.data?.moldCombinations;
    if (Array.isArray(combinations)) {
      return combinations.filter((item) => item.piece_kind === pieceKind && item.configuration_kind === "pilar_viga")
        .map((item) => [item.option_key || item.key, item.label]);
    }
    const beds = catalogChoices("LEITO");
    const sides = catalogChoices("LATERAL");
    return beds.flatMap(([bedCode, bedLabel]) => sides.map(([sideCode, sideLabel]) => [
      `${bedCode}|${sideCode}`,
      `${bedLabel} × ${sideLabel}`,
    ]));
  }

  function syncPieceMoldPair() {
    const [bedCode = "", sideCode = ""] = String($("pieceMoldPair")?.value || "").split("|");
    if ($("pieceMoldLeito")) $("pieceMoldLeito").value = bedCode;
    if ($("pieceMoldLateral")) $("pieceMoldLateral").value = sideCode;
  }

  function updatePieceMoldFields() {
    const kind = $("pieceKind")?.value;
    const arm = $("pieceMoldBraco");
    const pair = $("pieceMoldPair");
    if (!arm || !pair) return;
    const armField = arm.closest(".field");
    const pairField = pair.closest(".field");
    if (!kind) {
      armField.hidden = true;
      pairField.hidden = true;
      arm.required = false;
      pair.required = false;
      return;
    }
    const isArm = kind === "braco";
    armField.hidden = !isArm;
    pairField.hidden = isArm;
    arm.required = isArm;
    pair.required = !isArm;
    if (isArm) pair.value = "";
    else arm.value = "";
    syncPieceMoldPair();
  }

  function updatePositionConfigFields() {
    const kind = $("positionConfigurationKind")?.value;
    const arm = $("positionMoldBraco");
    const bed = $("positionMoldLeito");
    const side = $("positionMoldLateral");
    if (!arm || !bed || !side) return;
    if (!kind) {
      [arm, bed, side].forEach((select) => { select.closest(".field").hidden = true; select.required = false; });
      return;
    }
    const isArm = kind === "braco";
    arm.closest(".field").hidden = !isArm;
    bed.closest(".field").hidden = isArm;
    side.closest(".field").hidden = isArm;
    arm.required = isArm;
    bed.required = !isArm;
    side.required = !isArm;
  }

  function updatePieceMetrics() {
    const x = Number(String($("dimensionXcm")?.value || "").replace(",", "."));
    const y = Number(String($("dimensionYcm")?.value || "").replace(",", "."));
    const z = Number(String($("dimensionZcm")?.value || "").replace(",", "."));
    const valid = [x, y, z].every((value) => Number.isFinite(value) && value > 0);
    const volumeCm3 = valid ? x * y * z : null;
    const volumeM3 = valid ? volumeCm3 / 1_000_000 : null;
    const weightKg = valid ? volumeCm3 * 2.5 / 1000 : null;
    $("pieceVolumeCm3").textContent = valid ? formatNumber(volumeCm3, 3) : "—";
    $("pieceVolumeM3").textContent = valid ? formatNumber(volumeM3, 6) : "—";
    $("pieceWeightKg").textContent = valid ? formatNumber(weightKg, 3) : "—";
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
      if (state.tab === "pieces") {
        if (!ensureStage4()) return;
        return openPieceForm(data.pieceTypes.find((item) => item.id === id));
      }
      if (state.tab === "positions") return openPositionForm(data.positions.find((item) => item.id === id));
      if (state.tab === "molds" && !ensureStage4()) return;
      return openMoldForm(data.molds.find((item) => item.id === id));
    }
    if (action === "edit-position") return openPositionForm(data.positions.find((item) => item.id === id));
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
        const response = await global.PRELUX_API.saveWork({
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
        if (response?.planning?.warning) savedNotice = `Obra salva. ${response.planning.warning}`;
        else if (response?.planning?.committed) savedNotice = "Obra salva e pedidos vinculados replanejados.";
      } else if (kind === "order") {
        const workId = formValue(form, "orderWorkId");
        const clientName = formValue(form, "clientName");
        if (!workId && !clientName) throw new Error("Informe o cliente ou vincule o pedido a uma obra.");
        const work = workId ? state.data.works.find((item) => item.id === workId) : null;
        if (workId && !work?.start_date) throw new Error("Cadastre a data de início da obra antes de vincular este pedido.");
        const startDate = work?.start_date || formValue(form, "startDate");
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
          startDate,
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
        const response = await global.PRELUX_API.savePieceType({
          id,
          code: formValue(form, "code"),
          name: formValue(form, "name"),
          pieceKind: formValue(form, "pieceKind"),
          dimensionXcm: formValue(form, "dimensionXcm"),
          dimensionYcm: formValue(form, "dimensionYcm"),
          dimensionZcm: formValue(form, "dimensionZcm"),
          productionMinutesPerUnit: Number(formValue(form, "productionMinutesPerUnit")),
          observations: formValue(form, "observations"),
          moldCatalogs: formValue(form, "pieceKind") === "braco"
            ? { braco: formValue(form, "pieceMoldBraco") }
            : { leito: formValue(form, "pieceMoldLeito"), lateral: formValue(form, "pieceMoldLateral") },
        });
        if (response?.planning?.warning) savedNotice = `Peça salva. ${response.planning.warning}`;
        else if (response?.planning?.committed) savedNotice = "Peça salva e planejamento recalculado.";
      } else if (kind === "mold") {
        await global.PRELUX_API.saveMold({
          id,
          catalogCode: formValue(form, "catalogCode"),
          cycleMinutesPerUnit: formValue(form, "cycleMinutesPerUnit"),
          status: formValue(form, "status"),
          observations: formValue(form, "observations"),
        });
      } else if (kind === "position") {
        const response = await global.PRELUX_API.saveMoldPosition({
          code: formValue(form, "positionCode"),
          status: formValue(form, "status"),
          configurationKind: formValue(form, "positionConfigurationKind"),
          bracoCatalogCode: formValue(form, "positionConfigurationKind") === "braco" ? formValue(form, "positionMoldBraco") : "",
          leitoCatalogCode: formValue(form, "positionConfigurationKind") === "pilar_viga" ? formValue(form, "positionMoldLeito") : "",
          lateralCatalogCode: formValue(form, "positionConfigurationKind") === "pilar_viga" ? formValue(form, "positionMoldLateral") : "",
          notes: formValue(form, "positionNotes"),
        });
        if (response?.planning?.warning) savedNotice = `Posição salva. ${response.planning.warning}`;
        else if (response?.planning?.committed) savedNotice = "Posição salva e planejamento recalculado.";
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
      if (kind === "work" || kind === "order" || kind === "position" || kind === "piece") {
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
      state.supportsStage4 = Number(response?.schemaVersion || 0) >= 4 &&
        Array.isArray(response?.moldCatalog) && Array.isArray(response?.positions);
      renderMetrics();
      state.query = $("operationsSearch")?.value || state.query;
      renderTable(state.query);
      showStatus(state.supportsStage4
        ? "Cadastros de obras, pedidos, peças, moldes e posições conectados ao banco PRELUX."
        : "Obras e pedidos conectados. Os cadastros de peças, moldes e posições aguardam a migração 007 e a Edge Function da Etapa 4.");
    } catch (error) {
      const rawMessage = error.message || "Não foi possível carregar os cadastros.";
      const message = /posi[cç][aã]o|cat[aá]logo fixo|moldes das pe[cç]as/i.test(rawMessage)
        ? `O banco ainda precisa da migração 007 da Etapa 4. ${rawMessage}`
        : rawMessage;
      showStatus(message, true);
      if (!state.data) $("operationsTable").innerHTML = `<div class="calendar-placeholder"><div><strong>Cadastros indisponíveis</strong><p>${escapeHtml(message)}</p></div></div>`;
    } finally {
      state.loading = false;
    }
  }

  shell();
  global.addEventListener("prelux:operations:open", () => refreshData());
})(window);
