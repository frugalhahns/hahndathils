/**
 * Offline support. The gorges and state parks around Ithaca have poor signal,
 * and this site is the itinerary, so it needs to open on one bar.
 *
 * Strategy per resource:
 *   navigation      network first, fall back to the cached page
 *   encrypted data  network first, fall back to cache (stale beats nothing)
 *   assets, photos  cache first, since filenames carry a content hash or a
 *                   timestamp and never change in place
 */

const CACHE = "hahndathils-v1";
const SHELL = ["./", "./index.html"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const fresh = await fetch(request);
    if (fresh.ok) cache.put(request, fresh.clone());
    return fresh;
  } catch (err) {
    const hit = await cache.match(request);
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const fresh = await fetch(request);
  if (fresh.ok) cache.put(request, fresh.clone());
  return fresh;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // uploads, fonts, anything external

  if (request.mode === "navigate") {
    event.respondWith(
      networkFirst(request).catch(() => caches.match("./index.html"))
    );
    return;
  }
  if (url.pathname.includes("/data/")) {
    event.respondWith(networkFirst(request));
    return;
  }
  if (url.pathname.includes("/assets/") || url.pathname.includes("/photos/")) {
    event.respondWith(cacheFirst(request));
  }
});
