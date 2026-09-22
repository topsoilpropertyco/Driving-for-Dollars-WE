const CACHE = "five-pointes-private-shell-v32";
const SHELL = ["/", "/index.html", "/styles.css", "/app.js", "/coverage_preview.mjs", "/manifest.webmanifest", "/icon-ocean-sunny-192.png", "/apple-touch-icon.png", "/maps/grosse-pointe.geojson", "/maps/grosse-pointe-farms.geojson", "/maps/grosse-pointe-park.geojson", "/maps/grosse-pointe-shores.geojson", "/maps/grosse-pointe-woods.geojson"];
self.addEventListener("install", event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener("activate", event => event.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("five-pointes-private-shell-") && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())
));
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith("/api/")) return;
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
});
