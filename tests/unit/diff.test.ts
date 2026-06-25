import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchDiff, fetchPermitDiff } from '../../apps/web/src/lib/diff';

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

const VALID_PERMITS = {
  fromVersion: 1_716_700_000,
  toVersion: 1_716_800_000,
  added: [
    {
      permitNo: 'ND-32063',
      lng: -103.45,
      lat: 47.82,
      state: 'ND',
      operator: 'CONTINENTAL RESOURCES INC',
      wellName: 'GRAFF FEDERAL 12-1H',
      formation: 'BAKKEN',
      filedAt: '2026-06-20',
    },
    {
      permitNo: 'CO-400-12345',
      lng: -104.68,
      lat: 40.41,
      state: 'CO',
      operator: 'CIVITAS RESOURCES INC',
    },
  ],
  dropped: [
    {
      permitNo: 'ND-31000',
      lng: -103.1,
      lat: 47.5,
      state: 'ND',
    },
  ],
  byState: {
    added: { ND: 1, CO: 1 },
    dropped: { ND: 1 },
  },
};

describe('fetchPermitDiff', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns parsed permit diff on 200', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(VALID_PERMITS), { status: 200 })),
    ));
    const d = await fetchPermitDiff(0);
    expect(d?.toVersion).toBe(1_716_800_000);
    expect(d?.added.length).toBe(2);
    expect(d?.added[0].permitNo).toBe('ND-32063');
    expect(d?.added[0].operator).toBe('CONTINENTAL RESOURCES INC');
    expect(d?.dropped[0].permitNo).toBe('ND-31000');
  });

  it('returns null on 404 (no permit diff ever produced)', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(new Response('{"error":"no_diff"}', { status: 404 })),
    ));
    expect(await fetchPermitDiff(0)).toBeNull();
  });

  it('throws on 500', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(new Response('boom', { status: 500 })),
    ));
    await expect(fetchPermitDiff(0)).rejects.toThrow(/500/);
  });

  it('throws when required fields are missing', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ added: [] }), { status: 200 })),
    ));
    await expect(fetchPermitDiff(0)).rejects.toThrow(/missing required fields/);
  });

  it('hits the /diff/permits path (not /diff)', async () => {
    const stub = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ ...VALID_PERMITS, added: [], dropped: [] }), { status: 200 })),
    );
    vi.stubGlobal('fetch', stub);
    await fetchPermitDiff(0);
    const call = stub.mock.calls[0] as [string, unknown];
    expect(call[0]).toContain('/diff/permits');
    expect(call[0]).not.toMatch(/\/diff\?/);
  });

  it('accepts an empty-shape response (no new permits)', async () => {
    const empty = {
      fromVersion: 1_716_800_000,
      toVersion: 1_716_800_000,
      added: [],
      dropped: [],
    };
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(empty), { status: 200 })),
    ));
    const d = await fetchPermitDiff(1_716_800_000);
    expect(d?.added.length).toBe(0);
  });
});
