/*
 * Navegação principal.
 *
 * Este módulo é o único que muda a área visível. Ao abrir Pedidos ou
 * Planejamento, avisa o módulo correspondente para carregar os dados.
 */
export function initializeNavigation() {
  const tabs = [...document.querySelectorAll('.nav [role="tab"][data-view]')];
  const panels = {
    pedidos: document.getElementById("operationsView"),
    etiquetas: document.getElementById("etiquetasView"),
    planejamento: document.getElementById("planningView"),
  };
  const pageDetails = {
    pedidos: {
      title: "Pedidos",
      description: "Pedido → Engenharia → Projeto → Produzir",
    },
    etiquetas: {
      title: "Etiquetas",
      description: "Identificação e rastreabilidade de peças pré-moldadas",
    },
    planejamento: {
      title: "Planejamento",
      description: "Acompanhe pedidos, obras, capacidade e etapas de produção",
    },
  };
  const openEvents = {
    planejamento: "prelux:planning:open",
    pedidos: "prelux:operations:open",
  };

  function activate(view, { focusTab = false } = {}) {
    if (!panels[view] || !tabs.some((tab) => tab.dataset.view === view)) return;

    tabs.forEach((tab) => {
      const selected = tab.dataset.view === view;
      tab.classList.toggle("active", selected);
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (selected && focusTab) tab.focus();
    });
    Object.entries(panels).forEach(([name, panel]) => { panel.hidden = name !== view; });

    const details = pageDetails[view];
    document.getElementById("pageTitle").textContent = details.title;
    document.getElementById("pageDescription").textContent = details.description;
    document.title = `PRELUX · ${details.title}`;
    window.scrollTo({ top: 0, behavior: "smooth" });

    if (openEvents[view]) window.dispatchEvent(new CustomEvent(openEvents[view]));
  }

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => activate(tab.dataset.view));
    tab.addEventListener("keydown", (event) => {
      const currentIndex = tabs.indexOf(tab);
      let nextIndex = currentIndex;
      if (event.key === "ArrowDown" || event.key === "ArrowRight") nextIndex = (currentIndex + 1) % tabs.length;
      else if (event.key === "ArrowUp" || event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
      else if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = tabs.length - 1;
      else return;

      event.preventDefault();
      activate(tabs[nextIndex].dataset.view, { focusTab: true });
    });
  });

  // Os fluxos internos usam esta ação para abrir outra área sem conhecer o DOM.
  return Object.freeze({ open: (view) => activate(view) });
}
