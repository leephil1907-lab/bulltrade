/* Blockchain Bullhorn — service worker
   Offline shell for the installable app + Web Push notification handling. */
const CACHE = 'bb-shell-v1';
const ASSET_CACHE = 'bb-assets-v1';
const PRECACHE = [
  '/offline.html',
  '/assets/img/brand/logo.png',
  '/assets/img/icon-192.png',
  '/assets/img/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE && k !== ASSET_CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;                       // never touch mutations
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;             // let cross-origin pass through
  if (url.pathname.startsWith('/api/') || url.pathname === '/admin') return; // live data only

  // pages: network-first, fall back to cache, then the branded offline page
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try { return await fetch(req); }
      catch (err) {
        const cached = await caches.match(req);
        return cached || caches.match('/offline.html');
      }
    })());
    return;
  }

  // static assets: cache-first (css/js/img/fonts are versioned or immutable enough)
  if (url.pathname.startsWith('/assets/')) {
    e.respondWith((async () => {
      const cache = await caches.open(ASSET_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.status === 200) cache.put(req, fresh.clone());
        return fresh;
      } catch (err) { return hit || Response.error(); }
    })());
  }
});

/* ---- Web Push ---- */
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) { data = { body: e.data && e.data.text() }; }
  const title = data.title || 'Blockchain Bullhorn';
  e.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: '/assets/img/icon-192.png',
    badge: '/assets/img/favicon-64.png',
    tag: data.tag || 'bb-notify',
    data: { url: data.url || '/' },
    vibrate: [80, 40, 80]
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil((async () => {
    const winList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of winList) {
      const wUrl = new URL(w.url);
      if (wUrl.origin === location.origin && (wUrl.pathname === url || wUrl.pathname === new URL(url, location.origin).pathname)) {
        await w.focus();
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
