/**
 * Diff payload fetcher.
 *
 * Calls the Worker's `/diff?since=<version>` route which serves the
 * ETL-produced "what changed between the prior run and the current
 * run" JSON. Always 200 (the Worker normalizes the empty case to an
 * empty-array response shape), so this fetcher has no 404 branch —
 * any non-200 is a real error.
 *
 * Mirrors the localhost → prod fallback in manifest.ts so a dev who
 * boots the web app without a local Worker still sees real diffs.
 */

import type { DiffPayload } from '@subterra/shared';

import { API_BASE, resolveApiBase } from './api-base';

const PROD_FALLBACK = 'https://subterra-api.salamndrgaming.workers.dev';

export async function fetchDiff(since: number): Promise<DiffPayload | null> {
  const primary = await tryFetch(API_BASE, since);
  if (primary.kind === 'ok') return primary.diff;

  const isLocalTarget = API_BASE.includes('localhost') || API_BASE.includes('127.0.0.1');
  if (isLocalTarget && PROD_FALLBACK !== resolveApiBase()) {
    const fallback = await tryFetch(PROD_FALLBACK, since);
    if (fallback.kind === 'ok') {
      console.info('[diff] local API unreachable — using prod diff read-only');
      return fallback.diff;
    }
  }

  if (primary.kind === 'empty') return null;
  throw primary.error;
}

type FetchOutcome =
  | { kind: 'ok'; diff: DiffPayload }
  | { kind: 'empty' }
  | { kind: 'error'; error: Error };

async function tryFetch(base: string, since: number): Promise<FetchOutcome> {
  try {
    const url = `${base}/diff?since=${encodeURIComponent(String(since))}`;
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (res.status === 404) return { kind: 'empty' };
    if (!res.ok) {
      const body = await res.text();
      return {
        kind: 'error',
        error: new Error(`Diff fetch ${res.status}: ${body.slice(0, 200)}`),
      };
    }
    const body = (await res.json()) as DiffPayload;
    if (
      typeof body.toVersion !== 'number' ||
      typeof body.fromVersion !== 'number' ||
      !Array.isArray(body.added) ||
      !Array.isArray(body.dropped)
    ) {
      return { kind: 'error', error: new Error('Diff response missing required fields') };
    }
    return { kind: 'ok', diff: body };
  } catch (err) {
    return { kind: 'error', error: err instanceof Error ? err : new Error(String(err)) };
  }
}
