/*
 * The app shell is deliberately cache-first.  That keeps index.html and its
 * module graph on the same release while a newer worker is waiting.  The UI
 * can then ask the waiting worker to take over at a safe point by sending
 * { type: 'SKIP_WAITING' }.
 */
const CACHE_PREFIX = 'study-routine-shell';
const CACHE_VERSION = '2026-09-17-4';
const scopePath = new URL(self.registration.scope).pathname;
const scopeKey = encodeURIComponent(scopePath).replace(/%/g, '_');
const CACHE_NAME = `${CACHE_PREFIX}-${scopeKey}-${CACHE_VERSION}`;

// Keep this list explicit so an installed release cannot pull a new module
// from the network and accidentally run a mixed release while offline.
const SHELL_PATHS = [
  './',
  './index.html',
  './styles.css',
  './src/app.js',
  './src/model.js',
  './src/db.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-192-maskable.png',
  './icons/icon-512-maskable.png',
];

const shellUrls = () => SHELL_PATHS.map((path) => new URL(path, self.registration.scope).toString());
const withinScope = (url) => url.origin === self.location.origin
  && (url.pathname === scopePath || url.pathname.startsWith(scopePath));

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(shellUrls())),
  );
  // Do not call skipWaiting here.  A new release remains waiting until the
  // application explicitly tells it that the user is idle.
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Cache names include the registration scope.  Only remove old releases
    // for this app and this scope; unrelated applications keep their caches.
    const names = await caches.keys();
    const ownPrefix = `${CACHE_PREFIX}-${scopeKey}-`;
    await Promise.all(names
      .filter((name) => name.startsWith(ownPrefix) && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') event.waitUntil(self.skipWaiting());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (!withinScope(url)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;

    // Navigation fallback is the cached entry point.  It also covers a
    // direct-open URL and GitHub Pages' project subpath when offline.
    if (request.mode === 'navigate') {
      const fallback = await cache.match(new URL('./index.html', self.registration.scope).toString());
      if (fallback) return fallback;
    }

    // Unknown local files are allowed to load online but are intentionally not
    // added to the release cache.  The explicit shell list above is the
    // version boundary for this app.
    return fetch(request);
  })());
});
