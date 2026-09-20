/* Explain My Money — service worker.
 * Offline-first cache for the app shell. The app itself makes zero
 * network requests for financial processing and storage: all parsing,
 * OCR, and storage happen on-device. (Optional bring-your-own-key AI
 * phrasing is the only network use, per-call approved by the user.)
 * The service worker only serves the cached shell so the installed
 * app opens without connectivity.
 */
const CACHE = 'emm-shell-v1';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/app.js',
  './js/engine.js',
  './js/parsers.js',
  './js/store.js',
  './js/ocr.js',
  './js/llm.js',
  './vendor/pdf.min.js',
  './vendor/pdf.worker.min.js',
  './vendor/tesseract.min.js',
  './vendor/tesseract-worker.min.js',
  './vendor/tesseract-core.wasm.js',
  './vendor/tesseract-core.wasm',
  './vendor/eng.traineddata',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  // Only handle same-origin shell requests; the app makes no other fetches.
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return res;
      });
    })
  );
});
