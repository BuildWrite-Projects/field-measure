/* Field Measure — service worker.
 *
 * Its whole job is making the app open in a crawlspace with no signal. It keeps a
 * copy of the app's own files and serves those first, checking for a newer version
 * in the background.
 *
 * Bump VERSION whenever the app files change, or phones will keep serving the old
 * copy from cache.
 */
var VERSION = 'fm-v23';
var CORE = [
  './',
  'index.html',
  'config.js',
  'storage.js',
  'feedback.js',
  'manifest.webmanifest',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js'
];

/* Stock one file into the cache, defensively.
 *
 * Two things this has to survive on iOS Safari:
 *   - Building a Request with options Safari does not implement can throw, and a
 *     throw in here would abandon the whole install, leaving no offline support
 *     at all and no visible sign of it. Hence the nested try/catch.
 *   - cache.add() rejects anything that is not a normal 200, which includes the
 *     opaque responses you get from another domain. So fetch and put by hand.
 */
function cacheOne(cache, url) {
  var crossOrigin = url.indexOf('http') === 0;
  var req;
  try {
    req = crossOrigin ? new Request(url, { mode: 'no-cors' }) : new Request(url);
  } catch (e) {
    try { req = new Request(url); } catch (e2) { return Promise.resolve(); }
  }
  return fetch(req).then(function (res) {
    if (!res) return;
    if (res.ok || res.type === 'opaque') return cache.put(req, res);
  }).catch(function () {});
}

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(VERSION).then(function (cache) {
      /* One at a time, each swallowing its own failure, so a single missing file
         cannot stop the rest from being cached. */
      return Promise.all(CORE.map(function (u) { return cacheOne(cache, u); }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== VERSION; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  /* Never cache the database or anything auth-related. Stale measurements or a
     stale session would be worse than no answer at all. */
  if (url.hostname.indexOf('supabase') !== -1) return;

  /* The app's own code is fetched from the network first, so a new version is
     picked up the moment it is published, with the cache as the fallback when
     there is no signal. Everything else (icons, the Supabase library) is served
     from cache first, since those rarely change and speed matters more. */
  var sameOrigin = (url.origin === self.location.origin);
  var isAppCode = sameOrigin && /\.(html|js|webmanifest)$|\/$/.test(url.pathname);
  var networkFirst = (req.mode === 'navigate') || isAppCode;

  e.respondWith(
    caches.open(VERSION).then(function (cache) {
      /* App code skips the browser's own cache (the site lets it keep files
         for 10 minutes), so a newly published version arrives on the next
         open. no-cache still lets the server answer "unchanged" cheaply. If
         that fetch fails or comes back redirected (Safari refuses a redirected
         answer to a page load), fall back to the plain request. */
      function fresh() {
        if (!networkFirst) return fetch(req);
        var f;
        try { f = fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }); }
        catch (e) { return fetch(req); }
        return f.then(function (res) {
          if (!res || res.redirected) return fetch(req);
          return res;
        }, function () { return fetch(req); });
      }
      function fromNetwork() {
        return fresh().then(function (res) {
          if (res && (res.ok || res.type === 'opaque')) {
            cache.put(req, res.clone()).catch(function () {});
          }
          return res;
        });
      }

      if (networkFirst) {
        return fromNetwork().catch(function () {
          return cache.match(req).then(function (hit) {
            if (hit) return hit;
            if (req.mode === 'navigate') {
              /* Offline on a cold open: hand back the app shell by either of the
                 names it may have been cached under. */
              return cache.match('index.html').then(function (h2) {
                return h2 || cache.match('./') ||
                  new Response('', { status: 504, statusText: 'Offline' });
              });
            }
            return new Response('', { status: 504, statusText: 'Offline' });
          });
        });
      }

      return cache.match(req).then(function (hit) {
        if (hit) return hit;
        return fromNetwork().catch(function () {
          return new Response('', { status: 504, statusText: 'Offline' });
        });
      });
    })
  );
});
