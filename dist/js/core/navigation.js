/*
 * Navegação principal da aplicação.
 *
 * Este módulo possui o único código que alterna as três áreas da interface.
 * Ao abrir uma área, publica um evento para que o módulo correspondente possa
 * carregar ou atualizar seus dados sem criar dependência direta entre telas.
 */
(function attachNavigation(global) {
  const tabs = [...document.querySelectorAll('.nav [role="tab"][data-view]')];
  const panels = {
    etiquetas: document.getElementById("etiquetasView"),
    planejamento: document.getElementById("planningView"),
    cadastros: document.getElementById("operationsView"),
  };
  const pageDetails = {
    etiquetas: {
      title: "Etiquetas",
      description: "Identificação e rastreabilidade de peças pré-moldadas",
    },
    planejamento: {
      title: "Planejamento",
      description: "Acompanhe pedidos, obras, capacidade e etapas de produção",
    },
    cadastros: {
      title: "Cadastros de produção",
      description: "Gerencie obras, pedidos, peças, moldes e posições",
    },
  };
  const openEvents = {
    planejamento: "prelux:planning:open",
    cadastros: "prelux:operations:open",
  };

  function activate(view, { focusTab = false } = {}) {
    if (!panels[view] || !tabs.some((tab) => tab.dataset.view === view)) return;

    // Atualiza estado visual e semântico da aba e do painel correspondente.
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
    global.scrollTo({ top: 0, behavior: "smooth" });

    // O módulo da área reage ao evento e decide se precisa buscar dados.
    if (openEvents[view]) global.dispatchEvent(new CustomEvent(openEvents[view]));
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

  // API pequena para botões de outras telas navegarem sem conhecer o DOM.
  global.PRELUX_NAV = Object.freeze({ open: (view) => activate(view) });
})(window);
