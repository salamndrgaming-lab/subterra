/**
 * Tile manifest fetcher.
 *
 * Calls the Worker's `/manifest` route which proxies the manifest.json
 * the ETL job uploads to R2. The Worker returns 404 when no manifest
 * has been published yet — we surface that as `null` so the UI can
 * show a "no tiles yet" banner instead of an opaque error.
 *
 * Local-dev fallback: when the resolved base is the localhost Worker
 * and it has no manifest (404, or wrangler dev isn't running at all),
 * we retry against the production API read-only. The manifest rewrites
 * its pmtilesUrl/featuresDbUrl to whichever origin served it, and the
 * /tiles + /features routes have wildcard CORS — so a localhost web
 * app pointed at prod tiles Just Works. Lets `npm run dev:web` show
 * real data without running the ETL or seeding local R2.
 */

import type { TileManifest } from '@subterra/shared';

import { API_BASE, resolveApiBase } from './api-base';

const PROD_FALLBACK = 'https://subterra-api.salamndrgaming.workers.dev';

export async function fetchManifest(): Promise<TileManifest | null> {
  const primary = await tryFetch(API_BASE);
  if (primary.kind === 'ok') return primary.manifest;

  // Only fall back when we were aiming at a local dev Worker — a
  // deployed site failing to reach its own API is a real error the
  // user should see, not silently mask with prod data.
  const isLocalTarget = API_BASE.includes('localhost') || API_BASE.includes('127.0.0.1');
  if (isLocalTarget && PROD_FALLBACK !== resolveApiBase()) {
    const fallback = await tryFetch(PROD_FALLBACK);
    if (fallback.kind === 'ok') {
      console.info('[manifest] local API empty/unreachable — using prod tiles read-only');
      return fallback.manifest;
    }
  }

  if (primary.kind === 'empty') return null;
  throw primary.error;
}

type FetchOutcome =
  | { kind: 'ok'; manifest: TileManifest }
  | { kind: 'empty' }
  | { kind: 'error'; error: Error };

async function tryFetch(base: string): Promise<FetchOutcome> {
  try {
    const res = await fetch(`${base}/manifest`, {
      headers: { accept: 'application/json' },
    });
    if (res.status === 404) return { kind: 'empty' };
    if (!res.ok) {
      const body = await res.text();
      return {
        kind: 'error',
        error: new Error(`Manifest fetch ${res.status}: ${body.slice(0, 200)}`),
      };
    }
    const body = (await res.json()) as TileManifest;
    if (typeof body.version !== 'number' || typeof body.pmtilesUrl !== 'string') {
      return { kind: 'error', error: new Error('Manifest response missing required fields') };
    }
    return { kind: 'ok', manifest: body };
  } catch (err) {
    return { kind: 'error', error: err instanceof Error ? err : new Error(String(err)) };
  }
}
