import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getLastSeenVersion, markSeen } from '../../apps/web/src/lib/diff-store';

const STORAGE_KEY_V1 = 'subterra:diff-last-seen:v1';
const STORAGE_KEY_V2 = 'subterra:diff-last-seen:v2';

// Tiny in-memory localStorage shim — diff-store only uses get/set/remove
// (no length, no key(), no clear()), so this covers the full surface.
const memStore = new Map<string, string>();
const fakeLocalStorage = {
  getItem(k: string) {
    return memStore.has(k) ? memStore.get(k)! : null;
  },
  setItem(k: string, v: string) {
    memStore.set(k, v);
  },
  removeItem(k: string) {
    memStore.delete(k);
  },
};

beforeAll(() => {
  // diff-store guards every read/write with `typeof window === 'undefined'`,
  // and never touches `window` at module-load — so the shim only needs
  // to be in place before the first test calls in.
  (globalThis as { window?: { localStorage: typeof fakeLocalStorage } }).window = {
    localStorage: fakeLocalStorage,
  };
});

describe('diff-store', () => {
  beforeEach(() => {
    memStore.clear();
  });

  afterEach(() => {
    memStore.clear();
  });

  it('returns null per source when neither key is set', () => {
    expect(getLastSeenVersion('claims')).toBeNull();
    expect(getLastSeenVersion('permits')).toBeNull();
  });

  it('reads v2 key for both sources', () => {
    fakeLocalStorage.setItem(
      STORAGE_KEY_V2,
      JSON.stringify({ claims: 1_716_700_000, permits: 1_716_800_000 }),
    );
    expect(getLastSeenVersion('claims')).toBe(1_716_700_000);
    expect(getLastSeenVersion('permits')).toBe(1_716_800_000);
  });

  it('migrates v1 (bare number) to v2 on first read — claims only', () => {
    fakeLocalStorage.setItem(STORAGE_KEY_V1, '1716750000');
    expect(getLastSeenVersion('claims')).toBe(1_716_750_000);
    expect(getLastSeenVersion('permits')).toBeNull();
    const written = JSON.parse(fakeLocalStorage.getItem(STORAGE_KEY_V2) ?? '{}');
    expect(written.claims).toBe(1_716_750_000);
    expect(written.permits).toBeNull();
  });

  it('markSeen(claims, N) leaves a prior permits value untouched', () => {
    fakeLocalStorage.setItem(
      STORAGE_KEY_V2,
      JSON.stringify({ claims: 1_716_700_000, permits: 1_716_800_000 }),
    );
    markSeen('claims', 1_716_900_000);
    expect(getLastSeenVersion('claims')).toBe(1_716_900_000);
    expect(getLastSeenVersion('permits')).toBe(1_716_800_000);
  });

  it('markSeen(permits, N) leaves a prior claims value untouched', () => {
    fakeLocalStorage.setItem(
      STORAGE_KEY_V2,
      JSON.stringify({ claims: 1_716_700_000, permits: null }),
    );
    markSeen('permits', 1_716_950_000);
    expect(getLastSeenVersion('claims')).toBe(1_716_700_000);
    expect(getLastSeenVersion('permits')).toBe(1_716_950_000);
  });

  it('ignores non-finite versions', () => {
    markSeen('claims', Number.NaN);
    markSeen('permits', Number.POSITIVE_INFINITY);
    expect(getLastSeenVersion('claims')).toBeNull();
    expect(getLastSeenVersion('permits')).toBeNull();
  });

  it('treats a corrupt v2 blob as empty state', () => {
    fakeLocalStorage.setItem(STORAGE_KEY_V2, '{not json');
    expect(getLastSeenVersion('claims')).toBeNull();
    expect(getLastSeenVersion('permits')).toBeNull();
  });
});
