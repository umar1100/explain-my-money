/* Explain My Money — service worker.
 * Offline-first cache for the app shell. The app itself makes zero
 * network requests for financial processing and storage: all parsing,
 * OCR, and storage happen on-device. (Optional bring-your-own-key AI
 * phrasing is the only network use, per-call approved by the user.)
 * The service worker only serves the cached shell so the installed
 * app opens without connectivity.
 */
const CACHE = 'emm-shell-v14';      // app shell: tiny, installs fast — BUMP on any shell/JS change
const VCACHE = 'emm-vendor-v1';    // heavy vendor files: cached on first use
// The app shell is everything needed to boot and import statements.
// Heavy vendor files (PDF worker, Tesseract OCR engine + language data,
// ~15MB total) are NOT precached: they download on first use and are then
// cached, so first install stays quick on a phone.
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/app.js',
  './js/engine.js',
  './js/parsers.js',
  './js/generic-table.js',
  './js/store.js',
  './js/ocr.js',
  './js/llm.js',
  './js/lookup.js',
  './vendor/pdf.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];
const VENDOR_HEAVY = [
  './vendor/pdf.worker.min.js',
  './vendor/tesseract.min.js',
  './vendor/tesseract-worker.min.js',
  './vendor/tesseract-core.wasm.js',
  './vendor/tesseract-core.wasm',
  './vendor/eng.traineddata'
];
function isHeavyVendor(url) {
  var path = url.pathname;
  for (var i = 0; i < VENDOR_HEAVY.length; i++) {
    if (path.endsWith(VENDOR_HEAVY[i].slice(1))) return true;
  }
  return false;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE && k !== VCACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  // Only handle same-origin shell requests; the app makes no other fetches.
  if (url.origin !== self.location.origin) return;
  const heavy = isHeavyVendor(url);
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((res) => {
        // Cache a good copy for offline use: heavy vendor files go in
        // their own cache on first use; shell files in the shell cache.
        if (res && (res.status === 200 || res.status === 0)) {
          const copy = res.clone();
          const target = heavy ? VCACHE : CACHE;
          caches.open(target).then((cache) => cache.put(event.request, copy));
        }
        return res;
      });
    })
  );
});
