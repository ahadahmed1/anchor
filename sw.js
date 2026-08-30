/* ---- Anchor service worker ----
   Bump VERSION whenever the shell files change; old caches are dropped on activate. */
const VERSION = 'v8';
const SHELL_CACHE = 'anchor-shell-' + VERSION;

/* Relative URLs so the app works from any sub-path (GitHub Pages, /app/, ...).
   Every module is listed: they are fetched individually, so a missing one means the app
   half-loads offline rather than failing loudly. */
const SHELL = [
  './',
  'index.html',
  'css/styles.css',
  'js/app.js',
  'js/view.js',
  'js/timeline.js',
  'js/model.js',
  'js/schedule.js',
  'js/persist.js',
  'js/storage.js',
  'manifest.json',
  'icons/favicon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon-180.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== SHELL_CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  /* Navigations: try the network so updates land, fall back to the cached shell offline. */
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            caches.open(SHELL_CACHE).then(cache => cache.put('index.html', copy));
          }
          return response;
        })
        .catch(() => caches.match('index.html', { ignoreSearch: true })
          .then(cached => cached || caches.match('./')))
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  /* Same-origin assets: serve from cache immediately, refresh in the background. */
  event.respondWith(
    caches.match(request).then(cached => {
      const network = fetch(request).then(response => {
        if (response && response.status === 200) {
          const copy = response.clone();
          caches.open(SHELL_CACHE).then(cache => cache.put(request, copy));
        }
        return response;
      }).catch(err => {
        if (cached) return cached;
        throw err;
      });
      return cached || network;
    })
  );
});
