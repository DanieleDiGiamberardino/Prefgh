const CACHE = 'snp-v1';
const ASSETS = ['/', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

// Network first per le API, cache first per gli asset statici
self.addEventListener('fetch', e => {
  if (e.request.url.includes('/api/')) return; // mai cachare le API
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
