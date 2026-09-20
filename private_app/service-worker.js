const CACHE = "five-pointes-private-shell-v1";
const SHELL = ["/", "/index.html", "/styles.css", "/app.js"];
self.addEventListener("install", event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL))));
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith("/api/")) return;
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
});
