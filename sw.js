const CACHE_NAME = 'codebrew-v48-precount-html-2026-08-19';
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
  './data/pos-operational-overrides.js',
  './data/tool-menu.json',
  './data/tools/consulta.json',
  './data/tools/catalog.json',
  './data/tools/merch.json',
  './data/tools/export.json',
  './data/tools/etiquetado.json',
  './assets/stock_pdf_woe.jpeg',
  './assets/catalog/catalog-hero.webp',
  './assets/catalog/catalog-general-hero.webp',
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
      .then(keys => Promise.all(keys.filter(key => key.startsWith('codebrew-') && key !== CACHE_NAME).map(key => caches.delete(key))))
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
        const response=await event.preloadResponse||await fetch(event.request,{cache:'reload'});
        if(response?.ok){const copy=response.clone();event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.put('./index.html',copy)));}
        return response;
      }catch(error){return caches.match('./index.html');}
    })());
    return;
  }
  const path = requestUrl.pathname;
  const isGeneratedData = path.endsWith('/data/products.js') || path.endsWith('/data/woe.js') || path.endsWith('/data/merch-catalog.js') || path.endsWith('/data/woe-pdf-config.js') || path.endsWith('/data/stock-config.js') || path.endsWith('/data/ui-config.js') || path.endsWith('/data/app-audit.js') || path.endsWith('/data/pos-operational-overrides.js') || path.endsWith('/data/tool-menu.json') || path.includes('/data/tools/');
  const isCatalogImage = path.includes('/assets/catalog/images/');
  const isCoreResource = ['/app.js','/styles.css','/catalog.css','/index.html','/manifest.webmanifest'].some(suffix => path.endsWith(suffix));
  const freshFirst = isGeneratedData || isCatalogImage || isCoreResource;
  const timeoutMs = isCoreResource ? 1600 : 2500;
  event.respondWith(
    (freshFirst ? Promise.race([fetch(event.request,{cache:'reload'}),new Promise((_,reject)=>setTimeout(()=>reject(new Error('timeout')),timeoutMs))]).catch(() => caches.match(event.request)) : caches.match(event.request).then(cached => cached || fetch(event.request))).then(response => {
      if (response && response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
      }
      return response;
    })
  );
});
