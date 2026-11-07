'use strict';
// Service worker: makes DoseLoop installable and lets the app shell open offline.
// App files are network-first, so a new deploy is picked up on the next load; the pose
// model and libraries from CDNs are cache-first, since a pinned version never changes.
const SHELL = 'doseloop-shell-v6';
const CDN = 'doseloop-cdn-v1';
const FILES = ['./', 'index.html', 'styles.css', 'app.js', 'poses.js', 'figure.js', 'motion.js', 'vision.js', 'clinic.js', 'home.js', 'track.js', 'manifest.webmanifest', 'model/exercise-model.json', 'icons/icon-192.png', 'icons/icon-512.png'];
const CDN_HOSTS = ['cdn.jsdelivr.net', 'storage.googleapis.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== CDN).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (CDN_HOSTS.includes(url.hostname)) {
    e.respondWith(
      caches.open(CDN).then(async (c) => {
        const hit = await c.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok || res.type === 'opaque') c.put(req, res.clone());
        return res;
      })
    );
    return;
  }
  // Live data is never cached: participants must see real numbers or an error.
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) caches.open(SHELL).then((c) => c.put(req, res.clone()));
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('index.html')))
  );
});
