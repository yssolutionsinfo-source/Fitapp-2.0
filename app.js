// Servicewerker. Cachet alleen de schil van de app, nooit je gegevens:
// maaltijden en gewicht moeten altijd vers uit Supabase komen, anders kijk je
// naar cijfers van gisteren zonder het door te hebben.

// Ophogen bij elke wijziging aan de bestanden hieronder, anders blijven
// bezoekers op de oude versie hangen.
const VERSION = "v5";
const SHELL = `shell-${VERSION}`;
const RUNTIME = `runtime-${VERSION}`;

const SHELL_FILES = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== SHELL && k !== RUNTIME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Nooit onderscheppen: je eigen gegevens en de analyse. Die horen live te zijn,
  // en een gecachet antwoord op een foto-analyse zou ronduit verkeerd zijn.
  if (
    url.pathname.startsWith("/api/") ||
    url.hostname.endsWith(".supabase.co")
  ) {
    return;
  }

  // Navigatie: eerst het netwerk, zodat je een nieuwe versie meteen ziet.
  // Zonder verbinding val je terug op de opgeslagen pagina.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put("/index.html", copy));
          return res;
        })
        .catch(() => caches.match("/index.html"))
    );
    return;
  }

  // Lettertypen en de Supabase-bibliotheek van een CDN: cache met verversing
  // op de achtergrond, zodat de app ook offline opstart.
  if (url.hostname === "cdn.jsdelivr.net" || url.hostname.endsWith("gstatic.com") || url.hostname.endsWith("googleapis.com")) {
    event.respondWith(
      caches.match(request).then((hit) => {
        const fresh = fetch(request)
          .then((res) => {
            if (res.ok) caches.open(RUNTIME).then((c) => c.put(request, res.clone()));
            return res;
          })
          .catch(() => hit);
        return hit || fresh;
      })
    );
    return;
  }

  // Eigen bestanden: eerst het netwerk, cache als terugval. Andersom levert
  // een oude app.js op na een nieuwe uitrol, en dan zoek je je scheel naar een
  // bug die allang gerepareerd is.
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() => caches.match(request))
    );
  }
});
