const CACHE_NAME = 'prelux-emissor-etiquetas-v11';
const APP_SHELL = [
  './',
  './index.html',
  './css/operations.css?v=3',
  './js/core/api.js?v=16',
  './js/modules/production-calendar.js?v=7',
  './js/modules/operations-admin.js?v=4',
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
  const isVersionSensitive = request.url.includes('/js/core/api.js') || request.url.includes('/js/modules/production-calendar.js') || request.url.includes('/js/modules/operations-admin.js') || request.url.includes('/css/operations.css') || request.url.includes('/sw.js');

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
