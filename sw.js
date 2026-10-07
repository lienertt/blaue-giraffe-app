// Caches only the app's own files, so the app opens quickly and can be installed. Requests to the
// GitHub API are never cached: the data always comes fresh from GitHub.
const CACHE = 'dienstplan-v2';
const FILES = ['./', 'index.html', 'style.css', 'logic.js', 'app.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))));
  self.clients.claim();
});

// Network first for the app's own files (updates show up right away), cache as fallback offline.
// "no-cache" makes the browser revalidate with the server instead of using its HTTP cache
// (GitHub Pages sends max-age=600, which otherwise hides an update for up to ten minutes).
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(
    // By URL: a navigation request can't be copied with options.
    fetch(url.href, { cache: 'no-cache' })
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request)),
  );
});
