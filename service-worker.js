// Schedule 2.0 service worker
// Bump CACHE_VERSION whenever you deploy, so people get the new files
// instead of a stale cached copy.
const CACHE_VERSION = 'schedule-v4.16';

const SHELL = [
  './',
  './login.html',
  './schedule.html',
  './share.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './maintenance.webm',
  './hold-to-delete.json',
  './avatar-upload.json',
  './lottie.min.js',
  './qrcode.min.js'
];

// Install: pre-cache the app shell so it opens instantly and works offline.
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_VERSION)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()) // don't block install if one file 404s
  );
});

// Activate: clear out old cache versions.
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Lets a page tell a waiting worker to take over immediately.
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;

  // Only handle same-origin GETs. Firebase/Google calls go straight to the
  // network untouched, caching auth or Firestore traffic would break things.
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Pages and the app's own HTML must never come from the browser's HTTP
  // cache, or a stale copy gets served and then re-cached here, which is
  // how the app ended up stuck on old versions. cache:'reload' forces a
  // real trip to the network for those, while still letting us cache the
  // fresh result for offline use.
  const isPage = req.mode === 'navigate' ||
                 (req.headers.get('accept') || '').includes('text/html');

  // Network first, fall back to cache. This way the app is always current
  // when there's signal, and still opens when there isn't.
  e.respondWith(
    (isPage
      ? fetch(req.url, { cache: 'reload', credentials: 'same-origin' })
      : fetch(req))
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then(c => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() =>
        caches.match(req).then(hit => hit || caches.match('./schedule.html'))
      )
  );
});
