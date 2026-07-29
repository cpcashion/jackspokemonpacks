/**
 * Offline shell.
 *
 * `__BUILD_ID__` is replaced by the server with a hash of the files it is
 * actually serving. That means every deploy produces different service worker
 * bytes, the browser installs the new one, and the old cache is deleted by
 * name — nobody can be left pinned to a previous build.
 *
 * HTML is never cached. A stale shell is what makes an updated app look
 * unchanged, and this app is small enough that a cold HTML fetch costs
 * nothing worth trading for that risk. API responses are never cached either:
 * a stale price is worse than no price.
 */

const BUILD = '__BUILD_ID__';
const CACHE = `jacks-cards-${BUILD}`;

// Assets safe to serve from cache while offline. Note: no HTML.
const SHELL = ['/styles.css', '/script.js', '/manifest.webmanifest', '/icons/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('jacks-cards-') && k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // Navigations always come from the network. If the network is gone there is
  // nothing useful to show anyway — this app is a view onto live prices.
  if (request.mode === 'navigate') return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});
