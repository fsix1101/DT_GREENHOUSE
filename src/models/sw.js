const CACHE_VERSION = "agti-farm-v1";
const RUNTIME_CACHE = `runtime-${CACHE_VERSION}`;

function isCacheableRequest(request) {
  if (request.method !== "GET") return false;
  if (request.headers.has("range")) return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;

  const path = url.pathname.toLowerCase();
  if (path === "/" || path.endsWith(".html")) return true;
  if (path.startsWith("/assets/")) return true;

  const exts = [
    ".glb",
    ".gltf",
    ".bin",
    ".obj",
    ".mtl",
    ".js",
    ".css",
    ".wasm",
    ".json",
    ".svg",
    ".ico",
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
    ".gif",
    ".hdr",
    ".exr",
    ".ktx2",
    ".basis",
    ".dds",
    ".tif",
    ".tiff"
  ];
  return exts.some((ext) => path.endsWith(ext));
}

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(RUNTIME_CACHE));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.map((key) => {
          if (key === RUNTIME_CACHE) return Promise.resolve();
          if (key.startsWith("runtime-agti-farm-")) return caches.delete(key);
          return Promise.resolve();
        })
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (!isCacheableRequest(request)) return;

  const url = new URL(request.url);
  const path = url.pathname.toLowerCase();

  if (path === "/" || path.endsWith(".html")) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(RUNTIME_CACHE);
        try {
          const response = await fetch(request);
          if (response && response.ok) {
            cache.put(request, response.clone());
          }
          return response;
        } catch {
          const cached = await cache.match(request, { ignoreSearch: false });
          if (cached) return cached;
          return new Response("offline", { status: 503 });
        }
      })()
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(RUNTIME_CACHE);
      const cached = await cache.match(request, { ignoreSearch: false });
      const fetchPromise = fetch(request)
        .then((response) => {
          if (response && response.ok) {
            cache.put(request, response.clone());
          }
          return response;
        })
        .catch(() => null);

      if (cached) {
        event.waitUntil(fetchPromise);
        return cached;
      }

      const net = await fetchPromise;
      if (net) return net;
      return new Response("offline", { status: 503 });
    })()
  );
});
