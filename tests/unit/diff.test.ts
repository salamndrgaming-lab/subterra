import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchDiff } from '../../apps/web/src/lib/diff';

const VALID = {
  fromVersion: 1_716_700_000,
  toVersion: 1_716_800_000,
  added: [
    { serial: 'NMC123456', lng: -116.12, lat: 39.51, state: 'NV' },
    { serial: 'NMC123457', lng: -116.13, lat: 39.52, state: 'NV' },
  ],
  dropped: [
    { serial: 'NMC111111', lng: -114.0, lat: 38.2, state: 'NV' },
  ],
  byState: {
    added: { NV: 2 },
    dropped: { NV: 1 },
  },
};

describe('fetchDiff', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns parsed diff on 200', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(VALID), { status: 200 })),
    ));
    const d = await fetchDiff(0);
    expect(d?.toVersion).toBe(1_716_800_000);
    expect(d?.added.length).toBe(2);
    expect(d?.dropped[0].serial).toBe('NMC111111');
  });

  it('returns null on 404 (no diff ever produced)', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(new Response('{"error":"no_diff"}', { status: 404 })),
    ));
    expect(await fetchDiff(0)).toBeNull();
  });

  it('throws on 500', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(new Response('boom', { status: 500 })),
    ));
    await expect(fetchDiff(0)).rejects.toThrow(/500/);
  });

  it('throws when required fields are missing', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ added: [] }), { status: 200 })),
    ));
    await expect(fetchDiff(0)).rejects.toThrow(/missing required fields/);
  });

  it('encodes the since query parameter', async () => {
    const stub = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ ...VALID, added: [], dropped: [] }), { status: 200 })),
    );
    vi.stubGlobal('fetch', stub);
    await fetchDiff(1_716_700_000);
    const call = stub.mock.calls[0] as [string, unknown];
    expect(call[0]).toContain('since=1716700000');
  });

  it('accepts an empty-shape response (no new claims)', async () => {
    const empty = {
      fromVersion: 1_716_800_000,
      toVersion: 1_716_800_000,
      added: [],
      dropped: [],
    };
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(empty), { status: 200 })),
    ));
    const d = await fetchDiff(1_716_800_000);
    expect(d?.added.length).toBe(0);
    expect(d?.fromVersion).toBe(d?.toVersion);
  });
});
