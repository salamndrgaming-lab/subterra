/**
 * Tile manifest fetcher.
 *
 * Calls the Worker's `/manifest` route which proxies the manifest.json
 * the ETL job uploads to R2. The Worker returns 404 when no manifest
 * has been published yet — we surface that as `null` so the UI can
 * show a "no tiles yet" banner instead of an opaque error.
 */

import type { TileManifest } from '@subterra/shared';

const BASE = (import.meta.env.VITE_API_URL ?? 'http://localhost:8787').replace(/\/$/, '');

export async function fetchManifest(): Promise<TileManifest | null> {
  const res = await fetch(`${BASE}/manifest`, {
    headers: { accept: 'application/json' },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Manifest fetch ${res.status}: ${body.slice(0, 200)}`);
  }
  const body = (await res.json()) as TileManifest;
  if (typeof body.version !== 'number' || typeof body.pmtilesUrl !== 'string') {
    throw new Error('Manifest response missing required fields');
  }
  return body;
}
