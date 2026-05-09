/* Sprinter PWA service worker — push notifications */

self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = {};
  }
  const title = data.title || 'Sprinter';
  const opts = {
    body: data.body || '',
    tag: data.tag,
    badge: '/icon-192.png',
    icon: '/icon-192.png',
    vibrate: [80, 40, 80],
    data: { url: data.url || '/' },
    requireInteraction: false,
  };
  event.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      for (const c of all) {
        if (c.url.includes(self.location.origin)) {
          await c.focus();
          try {
            c.navigate(url);
          } catch (_) {
            /* navigate may fail across origins or in some browsers; ignore */
          }
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
