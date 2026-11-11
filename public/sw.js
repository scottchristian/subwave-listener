// Service worker: push notifications, plus a permanent cache for album art.
//
// WHY NO CACHING (the rule this file is built around)
// --------------------------------------------------
// The player polls live state and must never serve stale chunks, documents or
// API responses. So the fetch handler below matches ONE path and returns
// undefined for everything else, which leaves the browser's default behaviour
// exactly as it was. If you are here to add caching for something else: don't,
// unless it is genuinely immutable.
//
// WHY ART IS THE EXCEPTION
// ------------------------
// /api/cover/{subsonic_id} is served `public, max-age=86400, immutable` and
// keyed by a URL that is stable per track. The bytes for a given track never
// change, so cache-first has no staleness risk at all — the usual reason not
// to cache does not apply. That makes it the one thing worth keeping on the
// device indefinitely: the HTTP cache only promises 24 hours and re-fetches
// after that, which means a request to the host, which means a miss in the
// controller's 20-entry LRU, which means an upstream fetch from the music
// service. With this, a cover is fetched once per browser and then never again
// until the listener clears their cache.
//
// Two details that are easy to get wrong:
//
//   - Only a successful response is cached. The route answers 502 when the
//     upstream is unreachable, and a cache-first worker that cannot see the
//     status would store that failure forever — the artwork would be permanently
//     broken for that track with no way to recover short of clearing storage.
//     So the cache is populated with an explicit CORS fetch, which gives a
//     readable status, and anything that is not ok is passed straight through.
//
//   - The fetch is made with mode:"cors" while the <img> that triggered it is a
//     plain no-cors request. The response is therefore readable here, and
//     returning a CORS response to a no-cors request is permitted. This is what
//     avoids putting `crossorigin` on the artwork <img> elements, which would
//     couple every cover to the CORS header being present: if it ever went
//     missing, the images would break outright rather than degrade.
const COVER_PATH = "/api/cover/";
const COVER_CACHE = "causewayfm-cover-v1";

self.addEventListener("install", (event) => {
  // Take over immediately. Without this the worker would sit in "waiting"
  // until every tab closed, and the cover cache would only start filling on
  // some future visit.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop any cache from an earlier shape of this worker, so a changed
      // cover URL scheme cannot leave unusable entries behind forever.
      for (const name of await caches.keys()) {
        if (name !== COVER_CACHE) await caches.delete(name);
      }
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  // Scoped by path only, so this stays correct for any backend the station is
  // pointed at — LAN, self-hosted, or the public host — without the worker
  // needing to know that URL at build time.
  if (!url.pathname.startsWith(COVER_PATH)) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(COVER_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;

      try {
        const res = await fetch(req.url, { mode: "cors", credentials: "omit" });
        // `ok` is false for the 502 this route returns when the upstream is
        // down. Caching that would be permanent, invisible damage.
        if (res.ok) {
          // Cache the bytes, but return a separate copy: a response body can be
          // read once, and the caller still needs its own.
          await cache.put(req, res.clone());
        }
        return res;
      } catch (e) {
        // No CORS header, offline, upstream gone — whatever it was, do not make
        // the artwork worse than it would have been without this worker.
        return fetch(req);
      }
    })()
  );
});

self.addEventListener("push", (event) => {
  let data = { title: "Radio", body: "", url: "/admin" };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {}
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      // These must match the manifest's icon paths (lib/brandpaths.ts): /icons/*
      // does not exist, so notifications rendered with no icon at all.
      icon: "/brand/icons/icon-192.png",
      badge: "/brand/icons/icon-192.png",
      data: { url: data.url || "/admin" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/admin";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (w.url.includes(self.location.origin)) {
          w.navigate(url);
          return w.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
