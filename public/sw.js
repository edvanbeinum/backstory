/*
 * The only thing that can answer when the differ server is dead.
 *
 * differ installs as a standalone window, so it outlives the server that
 * serves it: quit the terminal, restart the laptop, and opening the app from
 * the dock gets the browser's raw "refused to connect" — no dock icon, no
 * explanation, no hint that the fix is one command. A service worker lives in
 * the browser rather than on the server, so it's still there to catch that
 * failed navigation and serve an offline page instead.
 *
 * Deliberately narrow: navigations only, network first, nothing else cached.
 * differ's data is git state that changes under it constantly — serving any
 * of it from a cache would be worse than showing nothing.
 */

// Bump when offline.html changes, or the old copy stays installed.
const CACHE = "differ-offline-v2";
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // `cache: "reload"` so a rebuilt offline page can't be shadowed by an
      // HTTP-cached copy of the previous one.
      .then((cache) => cache.add(new Request(OFFLINE_URL, { cache: "reload" })))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  // Everything else — RSC payloads, /api/*, static chunks — falls through to
  // the network untouched, and fails honestly when the server is gone.
  if (event.request.mode !== "navigate") return;

  event.respondWith(
    // Only a *network* failure lands in the catch. A 500 from a live server
    // is passed through: that's differ's own error page, which is truer than
    // claiming the server is down.
    fetch(event.request).catch(async () => {
      const cache = await caches.open(CACHE);
      return (await cache.match(OFFLINE_URL)) ?? Response.error();
    }),
  );
});
