/* 密聊 service worker: app-shell caching (offline read-only mode) + content-free push notifications. */
const SHELL = 'shell-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// the page tells us which build files it is using; older versions' files are removed from the cache.
// Only files whose content-hash prefix (e.g. "App-") matches a file in use are dropped, so lazily loaded
// chunks this page simply hasn't needed yet are kept.
self.addEventListener('message', (e) => {
  if (e.data?.t !== 'prune' || !Array.isArray(e.data.keep)) return;
  const keep = new Set(e.data.keep);
  const stem = (p) => p.replace(/^\/assets\//, '').replace(/-[A-Za-z0-9_-]{6,}\.(js|css|woff2)$/, '');
  const inUse = new Set([...keep].map(stem));
  e.waitUntil(
    caches.open(SHELL).then((c) =>
      c.keys().then((reqs) =>
        Promise.all(
          reqs
            .map((r) => new URL(r.url).pathname)
            .filter((p) => p.startsWith('/assets/') && !keep.has(p) && inUse.has(stem(p)))
            .map((p) => c.delete(p)),
        ),
      ),
    ),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  // never cache API calls, the realtime channel, encrypted blobs or the gate page assets
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io') || url.pathname.startsWith('/__gate')) return;
  // v0.8: the code-fingerprint check must see what the server has now, never a cached copy
  if (req.mode !== 'navigate' && (req.cache === 'no-store' || ['/code-fingerprint.json', '/index.html', '/sw.js'].includes(url.pathname))) return;

  if (req.mode === 'navigate') {
    // network first: the server decides (gate page for unknown IPs); the cached shell is only an offline fallback
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put('/index.html', copy));
          }
          return res;
        })
        .catch(() => caches.match('/index.html').then((r) => r || Response.error())),
    );
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    // content-hashed build files: cache first
    e.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(SHELL).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  // icons, manifest: stale-while-revalidate
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || net;
    }),
  );
});

// The server only ever sends {"t":"msg"}, {"t":"call"} (someone is calling) or {"t":"alert"} (admins) — it can't read anything.
self.addEventListener('push', (e) => {
  let kind = 'msg';
  try {
    kind = e.data?.json()?.t || 'msg';
  } catch {
    /* ignore */
  }
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const visible = clients.some((c) => c.visibilityState === 'visible');
      if (visible) return undefined;
      const body = kind === 'alert' ? '有新的安全提醒，请打开管理后台查看' : kind === 'call' ? '有人正在呼叫你，点开接听' : '你有新消息';
      return self.registration.showNotification('密聊', {
        body,
        tag: kind === 'alert' ? 'admin-alert' : kind === 'call' ? 'incoming-call' : 'new-messages',
        data: { url: kind === 'alert' ? '/admin' : '/' },
        requireInteraction: kind === 'call',
        vibrate: kind === 'call' ? [300, 200, 300, 200, 300] : undefined,
        renotify: true,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
      });
    }),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const c = clients.find((x) => 'focus' in x);
      const url = e.notification.data?.url || '/';
      if (c) return c.focus().then((w) => (url !== '/' && w.navigate ? w.navigate(url) : w));
      return self.clients.openWindow(url);
    }),
  );
});
