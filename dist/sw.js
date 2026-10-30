// A versão muda junto dos arquivos do app para que celulares baixem a estrutura nova.
const CACHE_NAME = 'prelux-emissor-etiquetas-v16';
const APP_SHELL = [
  './',
  './index.html',
  './css/app.css?v=3',
  './css/operations.css?v=4',
  './js/core/api.js?v=17',
  './js/core/navigation.js?v=1',
  './js/domain/mold-compatibility.js?v=1',
  './js/repositories/planning-repository.js?v=1',
  './js/repositories/operations-repository.js?v=2',
  './js/modules/label-emitter.js?v=1',
  './js/modules/production-calendar.js?v=10',
  './js/modules/operations-admin.js?v=8',
  './manifest.webmanifest',
  './assets/PRE_RASTRE.png',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const request = event.request;
  const isNavigation = request.mode === 'navigate' || request.destination === 'document';
  const isVersionSensitive = [
    '/js/core/api.js',
    '/js/core/navigation.js',
    '/js/domain/mold-compatibility.js',
    '/js/repositories/',
    '/js/modules/',
    '/css/app.css',
    '/css/operations.css',
    '/sw.js',
  ].some(path => request.url.includes(path));

  if (isNavigation || isVersionSensitive) {
    event.respondWith(fetch(request).then(response => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
      }
      return response;
    }).catch(() => caches.match(request).then(cached => cached || caches.match('./index.html'))));
    return;
  }

  event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
    }
    return response;
  }).catch(() => caches.match('./index.html'))));
});
