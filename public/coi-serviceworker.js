/*! coi-serviceworker v0.1.7 - Guido Zuidhof and contributors, licensed under MIT */
// Grants cross-origin isolation (SharedArrayBuffer) on static hosts that cannot set
// COEP/COOP response headers themselves (e.g. GitHub Pages). Needed for the ./shell
// terminal's pyodide Ctrl-C interrupt. On a visitor's first load it registers itself
// and reloads the page once; thereafter every navigation is already isolated.
let coepCredentialless = false;
if (typeof window === 'undefined') {
  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

  self.addEventListener('message', (ev) => {
    if (!ev.data) return;
    if (ev.data.type === 'deregister') {
      self.registration.unregister().then(() => self.clients.matchAll()).then((clients) => {
        clients.forEach((client) => client.navigate(client.url));
      });
    } else if (ev.data.type === 'coepCredentialless') {
      coepCredentialless = ev.data.value;
    }
  });

  self.addEventListener('fetch', (event) => {
    const r = event.request;
    if (r.cache === 'only-if-cached' && r.mode !== 'same-origin') return;

    const request =
      coepCredentialless && r.mode === 'no-cors'
        ? new Request(r, { credentials: 'omit' })
        : r;

    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.status === 0) return response;
          const newHeaders = new Headers(response.headers);
          newHeaders.set('Cross-Origin-Embedder-Policy', coepCredentialless ? 'credentialless' : 'require-corp');
          if (!coepCredentialless) newHeaders.set('Cross-Origin-Resource-Policy', 'cross-origin');
          newHeaders.set('Cross-Origin-Opener-Policy', 'same-origin');
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders,
          });
        })
        .catch((e) => console.error(e)),
    );
  });
} else {
  (() => {
    const reloadedBySelf = window.sessionStorage.getItem('coiReloadedBySelf');
    window.sessionStorage.removeItem('coiReloadedBySelf');
    const coepDegrading = reloadedBySelf === 'coepdegrade';

    const coi = {
      shouldRegister: () => !reloadedBySelf,
      shouldDeregister: () => false,
      coepCredentialless: () => true,
      coepDegrade: () => true,
      doReload: () => window.location.reload(),
      quiet: false,
    };

    const n = navigator;
    const controlling = n.serviceWorker && n.serviceWorker.controller;

    if (controlling) {
      n.serviceWorker.controller.postMessage({ type: 'coepCredentialless', value: coi.coepCredentialless() });
    }

    if (controlling && !window.crossOriginIsolated && coi.shouldDeregister()) {
      n.serviceWorker.controller.postMessage({ type: 'deregister' });
    }

    if (window.crossOriginIsolated !== false || !coi.shouldRegister()) return;

    if (!window.isSecureContext) {
      if (!coi.quiet) console.log('COOP/COEP Service Worker not registered, a secure context is required.');
      return;
    }

    if (n.serviceWorker) {
      n.serviceWorker.register(window.document.currentScript.src).then((registration) => {
        if (!coi.quiet) console.log('COOP/COEP Service Worker registered', registration.scope);
        registration.addEventListener('updatefound', () => {
          if (!coi.quiet) console.log('Reloading page to make use of updated COOP/COEP Service Worker.');
          window.sessionStorage.setItem('coiReloadedBySelf', 'updatefound');
          coi.doReload();
        });
        if (registration.active && !n.serviceWorker.controller) {
          if (!coi.quiet) console.log('Reloading page to make use of COOP/COEP Service Worker.');
          window.sessionStorage.setItem('coiReloadedBySelf', 'notcontrolling');
          coi.doReload();
        }
      }, (err) => {
        if (!coi.quiet) console.error('COOP/COEP Service Worker failed to register:', err);
      });
    }
  })();
}
