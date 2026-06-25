/**
 * Diff payload fetchers — one per source (claims, permits).
 *
 * Calls the Worker's `/diff?since=<version>` (claims) and
 * `/diff/permits?since=<version>` (permits) routes. Each returns the
 * ETL-produced "what changed since the prior run" JSON. The Worker
 * normalizes the empty case to an empty-array response shape, so a
 * 200 with `added.length === 0` is the steady-state "no news" reply.
 *
 * Mirrors the localhost → prod fallback in manifest.ts so a dev who
 * boots the web app without a local Worker still sees real diffs.
 */

import type { DiffPayload, DiffPermitPayload } from '@subterra/shared';

import { API_BASE, resolveApiBase } from './api-base';

const PROD_FALLBACK = 'https://subterra-api.salamndrgaming.workers.dev';

type FetchOutcome<T> =
  | { kind: 'ok'; diff: T }
  | { kind: 'empty' }
  | { kind: 'error'; error: Error };

/** Claims diff — BLM mining-claim adds/drops between ETL runs. */
export async function fetchDiff(since: number): Promise<DiffPayload | null> {
  return fetchDiffAt<DiffPayload>('/diff', since, validateClaimsDiff);
}

/** Permits diff — O&G drilling-permit adds/drops. Leading-indicator
 *  signal: an operator files weeks-to-months before spud. */
export async function fetchPermitDiff(
  since: number,
): Promise<DiffPermitPayload | null> {
  return fetchDiffAt<DiffPermitPayload>('/diff/permits', since, validatePermitsDiff);
}

async function fetchDiffAt<T>(
  path: string,
  since: number,
  validate: (body: unknown) => body is T,
): Promise<T | null> {
  const primary = await tryFetch<T>(API_BASE, path, since, validate);
  if (primary.kind === 'ok') return primary.diff;

  const isLocalTarget = API_BASE.includes('localhost') || API_BASE.includes('127.0.0.1');
  if (isLocalTarget && PROD_FALLBACK !== resolveApiBase()) {
    const fallback = await tryFetch<T>(PROD_FALLBACK, path, since, validate);
    if (fallback.kind === 'ok') {
      console.info(`[diff] local API unreachable — using prod ${path} read-only`);
      return fallback.diff;
    }
  }

  if (primary.kind === 'empty') return null;
  throw primary.error;
}

async function tryFetch<T>(
  base: string,
  path: string,
  since: number,
  validate: (body: unknown) => body is T,
): Promise<FetchOutcome<T>> {
  try {
    const url = `${base}${path}?since=${encodeURIComponent(String(since))}`;
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (res.status === 404) return { kind: 'empty' };
    if (!res.ok) {
      const body = await res.text();
      return {
        kind: 'error',
        error: new Error(`Diff fetch ${res.status}: ${body.slice(0, 200)}`),
      };
    }
    const body: unknown = await res.json();
    if (!validate(body)) {
      return { kind: 'error', error: new Error('Diff response missing required fields') };
    }
    return { kind: 'ok', diff: body };
  } catch (err) {
    return { kind: 'error', error: err instanceof Error ? err : new Error(String(err)) };
  }
}

function validateClaimsDiff(body: unknown): body is DiffPayload {
  if (!body || typeof body !== 'object') return false;
  const b = body as Partial<DiffPayload>;
  return (
    typeof b.toVersion === 'number' &&
    typeof b.fromVersion === 'number' &&
    Array.isArray(b.added) &&
    Array.isArray(b.dropped)
  );
}

function validatePermitsDiff(body: unknown): body is DiffPermitPayload {
  if (!body || typeof body !== 'object') return false;
  const b = body as Partial<DiffPermitPayload>;
  return (
    typeof b.toVersion === 'number' &&
    typeof b.fromVersion === 'number' &&
    Array.isArray(b.added) &&
    Array.isArray(b.dropped)
  );
}
