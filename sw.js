const CACHE_NAME = 'codebrew-merch-v9-woe-pdf-letter-2026-08-09';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './data/products.js',
  './data/woe.js',
  './data/woe-pdf-config.js',
  './data/import-report.json',
  './Lista_Precios_Base.xlsx',
  './assets/icon-192.png',
  './assets/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match('./index.html')));
    return;
  }
  const path = new URL(event.request.url).pathname;
  const isGeneratedData = path.endsWith('/data/products.js') || path.endsWith('/data/woe.js') || path.endsWith('/data/import-report.json');
  event.respondWith(
    (isGeneratedData ? fetch(event.request).catch(() => caches.match(event.request)) : caches.match(event.request).then(cached => cached || fetch(event.request))).then(response => {
      if (response && response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
      }
      return response;
    })
  );
});
