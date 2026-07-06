// Service worker — cache app shell để chạy offline
const CACHE = 'caloviet-v16';
const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/foods.js',
  './js/calc.js',
  './js/store.js',
  './js/strava.js',
  './libs/zxing.min.js',
  './js/scanner.js',
  './js/vision.js',
  './js/app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Không đụng request khác origin (Strava, Open Food Facts, Anthropic)
  if (url.origin !== location.origin) return;
  // Endpoint động (function OAuth) — luôn gọi mạng, không cache
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/.netlify/')) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(hit =>
      hit || fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
    )
  );
});
