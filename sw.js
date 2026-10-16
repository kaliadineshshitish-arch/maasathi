/* Maasathi service worker — offline-first, cache only own files.
 * No external requests. Privacy: nothing leaves the device. */
const CACHE = 'maasathi-v10';
const ASSETS = [
  './', './index.html', './privacy.html', './terms.html',
  './css/styles.css',
  './js/i18n.js', './js/i18n/en.js', './js/content.js', './js/config.js', './js/app.js',
  './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Web Push aane par notification dikhao — app band ho to bhi */
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) {}
  const title = (data && data.title) || 'Maasathi';
  e.waitUntil(
    self.registration.showNotification(title, {
      body: (data && data.body) || '',
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      tag: (data && data.tag) || 'maasathi-rem',
      data: data,
    })
  );
});

/* reminder notification tap -> app kholo */
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ('focus' in c) return c.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow('./index.html');
    })
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // never touch external requests
  e.respondWith(
    caches.match(e.request).then((r) => r || fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match('./index.html')))
  );
});
