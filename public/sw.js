const CACHE_NAME    = "pos-cache-v2";
const CACHE_STATIC  = ["/", "/index.html", "/manifest.json"];

// ── Install: pre-cachear estáticos ────────────────────────────
self.addEventListener("install", event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CACHE_STATIC))
  );
});

// ── Activate: borrar caches viejos ────────────────────────────
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: estrategia híbrida ─────────────────────────────────
// · Supabase / APIs externas → Network-first (sin caché)
// · Estáticos del propio origen → Cache-first con fallback a red
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);

  // Ignorar peticiones no GET y extensiones de Chrome
  if (event.request.method !== "GET") return;
  if (url.protocol === "chrome-extension:") return;

  // APIs externas (Supabase, etc.) → solo red, sin caché
  if (url.origin !== self.location.origin) {
    event.respondWith(fetch(event.request).catch(() => new Response("", { status: 503 })));
    return;
  }

  // Estáticos propios → cache-first, red como fallback
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Solo cachear respuestas válidas de nuestro origen
        if (response && response.status === 200 && response.type === "basic") {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
