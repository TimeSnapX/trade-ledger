/*
 * Trade Ledger service worker: makes the app installable and lets it open offline.
 * - Scope /trade-ledger/ only. Handles same-origin GET requests inside that path.
 * - Network first: online behaviour is unchanged, the cache is only an offline
 *   fallback. Cross-origin requests (fonts, maps, any Google sign-in or API) and
 *   non-GET requests are never intercepted and never cached.
 * - App data lives in localStorage / IndexedDB and is never touched here.
 * Bump VERSION to drop old caches (only caches named "trade-ledger-sw-*" are removed).
 */
const VERSION = "v1";
const PREFIX = "trade-ledger-sw-";
const CACHE = PREFIX + VERSION;
const SCOPE = new URL(self.registration.scope);
const SHELL = ["./", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png", "icons/apple-touch-icon.png"];

const isPage = (r) => r.mode === "navigate" || (r.headers.get("accept") || "").includes("text/html");

function handled(request) {
  if (request.method !== "GET") return false;
  if (request.headers.has("range")) return false;
  const url = new URL(request.url);
  if (url.origin !== SCOPE.origin) return false; // cross-origin (Google, fonts, APIs): never touched
  if (!url.pathname.startsWith(SCOPE.pathname)) return false; // other apps on this origin
  if (url.pathname === SCOPE.pathname + "sw.js") return false;
  return true;
}

function cacheKey(request) {
  const url = new URL(request.url);
  url.hash = "";
  if (isPage(request)) url.search = "";
  return url.href;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.all(SHELL.map((p) => {
        const u = new URL(p, SCOPE).href;
        return fetch(new Request(u, { cache: "reload" })).then((res) => (res.ok ? cache.put(u, res) : null)).catch(() => null);
      })))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (!handled(request)) return;
  const key = cacheKey(request);
  event.respondWith(
    fetch(request).then((res) => {
      if (res.ok && res.type === "basic") {
        const copy = res.clone();
        event.waitUntil(caches.open(CACHE).then((c) => c.put(key, copy)).catch(() => {}));
      }
      return res;
    }).catch(async () => {
      const cache = await caches.open(CACHE);
      const hit = (await cache.match(key)) || (await cache.match(request.url, { ignoreSearch: true }));
      if (hit) return hit;
      if (isPage(request)) {
        const shell = (await cache.match(SCOPE.href)) || (await cache.match(new URL("index.html", SCOPE).href));
        if (shell) return shell;
      }
      return Response.error();
    }),
  );
});
