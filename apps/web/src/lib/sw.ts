/** Service worker client — registration + offline-cache helpers.
 *
 * Registration only runs in production builds (Vite HMR + SW is a
 * footgun in dev — HMR pages get served from cache and stale module
 * graphs are intercepted). The helpers gracefully no-op when no SW
 * controller is active. */

const SW_URL = '/sw.js';

interface PrecacheDoneMsg {
  type: 'precache-pmtiles-done';
  url: string;
  ok: boolean;
  error?: string;
}

interface StatusMsg {
  type: 'pmtiles-status';
  cached: boolean;
  url: string | null;
}

type IncomingMsg = PrecacheDoneMsg | StatusMsg;

export function registerSW(): void {
  if (typeof window === 'undefined') return;
  if (!('serviceWorker' in navigator)) return;
  if (import.meta.env.DEV) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register(SW_URL).catch((err) => {
      console.warn('[sw] registration failed', err);
    });
  });
}

function getController(): ServiceWorker | null {
  if (typeof navigator === 'undefined') return null;
  return navigator.serviceWorker?.controller ?? null;
}

function onSWMessage(
  match: (msg: IncomingMsg) => boolean,
  timeoutMs: number,
): Promise<IncomingMsg | null> {
  return new Promise((resolve) => {
    let done = false;
    const handler = (event: MessageEvent): void => {
      const data = event.data as IncomingMsg | undefined;
      if (!data || typeof data !== 'object') return;
      if (!match(data)) return;
      done = true;
      navigator.serviceWorker.removeEventListener('message', handler);
      resolve(data);
    };
    navigator.serviceWorker.addEventListener('message', handler);
    setTimeout(() => {
      if (done) return;
      navigator.serviceWorker.removeEventListener('message', handler);
      resolve(null);
    }, timeoutMs);
  });
}

/** Download the full PMTiles file and store it in the offline cache.
 *  Resolves with `{ ok: true }` on success, `{ ok: false, error }` on
 *  failure (network error, HTTP 4xx/5xx, no controller, etc.). */
export async function precachePmtiles(
  url: string,
): Promise<{ ok: boolean; error?: string }> {
  const controller = getController();
  if (!controller) return { ok: false, error: 'service worker not active' };

  const responsePromise = onSWMessage(
    (m) => m.type === 'precache-pmtiles-done' && m.url === url,
    // Allow up to 5 minutes for the full download — PMTiles files can
    // be hundreds of MB on slower connections.
    5 * 60_000,
  );
  controller.postMessage({ type: 'precache-pmtiles', url });
  const reply = (await responsePromise) as PrecacheDoneMsg | null;
  if (!reply) return { ok: false, error: 'service worker timed out' };
  return { ok: reply.ok, error: reply.error };
}

/** Check whether the PMTiles file is currently in the offline cache.
 *  Resolves with the cached URL (so the UI can show which version is
 *  cached) or null if not cached / SW not active. */
export async function checkPmtilesCached(): Promise<{
  cached: boolean;
  url: string | null;
}> {
  const controller = getController();
  if (!controller) return { cached: false, url: null };

  const responsePromise = onSWMessage((m) => m.type === 'pmtiles-status', 2_000);
  controller.postMessage({ type: 'check-pmtiles' });
  const reply = (await responsePromise) as StatusMsg | null;
  if (!reply) return { cached: false, url: null };
  return { cached: reply.cached, url: reply.url };
}
