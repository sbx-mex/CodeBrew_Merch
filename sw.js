const CACHE_NAME = 'codebrew-merch-v12-stock-2026-08-09';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './data/products.js',
  './data/woe.js',
  './data/woe-pdf-config.js',
  './data/stock-config.js',
  './data/app-audit.js',
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
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).then(response=>{const copy=response.clone();caches.open(CACHE_NAME).then(cache=>cache.put('./index.html',copy));return response;}).catch(() => caches.match('./index.html')));
    return;
  }
  const path = requestUrl.pathname;
  const isGeneratedData = path.endsWith('/data/products.js') || path.endsWith('/data/woe.js') || path.endsWith('/data/woe-pdf-config.js') || path.endsWith('/data/stock-config.js') || path.endsWith('/data/app-audit.js');
  event.respondWith(
    (isGeneratedData ? Promise.race([fetch(event.request),new Promise((_,reject)=>setTimeout(()=>reject(new Error('timeout')),2500))]).catch(() => caches.match(event.request)) : caches.match(event.request).then(cached => cached || fetch(event.request))).then(response => {
      if (response && response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
      }
      return response;
    })
  );
});
