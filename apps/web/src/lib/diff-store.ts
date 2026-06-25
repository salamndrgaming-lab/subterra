/**
 * "Last seen tile-manifest version" persistence for the diff pills.
 *
 * Each pill (claims, permits, future wells / leases) tracks its own
 * last-seen version independently — granular dismissal matters: a
 * landman who tracks permits doesn't want a claims-only week's worth
 * of churn to also clear their permit pill, and vice versa.
 *
 * Storage shape (v2):
 *   subterra:diff-last-seen:v2 = {"claims": 1716800000, "permits": 1716800000}
 *
 * Migration from v1 (bare number, claims-only) happens on first read:
 *   v1 value N → v2 = {"claims": N, "permits": null}
 *
 * Reads + writes are try/catch-wrapped: private-mode Safari throws on
 * localStorage access, in which case the pill simply doesn't surface
 * — better than a broken page.
 */

export type DiffSource = 'claims' | 'permits';

const STORAGE_KEY_V2 = 'subterra:diff-last-seen:v2';
const STORAGE_KEY_V1 = 'subterra:diff-last-seen:v1';

interface SeenState {
  claims: number | null;
  permits: number | null;
}

function emptyState(): SeenState {
  return { claims: null, permits: null };
}

function load(): SeenState {
  if (typeof window === 'undefined') return emptyState();
  try {
    const rawV2 = window.localStorage.getItem(STORAGE_KEY_V2);
    if (rawV2) {
      const parsed = JSON.parse(rawV2) as Partial<SeenState>;
      return {
        claims: numberOrNull(parsed.claims),
        permits: numberOrNull(parsed.permits),
      };
    }
    // v1 migration — bare number was claims-only.
    const rawV1 = window.localStorage.getItem(STORAGE_KEY_V1);
    if (rawV1) {
      const parsed = Number(rawV1);
      if (Number.isFinite(parsed)) {
        const migrated: SeenState = { claims: parsed, permits: null };
        // Persist v2 + leave v1 in place for one release cycle so a
        // rollback (re-deploying the old web build) still sees its
        // own key. The next markSeen call will keep v2 fresh.
        try {
          window.localStorage.setItem(STORAGE_KEY_V2, JSON.stringify(migrated));
        } catch {
          // best-effort
        }
        return migrated;
      }
    }
  } catch {
    // localStorage unreadable — return empty state.
  }
  return emptyState();
}

function numberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function getLastSeenVersion(source: DiffSource): number | null {
  return load()[source];
}

export function markSeen(source: DiffSource, version: number): void {
  if (typeof window === 'undefined') return;
  if (!Number.isFinite(version)) return;
  try {
    const current = load();
    const next: SeenState = { ...current, [source]: version };
    window.localStorage.setItem(STORAGE_KEY_V2, JSON.stringify(next));
  } catch {
    // private-mode Safari etc. — silently ignore.
  }
}
