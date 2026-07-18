/*! coi-serviceworker (SW-only) — derived from Guido Zuidhof's coi-serviceworker, MIT */
// Injects COOP/COEP (and CORP) into responses so the page can be cross-origin isolated
// and use SharedArrayBuffer — needed for the ./shell terminal's pyodide Ctrl-C on a
// static host (GitHub Pages) that can't set these headers itself.
//
// Unlike the upstream shim, this file is SW-only: it is registered ON DEMAND from the
// shell launcher (not auto-registered on page load), so visitors who never open the
// terminal never trigger the one-time isolation reload.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.status === 0) return response; // opaque — leave as-is
        const headers = new Headers(response.headers);
        headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
        headers.set('Cross-Origin-Opener-Policy', 'same-origin');
        headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      })
      .catch((error) => console.error(error)),
  );
});
