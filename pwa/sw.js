const cacheName = "screener-paper-v27";
const files = ["./", "./app.js", "./live-adapter.js", "./network.js", "./wallet-standard.js", "./policy.js", "./markets.js", "./market-panel.js", "./rules.js", "./copy.js", "./jupiter.js", "./scanner.js", "./devnet.js", "./style.css", "./engine.wasm", "./manifest.webmanifest",
  "./icon-192.png", "./icon-512.png", "./LICENSE"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(files)));
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith("screener-paper-") && key !== cacheName)
      .map(key => caches.delete(key))
  )));
});
self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(caches.open(cacheName).then(async cache => {
    const cached = await cache.match(request);
    return cached || fetch(request);
  }));
});
