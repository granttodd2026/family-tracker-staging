// App-shell service worker. Data itself lives in each phone's local storage + encrypted sync.
// Versioned cache (stamped by build.sh), cache-first shell (instant and immune to weak Wi-Fi), and a
// PROMPTED update: a new worker waits until the user taps "Update" (no unconditional skipWaiting),
// so an open page never mixes old and new files.
const VERSION = '1.13.7+202610121559';
const C = 'baby-' + VERSION;
const SHELL = ['./', 'app.js', 'nonholders.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/apple-touch-icon.png', 'nosleep.mp4'];
self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(C);
    // bypass the HTTP cache so a stale app.js can never be paired with this worker
    const res = await Promise.all(SHELL.map((u) => fetch(new Request(u, { cache: 'reload' }))));
    if (res.some((r) => !r.ok)) throw new Error('shell fetch failed');
    if (!(await res[1].clone().text()).includes(VERSION)) throw new Error('app.js does not match ' + VERSION);
    await Promise.all(res.map((r, i) => c.put(SHELL[i], r)));
  })());
});
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== C && (k.startsWith('baby-'))).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('message', (e) => { if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting(); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  if (e.request.mode === 'navigate') { e.respondWith(caches.open(C).then((c) => c.match('./')).then((r) => r || fetch(e.request))); return; }
  // video (board keep-awake): iOS requests it with Range and needs 206 Partial Content, so serve ranges from the cache
  if (/\.mp4$/.test(u.pathname)) { e.respondWith(rangeFromCache(e.request)); return; }
  // shell files: cache-first; anything else (e.g. version.txt): network, falling back to cache
  e.respondWith(caches.open(C).then(async (c) => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    if (hit) return hit;
    try { return await fetch(e.request); } catch { return (await c.match(e.request, { ignoreSearch: true })) || Response.error(); }
  }));
});

// Lock-screen reminders (payload is end-to-end encrypted by Web Push; only generic text).
// Usage counts (event names only) for the app's hourly encrypted rollup; read and cleared by the app.
async function bumpUsage(k) { try { const c = await caches.open('mt-usage'); const r = await c.match('push'); const o = r ? await r.json() : {}; o[k] = (o[k] || 0) + 1; await c.put('push', new Response(JSON.stringify(o))); } catch {} }
self.addEventListener('push', (e) => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch { d = { title: e.data && e.data.text() }; }
  e.waitUntil(Promise.all([bumpUsage('delivered:' + String(d.tag || 'reminder').replace(/^med-.*/, 'med').replace(/[^a-z0-9-]/gi, '').slice(0, 20)), self.registration.showNotification(d.title || 'Baby App', {
    body: d.body || '', tag: d.tag || 'reminder', renotify: !d.quiet, silent: !!d.quiet, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', data: d.data || {},
  })]));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    await bumpUsage('opened');
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) if ('focus' in c) return c.focus();
    return self.clients.openWindow('./');
  })());
});

async function rangeFromCache(req) {
  const c = await caches.open(C); let r = await c.match(req, { ignoreSearch: true });
  if (!r) { try { r = await fetch(req.url); if (r.ok) await c.put(req.url, r.clone()); } catch { return fetch(req); } }
  const range = req.headers.get('range'); if (!range || !r.ok) return r;
  const buf = await r.arrayBuffer(), size = buf.byteLength, m = /bytes=(\d*)-(\d*)/.exec(range);
  let start = m && m[1] ? Number(m[1]) : 0, end = m && m[2] ? Number(m[2]) : size - 1;
  if (m && !m[1] && m[2]) { start = Math.max(0, size - Number(m[2])); end = size - 1; }
  if (start >= size || end < start) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  end = Math.min(end, size - 1);
  return new Response(buf.slice(start, end + 1), { status: 206, headers: { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes' } });
}
