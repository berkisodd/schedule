// Schedule 2.0 service worker
// Bump CACHE_VERSION whenever you deploy, so people get the new files
// instead of a stale cached copy.
const CACHE_VERSION = 'schedule-v2.9';

const SHELL = [
  './',
  './login.html',
  './schedule.html',
  './share.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
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

self.addEventListener('fetch', (e) => {
  const req = e.request;

  // Only handle same-origin GETs. Firebase/Google calls go straight to the
  // network untouched, caching auth or Firestore traffic would break things.
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Network first, fall back to cache. This way the app is always current
  // when there's signal, and still opens when there isn't.
  e.respondWith(
    fetch(req)
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
