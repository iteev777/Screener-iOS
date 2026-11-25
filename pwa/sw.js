const cacheName = "screener-paper-v46";
const files = ["./", "./index.html", "./app.js", "./dashboard-nav.js", "./visual-rules.js", "./live-adapter.js", "./network.js", "./wallet-standard.js", "./policy.js", "./markets.js", "./market-panel.js", "./rules.js", "./copy.js", "./jupiter.js", "./scanner.js", "./market-tape.js", "./market-resolver.js", "./pool-stream.js", "./candidate-analyst.js", "./analyst-worker.js", "./momentum.js", "./momentum-learning.js", "./paper-signal-model.js", "./agent-dashboard.js", "./trojan-analysis.js", "./trojan-discovery.js", "./trojan-entry.js", "./trojan-pools.js", "./trojan-security.js", "./devnet.js", "./style.css", "./engine.wasm", "./manifest.webmanifest",
  "./icon-192.png", "./icon-512.png", "./LICENSE"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(files)));
});
self.addEventListener("message", event => {
  if (event.data?.type === "ACTIVATE_UPDATE") event.waitUntil(self.skipWaiting());
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
    if (request.mode === "navigate") {
      try { const fresh = await fetch(request, {cache:"no-store"}); if (fresh.ok) return fresh; } catch {}
    }
    const cached = await cache.match(request);
    if (cached) return cached;
    try { return await fetch(request); }
    catch (error) {
      if (request.mode === "navigate" && new URL(request.url).href.startsWith(self.registration.scope)) {
        const shell = await cache.match(new URL("./", self.registration.scope).href);
        if (shell) return shell;
      }
      throw error;
    }
  }));
});
