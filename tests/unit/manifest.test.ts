import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchManifest } from '../../apps/web/src/lib/manifest';

const VALID = {
  version: 1,
  publishedAt: '2026-05-20T00:00:00Z',
  pmtilesUrl: 'https://tiles.subterra.app/tiles/subterra.pmtiles',
  featuresDbUrl: 'https://tiles.subterra.app/features/subterra-features.db',
  checksums: { pmtiles: 'abc', featuresDb: 'def' },
  counts: { mining_claims: 100_000 },
};

describe('fetchManifest', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns parsed manifest on 200', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(VALID), { status: 200 })),
    ));
    const m = await fetchManifest();
    expect(m?.version).toBe(1);
    expect(m?.counts.mining_claims).toBe(100_000);
  });

  it('returns null on 404 (no tiles published yet)', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(new Response('{"error":"no_manifest"}', { status: 404 })),
    ));
    expect(await fetchManifest()).toBeNull();
  });

  it('throws on 500', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(new Response('boom', { status: 500 })),
    ));
    await expect(fetchManifest()).rejects.toThrow(/500/);
  });

  it('throws when required fields are missing', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ version: 'oops' }), { status: 200 })),
    ));
    await expect(fetchManifest()).rejects.toThrow(/missing required/);
  });
});
