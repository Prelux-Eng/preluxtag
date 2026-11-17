/*
 * Ponto de entrada do PRELUX.
 *
 * A ordem de inicialização fica explícita aqui: navegação primeiro, depois
 * cada área da aplicação. Os imports declaram as dependências sem variáveis
 * globais compartilhadas entre telas.
 */
import { initializeNavigation } from "./core/navigation.js";
import { initializeLabels } from "./features/labels/index.js";
import { initializePlanning } from "./features/planning/index.js";
import { initializeOperations } from "./features/operations/index.js";
import { listPieceMoldOptions } from "./domain/mold-compatibility.js";
import { operationsRepository } from "./repositories/operations-repository.js";
import { planningRepository } from "./repositories/planning-repository.js";

const navigation = initializeNavigation();

initializeLabels({ operationsRepository });
initializePlanning({
  planningRepository,
  operationsRepository,
  navigate: navigation.open,
});
initializeOperations({
  operationsRepository,
  listPieceMoldOptions,
  navigate: navigation.open,
});

// A abertura inicial segue o primeiro acesso da navegação: PEDIDOS.
// Assim a área carrega os pedidos sem exigir um clique adicional.
navigation.open("pedidos");

// O service worker é registrado em um só lugar para controlar a atualização PWA.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js?v=29").catch(() => {});
  });
}
