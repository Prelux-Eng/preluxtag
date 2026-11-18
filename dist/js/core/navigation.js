/*
 * Navegação principal entre Pedidos, Planejamento e Etiquetas.
 * Cada área mantém o próprio módulo e recebe um evento ao ser aberta.
 */
export function initializeNavigation() {
  const tabs = [...document.querySelectorAll(".nav [role=tab][data-view]")];
  const panels = {
    pedidos: document.getElementById("operationsView"),
    planejamento: document.getElementById("planningView"),
    etiquetas: document.getElementById("etiquetasView"),
  };
  const pageDetails = {
    pedidos: { title: "Pedidos", description: "Pedido → Engenharia → Projeto → Produzir" },
    planejamento: { title: "Planejamento", description: "Períodos, capacidade e sequência da produção" },
    etiquetas: { title: "Etiquetas", description: "Identificação e rastreabilidade das peças" },
  };
  const openEvents = {
    planejamento: "prelux:planning:open",
    pedidos: "prelux:operations:open",
    etiquetas: "prelux:labels:open",
  };

  function activate(view, { focusTab = false, detail } = {}) {
    if (!panels[view] || !tabs.some((tab) => tab.dataset.view === view)) return;
    tabs.forEach((tab) => {
      const selected = tab.dataset.view === view;
      tab.classList.toggle("active", selected);
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (selected && focusTab) tab.focus();
    });
    Object.entries(panels).forEach(([name, panel]) => { panel.hidden = name !== view; });
    const page = pageDetails[view];
    document.getElementById("pageTitle").textContent = page.title;
    document.getElementById("pageDescription").textContent = page.description;
    document.title = "PRELUX · " + page.title;
    window.scrollTo({ top: 0, behavior: "smooth" });
    if (openEvents[view]) {
      const options = detail === undefined ? undefined : { detail };
      window.dispatchEvent(new CustomEvent(openEvents[view], options));
    }
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

  return Object.freeze({ open: (view, options) => activate(view, options) });
}
