// Offline support: the app shell is cached so saved scores play without a connection.
const CACHE = 'notereader-v1';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'score.js', 'player.js', 'store.js',
  'vendor/verovio-toolkit-wasm.js', 'sample.musicxml', 'icon.svg', 'icon-192.png', 'manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;
  if (url.pathname.includes('/vendor/')) {
    // Large and never changes: cache first.
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
    return;
  }
  // Everything else: fresh when online, cached when not.
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
      return res.clone();
    }).catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
