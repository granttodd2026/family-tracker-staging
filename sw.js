// App-shell service worker. Data itself lives in each phone's local storage + encrypted sync.
// Versioned cache (stamped by build.sh), cache-first shell (instant and immune to weak Wi-Fi), and a
// 1.13.10 AUTO update: a new worker skips waiting once its whole shell is cached, so the next open runs it. A page that
// is already open keeps its old code in memory, and app.js reloads it onto the new version only at a safe moment.
const VERSION = '1.13.13+202610130405';
const C = 'baby-' + VERSION;
const SHELL = ['./', 'app.js', 'nonholders.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/apple-touch-icon.png', 'nosleep.mp4'];
// 1.13.11 (hotfix): install must not fail on a briefly stale CDN copy (GitHub Pages edges cache 600 s) or a flaky network.
// Each file is fetched with no-store + a per-version query (a CDN cache miss, so origin-fresh), retried with backoff; the
// app.js version check retries too. nosleep.mp4 (board keep-awake) is optional here and cached on first use.
const REQUIRED = SHELL.filter((u) => !/\.mp4$/.test(u));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fresh(u, i) { return fetch(new Request(u + (u.includes('?') ? '&' : '?') + 'sw=' + encodeURIComponent(VERSION) + '-' + i + '-' + Date.now(), { cache: 'no-store' })); }
async function getChecked(u) {
  let last;
  for (let i = 0; i < 4; i++) {
    try { const r = await fresh(u, i); if (r.ok && (u !== 'app.js' || (await r.clone().text()).includes(VERSION))) return r; last = new Error(u + ' ' + r.status + (r.ok ? ' (stale)' : '')); } catch (e) { last = e; }
    await sleep(1000 * (i + 1));
  }
  throw last || new Error('fetch ' + u);
}
self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(C);
    const res = await Promise.all(REQUIRED.map(getChecked)); // all-or-nothing: never pair this worker with a stale shell
    await Promise.all(res.map((r, i) => c.put(REQUIRED[i], r)));
    try { const v = await fresh('nosleep.mp4', 0); if (v.ok) await c.put('nosleep.mp4', v); } catch {}
    await self.skipWaiting(); // 1.13.10: only after the full, version-matched shell is in the new cache
  })());
});
// After taking over, 1.13.10+ pages reload themselves at a safe moment (controllerchange). Older pages can't be reloaded
// safely from here (no way to know they're mid-entry), so their own Update tap does it (see SKIP_WAITING below).
let activated = false;
self.addEventListener('activate', (e) => { e.waitUntil((async () => {
  const ks = await caches.keys(); await Promise.all(ks.filter((k) => k !== C && k.startsWith('baby-')).map((k) => caches.delete(k)));
  await self.clients.claim(); activated = true;
})()); });
self.addEventListener('message', (e) => {
  const d = e.data || {}, src = e.source;
  if (d.type === 'SKIP_WAITING') {
    if (!(activated || (self.registration.active && !self.registration.waiting))) { self.skipWaiting(); return; }
    // already active: an older page's "Update" tap (its controllerchange already passed) -> reload that page onto this version
    if (src && src.navigate) e.waitUntil(src.navigate(src.url).catch(() => {}));
  }
});
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
