/* Subterra service worker — offline tile cache.
 *
 * Strategy by URL kind:
 *   - app shell (HTML/JS/CSS, same-origin): StaleWhileRevalidate
 *   - /manifest (version + URLs from the API Worker): StaleWhileRevalidate
 *   - basemap raster tiles (CartoDB / Esri / AWS Terrarium): CacheFirst, LRU-capped
 *   - PMTiles (.pmtiles via Range requests): cached only when explicitly
 *       precached via the postMessage protocol; on Range hits we slice
 *       from the cached full file and synthesize a 206 response.
 *
 * Versioning: cache names are namespaced under VERSION. Bump VERSION to
 * force a full cache eviction. Within PMTiles, we evict prior-version
 * URLs whenever a new version is precached (the URL carries ?v=N from
 * the manifest, so per-version files don't collide).
 *
 * No Workbox dep — the four strategies hand-roll to ~120 lines, and we
 * avoid a build-time workbox-build step.
 */

const VERSION = 'subterra-sw-v1';
const SHELL_CACHE = `${VERSION}-shell`;
const MANIFEST_CACHE = `${VERSION}-manifest`;
const TILES_CACHE = `${VERSION}-tiles`;
const PMTILES_CACHE = `${VERSION}-pmtiles`;

// LRU cap for opportunistically cached raster tiles. ~400 entries ≈
// well under any CacheStorage quota even at 100KB per tile.
const MAX_TILE_ENTRIES = 400;

self.addEventListener('install', () => {
  // No precache list at install time — app shell is populated
  // opportunistically on first navigation. skipWaiting lets the new SW
  // take over without requiring a page reload.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Purge any caches from older VERSION namespaces.
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // PMTiles file — Range-aware cache lookup.
  if (url.pathname.endsWith('.pmtiles')) {
    event.respondWith(handlePmtiles(req));
    return;
  }

  // Manifest JSON — fresh-if-online, cached-if-not.
  if (url.pathname.endsWith('/manifest')) {
    event.respondWith(staleWhileRevalidate(req, MANIFEST_CACHE));
    return;
  }

  // Raster tile providers — known hostnames, opportunistic CacheFirst.
  if (isRasterTileUrl(url)) {
    event.respondWith(cacheFirstWithLru(req, TILES_CACHE, MAX_TILE_ENTRIES));
    return;
  }

  // App shell — same-origin HTML / JS / CSS.
  if (url.origin === self.location.origin && isShellResource(req)) {
    event.respondWith(staleWhileRevalidate(req, SHELL_CACHE));
    return;
  }
  // Everything else: passthrough (default fetch behavior).
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;

  if (data.type === 'precache-pmtiles' && typeof data.url === 'string') {
    event.waitUntil(precachePmtiles(data.url, event.source));
    return;
  }
  if (data.type === 'check-pmtiles') {
    event.waitUntil(checkPmtilesStatus(event.source));
    return;
  }
});

// ────────────────────────────────────────────────────────────────────
// Strategy implementations
// ────────────────────────────────────────────────────────────────────

async function handlePmtiles(req) {
  const range = req.headers.get('range');
  const cache = await caches.open(PMTILES_CACHE);
  const cached = await cache.match(req.url, { ignoreSearch: false });

  if (cached) {
    if (range) {
      const ab = await cached.clone().arrayBuffer();
      return sliceRange(ab, range);
    }
    return cached.clone();
  }

  // Not in cache — passthrough to network. If offline, the PMTiles
  // library will get a network error and just skip rendering that tile.
  try {
    return await fetch(req);
  } catch {
    return new Response(null, {
      status: 504,
      statusText: 'Offline — PMTiles not cached. Click Save tiles for offline.',
    });
  }
}

/** Synthesize a 206 Partial Content response from a cached full file. */
function sliceRange(arrayBuffer, rangeHeader) {
  const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
  if (!match) return new Response(arrayBuffer, { status: 200 });
  const start = parseInt(match[1], 10);
  const totalLen = arrayBuffer.byteLength;
  const end = match[2] ? Math.min(parseInt(match[2], 10), totalLen - 1) : totalLen - 1;
  if (start > end || start >= totalLen) {
    return new Response(null, {
      status: 416,
      statusText: 'Range Not Satisfiable',
      headers: { 'Content-Range': `bytes */${totalLen}` },
    });
  }
  const slice = arrayBuffer.slice(start, end + 1);
  return new Response(slice, {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Range': `bytes ${start}-${end}/${totalLen}`,
      'Content-Length': String(slice.byteLength),
      'Accept-Ranges': 'bytes',
    },
  });
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const fetchPromise = fetch(req)
    .then((resp) => {
      if (resp && resp.ok) cache.put(req, resp.clone());
      return resp;
    })
    .catch(() => cached);
  return cached || fetchPromise;
}

async function cacheFirstWithLru(req, cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const resp = await fetch(req);
    if (resp && resp.ok) {
      cache.put(req, resp.clone());
      trimCache(cacheName, maxEntries).catch(() => {});
    }
    return resp;
  } catch {
    return new Response(null, { status: 504 });
  }
}

async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  const toDelete = keys.length - maxEntries;
  for (let i = 0; i < toDelete; i++) {
    await cache.delete(keys[i]);
  }
}

async function precachePmtiles(url, client) {
  const cache = await caches.open(PMTILES_CACHE);
  try {
    // Plain GET (no Range header) — we want the whole file once.
    const resp = await fetch(url, { cache: 'reload' });
    if (!resp.ok) throw new Error(`status ${resp.status}`);
    await cache.put(url, resp.clone());
    // Evict any prior-version PMTiles entries — we only ever cache one
    // version at a time, keyed by the manifest's ?v=N URL.
    const keys = await cache.keys();
    for (const r of keys) {
      if (r.url !== url) await cache.delete(r);
    }
    postToClient(client, { type: 'precache-pmtiles-done', url, ok: true });
  } catch (err) {
    postToClient(client, {
      type: 'precache-pmtiles-done',
      url,
      ok: false,
      error: String(err && err.message ? err.message : err),
    });
  }
}

async function checkPmtilesStatus(client) {
  const cache = await caches.open(PMTILES_CACHE);
  const keys = await cache.keys();
  const cachedUrl = keys[0] ? keys[0].url : null;
  postToClient(client, { type: 'pmtiles-status', cached: !!cachedUrl, url: cachedUrl });
}

function postToClient(client, message) {
  if (client && typeof client.postMessage === 'function') {
    client.postMessage(message);
  }
}

function isRasterTileUrl(url) {
  const h = url.hostname;
  if (
    h === 'a.basemaps.cartocdn.com' ||
    h === 'b.basemaps.cartocdn.com' ||
    h === 'c.basemaps.cartocdn.com' ||
    h === 'd.basemaps.cartocdn.com'
  ) {
    return true;
  }
  if (h === 'server.arcgisonline.com') return true;
  if (h === 's3.amazonaws.com' && url.pathname.startsWith('/elevation-tiles-prod/')) {
    return true;
  }
  return false;
}

function isShellResource(req) {
  if (req.mode === 'navigate') return true;
  const dest = req.destination;
  return dest === 'script' || dest === 'style' || dest === 'document' || dest === 'worker';
}
