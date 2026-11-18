/*
 * Navega entre Pedido, Engenharia, Projeto, Produzir, Planejamento e Etiquetas.
 * As quatro primeiras abas compartilham o módulo de operações com etapas próprias.
 */
export function initializeNavigation() {
  const tabs = [...document.querySelectorAll(".nav [role=tab][data-view]")];
  const tabList = tabs[0]?.closest("[role=tablist]");
  const compactNavigation = window.matchMedia("(max-width: 1100px)");
  const updateOrientation = () => {
    tabList?.setAttribute("aria-orientation", compactNavigation.matches ? "horizontal" : "vertical");
  };
  const operationsPanel = document.getElementById("operationsView");
  const operationStages = {
    pedidos: "orders",
    engenharia: "engineering",
    projeto: "projects",
    produzir: "produzir",
  };
  const panels = {
    ...Object.fromEntries(Object.keys(operationStages).map((view) => [view, operationsPanel])),
    planejamento: document.getElementById("planningView"),
    etiquetas: document.getElementById("etiquetasView"),
  };
  const pageTitles = {
    pedidos: "Pedidos",
    engenharia: "Engenharia",
    projeto: "Projeto",
    produzir: "Produzir",
    planejamento: "Planejamento",
    etiquetas: "Etiquetas",
  };
  const openEvents = {
    planejamento: "prelux:planning:open",
    etiquetas: "prelux:labels:open",
    ...Object.fromEntries(Object.keys(operationStages).map((view) => [view, "prelux:operations:open"])),
  };

  updateOrientation();
  compactNavigation.addEventListener("change", updateOrientation);

  function activate(view, { focusTab = false, detail } = {}) {
    if (!panels[view] || !tabs.some((tab) => tab.dataset.view === view)) return;
    tabs.forEach((tab) => {
      const selected = tab.dataset.view === view;
      tab.classList.toggle("active", selected);
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (selected && focusTab) tab.focus();
    });
    const selectedPanel = panels[view];
    new Set(Object.values(panels)).forEach((panel) => { panel.hidden = panel !== selectedPanel; });
    const title = pageTitles[view];
    const selectedTab = tabs.find((tab) => tab.dataset.view === view);
    selectedPanel.setAttribute("aria-labelledby", selectedTab.id);
    selectedPanel.setAttribute("aria-label", title);
    document.getElementById("pageTitle").textContent = title;
    document.title = "PRELUX · " + title;
    window.scrollTo({ top: 0, behavior: "smooth" });
    if (openEvents[view]) {
      const eventDetail = operationStages[view]
        ? { ...(detail || {}), stage: operationStages[view] }
        : detail;
      const options = eventDetail === undefined ? undefined : { detail: eventDetail };
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
