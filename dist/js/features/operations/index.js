/*
 * Área PEDIDOS.
 * Apresenta o fluxo Pedido → Engenharia → Projeto → Produzir e mantém Cadastro
 * (obras, peças, formas e posições) como subtópico da entrada dos pedidos.
 */
export function initializeOperations({ operationsRepository, listPieceMoldOptions, navigate }) {
  const $ = (id) => document.getElementById(id);
  // Estado temporário da tela; os registros definitivos permanecem no Supabase.
  const state = { data: null, tab: "orders", labelOrderId: null, cadastroOpen: false, loading: false, query: "", supportsStage4: false, supportsFabio2: false };
  const cadastroTabs = [
    ["works", "Obras"],
    ["pieces", "Peças"],
    ["molds", "Formas e catálogo"],
    ["positions", "Posições"],
  ];
  const flowStages = [
    ["orders", "1 · PEDIDO"],
    ["engineering", "2 · ENGENHARIA"],
    ["projects", "3 · PROJETO"],
    ["produzir", "4 · PRODUZIR"],
    ["labels", "5 · ETIQUETAS"],
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

  // Traduz os códigos persistidos pelo banco em rótulos legíveis na interface.
  function statusLabel(value) {
    const labels = {
      planejamento: "Planejamento", ativa: "Ativa", concluida: "Concluída", cancelada: "Cancelada",
      orcamento: "Orçamento", aprovado: "Aprovado", em_producao: "Em produção", concluido: "Concluído",
      entregue: "Entregue", atrasado: "Atrasado", cancelado: "Cancelado", ativo: "Ativo",
      manutencao: "Manutenção", bloqueado: "Bloqueado", retirado: "Retirado", planejada: "Planejada",
      disponivel: "Disponível", em_preparacao: "Em preparação", em_manutencao: "Em manutenção",
      em_andamento: "Em andamento", aguardando_aprovacao: "Aguardando aprovação", aprovada: "Aprovada",
      reprovada: "Reprovada", planned: "Planejada", in_progress: "Em andamento", done: "Concluída",
      cancelled: "Cancelada", pronta: "Pronta",
    };
    return labels[value] || value || "—";
  }

  function badge(value) {
    const tone = ["ativa", "concluida", "concluido", "pronta", "aprovado", "em_producao", "entregue", "ativo", "aprovada", "done", "disponivel"].includes(value)
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

  // Monta a estrutura da aba e registra os eventos delegados da interface.
  function shell() {
    $("operationsView").innerHTML = `
      <div class="toolbar operations-toolbar">
        <div><h2>Pedidos</h2><p>Entrada do pedido e acompanhamento pelas etapas de engenharia, projeto e produção.</p></div>
        <div class="actions"><button class="btn" id="operationsRefresh" type="button">Atualizar dados</button><button class="btn primary" id="operationsNew" type="button">Novo pedido</button></div>
      </div>
      <div class="metric-grid">
        <div class="card metric-card"><small>Obras ativas</small><strong id="operationsWorksMetric">—</strong><span>cadastros em andamento</span></div>
        <div class="card metric-card"><small>Pedidos abertos</small><strong id="operationsOrdersMetric">—</strong><span>fora dos status concluídos, entregues ou cancelados</span></div>
        <div class="card metric-card"><small>Tipos de peça</small><strong id="operationsPiecesMetric">—</strong><span>catálogo ativo</span></div>
        <div class="card metric-card"><small>Formas disponíveis</small><strong id="operationsMoldsMetric">—</strong><span>formas ativas</span></div>
        <div class="card metric-card"><small>Posições configuradas</small><strong id="operationsPositionsMetric">—</strong><span>de 4 posições físicas</span></div>
      </div>
      <section class="operations-flow-card" aria-labelledby="operationsFlowTitle">
        <div class="operations-flow-heading"><div><h3 id="operationsFlowTitle">Fluxo de negócio</h3><p>O pedido é a origem dos dados; a produção e as etiquetas consomem as etapas anteriores.</p></div><button class="btn" id="operationsOpenCadastro" type="button">Abrir Cadastro</button></div>
        <nav class="operations-flow" id="operationsFlow" aria-label="Etapas do pedido"></nav>
      </section>
      <div class="operations-status" id="operationsStatus">Carregando cadastros.</div>
      <section class="card operations-panel" id="operationsDataPanel">
        <div class="operations-section-heading" id="operationsCadastroHeading" hidden><div><h3>Cadastro</h3><p>Obras, peças, catálogo de leito/lateral/braço/placa, formas e posições.</p></div><button class="btn" id="operationsReturnToOrders" type="button">Voltar ao pedido</button></div>
        <nav class="operations-tabs" id="operationsTabs" aria-label="Cadastro dentro da área Pedidos" hidden></nav>
        <div id="operationsTable"></div>
      </section>
      <div id="operationsLabelMount" hidden></div>
      <div class="modal-backdrop operations-modal" id="operationsModal" hidden>
        <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="operationsModalTitle">
          <div class="modal-head"><div><h3 id="operationsModalTitle">Novo cadastro</h3><p id="operationsModalSubtitle"></p></div><button class="close-btn" id="operationsModalClose" type="button" aria-label="Fechar">×</button></div>
          <form id="operationsForm"><div class="operations-modal-body" id="operationsModalBody"></div><div class="ops-modal-status" id="operationsModalStatus"></div><div class="ops-modal-actions"><button class="btn" id="operationsModalCancel" type="button">Cancelar</button><button class="btn primary" id="operationsModalSave" type="submit">Salvar cadastro</button></div></form>
        </div>
      </div>`;
    // O emissor já existente passa a fazer parte de Pedidos, sem recriar o canvas.
    const labelsView = $("etiquetasView");
    if (labelsView) {
      $("operationsLabelMount").append(labelsView);
      labelsView.hidden = false;
    }
    renderTabs();
    $("operationsRefresh").addEventListener("click", () => refreshData());
    $("operationsNew").addEventListener("click", () => openNew());
    $("operationsOpenCadastro").addEventListener("click", () => {
      state.tab = "works";
      state.cadastroOpen = true;
      state.query = "";
      renderTabs();
      renderTable();
    });
    $("operationsReturnToOrders").addEventListener("click", () => {
      state.tab = "orders";
      state.cadastroOpen = false;
      state.query = "";
      renderTabs();
      renderTable();
    });
    $("operationsFlow").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-flow-stage]");
      if (!button) return;
      const stage = button.dataset.flowStage;
      state.tab = stage;
      if (stage === "labels") state.labelOrderId = null;
      state.cadastroOpen = false;
      state.query = "";
      renderTabs();
      renderTable();
      if (stage === "labels") window.dispatchEvent(new CustomEvent("prelux:labels:open", { detail: { data: state.data } }));
    });
    $("operationsTabs").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-operations-tab]");
      if (!button) return;
      state.tab = button.dataset.operationsTab;
      state.cadastroOpen = true;
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
      if (event.target.id === "preparationStartDate" || event.target.id === "preparationMoldId") updatePreparationEnd();
      if (event.target.id === "orderWorkId") syncOrderClientHelp();
      if (event.target.id === "registrationWorkMode") updateRegistrationWorkMode();
      if (event.target.id === "registrationPieceKind") updateRegistrationMoldFields();
      if (event.target.matches("[data-item-piece]") && $("orderProjectSections")) refreshOrderProjectSections();
      if (event.target.id === "pieceKind") { updatePieceMoldFields(); updatePieceMetrics(); }
      if (event.target.id === "pieceMoldPair") syncPieceMoldPair();
      if (event.target.id === "projectOrderId") refreshProjectSectionsForOrder();
    });
    $("operationsModalBody").addEventListener("input", (event) => {
      if (["dimensionXcm", "dimensionYcm", "dimensionZcm"].includes(event.target.id)) updatePieceMetrics();
      if (["registrationDimensionX", "registrationDimensionY", "registrationDimensionZ"].includes(event.target.id)) {
        updateRegistrationMetrics();
        updateRegistrationPositionHint();
      }
      if (event.target.id === "registrationStartDate") updateRegistrationDueDate();
      if (event.target.id === "registrationDueDate") {
        event.target.dataset.manual = "true";
        $("registrationDueMode").textContent = "editada manualmente";
        $("registrationRestoreDue").hidden = false;
      }
      if (event.target.id === "registrationWorkNumber") populateExistingWork();
      if (event.target.matches("[data-item-quantity]") && $("orderProjectSections")) refreshOrderProjectSections();
    });
    $("operationsModalBody").addEventListener("click", (event) => {
      if (event.target.id === "addOrderItem") { addOrderItemRow(); refreshOrderProjectSections(); }
      if (event.target.id === "registrationSaveItem") saveRegistrationItem();
      if (event.target.id === "registrationRestoreDue") updateRegistrationDueDate(true);
      if (event.target.closest("[data-remove-order-item]")) { event.target.closest(".ops-item-row")?.remove(); refreshOrderProjectSections(); }
      if (event.target.id === "addProjectSection") addProjectSection();
      if (event.target.id === "addOrderProjectSection") addProjectSection();
      if (event.target.closest("[data-add-project-item]")) addProjectItem(event.target.closest(".ops-project-section"));
      if (event.target.closest("[data-remove-project-section]")) event.target.closest(".ops-project-section")?.remove();
      if (event.target.closest("[data-remove-project-item]")) event.target.closest(".ops-project-item-row")?.remove();
    });
  }

  // Resumo, tabelas e indicadores: recebem dados normalizados do repositório.
  function renderTabs() {
    $("operationsFlow").innerHTML = flowStages.map(([key, label]) =>
      `<button type="button" data-flow-stage="${key}" aria-pressed="${key === state.tab}">${label}</button>`
    ).join("");
    $("operationsTabs").innerHTML = cadastroTabs.map(([key, label]) =>
      `<button type="button" data-operations-tab="${key}" aria-pressed="${key === state.tab}">${label}</button>`
    ).join("");
    $("operationsCadastroHeading").hidden = !state.cadastroOpen;
    $("operationsTabs").hidden = !state.cadastroOpen;
    const labels = { works: "Nova obra", orders: "Novo pedido", engineering: "Novo pedido", projects: "Novo projeto", produzir: "Produção", labels: "Etiquetas", pieces: "Nova peça", molds: "Nova forma", positions: "Gerenciar posições" };
    $("operationsNew").textContent = labels[state.tab];
    $("operationsNew").hidden = ["engineering", "produzir", "labels", "positions"].includes(state.tab);
    $("operationsDataPanel").hidden = state.tab === "labels";
    $("operationsLabelMount").hidden = state.tab !== "labels";
  }

  function metric(id, value) { $(id).textContent = String(value); }

  function renderMetrics() {
    const data = state.data;
    if (!data) return;
    metric("operationsWorksMetric", data.works.length);
    metric("operationsOrdersMetric", data.orders.filter((order) => !["concluido", "entregue", "cancelado"].includes(order.status)).length);
    metric("operationsPiecesMetric", data.pieceTypes.length);
    metric("operationsMoldsMetric", data.molds.filter((mold) => mold.status === "ativo").length);
    metric("operationsPositionsMetric", state.supportsStage4 ? data.positions.filter((position) => position.status !== "em_manutencao").length : "—");
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
    return ({ braco: "Braço", pilar: "Pilar", viga: "Viga", placa: "Placa" })[value] || "Tipo pendente";
  }

  function catalogLabel(code) {
    const item = (state.data?.moldCatalog || []).find((row) => row.code === code);
    return item ? `${item.mold_type === "BRACO" ? "BRAÇO" : item.mold_type} ${item.measure_label} cm` : "Forma não informada";
  }

  function pieceMoldSummary(piece) {
    if (piece.piece_kind === "placa") return "Bancada plana · sem forma";
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

  function pieceDimensionsLabel(piece) {
    const dimensions = [piece.dimension_x_cm, piece.dimension_y_cm, piece.dimension_z_cm];
    if (dimensions.some((value) => value == null)) return escapeHtml(piece.dimensions || "Não informado");
    const values = dimensions.map((value) => formatNumber(value, 3)).join(" × ");
    const meaning = piece.piece_kind === "placa"
      ? "largura × altura × espessura"
      : piece.piece_kind === "braco"
        ? "forma X × Z · comprimento Y"
        : ["pilar", "viga"].includes(piece.piece_kind)
          ? "LEITO X × comprimento Y × LATERAL Z"
          : "X × Y × Z";
    return `${values} cm<span class="muted">${meaning}</span>`;
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
    if (position.status === "em_manutencao") return "Indisponível para alocação";
    if (position.configuration_kind === "placa") return "Bancada plana";
    const installed = position.installed_mold_catalog_codes || [];
    return installed.length ? `Forma montada: ${installed.map(catalogLabel).join(" + ")}` : "Forma definida pelo pedido";
  }

  // Tabelas e indicadores: convertem o pacote do repositório em listas filtráveis.
  // Cada tabela usa o cadastro selecionado; ações são tratadas por delegação
  // para continuar funcionando depois que o HTML da lista é atualizado.
  function renderTable(query = state.query) {
    state.query = query;
    if (!state.data) return;
    if (state.tab === "labels") return;
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
      const labeledOrders = new Set((data.productionLabels || []).map((label) => label.order_id));
      const rows = data.orders.filter((order) => `${order.order_number} ${order.work_name} ${order.client_name} ${order.status}`.toLocaleLowerCase().includes(filter));
      $("operationsRows").innerHTML = rows.length ? rows.map((order) => `<tr>
        <td>${escapeHtml(order.order_number || "Sem número")}<span class="muted">${order.items.reduce((total, item) => total + Number(item.quantity || 0), 0)} peças</span></td>
        <td>${escapeHtml(order.work_name || "Sem obra")}<span class="muted">${escapeHtml(order.client_name || "—")}</span></td>
        <td>${order.items.map((item) => `${escapeHtml(item.piece_code || item.piece_name)} × ${Number(item.quantity)}`).join("<br>") || "—"}</td>
        <td>${dateBR(order.start_date)}</td><td>${dateBR(order.requested_due_date)}</td><td>${badge(order.status)}${order.waitingForPosition ? '<span class="muted">Aguardando posicao</span>' : ""}</td>
        <td><div class="row-actions">${order.hasResourceAllocation ? '<span class="ops-badge warn" title="Os itens são preservados para manter o histórico das alocações.">Alocação registrada</span>' : actionButton("edit", order.id, "Editar")}${labeledOrders.has(order.id) ? actionButton("open-order-labels", order.id, "Etiquetas") : ""}</div></td>
      </tr>`).join("") : `<tr><td colspan="7" class="empty">Nenhum pedido encontrado.</td></tr>`;
    } else if (state.tab === "engineering") {
      $("operationsTable").innerHTML = tableHeader("Engenharia", "Confira os itens recebidos e a forma selecionada ou as opções disponíveis. Esta consulta não cria dados nem altera o pedido.", "Pesquisar pedido, cliente ou peça", ["Pedido", "Itens recebidos", "Forma selecionada / opções", "Ações"]);
      const rows = data.orders.filter((order) => `${order.order_number} ${order.client_name} ${order.work_name} ${order.items.map((item) => `${item.piece_code} ${item.piece_name}`).join(" ")}`.toLocaleLowerCase().includes(filter));
      $("operationsRows").innerHTML = rows.length ? rows.map((order) => {
        const itemRows = order.items.map((item) => {
          const piece = data.pieceTypes.find((candidate) => candidate.id === item.piece_type_id);
          const kind = piece?.piece_kind;
          const options = kind === "placa" ? [] : moldCombinationsFor(kind || "");
          const molds = piece?.mold_catalogs || {};
          const compatibility = kind === "placa"
            ? "Bancada plana · sem forma"
            : kind === "braco" && molds.braco
              ? catalogLabel(molds.braco)
              : ["pilar", "viga"].includes(kind) && molds.leito && molds.lateral
                ? `${catalogLabel(molds.leito)} + ${catalogLabel(molds.lateral)}`
                : options.length
                  ? `${options.length} combinação(ões) disponíveis`
                  : "Tipo sem combinação de forma cadastrada";
          return `<div><strong>${escapeHtml(item.piece_code || item.piece_name || "Peça")}</strong> × ${Number(item.quantity)}<span class="muted">${escapeHtml(compatibility)}</span></div>`;
        }).join("") || "<span class=muted>Pedido sem itens cadastrados.</span>";
        return `<tr><td>${escapeHtml(order.order_number || "Sem número")}<span class="muted">${escapeHtml(order.client_name || order.work_name || "Cliente não informado")}</span></td><td>${itemRows}</td><td>${order.items.length ? `${order.items.length} tipo(s) de peça revisado(s)` : "Aguardando itens"}</td><td><div class="row-actions">${actionButton("edit", order.id, "Abrir pedido")}</div></td></tr>`;
      }).join("") : `<tr><td colspan="4" class="empty">Nenhum pedido encontrado para análise.</td></tr>`;
    } else if (state.tab === "projects") {
      if (!state.supportsFabio2) {
        $("operationsTable").innerHTML = `<div class="calendar-placeholder"><div><strong>Projetos de engenharia aguardam a Etapa 5</strong><p>A migração 009 habilita a divisão dos itens de cada pedido em seções do projeto.</p></div></div>`;
        return;
      }
      $("operationsTable").innerHTML = tableHeader("Projetos por pedido", "Organize os itens de um pedido em seções e controle a quantidade distribuída.", "Pesquisar projeto, pedido ou cliente", ["Pedido", "Cliente", "Seções", "Itens distribuídos", "Ações"]);
      const rows = (data.engineeringProjects || []).filter((project) => {
        const order = data.orders.find((item) => item.id === project.order_id);
        return `${order?.order_number || ""} ${order?.client_name || ""}`.toLocaleLowerCase().includes(filter);
      });
      $("operationsRows").innerHTML = rows.length ? rows.map((project) => {
        const order = data.orders.find((item) => item.id === project.order_id);
        const sections = project.sections || [];
        const itemCount = sections.reduce((total, section) => total + (section.items || []).length, 0);
        return `<tr>
          <td>${escapeHtml(order?.order_number || "Pedido sem número")}<span class="muted">${escapeHtml(order?.work_name || "Sem obra")}</span></td>
          <td>${escapeHtml(order?.client_name || "—")}</td>
          <td>${sections.length}<span class="muted">${sections.map((section) => escapeHtml(section.section_name)).join(" · ")}</span></td>
          <td>${itemCount}</td>
          <td><div class="row-actions">${actionButton("edit-project", project.id, "Abrir projeto")}</div></td>
        </tr>`;
      }).join("") : `<tr><td colspan="5" class="empty">Ainda não há projetos de engenharia. Crie um projeto a partir de um pedido ativo.</td></tr>`;
    } else if (state.tab === "produzir") {
      renderProduction(filter);
      return;
    } else if (state.tab === "pieces") {
      $("operationsTable").innerHTML = tableHeader("Catálogo de peças", "Tipos fixos, dimensões em centímetros e métricas calculadas automaticamente.", "Pesquisar código ou peça", ["Código / peça", "Tipo", "Medidas (cm)", "Volume / peso", "Etapas", "Formas", "Ações"]);
      const rows = data.pieceTypes.filter((piece) => `${piece.code} ${piece.name} ${piece.piece_kind || ""} ${piece.dimensions}`.toLocaleLowerCase().includes(filter));
      $("operationsRows").innerHTML = rows.length ? rows.map((piece) => `<tr>
        <td>${escapeHtml(piece.code)}<span class="muted">${escapeHtml(piece.name)}</span></td>
        <td>${escapeHtml(pieceTypeLabel(piece.piece_kind))}</td>
        <td>${pieceDimensionsLabel(piece)}</td>
        ${pieceMetricsLabel(piece)}
        <td>Concretagem, cura e acabamento<span class="muted">preparação da forma quando necessária</span></td>
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

  function renderProduction(filter) {
    const orders = new Map(state.data.orders.map((order) => [order.id, order]));
    const units = (state.data.productionUnits || []).filter((unit) => {
      const order = orders.get(unit.order_id);
      return `${order?.order_number || ""} ${unit.piece_code} ${unit.piece_name} ${unit.status}`
        .toLocaleLowerCase().includes(filter);
    });
    $("operationsTable").innerHTML = tableHeader("Produzir", "Conclua cada etapa da unidade. A peça fica Pronta após todas as etapas; o pedido fica Concluído quando todas as quantidades estiverem prontas.", "Pesquisar pedido ou peça", ["Pedido", "Peça produzida", "Etapas", "Status da peça", "Ação"]);
    $("operationsRows").innerHTML = units.length ? units.map((unit) => {
      const order = orders.get(unit.order_id);
      const next = (unit.steps || []).find((step) => step.status !== "done");
      const steps = (unit.steps || []).map((step) => `${escapeHtml(step.step_kind)}: ${escapeHtml(statusLabel(step.status))}`).join(" · ");
      const canFinish = next && !["cancelled", "scrapped", "pronta"].includes(unit.status) && next.status !== "cancelled";
      return `<tr><td>${escapeHtml(order?.order_number || "Pedido")}<span class="muted">${badge(order?.status)}</span></td>
        <td>${escapeHtml(unit.piece_code || unit.piece_name || "Peça")} · unidade ${Number(unit.unit_sequence)}</td>
        <td>${steps || "Etapas não cadastradas"}</td><td>${badge(unit.status)}</td>
        <td><div class="row-actions">${canFinish ? actionButton("complete-production-step", next.id, `Concluir ${escapeHtml(next.step_kind)}`) : unit.status === "pronta" ? "Peça pronta" : "Aguardando etapa"}</div></td></tr>`;
    }).join("") : `<tr><td colspan="5" class="empty">Nenhuma unidade programada. Confirme um pedido no Planejamento para iniciar a produção.</td></tr>`;
    $("operationsSearch").addEventListener("input", (event) => { state.query = event.target.value; renderTable(state.query); });
  }

  function renderMolds(filter) {
    const data = state.data;
    const rows = data.molds.filter((mold) => `${mold.code} ${mold.name} ${mold.mold_type} ${mold.dimensions}`.toLocaleLowerCase().includes(filter));
    const moldById = new Map(data.molds.map((mold) => [mold.id, mold.code]));
    const pieceById = new Map(data.pieceTypes.map((piece) => [piece.id, piece.code]));
    const orderItemById = new Map();
    for (const order of data.orders) for (const item of order.items) orderItemById.set(item.id, { item, order });
    const preparationDurationLabel = state.supportsFabio2 ? "5 dias úteis" : "7 dias corridos";
    const moldRows = rows.length ? rows.map((mold) => `<tr>
      <td>${escapeHtml(mold.catalog_code ? catalogLabel(mold.catalog_code) : (mold.catalog_label || mold.name || "Forma legada"))}</td>
      <td>${escapeHtml(mold.code)}<span class="muted">${mold.catalog_code ? "identificador gerado" : "cadastro legado"}</span></td>
      <td>${mold.cycle_minutes_per_unit == null ? "Não informado" : `${Number(mold.cycle_minutes_per_unit)} min/un.`}<span class="muted">preparação: ${preparationDurationLabel}</span></td>
      <td>${(mold.piece_type_ids || []).map((id) => escapeHtml(pieceById.get(id) || "")).filter(Boolean).join(", ") || "—"}</td>
      <td>${badge(mold.status)}</td>
      <td><div class="row-actions">${actionButton("edit", mold.id, "Editar")}${actionButton("prepare", mold.id, "Preparar")}${actionButton("allocate", mold.id, "Alocar")}${mold.status !== "retirado" ? actionButton("archive", mold.id, "Retirar") : ""}</div></td>
    </tr>`).join("") : `<tr><td colspan="6" class="empty">Nenhuma forma cadastrada. As formas existentes podem ser incluídas sem importar códigos presumidos.</td></tr>`;
    const preparationRows = data.preparations.map((prep) => `<tr>
      <td>${escapeHtml(moldById.get(prep.mold_id) || "Forma")}</td><td>${dateBR(prep.start_date)} – ${dateBR(prep.end_date)}</td>
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
      <div class="operations-list-head"><div><h3>Formas</h3><p>Catálogo fixo de medidas, ciclo opcional e preparação de ${preparationDurationLabel}.</p></div><input class="search" id="operationsSearch" value="${escapeHtml(state.query)}" placeholder="Pesquisar forma ou medida" aria-label="Pesquisar formas" /></div>
      <div class="table-wrap"><table class="operations-table"><thead><tr><th>Forma</th><th>Identificador</th><th>Ciclo</th><th>Compatibilidade</th><th>Status</th><th>Ações</th></tr></thead><tbody id="moldRows">${moldRows}</tbody></table></div>
      <div class="operations-list-head"><div><h3>Preparações</h3><p>${preparationDurationLabel}; produção depende de checklist aprovado.</p></div><button class="btn" type="button" data-ops-action="new-preparation">Nova preparação</button></div>
      <div class="table-wrap"><table class="operations-table"><thead><tr><th>Forma</th><th>Período contínuo</th><th>Status</th><th>Aprovador</th><th>Ações</th></tr></thead><tbody>${preparationRows}</tbody></table></div>
      <div class="operations-list-head"><div><h3>Alocações</h3><p>A mesma forma não pode ser reservada em períodos sobrepostos.</p></div><button class="btn" type="button" data-ops-action="new-allocation">Alocar produção</button></div>
      <div class="table-wrap"><table class="operations-table"><thead><tr><th>Recurso</th><th>Pedido / peça</th><th>Período</th><th>Status</th><th>Ações</th></tr></thead><tbody>${allocationRows}</tbody></table></div>
      <p class="operations-help">Preparação: limpeza, aplicação de desmoldante e montagem precisam estar marcadas antes da aprovação. Conflitos de outros recursos só são mantidos com justificativa e responsável registrados.</p>`;
    $("operationsSearch").addEventListener("input", (event) => { state.query = event.target.value; renderTable(state.query); });
  }

  function renderPositions(filter) {
    const positions = state.data.positions || [];
    const rows = positions.filter((position) => `${position.code} ${position.status} ${positionConfigLabel(position)}`.toLocaleLowerCase().includes(filter));
    const positionRows = rows.map((position) => `<tr>
      <td>${escapeHtml(position.code)}</td>
      <td>${escapeHtml(positionConfigLabel(position))}<span class="muted">${position.configuration_kind === "placa" ? "Uso exclusivo para placa · sem forma" : "A fila associa os moldes exigidos pelo item"}</span></td>
      <td>${badge(position.status)}</td>
      <td>${escapeHtml(position.notes || "—")}</td>
      <td><div class="row-actions">${actionButton("edit-position", position.id, "Configurar")}${position.installed_mold_catalog_codes?.length ? actionButton("reset-position-form", position.id, "Desmontar forma") : ""}</div></td>
    </tr>`).join("") || `<tr><td colspan="5" class="empty">Nenhuma posição encontrada.</td></tr>`;
    const setupStatus = state.supportsStage4 ? "" : `<div class="ops-form-hint full">Para configurar posições e formas, aplique database/007_stage4_piece_catalog_positions.sql e publique a Edge Function operations-admin atualizada.</div>`;
    $("operationsTable").innerHTML = `<div class="operations-list-head"><div><h3>Posições físicas de produção</h3><p>Quatro posições fixas. A preparação e a concretagem ocupam a posição; a cura acontece fora dela. A forma permanece montada até troca ou desmontagem.</p></div><input class="search" id="operationsSearch" value="${escapeHtml(state.query)}" placeholder="Pesquisar posição ou pedido" aria-label="Pesquisar posições" /></div>
      ${setupStatus}
      <div class="table-wrap"><table class="operations-table"><thead><tr><th>Posição</th><th>Configuração</th><th>Status</th><th>Observações</th><th>Ações</th></tr></thead><tbody>${positionRows}</tbody></table></div>
      <p class="operations-help">Braço usa a forma BRAÇO correspondente a X × Z. Pilar e Viga usam LEITO para X e LATERAL para Z; Y é o comprimento. A fila associa essas formas à primeira posição livre. Bancadas planas são reservadas para placas.</p>`;
    $("operationsSearch").addEventListener("input", (event) => { state.query = event.target.value; renderTable(state.query); });
  }

  // Formulários: constroem os campos e guardam qual registro está sendo editado.
  // Construtores compartilhados mantêm os formulários e seus estados consistentes.
  function openModal(title, subtitle, body, kind, record = null) {
    $("operationsModalTitle").textContent = title;
    $("operationsModalSubtitle").textContent = subtitle;
    $("operationsModalBody").innerHTML = body;
    $("operationsModalStatus").textContent = "";
    $("operationsModalStatus").classList.remove("show");
    $("operationsForm").dataset.kind = kind;
    // O cadastro em etapas valida somente os campos da etapa visível.
    // A validação nativa do formulário bloquearia o submit pelos campos da etapa 2 oculta.
    $("operationsForm").noValidate = kind === "registration";
    $("operationsForm").dataset.recordId = record?.id || "";
    $("operationsModal").hidden = false;
    $("operationsModalSave").disabled = false;
    $("operationsModalSave").textContent = record ? "Salvar alterações" : "Salvar cadastro";
    $("operationsModalBody").querySelector("input,select,textarea")?.focus();
  }

  function closeModal() {
    $("operationsModal").hidden = true;
    $("operationsForm").reset();
    $("operationsForm").noValidate = false;
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

  // Cada formulário prepara um caso de uso e entrega a persistência ao repositório.
  // Formulários de obra, pedido e projeto de engenharia.
  function openNew() {
    if (["pieces", "molds", "positions"].includes(state.tab) && !ensureStage4()) return;
    if (state.tab === "works") return openWorkForm();
    if (state.tab === "orders") return openRegistrationWizard();
    if (state.tab === "projects") return openProjectForm();
    if (state.tab === "pieces") return openPieceForm();
    if (state.tab === "molds") return openMoldForm();
  }

  function nextOrderPreview() {
    const highest = (state.data?.orders || []).reduce((max, order) => {
      const match = String(order.order_number || "").match(/^PED-(\d+)$/i);
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0);
    return `PED-${String(highest + 1).padStart(4, "0")}`;
  }

  function registrationWizardBody() {
    return `<section class="ops-registration-step" data-registration-step="1">
      <div class="ops-registration-progress"><strong>Etapa 1 · Dados recebidos</strong><span>Salve o pedido primeiro; os itens podem ser incluídos em seguida.</span></div>
      <div class="ops-form-grid">
        ${selectField("registrationWorkMode", "Vínculo do pedido", "com_obra", [["com_obra", "Vincular a uma obra"], ["sem_obra", "Sem obra"]], { required: true })}
        <div class="ops-form-grid full" id="registrationWorkFields">
          ${inputField("registrationWorkNumber", "Número da obra", "", "text", { required: true })}
          ${inputField("registrationWorkName", "Nome da obra", "", "text", { required: true })}
          ${inputField("registrationResponsible", "Responsável", "", "text", { optional: true })}
          ${inputField("registrationAddress", "Endereço da obra", "", "text", { optional: true })}
          ${inputField("registrationClient", "Cliente", "", "text", { required: true })}
        </div>
        <div class="ops-form-grid full" id="registrationManualOrderFields" hidden>
          ${inputField("registrationManualClient", "Cliente", "", "text", { required: true })}
        </div>
        ${inputField("registrationStartDate", "Data de início", today(), "date", { required: true })}
        <div class="field"><label for="registrationDueDate">Prazo previsto <span id="registrationDueMode">automático · início + 90 dias corridos</span></label><input class="input" id="registrationDueDate" name="registrationDueDate" type="date" required /><button class="btn ops-restore-due" id="registrationRestoreDue" type="button" hidden>Restaurar +90 dias</button></div>
        ${textareaField("registrationOrderObservations", "Observações do pedido")}
        <div class="field"><label>Número do pedido</label><input class="input" id="registrationOrderPreview" value="${escapeHtml(nextOrderPreview())}" readonly /><span class="form-help">O banco gera a sequência definitiva no salvamento.</span></div>
        <div class="ops-form-hint full" id="registrationWorkMatch" aria-live="polite">Se o número da obra já existir, seus dados serão atualizados nesta gravação.</div>
      </div>
    </section>
    <section class="ops-registration-step" data-registration-step="2" hidden>
      <div class="ops-registration-progress"><strong id="registrationSavedOrderLabel">Pedido salvo</strong><span>Inclua um item por vez. Cada item fica gravado imediatamente.</span></div>
      <div class="ops-registration-items" id="registrationSavedItemsList" aria-live="polite"><p>Nenhum item incluído ainda.</p></div>
      <div class="ops-form-grid">
        ${inputField("registrationPieceCode", "Código da peça", "", "text", { required: true })}
        ${inputField("registrationPieceName", "Nome da peça", "", "text", { required: true })}
        ${selectField("registrationPieceKind", "Tipo de peça", "", [["braco", "Braço"], ["pilar", "Pilar"], ["viga", "Viga"], ...(state.supportsFabio2 ? [["placa", "Placa"]] : [])], { required: true, placeholder: "Selecione o tipo" })}
        ${inputField("registrationQuantity", "Quantidade do pedido", "1", "number", { min: 1, step: 1, required: true })}
        ${inputField("registrationDimensionX", "Dimensão X (cm)", "", "number", { min: 0.001, step: "0.001", required: true })}
        ${inputField("registrationDimensionY", "Comprimento Y (cm)", "", "number", { min: 0.001, step: "0.001", required: true })}
        ${inputField("registrationDimensionZ", "Dimensão Z (cm)", "", "number", { min: 0.001, step: "0.001", required: true })}
        <div class="ops-form-hint full" id="registrationPositionHint" aria-live="polite">Pilar e viga: X localiza o leito, Z a lateral e Y é o comprimento. Braço: X × Z localiza a forma fixa. Placa: X largura, Y altura, Z espessura; usa bancada plana.</div>
        <div class="ops-form-hint full">O prazo considera concretagem, cura e acabamento. Se a forma ainda não estiver pronta, inclui também a preparação antes da concretagem.</div>
        <div class="ops-computed-metrics full" aria-live="polite"><div><small>Volume</small><strong id="registrationVolumeM3">—</strong><span>m³</span></div><div><small>Peso estimado</small><strong id="registrationWeightKg">—</strong><span>kg</span></div><div><small>Volume bruto X × Y × Z</small><strong id="registrationVolumeCm3">—</strong><span>cm³</span></div></div>
        ${textareaField("registrationPieceObservations", "Observações da peça")}
        ${textareaField("registrationItemObservations", "Observações do item do pedido")}
        <div class="ops-form-actions full"><button class="btn primary" id="registrationSaveItem" type="button">Salvar item no pedido</button></div>
      </div>
    </section>`;
  }

  function openRegistrationWizard() {
    if (!ensureFabio2()) return;
    openModal("Novo pedido", "Registre os dados recebidos e depois adicione os itens do pedido.", registrationWizardBody(), "registration");
    const form = $("operationsForm");
    form.dataset.registrationStep = "1";
    form.dataset.orderId = "";
    form.dataset.orderNumber = "";
    form.dataset.registrationSavedItems = "[]";
    $("operationsModalSave").textContent = "Salvar pedido e continuar";
    updateRegistrationWorkMode();
    updateRegistrationDueDate();
  }

  function updateRegistrationDueDate(force = false) {
    const start = $("registrationStartDate")?.value;
    const due = $("registrationDueDate");
    if (!due || !start) return;
    if (force) {
      due.dataset.manual = "false";
      $("registrationRestoreDue").hidden = true;
      $("registrationDueMode").textContent = "automática · início + 90 dias corridos";
    }
    if (due.dataset.manual !== "true") due.value = addDays(start, 90);
  }

  function updateRegistrationWorkMode() {
    const linkedToWork = $("registrationWorkMode")?.value !== "sem_obra";
    const workFields = $("registrationWorkFields");
    const manualFields = $("registrationManualOrderFields");
    if (!workFields || !manualFields) return;
    workFields.hidden = !linkedToWork;
    manualFields.hidden = linkedToWork;
    for (const id of ["registrationWorkNumber", "registrationWorkName", "registrationClient"]) {
      const field = $(id);
      if (field) field.required = linkedToWork;
    }
    const manualClient = $("registrationManualClient");
    if (manualClient) manualClient.required = !linkedToWork;
    if (manualClient && linkedToWork) manualClient.value = "";
    if (linkedToWork && $("registrationWorkNumber")?.value) populateExistingWork();
    const help = $("registrationWorkMatch");
    if (help) help.textContent = linkedToWork
      ? "Uma obra com o mesmo número será atualizada; o cliente, o início e o prazo do pedido acompanharão a obra."
      : "Este pedido ficará sem obra; informe o cliente e a data de início manualmente.";
  }

  function normalizeMeasure(value) {
    const number = Number(String(value ?? "").trim().replace(",", "."));
    return Number.isFinite(number) ? number : null;
  }

  function resolveRegistrationMolds(kind, xValue, zValue) {
    const x = normalizeMeasure(xValue);
    const z = normalizeMeasure(zValue);
    if (!kind || x == null || z == null || x <= 0 || z <= 0) return null;
    if (kind === "placa") return { codes: [], label: "PLACA · BANCADA PLANA" };
    const catalog = state.data?.moldCatalog || [];
    if (kind === "pilar" || kind === "viga") {
      const bed = catalog.find((row) => row.mold_type === "LEITO" && normalizeMeasure(row.measure_label) === x);
      const side = catalog.find((row) => row.mold_type === "LATERAL" && normalizeMeasure(row.measure_label) === z);
      return bed && side ? { codes: [bed.code, side.code], label: `LEITO ${bed.measure_label} + LATERAL ${side.measure_label}` } : null;
    }
    if (kind === "braco") {
      const arm = catalog.find((row) => {
        if (row.mold_type !== "BRACO") return false;
        const match = String(row.measure_label || "").match(/^\s*(\d+(?:[.,]\d+)?)\s*x\s*(\d+(?:[.,]\d+)?)\s*$/i);
        return match && normalizeMeasure(match[1]) === x && normalizeMeasure(match[2]) === z;
      });
      return arm ? { codes: [arm.code], label: `FORMA FIXA ${arm.measure_label}` } : null;
    }
    return null;
  }

  function updateRegistrationMoldFields() {
    const kind = $("registrationPieceKind")?.value;
    const isPlate = kind === "placa";
    const labels = {
      registrationDimensionX: isPlate ? "Largura X (cm) · PLACA" : kind === "braco" ? "Dimensão X (cm) · BRAÇO" : "Dimensão X (cm) · LEITO",
      registrationDimensionY: isPlate ? "Altura Y (cm) · PLACA" : "Comprimento Y (cm)",
      registrationDimensionZ: isPlate ? "Espessura Z (cm) · PLACA" : kind === "braco" ? "Dimensão Z (cm) · BRAÇO" : "Dimensão Z (cm) · LATERAL",
    };
    for (const [id, labelText] of Object.entries(labels)) {
      const label = document.querySelector(`label[for="${id}"]`);
      if (label?.firstChild) label.firstChild.textContent = labelText;
    }
    updateRegistrationPositionHint();
  }

  function updateRegistrationPositionHint() {
    const kind = $("registrationPieceKind")?.value;
    const x = $("registrationDimensionX")?.value;
    const z = $("registrationDimensionZ")?.value;
    const mold = resolveRegistrationMolds(kind, x, z);
    const availablePositions = (state.data?.positions || []).filter((position) =>
      position.status !== "em_manutencao" && (kind === "placa"
        ? position.configuration_kind === "placa"
        : position.configuration_kind !== "placa")
    );
    const message = $("registrationPositionHint");
    if (!message) return;
    message.textContent = !kind
      ? "Escolha o tipo e informe X e Z para localizar a forma compatível automaticamente."
      : kind === "placa"
        ? availablePositions.length
          ? "Placa sem forma: X é largura, Y é altura e Z é espessura. O Planejamento usará a bancada plana cadastrada."
          : "Placa sem forma: X é largura, Y é altura e Z é espessura. Cadastre uma posição como bancada plana; o pedido poderá ser salvo e ficará aguardando posição."
      : !x || !z
        ? "Informe X e Z para localizar a forma; Y é o comprimento e também participa do volume e do peso."
        : !mold
          ? kind === "braco"
            ? "Não existe forma fixa de braço com as medidas X × Z no catálogo. Confira o catálogo antes de salvar."
            : "Não existe no catálogo a combinação LEITO X + LATERAL Z. Confira as medidas cadastradas antes de salvar."
          : availablePositions.length
            ? `${mold.label}. O planejamento associa essa forma a uma das ${availablePositions.length} posições físicas e escolhe uma livre no período.`
            : `${mold.label}. Não há posição física disponível agora; o item poderá ser salvo aguardando posição.`;
  }

  function updateRegistrationMetrics() {
    const x = Number($("registrationDimensionX")?.value);
    const y = Number($("registrationDimensionY")?.value);
    const z = Number($("registrationDimensionZ")?.value);
    const valid = [x, y, z].every((value) => Number.isFinite(value) && value > 0);
    const volumeCm3 = valid ? x * y * z : null;
    $("registrationVolumeCm3").textContent = valid ? formatNumber(volumeCm3, 3) : "—";
    $("registrationVolumeM3").textContent = valid ? formatNumber(volumeCm3 / 1_000_000, 6) : "—";
    $("registrationWeightKg").textContent = valid ? formatNumber(volumeCm3 * 2.5 / 1000, 3) : "—";
  }
  function populateExistingWork() {
    const number = $("registrationWorkNumber")?.value.trim().toLocaleUpperCase();
    const work = (state.data?.works || []).find((item) => String(item.work_number || "").trim().toLocaleUpperCase() === number);
    const message = $("registrationWorkMatch");
    if (!message) return;
    if (!work) {
      message.textContent = "Se o número da obra já existir, seus dados serão atualizados nesta gravação.";
      return;
    }
    $("registrationWorkName").value = work.name || "";
    $("registrationResponsible").value = work.responsible_name || "";
    $("registrationClient").value = work.client_name || "";
    $("registrationAddress").value = work.address || "";
    if (work.start_date) $("registrationStartDate").value = work.start_date;
    updateRegistrationDueDate(true);
    if (work.requested_due_date) {
      const due = $("registrationDueDate");
      due.value = work.requested_due_date;
      const isManual = work.requested_due_date !== addDays(work.start_date || $("registrationStartDate").value, 90);
      due.dataset.manual = String(isManual);
      $("registrationDueMode").textContent = isManual ? "prazo manual já salvo na obra" : "automática · início + 90 dias corridos";
      $("registrationRestoreDue").hidden = !isManual;
    }
    message.textContent = `A obra ${work.work_number} já existe. Os dados informados serão atualizados e os pedidos ligados a ela herdarão cliente e início.`;
  }

  function ensureStage4() {
    if (state.supportsStage4) return true;
    const message = "Os cadastros novos da Etapa 4 aguardam a migração 007 e a Edge Function operations-admin atualizada no Supabase.";
    showStatus(message, true);
    toast("Aplique a migração 007 no Supabase para continuar.");
    return false;
  }

  function ensureFabio2() {
    if (state.supportsFabio2) return true;
    const message = "O fluxo de projetos, placas e etapas com horários exatos depende da migration 009 e da Edge Function atualizada.";
    showStatus(message, true);
    toast("A Etapa 5 ainda não está instalada no Supabase.");
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
    const typeOptions = state.data.pieceTypes.map((piece) => `<option value="${escapeHtml(piece.id)}" ${item.piece_type_id === piece.id ? "selected" : ""}>${escapeHtml(piece.code)} · ${escapeHtml(piece.name)}</option>`).join("");
    const itemKey = item.item_key || item.itemKey || item.id || createOrderItemKey();
    return `<div class="ops-item-row">
      <input type="hidden" data-item-key value="${escapeHtml(itemKey)}" />
      <select class="select" data-item-piece required><option value="">Selecione a peça</option>${typeOptions}</select>
      <input class="input" data-item-quantity type="number" min="1" step="1" value="${escapeHtml(item.quantity || 1)}" required aria-label="Quantidade" />
      <input class="input ops-item-observations" data-item-observations value="${escapeHtml(item.observations || "")}" maxlength="500" placeholder="Observação do item" aria-label="Observação do item" />
      <button class="ops-item-remove" type="button" data-remove-order-item aria-label="Remover item">×</button>
    </div>`;
  }

  function createOrderItemKey() {
    return globalThis.crypto?.randomUUID?.() || `item-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function currentOrderItemsForSections() {
    return [...($("orderItems")?.querySelectorAll(".ops-item-row") || [])].map((row) => {
      const pieceTypeId = row.querySelector("[data-item-piece]")?.value;
      const piece = state.data.pieceTypes.find((item) => item.id === pieceTypeId);
      return {
        id: row.querySelector("[data-item-key]")?.value || "",
        piece_code: piece?.code || "",
        piece_name: piece?.name || "",
        quantity: Number(row.querySelector("[data-item-quantity]")?.value || 0),
      };
    });
  }

  function openOrderForm(order = null) {
    const workOptions = state.data.works.map((work) => [work.id, `${work.work_number ? `${work.work_number} · ` : ""}${work.name}`]);
    const statusOptions = [["orcamento", "Orçamento"], ["em_producao", "Em produção"], ["entregue", "Entregue"], ["atrasado", "Atrasado"], ["cancelado", "Cancelado"]];
    if (order && order.status !== "orcamento") statusOptions.splice(1, 0, ["aprovado", "Aprovado"]);
    if (order) statusOptions.splice(3, 0, ["concluido", "Concluído"]);
    const items = order?.items?.length ? order.items : [{}];
    const engineeringProject = order
      ? (state.data.engineeringProjects || []).find((project) => project.order_id === order.id)
      : null;
    const projectSections = engineeringProject?.sections || [];
    const projectEditor = engineeringProject ? `<div class="field full"><label>Distribuição por seções <span>salva junto com o pedido</span></label><p class="ops-form-hint">Ajuste as seções nesta mesma gravação sempre que alterar tipos ou quantidades dos itens.</p><div class="ops-project-sections" id="orderProjectSections">${projectSections.map((section, index) => projectSectionCard(order, section, index)).join("")}</div><div class="ops-inline-actions"><button class="btn" type="button" id="addOrderProjectSection">Adicionar seção</button></div></div>` : "";
    const body = `<div class="ops-form-grid">
      ${inputField("orderNumber", "Número do pedido", order?.order_number || "", "text", { optional: true })}
      ${selectField("orderWorkId", "Obra", order?.work_id || "", workOptions, { optional: true, placeholder: "Pedido sem obra vinculada" })}
      ${inputField("clientName", "Cliente (quando não houver obra)", order?.client_name || "", "text", { placeholder: "Cliente do pedido" })}
      <div class="ops-form-hint full" id="orderClientHelp">Ao escolher uma obra, o pedido usa automaticamente o cliente cadastrado nela.</div>
      ${inputField("startDate", "Data de início", order?.start_date || today(), "date", { required: true, readonly: Boolean(order?.work_id) })}
      ${inputField("requestedDueDate", "Prazo solicitado", order?.requested_due_date || "", "date", { optional: true })}
      ${selectField("status", "Status", order?.status || "orcamento", statusOptions, { required: true, placeholder: "Selecione o status" })}
      <div class="ops-form-hint full">Concluído é aplicado quando todas as unidades produzidas estiverem Prontas.</div>
      <div class="field full"><label>Itens do pedido <span>o prazo resulta das etapas e da preparação da forma quando necessária</span></label><div class="ops-items" id="orderItems">${items.map(orderItemRow).join("")}</div><div class="ops-inline-actions"><button class="btn" type="button" id="addOrderItem">Adicionar item</button></div></div>
      ${projectEditor}
      ${textareaField("observations", "Observações", order?.observations || "")}
    </div>`;
    openModal(order ? "Editar pedido" : "Novo pedido", "O pedido será ligado à obra escolhida e poderá ser planejado no calendário.", body, "order", order);
    syncOrderClientHelp();
  }

  function addOrderItemRow() {
    $("orderItems").insertAdjacentHTML("beforeend", orderItemRow());
  }

  function projectItemRow(order, selected = {}) {
    const choices = (order?.items || []).map((item) =>
      `<option value="${escapeHtml(item.id)}" ${selected.order_item_id === item.id ? "selected" : ""}>${escapeHtml(item.piece_code || item.piece_name || "Peça")} · ${Number(item.quantity)} solicitadas</option>`
    ).join("");
    return `<div class="ops-project-item-row">
      <select class="select" data-project-item required><option value="">Selecione um item do pedido</option>${choices}</select>
      <input class="input" data-project-quantity type="number" min="1" step="1" value="${escapeHtml(selected.quantity || 1)}" required aria-label="Quantidade desta seção" />
      <button class="ops-item-remove" type="button" data-remove-project-item aria-label="Remover item da seção">×</button>
    </div>`;
  }

  function projectSectionCard(order, section = {}, index = 0) {
    const sectionName = section.section_name || section.sectionName || `Seção ${index + 1}`;
    const items = section.items?.length ? section.items : [{}];
    return `<section class="ops-project-section">
      <div class="ops-project-section-head"><label>Nome da seção<input class="input" data-project-section-name maxlength="120" required value="${escapeHtml(sectionName)}" /></label><button class="icon-btn" type="button" data-remove-project-section>Remover seção</button></div>
      <div class="ops-project-items">${items.map((item) => projectItemRow(order, item)).join("")}</div>
      <button class="btn" type="button" data-add-project-item>Adicionar item à seção</button>
    </section>`;
  }

  function readProjectSections() {
    return [...document.querySelectorAll(".ops-project-section")].map((section) => ({
      sectionName: section.querySelector("[data-project-section-name]").value.trim(),
      items: [...section.querySelectorAll(".ops-project-item-row")].map((row) => ({
        orderItemId: row.querySelector("[data-project-item]").value,
        quantity: Number(row.querySelector("[data-project-quantity]").value),
      })),
    }));
  }

  function addProjectSection(section = null) {
    const container = $("projectSections") || $("orderProjectSections");
    const order = state.data.orders.find((item) => item.id === $("projectOrderId")?.value) || { items: currentOrderItemsForSections() };
    const index = container.querySelectorAll(".ops-project-section").length;
    container.insertAdjacentHTML("beforeend", projectSectionCard(order, section || {}, index));
  }

  function addProjectItem(section) {
    if (!section) return;
    const order = state.data.orders.find((item) => item.id === $("projectOrderId")?.value) || { items: currentOrderItemsForSections() };
    section.querySelector(".ops-project-items").insertAdjacentHTML("beforeend", projectItemRow(order));
  }

  function refreshOrderProjectSections() {
    const container = $("orderProjectSections");
    if (!container) return;
    const previous = readProjectSections();
    const order = { items: currentOrderItemsForSections() };
    container.innerHTML = previous.map((section, index) => projectSectionCard(order, {
      section_name: section.sectionName,
      items: section.items.map((item) => ({ order_item_id: item.orderItemId, quantity: item.quantity })),
    }, index)).join("");
  }

  function refreshProjectSectionsForOrder() {
    const container = $("projectSections");
    if (!container) return;
    const previous = readProjectSections();
    const order = state.data.orders.find((item) => item.id === $("projectOrderId")?.value);
    container.innerHTML = previous.map((section, index) => projectSectionCard(order, {
      section_name: section.sectionName,
      items: section.items.map((item) => ({ ...item, order_item_id: "" })),
    }, index)).join("");
  }

  function openProjectForm(project = null) {
    if (!ensureFabio2()) return;
    const existingProjects = new Set((state.data.engineeringProjects || []).map((item) => item.order_id));
    const orders = state.data.orders.filter((order) =>
      !["concluido", "entregue", "cancelado"].includes(order.status) && (project?.order_id === order.id || !existingProjects.has(order.id))
    );
    const orderOptions = orders.map((order) => [order.id, `${order.order_number || "Pedido sem número"} · ${order.client_name || "Cliente"}`]);
    const projectSections = project?.sections?.length ? project.sections : [{ section_name: "Seção 1", items: [{}] }];
    const body = `<div class="ops-form-grid">
      ${selectField("projectOrderId", "Pedido", project?.order_id || "", orderOptions, { required: true, placeholder: "Selecione um pedido ativo" })}
      <p class="ops-form-hint full">O projeto pertence a um pedido. Distribua toda a quantidade de cada item entre as seções; a soma precisa ser igual à quantidade pedida.</p>
      <div class="ops-project-sections full" id="projectSections">${projectSections.map((section, index) => projectSectionCard(state.data.orders.find((order) => order.id === (project?.order_id || orderOptions[0]?.[0])), section, index)).join("")}</div>
      <div class="ops-inline-actions full"><button class="btn" type="button" id="addProjectSection">Adicionar seção</button></div>
    </div>`;
    openModal(project ? "Editar projeto de engenharia" : "Novo projeto de engenharia", "Organize a fabricação do pedido em seções e quantidades.", body, "project", project);
    if (project) {
      $("projectOrderId").disabled = true;
      const hiddenOrderId = document.createElement("input");
      hiddenOrderId.type = "hidden";
      hiddenOrderId.name = "projectOrderId";
      hiddenOrderId.value = project.order_id;
      $("operationsForm").append(hiddenOrderId);
    }
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

  // Formulários de catálogo: tipo de peça, molde e configuração de posição.
  function openPieceForm(piece = null) {
    if (!ensureStage4()) return;
    if (piece?.piece_kind === "placa" && !ensureFabio2()) return;
    const molds = piece?.mold_catalogs || {};
    const typeOptions = [["braco", "Braço"], ["pilar", "Pilar"], ["viga", "Viga"], ...(state.supportsFabio2 ? [["placa", "Placa"]] : [])];
    const isPlate = piece?.piece_kind === "placa";
    const armOptions = catalogChoices("BRACO");
    const combinations = moldCombinationsFor(piece?.piece_kind || "pilar");
    const selectedPair = molds.leito && molds.lateral ? `${molds.leito}|${molds.lateral}` : "";
    const dimensionXLabel = isPlate ? "Largura (cm)" : "Dimensão X (cm)";
    const dimensionYLabel = isPlate ? "Altura (cm)" : "Comprimento Y (cm)";
    const dimensionZLabel = isPlate ? "Espessura (cm)" : "Dimensão Z (cm)";
    const body = `<div class="ops-form-grid">
      ${inputField("code", "Código da peça", piece?.code || "", "text", { required: true })}
      ${inputField("name", "Nome da peça", piece?.name || "", "text", { required: true })}
      ${selectField("pieceKind", "Tipo de peça", piece?.piece_kind || "", typeOptions, { required: true, placeholder: "Selecione braço, pilar, viga ou placa" })}
      ${inputField("dimensionXcm", dimensionXLabel, piece?.dimension_x_cm ?? "", "number", { min: 0.001, step: "0.001", required: true })}
      ${inputField("dimensionYcm", dimensionYLabel, piece?.dimension_y_cm ?? "", "number", { min: 0.001, step: "0.001", required: true })}
      ${inputField("dimensionZcm", dimensionZLabel, piece?.dimension_z_cm ?? "", "number", { min: 0.001, step: "0.001", required: true })}
      <div class="ops-computed-metrics full" aria-live="polite">
        <div><small>Volume</small><strong id="pieceVolumeCm3">—</strong><span>cm³</span></div>
        <div><small>Volume</small><strong id="pieceVolumeM3">—</strong><span>m³</span></div>
        <div><small>Peso estimado</small><strong id="pieceWeightKg">—</strong><span>kg</span></div>
      </div>
      <div class="ops-form-hint full">O planejamento calcula o prazo pelas etapas de concretagem, cura e acabamento. A preparação da forma entra antes da concretagem quando for necessária.</div>
      ${selectField("pieceMoldBraco", "Forma BRAÇO", molds.braco || "", armOptions, { required: true, placeholder: "Selecione uma medida" })}
      ${selectField("pieceMoldPair", "Combinação de formas LEITO × LATERAL", selectedPair, combinations, { required: true, placeholder: "Selecione uma combinação" })}
      <input type="hidden" id="pieceMoldLeito" name="pieceMoldLeito" value="${escapeHtml(molds.leito || "")}" />
      <input type="hidden" id="pieceMoldLateral" name="pieceMoldLateral" value="${escapeHtml(molds.lateral || "")}" />
      ${textareaField("observations", "Observações", piece?.observations || "")}
    </div>`;
    openModal(piece ? "Editar peça" : "Nova peça", "Para placa, informe largura, altura e espessura em centímetros. Volume e peso seguem o cálculo automático existente.", body, "piece", piece);
    updatePieceMoldFields();
    updatePieceMetrics();
  }

  function openMoldForm(mold = null) {
    if (!ensureStage4()) return;
    const moldOptions = (state.data.moldCatalog || []).map((item) => [item.code, `${item.mold_type === "BRACO" ? "BRAÇO" : item.mold_type} ${item.measure_label} cm`]);
    const body = `<div class="ops-form-grid">
      ${selectField("catalogCode", "Forma do catálogo fixo", mold?.catalog_code || "", moldOptions, { required: true, placeholder: "Selecione tipo e medida" })}
      ${inputField("cycleMinutesPerUnit", "Ciclo (min/un.)", mold?.cycle_minutes_per_unit ?? "", "number", { min: 1, step: 1, optional: true })}
      ${selectField("status", "Status", mold?.status || "ativo", [["ativo", "Ativo"], ["manutencao", "Manutenção"], ["bloqueado", "Bloqueado"], ["retirado", "Retirado"]])}
      <div class="ops-form-hint">A preparação dura ${state.supportsFabio2 ? "cinco dias úteis" : "sete dias corridos"} e precisa ser aprovada antes da produção.</div>
      ${textareaField("observations", "Observações", mold?.observations || "")}
    </div>`;
    openModal(mold ? "Editar forma" : "Nova forma", "Tipo e medida vêm do catálogo fixo; o identificador é gerado pelo sistema.", body, "mold", mold);
  }

  function openPositionForm(position) {
    if (!ensureStage4()) return;
    const body = `<div class="ops-form-grid">
      <input type="hidden" id="positionCode" name="positionCode" value="${escapeHtml(position.code)}" />
      <div class="field"><label>Posição física</label><input class="input" value="${escapeHtml(position.code)}" disabled /></div>
      ${selectField("status", "Status", position.status || "disponivel", [["disponivel", "Disponível"], ["em_preparacao", "Em preparação"], ["em_producao", "Em produção"], ["em_manutencao", "Em manutenção"]])}
      ${selectField("positionUseKind", "Uso da posição", position.configuration_kind === "placa" ? "placa" : "formas", [["formas", "Formas definidas pelo pedido"], ["placa", "Bancada plana para placas"]], { required: true })}
      ${textareaField("positionNotes", "Observações", position.notes || "")}
      <div class="ops-form-hint full">Braço, pilar e viga recebem as formas exigidas pelo item do pedido. Uma bancada plana é reservada para produzir placas sem forma.</div>
    </div>`;
    openModal(`Editar posição ${position.code}`, "Cadastre a disponibilidade e as observações da posição física.", body, "position", position);
  }

  // Regras de moldes: catálogo fixo, combinações e campos de posição compatíveis.
  function catalogChoices(moldType) {
    return (state.data?.moldCatalog || []).filter((item) => item.mold_type === moldType)
      .map((item) => [item.code, `${moldType === "BRACO" ? "BRAÇO" : moldType} ${item.measure_label} cm`]);
  }

  function moldCombinationsFor(pieceKind) {
    // Strategy do domínio seleciona braço fixo ou combinação variável adequada.
    return listPieceMoldOptions(pieceKind, {
      catalog: state.data?.moldCatalog,
      combinations: state.data?.moldCombinations,
    });
  }

  function syncPieceMoldPair() {
    const [bedCode = "", sideCode = ""] = String($("pieceMoldPair")?.value || "").split("|");
    if ($("pieceMoldLeito")) $("pieceMoldLeito").value = bedCode;
    if ($("pieceMoldLateral")) $("pieceMoldLateral").value = sideCode;
  }

  function updatePieceMoldFields() {
    const kind = $("pieceKind")?.value;
    const dimensionLabels = {
      dimensionXcm: kind === "placa" ? "Largura (cm)" : kind === "braco" ? "Dimensão X (cm) · BRAÇO" : "Dimensão X (cm) · LEITO",
      dimensionYcm: kind === "placa" ? "Altura (cm)" : "Comprimento Y (cm)",
      dimensionZcm: kind === "placa" ? "Espessura (cm)" : kind === "braco" ? "Dimensão Z (cm) · BRAÇO" : "Dimensão Z (cm) · LATERAL",
    };
    for (const [id, labelText] of Object.entries(dimensionLabels)) {
      const label = document.querySelector(`label[for="${id}"]`);
      if (label?.firstChild) label.firstChild.textContent = labelText;
    }
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
    const selectedOption = pair.value;
    const options = moldCombinationsFor(kind);
    pair.innerHTML = `<option value="">Selecione uma combinação</option>${options.map(([value, label]) =>
      `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`).join("")}`;
    pair.value = options.some(([value]) => value === selectedOption) ? selectedOption : "";
    const isArm = kind === "braco";
    const isPlate = kind === "placa";
    armField.hidden = !isArm || isPlate;
    pairField.hidden = isArm || isPlate;
    arm.required = isArm;
    pair.required = !isArm && !isPlate;
    if (isArm || isPlate) pair.value = "";
    if (!isArm || isPlate) arm.value = "";
    syncPieceMoldPair();
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

  // Preparação e alocação de recursos ligados a moldes e pedidos.
  // Preparação e alocação de recursos do chão de fábrica.
  function openPreparationForm(mold, preparation = null) {
    const moldOptions = state.data.molds.filter((item) => item.status !== "retirado").map((item) => [item.id, `${item.code} · ${item.name}`]);
    const checklist = preparation?.checklist || {};
    const startDate = preparation?.start_date || today();
    const statuses = [["planejada", "Planejada"], ["em_andamento", "Em andamento"], ["aguardando_aprovacao", "Aguardando aprovação"], ["aprovada", "Aprovada"], ["reprovada", "Reprovada"], ["cancelada", "Cancelada"]];
    const body = `<div class="ops-form-grid">
      ${selectField("preparationMoldId", "Forma", preparation?.mold_id || mold?.id || "", moldOptions, { required: true })}
      ${inputField("preparationStartDate", "Início da preparação", startDate, "date", { required: true })}
      ${inputField("preparationEndDate", "Conclusão prevista", "", "date", { disabled: true })}
      <div class="ops-form-hint full" id="preparationEndHelp">A conclusão será calculada pelo calendário de dias úteis.</div>
      ${selectField("status", "Status", preparation?.status || "planejada", statuses)}
      <div class="field full"><label>Checklist obrigatório</label><div class="ops-checklist">
        <label><input type="checkbox" name="limpeza" ${checklist.limpeza ? "checked" : ""}> Limpeza</label>
        <label><input type="checkbox" name="desmoldante" ${checklist.desmoldante ? "checked" : ""}> Desmoldante</label>
        <label><input type="checkbox" name="montagem" ${checklist.montagem ? "checked" : ""}> Montagem</label>
      </div></div>
      ${inputField("approvedBy", "Aprovado por", preparation?.approved_by || "", "text", { optional: true })}
      ${textareaField("observations", "Observações", preparation?.observations || "")}
    </div>`;
    openModal(preparation ? "Editar preparação" : "Preparar forma", "A duração configurada da forma determina o cálculo da conclusão.", body, "preparation", preparation);
    updatePreparationEnd();
  }

  async function updatePreparationEnd() {
    const start = $("preparationStartDate");
    const end = $("preparationEndDate");
    const moldId = $("preparationMoldId")?.value;
    const help = $("preparationEndHelp");
    if (!start || !end) return;
    end.value = "";
    if (!start.value || !moldId) return;
    const requestedStart = start.value;
    if (help) help.textContent = "Calculando a data com o calendário da fábrica…";
    try {
      const result = await operationsRepository.calculateMoldPreparationEnd({ moldId, startDate: requestedStart });
      if (start.value !== requestedStart || $("preparationMoldId")?.value !== moldId) return;
      end.value = result.endDate || "";
      if (help) help.textContent = state.supportsFabio2
        ? "A conclusão considera cinco dias úteis e as exceções do calendário."
        : "A conclusão considera sete dias corridos no fluxo atual.";
    } catch (error) {
      if (help) help.textContent = error.message || "Não foi possível calcular a conclusão. Atualize o calendário e tente novamente.";
    }
  }

  function openAllocationForm(mold = null, allocation = null) {
    const moldOptions = state.data.molds.filter((item) => item.status === "ativo").map((item) => [item.id, `${item.code} · ${item.name}`]);
    const orderItemOptions = [];
    for (const order of state.data.orders.filter((item) => !["concluido", "entregue", "cancelado"].includes(item.status))) {
      for (const item of order.items) orderItemOptions.push([item.id, `${order.order_number || "Pedido"} · ${item.piece_code || item.piece_name} × ${item.quantity}`]);
    }
    const resourceKind = allocation?.resource_kind || (mold ? "mold" : "mold");
    const body = `<div class="ops-form-grid">
      ${selectField("allocationResourceKind", "Tipo de recurso", resourceKind, [["mold", "Forma"], ["other", "Outro recurso"]])}
      ${selectField("allocationMoldId", "Forma", allocation?.mold_id || mold?.id || "", moldOptions, { required: true, placeholder: "Selecione" })}
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
    openModal(allocation ? "Editar alocação" : "Alocar produção", "Associe uma forma e um item do pedido às datas de produção.", body, "allocation", allocation);
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

  // Eventos da tabela e do modal: encaminham cada ação para seu método de domínio.
  // Ações de linha: editar, preparar, alocar ou arquivar o registro escolhido.
  async function handleTableClick(event) {
    const button = event.target.closest("[data-ops-action]");
    if (!button) return;
    const { opsAction: action, id } = button.dataset;
    const data = state.data;
    if (action === "new-preparation") return openPreparationForm(null);
    if (action === "new-allocation") return openAllocationForm();
    if (action === "edit") {
      if (state.tab === "works") return openWorkForm(data.works.find((item) => item.id === id));
      if (state.tab === "orders" || state.tab === "engineering") return openOrderForm(data.orders.find((item) => item.id === id));
      if (state.tab === "pieces") {
        if (!ensureStage4()) return;
        return openPieceForm(data.pieceTypes.find((item) => item.id === id));
      }
      if (state.tab === "positions") return openPositionForm(data.positions.find((item) => item.id === id));
      if (state.tab === "molds" && !ensureStage4()) return;
      return openMoldForm(data.molds.find((item) => item.id === id));
    }
    if (action === "edit-project") {
      if (!ensureFabio2()) return;
      return openProjectForm(data.engineeringProjects.find((item) => item.id === id));
    }
    if (action === "edit-position") return openPositionForm(data.positions.find((item) => item.id === id));
    if (action === "open-order-labels") {
      state.tab = "labels";
      state.labelOrderId = id;
      state.cadastroOpen = false;
      renderTabs();
      window.dispatchEvent(new CustomEvent("prelux:labels:open", { detail: { orderId: id, data: state.data } }));
      return;
    }
    if (action === "complete-production-step") {
      if (!confirm("Confirmar a conclusão desta etapa de produção?")) return;
      try {
        const response = await operationsRepository.completeProductionStep({ stepId: id });
        toast(response?.production?.orderStatus === "concluido" ? "Pedido concluído. Etiquetas geradas." : response?.production?.unitStatus === "pronta" ? "Peça pronta." : "Etapa concluída.");
        await refreshData(true);
        window.dispatchEvent(new CustomEvent("prelux:operations:changed", { detail: { kind: "production", id } }));
        if (response?.production?.orderStatus === "concluido") {
          state.tab = "labels";
          state.labelOrderId = response.production.orderId;
          state.cadastroOpen = false;
          renderTabs();
          window.dispatchEvent(new CustomEvent("prelux:labels:open", { detail: { orderId: response.production.orderId, data: state.data } }));
        }
      } catch (error) { showStatus(error.message || "Não foi possível concluir a etapa.", true); }
      return;
    }
    if (action === "reset-position-form") {
      const position = data.positions.find((item) => item.id === id);
      if (!position || !confirm(`Desmontar a forma montada em ${position.code}?`)) return;
      try {
        const response = await operationsRepository.resetPositionForm({ code: position.code });
        toast(response?.planning?.warning || `Forma de ${position.code} desmontada.`);
        await refreshData(true);
      } catch (error) { showStatus(error.message || "Não foi possível desmontar a forma.", true); }
      return;
    }
    if (action === "prepare") return openPreparationForm(data.molds.find((item) => item.id === id));
    if (action === "allocate") return openAllocationForm(data.molds.find((item) => item.id === id));
    if (action === "edit-preparation") return openPreparationForm(null, data.preparations.find((item) => item.id === id));
    if (action === "edit-allocation") return openAllocationForm(null, data.allocations.find((item) => item.id === id));
    if (action === "cancel-allocation") {
      const allocation = data.allocations.find((item) => item.id === id);
      if (!allocation || !confirm("Cancelar esta alocação de recurso?")) return;
      try {
        await operationsRepository.saveResourceAllocation({
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
        await operationsRepository.archiveOperationRecord(kind, id);
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
    element.classList.remove("success");
  }

  function showModalSuccess(message) {
    const element = $("operationsModalStatus");
    element.textContent = message;
    element.classList.add("show", "success");
    element.classList.remove("error");
  }

  function registrationClientName(form) {
    return formValue(form, formValue(form, "registrationWorkMode") === "sem_obra" ? "registrationManualClient" : "registrationClient");
  }

  function renderRegistrationItems() {
    const rows = JSON.parse($("operationsForm").dataset.registrationSavedItems || "[]");
    const target = $("registrationSavedItemsList");
    if (!target) return;
    target.innerHTML = rows.length
      ? rows.map((item, index) => `<article class="ops-registration-item"><div><strong>${index + 1}. ${escapeHtml(item.code)} · ${escapeHtml(item.name)}</strong><span>${escapeHtml(item.kindLabel)} · ${item.quantity} un. · ${escapeHtml(item.dimensions)}</span></div><span>${escapeHtml(item.planningLabel)}</span></article>`).join("")
      : "<p>Nenhum item incluído ainda.</p>";
  }

  async function saveRegistrationItem() {
    const form = $("operationsForm");
    const button = $("registrationSaveItem");
    if (!form.dataset.orderId || !button || button.disabled) return;
    const requiredValues = ["registrationPieceCode", "registrationPieceName", "registrationPieceKind"];
    const missing = requiredValues.some((id) => !String($(id)?.value || "").trim());
    const requiredNumbers = ["registrationQuantity", "registrationDimensionX", "registrationDimensionY", "registrationDimensionZ"];
    const invalid = requiredNumbers.map((id) => $(id)).find((field) => !field?.checkValidity() || !Number.isFinite(Number(field.value)) || Number(field.value) <= 0);
    if (missing) {
      showModalError("Preencha o código, o nome e o tipo da peça.");
      return;
    }
    if (invalid) { invalid.reportValidity(); return; }
    if (!Number.isInteger(Number($("registrationQuantity").value))) {
      showModalError("A quantidade precisa ser um número inteiro maior que zero.");
      $("registrationQuantity").focus();
      return;
    }
    const kind = $("registrationPieceKind").value;
    const x = Number($("registrationDimensionX").value);
    const y = Number($("registrationDimensionY").value);
    const z = Number($("registrationDimensionZ").value);
    const molds = resolveRegistrationMolds(kind, x, z);
    if (!molds) {
      showModalError("Não encontrei uma forma compatível no catálogo para X e Z. Ajuste as medidas ou atualize o catálogo.");
      $("registrationDimensionX").focus();
      return;
    }
    const savedItems = JSON.parse(form.dataset.registrationSavedItems || "[]");
    button.disabled = true;
    button.textContent = "Salvando item…";
    try {
      const response = await operationsRepository.addOrderPieceItem({
        orderId: form.dataset.orderId,
        pieceCode: formValue(form, "registrationPieceCode"),
        pieceName: formValue(form, "registrationPieceName"),
        pieceKind: kind,
        quantity: Number(formValue(form, "registrationQuantity")),
        dimensionXcm: x,
        dimensionYcm: y,
        dimensionZcm: z,
        pieceObservations: formValue(form, "registrationPieceObservations"),
        itemObservations: formValue(form, "registrationItemObservations"),
        moldCatalogCodes: molds.codes,
        sequence: savedItems.length + 1,
      });
      const positions = response?.planning?.positionCodes || response?.registration?.positionCodes || [];
      const typeLabels = { braco: "Braço", pilar: "Pilar", viga: "Viga", placa: "Placa" };
      savedItems.push({
        code: formValue(form, "registrationPieceCode").toLocaleUpperCase(),
        name: formValue(form, "registrationPieceName"),
        kindLabel: typeLabels[kind],
        quantity: Number(formValue(form, "registrationQuantity")),
        dimensions: `${formatNumber(x, 3)} × ${formatNumber(y, 3)} × ${formatNumber(z, 3)} cm`,
        planningLabel: response?.planning?.simulatedOnly
          ? "Orçamento · sem reserva; simule no Planejamento"
          : response?.planning?.waitingForPosition
          ? "Aguardando posição livre"
          : positions.length ? `Posição: ${positions.join(", ")}` : "Planejamento atualizado",
      });
      form.dataset.registrationSavedItems = JSON.stringify(savedItems);
      renderRegistrationItems();
      showModalSuccess(`Item ${formValue(form, "registrationPieceCode").toLocaleUpperCase()} salvo no pedido.`);
      for (const id of ["registrationPieceCode", "registrationPieceName", "registrationDimensionX", "registrationDimensionY", "registrationDimensionZ", "registrationPieceObservations", "registrationItemObservations"]) {
        const field = $(id);
        if (field) field.value = "";
      }
      $("registrationQuantity").value = "1";
      updateRegistrationMetrics();
      updateRegistrationPositionHint();
      $("registrationPieceCode").focus();
      await refreshData(true);
    } catch (error) {
      showModalError(error.message || "Não foi possível salvar o item.");
      $("operationsModalStatus").classList.add("error");
    } finally {
      button.disabled = false;
      button.textContent = "Salvar item no pedido";
    }
  }

  // A gravação escolhe a ação adequada e atualiza os dados após sucesso.
  async function submitForm(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const kind = form.dataset.kind;
    if (kind !== "registration" && !form.reportValidity()) return;
    const id = form.dataset.recordId || "";
    const save = $("operationsModalSave");
    let savedNotice = "Cadastro salvo.";
    save.disabled = true;
    save.textContent = "Salvando…";
    try {
      if (kind === "registration") {
        const step = form.dataset.registrationStep || "1";
        const activeStep = $("operationsModalBody").querySelector(`[data-registration-step="${step}"]`);
        if (step === "1") {
          const invalid = [...(activeStep?.querySelectorAll("input,select,textarea") || [])].find((field) => !field.disabled && !field.checkValidity());
          if (invalid) {
            invalid.reportValidity();
            save.disabled = false;
            save.textContent = "Salvar pedido e continuar";
            return;
          }
          const workMode = formValue(form, "registrationWorkMode");
          const startDate = formValue(form, "registrationStartDate");
          const dueDate = formValue(form, "registrationDueDate");
          const linkedToWork = workMode !== "sem_obra";
          const response = await operationsRepository.createOrderHeader({
            clientName: registrationClientName(form),
            startDate,
            requestedDueDate: dueDate,
            requestedDueDateManual: $("registrationDueDate").dataset.manual === "true",
            orderObservations: formValue(form, "registrationOrderObservations"),
            work: linkedToWork ? {
              workNumber: formValue(form, "registrationWorkNumber"),
              name: formValue(form, "registrationWorkName"),
              responsibleName: formValue(form, "registrationResponsible"),
              address: formValue(form, "registrationAddress"),
              clientName: registrationClientName(form),
              startDate,
              requestedDueDate: dueDate,
              requestedDueDateManual: $("registrationDueDate").dataset.manual === "true",
            } : null,
          });
          const header = response?.order || response?.registration || response;
          form.dataset.orderId = String(header?.orderId || header?.id || "");
          form.dataset.orderNumber = String(header?.orderNumber || header?.order_number || "");
          if (!form.dataset.orderId) throw new Error("O pedido foi recebido, mas o banco não retornou o identificador para incluir itens.");
          $("registrationSavedOrderLabel").textContent = `Pedido ${form.dataset.orderNumber} salvo`;
          form.dataset.registrationStep = "2";
          $("operationsModalBody").querySelector('[data-registration-step="1"]').hidden = true;
          $("operationsModalBody").querySelector('[data-registration-step="2"]').hidden = false;
          $("operationsModalTitle").textContent = `Pedido ${form.dataset.orderNumber} · Itens`;
          for (const field of $("operationsModalBody").querySelector('[data-registration-step="2"]').querySelectorAll("input,select,textarea")) field.required = false;
          save.disabled = false;
          save.textContent = "Concluir por agora";
          updateRegistrationMoldFields();
          updateRegistrationMetrics();
          $("registrationPieceCode").focus();
          return;
        }
        const count = JSON.parse(form.dataset.registrationSavedItems || "[]").length;
        savedNotice = count
          ? `Pedido ${form.dataset.orderNumber} salvo com ${count} ${count === 1 ? "item" : "itens"}.`
          : `Pedido ${form.dataset.orderNumber} salvo sem itens. Você pode adicioná-los depois.`;
      } else if (kind === "work") {
        const response = await operationsRepository.saveWork({
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
          itemKey: row.querySelector("[data-item-key]").value,
          pieceTypeId: row.querySelector("[data-item-piece]").value,
          quantity: Number(row.querySelector("[data-item-quantity]").value),
          observations: row.querySelector("[data-item-observations]").value.trim(),
        }));
        if (items.some((item) => !item.pieceTypeId || !Number.isInteger(item.quantity) || item.quantity < 1)) throw new Error("Confira o tipo e a quantidade de cada item do pedido.");
        if (new Set(items.map((item) => item.itemKey)).size !== items.length) throw new Error("Cada item do pedido precisa ter uma identificação única.");
        const engineeringProject = (state.data.engineeringProjects || []).find((project) => project.order_id === id);
        let projectSections;
        if (engineeringProject) {
          projectSections = readProjectSections().map((section, index) => ({
            sectionName: section.sectionName,
            sortOrder: index + 1,
            items: section.items.map((item) => ({ itemKey: item.orderItemId, quantity: item.quantity })),
          }));
          if (!projectSections.length || projectSections.some((section) => !section.sectionName || !section.items.length || section.items.some((item) => !item.itemKey || !Number.isInteger(item.quantity) || item.quantity < 1))) {
            throw new Error("Cada seção do projeto precisa ter um nome e ao menos um item com quantidade válida.");
          }
          const sectionNames = projectSections.map((section) => section.sectionName.toLocaleLowerCase());
          if (new Set(sectionNames).size !== sectionNames.length) throw new Error("Use um nome diferente para cada seção.");
          for (const section of projectSections) {
            const itemKeys = section.items.map((item) => item.itemKey);
            if (new Set(itemKeys).size !== itemKeys.length) throw new Error("Cada item deve aparecer uma única vez em cada seção.");
          }
          const assignedByItem = new Map();
          for (const section of projectSections) {
            for (const item of section.items) assignedByItem.set(item.itemKey, (assignedByItem.get(item.itemKey) || 0) + item.quantity);
          }
          const incompleteItems = items.filter((item) => (assignedByItem.get(item.itemKey) || 0) !== item.quantity);
          if (incompleteItems.length) {
            const names = incompleteItems.slice(0, 3).map((item) => {
              const piece = state.data.pieceTypes.find((candidate) => candidate.id === item.pieceTypeId);
              return `${piece?.code || piece?.name || "Item"}: ${item.quantity}`;
            }).join(", ");
            throw new Error(`A distribuição das seções precisa fechar exatamente a quantidade do pedido. Confira: ${names}.`);
          }
        }
        const response = await operationsRepository.saveOrder({
          id,
          orderNumber: formValue(form, "orderNumber"),
          workId,
          clientName,
          startDate,
          requestedDueDate: formValue(form, "requestedDueDate"),
          status: formValue(form, "status"),
          observations: formValue(form, "observations"),
          items,
          projectSections,
        });
        const savedOrderLabel = engineeringProject ? "Pedido e projeto" : "Pedido";
        if (response?.planning?.simulatedOnly) {
          savedNotice = `${savedOrderLabel} salvo. Orçamento sem reserva; simule no Planejamento.`;
        } else if (response?.planning?.warning) {
          savedNotice = `${savedOrderLabel} ${engineeringProject ? "salvos" : "salvo"}. ${response.planning.warning}`;
        } else if (response?.planning?.removedFromPlan) {
          savedNotice = `${savedOrderLabel} ${engineeringProject ? "atualizados" : "atualizado"} e fila de produção recalculada.`;
        } else if (response?.planning?.committed) {
          savedNotice = `${savedOrderLabel} ${engineeringProject ? "salvos" : "salvo"} e ${engineeringProject ? "incluídos" : "incluído"} automaticamente no planejamento.`;
        }
      } else if (kind === "project") {
        if (!ensureFabio2()) throw new Error("O projeto de engenharia aguarda a Etapa 5.");
        const sections = readProjectSections().map((section, index) => ({
          ...section,
          sortOrder: index + 1,
        }));
        if (!sections.length || sections.some((section) => !section.sectionName || !section.items.length || section.items.some((item) => !item.orderItemId || !Number.isInteger(item.quantity) || item.quantity < 1))) {
          throw new Error("Cada seção precisa de um nome e ao menos um item com quantidade válida.");
        }
        const normalizedNames = sections.map((section) => section.sectionName.toLocaleLowerCase());
        if (new Set(normalizedNames).size !== normalizedNames.length) throw new Error("Use um nome diferente para cada seção.");
        const projectOrder = state.data.orders.find((order) => order.id === formValue(form, "projectOrderId"));
        const assignedByItem = new Map();
        for (const section of sections) {
          const sectionItemIds = section.items.map((item) => item.orderItemId);
          if (new Set(sectionItemIds).size !== sectionItemIds.length) {
            throw new Error("Cada item deve aparecer uma única vez em cada seção.");
          }
          for (const item of section.items) {
            assignedByItem.set(item.orderItemId, (assignedByItem.get(item.orderItemId) || 0) + item.quantity);
          }
        }
        const incompleteItems = (projectOrder?.items || []).filter((item) =>
          (assignedByItem.get(item.id) || 0) !== Number(item.quantity)
        );
        if (incompleteItems.length) {
          const itemNames = incompleteItems.slice(0, 3).map((item) => `${item.piece_code || item.piece_name}: ${item.quantity}`).join(", ");
          throw new Error(`A distribuição precisa fechar exatamente a quantidade pedida. Confira: ${itemNames}.`);
        }
        await operationsRepository.saveEngineeringProject({
          orderId: formValue(form, "projectOrderId"),
          sections,
        });
        savedNotice = "Projeto e divisão dos itens salvos.";
      } else if (kind === "piece") {
        const pieceKind = formValue(form, "pieceKind");
        const pieceRecord = {
          id,
          code: formValue(form, "code"),
          name: formValue(form, "name"),
          dimensionXcm: formValue(form, "dimensionXcm"),
          dimensionYcm: formValue(form, "dimensionYcm"),
          dimensionZcm: formValue(form, "dimensionZcm"),
          observations: formValue(form, "observations"),
        };
        const response = pieceKind === "placa"
          ? await operationsRepository.savePlateType(pieceRecord)
          : await operationsRepository.savePieceType({
          ...pieceRecord,
          pieceKind,
          moldCatalogs: formValue(form, "pieceKind") === "braco"
            ? { braco: formValue(form, "pieceMoldBraco") }
            : { leito: formValue(form, "pieceMoldLeito"), lateral: formValue(form, "pieceMoldLateral") },
        });
        if (response?.planning?.warning) savedNotice = `${pieceKind === "placa" ? "Placa" : "Peça"} salva. ${response.planning.warning}`;
        else if (response?.planning?.committed) savedNotice = `${pieceKind === "placa" ? "Placa" : "Peça"} salva e planejamento recalculado.`;
      } else if (kind === "mold") {
        await operationsRepository.saveMold({
          id,
          catalogCode: formValue(form, "catalogCode"),
          cycleMinutesPerUnit: formValue(form, "cycleMinutesPerUnit"),
          status: formValue(form, "status"),
          observations: formValue(form, "observations"),
        });
      } else if (kind === "position") {
        const response = await operationsRepository.saveMoldPosition({
          code: formValue(form, "positionCode"),
          status: formValue(form, "status"),
          useKind: formValue(form, "positionUseKind"),
          notes: formValue(form, "positionNotes"),
        });
        if (response?.planning?.warning) savedNotice = `Posição salva. ${response.planning.warning}`;
        else if (response?.planning?.committed) savedNotice = "Posição salva e planejamento recalculado.";
      } else if (kind === "preparation") {
        await operationsRepository.saveMoldPreparation({
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
        await operationsRepository.saveResourceAllocation({
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
      if (["work", "order", "position", "piece", "project", "registration"].includes(kind)) {
        window.dispatchEvent(new CustomEvent("prelux:operations:changed", { detail: { kind, id } }));
      }
      await refreshData(true);
    } catch (error) {
      showModalError(error.message || "Não foi possível salvar o cadastro.");
      save.disabled = false;
      save.textContent = id ? "Salvar alterações" : "Salvar cadastro";
    }
  }

  // Inicialização e atualização: busca o conjunto de dados pelo repositório.
  // Atualiza o estado local da aba a partir do backend, sem alterar o banco
  // durante a inicialização do módulo.
  async function refreshData(silent = false) {
    if (state.loading) return;
    state.loading = true;
    if (!silent) showStatus("Atualizando cadastros…");
    try {
      const response = await operationsRepository.getOperationsData();
      state.data = response;
      state.supportsStage4 = Number(response?.schemaVersion || 0) >= 4 &&
        Array.isArray(response?.moldCatalog) && Array.isArray(response?.positions);
      state.supportsFabio2 = response?.fabio2Available === true && Number(response?.schemaVersion || 0) >= 5;
      renderMetrics();
      state.query = $("operationsSearch")?.value || state.query;
      renderTable(state.query);
      if (state.tab === "labels") window.dispatchEvent(new CustomEvent("prelux:labels:open", { detail: { orderId: state.labelOrderId, data: state.data } }));
      showStatus(state.supportsStage4
        ? state.supportsFabio2
          ? "Pedidos, cadastro e projetos de engenharia conectados ao banco PRELUX."
          : "Pedidos e cadastro conectados. Projetos e peças do catálogo estão disponíveis no banco PRELUX."
        : "Obras e pedidos conectados. O cadastro de peças, formas e posições aguarda a migração 007 e a Edge Function da Etapa 4.");
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
  window.addEventListener("prelux:operations:open", () => refreshData());
  window.addEventListener("prelux:labels:select", () => {
    state.tab = "labels";
    state.labelOrderId = null;
    state.cadastroOpen = false;
    renderTabs();
    window.dispatchEvent(new CustomEvent("prelux:labels:open"));
  });
}
