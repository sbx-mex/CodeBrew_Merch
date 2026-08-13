const CACHE_NAME = 'codebrew-merch-v25-faithful-restoration-2026-08-13';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './catalog.css',
  './app.js',
  './manifest.webmanifest',
  './data/products.js',
  './data/woe.js',
  './data/merch-catalog.js',
  './data/woe-pdf-config.js',
  './data/stock-config.js',
  './data/ui-config.js',
  './data/app-audit.js',
  './assets/catalog/catalog-hero.webp',
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
    Promise.all([self.registration.navigationPreload?.enable?.(), caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
    ]).then(() => self.clients.claim())
  );
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;
  if (event.request.mode === 'navigate') {
    event.respondWith((async()=>{
      try{
        const response=await event.preloadResponse||await fetch(event.request);
        if(response?.ok){const copy=response.clone();event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.put('./index.html',copy)));}
        return response;
      }catch(error){return caches.match('./index.html');}
    })());
    return;
  }
  const path = requestUrl.pathname;
  const isGeneratedData = path.endsWith('/data/products.js') || path.endsWith('/data/woe.js') || path.endsWith('/data/merch-catalog.js') || path.endsWith('/data/woe-pdf-config.js') || path.endsWith('/data/stock-config.js') || path.endsWith('/data/ui-config.js') || path.endsWith('/data/app-audit.js');
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
