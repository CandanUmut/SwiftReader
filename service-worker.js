const CACHE_NAME = "swiftreader-shell-v3";
const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./vendor/jszip.min.js",
  "./vendor/epub.min.js",
  "./manifest.json"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async cache => {
      const results = await Promise.allSettled(
        SHELL_ASSETS.map(asset => cache.add(asset))
      );
      const failed = results
        .map((result, index) => (result.status === "rejected" ? SHELL_ASSETS[index] : null))
        .filter(Boolean);
      if (failed.length) {
        console.warn("Service worker precache failed for:", failed);
      }
    })
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))
    )
  );
});

self.addEventListener("fetch", event => {
  const { request } = event;
  if (request.method !== "GET") return;
  if (new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.match(request).then(cached => cached || fetch(request))
  );
});
