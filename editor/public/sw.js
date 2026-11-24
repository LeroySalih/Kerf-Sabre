// Minimal app-shell cache so the Editor opens offline. Bump CACHE to invalidate.
// The Editor lives at /editor/ (the public website is at /, /pricing and /sign-in). Pages are fetched from the network first; offline,
// an Editor address (/editor/, /editor/?station=..., /editor/?offline=1) gets the cached Editor, and any other page only its own cached
// copy, so the landing page is never shown as the Editor or the Editor as the landing page. v1 cached the Editor as "/": it is dropped.
const CACHE = "kerf-editor-v2";
const EDITOR = "/editor/";
const SHELL = [EDITOR, "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))));
self.addEventListener("activate", (e) =>
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))),
);
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  const editorPage = e.request.mode === "navigate" && url.pathname === EDITOR;
  // one cached copy of the Editor, whatever its query (a query-less key also keeps the sign-in tokens of DINO returns out of the cache)
  const key = editorPage ? EDITOR : e.request;
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        if (r.ok && !r.redirected) {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put(key, copy));
        }
        return r;
      })
      .catch(() => caches.match(key).then((r) => r ?? Response.error())),
  );
});
