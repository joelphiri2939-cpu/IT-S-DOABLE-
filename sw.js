// IT'S DOABLE! TALENT — Service Worker
// Cache the app shell for fast/offline loads. Firestore handles its own
// offline persistence for data; this SW only concerns itself with static assets.

const CACHE_VERSION = 'idt-shell-v1';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Never intercept Firebase/Google API calls — always go to network.
  if (
    req.url.includes('firestore.googleapis.com') ||
    req.url.includes('identitytoolkit.googleapis.com') ||
    req.url.includes('googleapis.com') ||
    req.url.includes('gstatic.com/firebasejs') ||
    req.method !== 'GET'
  ) {
    return;
  }

  // App shell / navigation: network-first so users always get the latest
  // build when online, falling back to cache when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put('./index.html', clone));
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Static assets: cache-first
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((res) => {
      const clone = res.clone();
      caches.open(CACHE_VERSION).then((cache) => cache.put(req, clone));
      return res;
    }).catch(() => cached))
  );
});

// ---------- Push notifications ----------
// The actual delivery (VAPID signing, talking to the push service) all
// happens in the Cloudflare Worker before this ever fires — by the time
// we're here, the OS has already handed us a payload to display.
self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (err) { /* fall through to defaults below */ }

  // Branding is always shown, never left to the payload — this is what
  // makes every notification instantly recognizable as coming from the
  // app, with its name and logo, rather than just a bare message.
  const APP_NAME = "IT'S DOABLE! TALENT";
  const APP_ICON = './icons/icon-192.png';   // small icon next to the notification
  const APP_BADGE = './icons/icon-192.png';  // monochrome status-bar badge (Android)

  const title = APP_NAME;

  // If the worker sends a more specific heading (e.g. "New comment"),
  // it's folded into the body as a bold-ish lead-in above the message,
  // instead of replacing the app name in the title bar.
  const messageBody = payload.body || payload.message || '';
  const body = (payload.title && payload.title !== APP_NAME)
    ? `${payload.title}\n${messageBody}`
    : messageBody;

  const options = {
    body,
    icon: APP_ICON,
    badge: APP_BADGE,
    image: payload.image || undefined, // optional larger banner image, if the worker sends one
    tag: payload.tag || 'general',
    renotify: true,
    data: payload.data || { url: './' },
    vibrate: [80, 40, 80]
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Tapping a notification: focus an already-open tab if there is one,
// otherwise open a new one, landing on whatever the notification pointed to.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || './';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsList) => {
      for (const client of clientsList) {
        if ('focus' in client) {
          client.postMessage({ type: 'notification-click', url: targetUrl });
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
