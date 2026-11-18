// Versão do shell do app; avance sempre que mudar HTML, CSS ou JavaScript.
const CACHE_NAME = "prelux-emissor-etiquetas-v33";
const APP_SHELL = [
  "./",
  "./index.html",
  "./css/app.css?v=5",
  "./css/operations.css?v=9",
  "./css/prelux-refresh.css?v=3",
  "./js/main.js?v=8",
  "./js/core/api.js",
  "./js/core/navigation.js",
  "./js/domain/mold-compatibility.js",
  "./js/repositories/operations-repository.js",
  "./js/repositories/planning-repository.js",
  "./js/features/labels/index.js",
  "./js/features/planning/index.js",
  "./js/features/planning/scenario-calendar.js",
  "./js/features/operations/index.js",
  "./manifest.webmanifest?v=3",
  "./assets/PRE_RASTRE.png",
  "./assets/logo-prelux.png",
  "./assets/logo-prelux-clara.png",
  "./assets/prelux-fabrica.png",
  "./assets/icone-cadastro.png",
  "./assets/icone-planejamento.png",
  "./assets/icone-engenharia.png",
  "./assets/icone-etiqueta.png",
  "./icons/icon.svg",
  "./icons/favicon-32.png",
  "./icons/favicon-64.png",
  "./icons/icon-192.png?v=3",
  "./icons/icon-512.png?v=3",
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
