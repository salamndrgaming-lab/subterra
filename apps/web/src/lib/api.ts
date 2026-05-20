/**
 * Thin fetch wrapper for the Subterra Worker API.
 *
 * Endpoints implemented in later phases return 501 with a clear body.
 * This client throws an Error with the server's `message` field so the
 * UI can show a real explanation, not a generic "failed to load".
 */

import type { TileManifest } from '@subterra/shared';

const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:8787';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    ...init,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const body = await res.text();
  const parsed = body ? (JSON.parse(body) as unknown) : null;
  if (!res.ok) {
    const msg =
      (parsed && typeof parsed === 'object' && 'message' in parsed && typeof parsed.message === 'string'
        ? parsed.message
        : `${res.status} ${res.statusText}`);
    throw new Error(msg);
  }
  return parsed as T;
}

export const api = {
  health: () =>
    request<{ status: 'ok' | 'degraded'; components: { db: string; tiles: string } }>(`/health`),
  manifest: () => request<TileManifest>(`/manifest`),
};
