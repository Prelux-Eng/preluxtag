// Versão do shell do app; avance sempre que mudar HTML, CSS ou JavaScript.
const CACHE_NAME = "prelux-emissor-etiquetas-v42";
const APP_SHELL = [
  "./",
  "./index.html",
  "./css/app.css?v=6",
  "./css/operations.css?v=10",
  "./css/prelux-refresh.css?v=7",
  "./css/planning-print.css?v=2",
  "./js/main.js?v=11",
  "./js/core/api.js",
  "./js/core/navigation.js",
  "./js/domain/mold-compatibility.js",
  "./js/repositories/operations-repository.js",
  "./js/repositories/planning-repository.js",
  "./js/features/labels/index.js",
  "./js/features/planning/index.js",
  "./js/features/planning/print-report.js?v=2",
  "./js/features/planning/scenario-calendar.js",
  "./js/features/operations/index.js",
  "./manifest.webmanifest?v=4",
  "./assets/PRE_RASTRE_sem_logo.png",
  "./assets/logo-prelux-etiqueta.png",
  "./assets/logo-prelux.png",
  "./assets/logo-prelux-clara.png",
  "./assets/prelux-fabrica.png",
  "./assets/planning-pdf-background.png",
  "./assets/icone-cadastro-claro.png",
  "./assets/icone-planejamento-claro.png",
  "./assets/icone-engenharia-claro.png",
  "./assets/icone-etiqueta-claro.png",
  "./icons/favicon-32.png",
  "./icons/favicon-64.png",
  "./icons/icon-192.png?v=4",
  "./icons/icon-512.png?v=4",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const request = event.request;
  const isNavigation = request.mode === "navigate" || request.destination === "document";
  const isAppCode = request.url.includes("/js/") ||
    request.url.includes("/css/app.css") ||
    request.url.includes("/css/operations.css") ||
    request.url.includes("/css/prelux-refresh.css") ||
    request.url.includes("/sw.js");

  // Código e navegação usam a versão do servidor quando há conexão. Se ela
  // falhar, o shell previamente armazenado mantém a aplicação disponível.
  if (isNavigation || isAppCode) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match("./index.html"))),
    );
    return;
  }

  event.respondWith(
    caches.match(request)
      .then((cached) => cached || fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      }).catch(() => caches.match("./index.html"))),
  );
});
