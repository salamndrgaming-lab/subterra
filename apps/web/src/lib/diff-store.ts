/**
 * "Last seen tile-manifest version" persistence for the diff pill.
 *
 * The sidebar pill needs to know what version the user last loaded
 * so the /diff route can scope its added/dropped lists to "what
 * changed since you were last here." Persisted to localStorage
 * (per-browser, not per-account) so even anonymous visitors get the
 * signal — the same key shape as the view-mode store
 * (`subterra:<feature>:v<n>`) keeps the namespace consistent.
 *
 * Reads + writes are try/catch-wrapped: private-mode Safari throws on
 * localStorage access, in which case the pill simply doesn't surface
 * — better than a broken page.
 */

const STORAGE_KEY = 'subterra:diff-last-seen:v1';

export function getLastSeenVersion(): number | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function markSeen(version: number): void {
  if (typeof window === 'undefined') return;
  if (!Number.isFinite(version)) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, String(version));
  } catch {
    // private-mode Safari etc. — silently ignore.
  }
}
