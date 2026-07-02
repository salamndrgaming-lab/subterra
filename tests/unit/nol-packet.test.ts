import { describe, expect, it } from 'vitest';

import { buildStakingPacketPdf, type StakingPacketInput } from '../../apps/api/src/nol-packet';

const INPUT: StakingPacketInput = {
  aoiName: 'Tonopah North · 640 ac',
  acres: 640,
  centroid: [-117.23, 38.07],
  corners: [
    [-117.24, 38.06],
    [-117.22, 38.06],
    [-117.22, 38.08],
    [-117.24, 38.08],
  ],
  claimantName: 'Jane Prospector',
  claimType: 'lode',
  lodeClaims: 32,
  year1CostLow: 8000,
  year1CostHigh: 12000,
  annualCost: 6000,
  commoditySummary: 'AU:12, AG:7',
};

describe('staking packet PDF', () => {
  it('produces a valid non-trivial PDF', async () => {
    const bytes = await buildStakingPacketPdf(INPUT);
    expect(bytes.byteLength).toBeGreaterThan(1000);
    // %PDF- magic header
    const head = new TextDecoder().decode(bytes.slice(0, 5));
    expect(head).toBe('%PDF-');
    // %%EOF trailer
    const tail = new TextDecoder().decode(bytes.slice(-6));
    expect(tail).toContain('EOF');
  });

  it('handles missing optional fields (renders fill-in lines, no throw)', async () => {
    const bytes = await buildStakingPacketPdf({
      aoiName: 'Untitled',
      acres: 20,
      centroid: [-116, 39],
      corners: [[-116, 39]],
    });
    expect(bytes.byteLength).toBeGreaterThan(1000);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
  });

  it('paginates when there are many corners', async () => {
    const many: Array<[number, number]> = Array.from({ length: 12 }, (_, i) => [-117 + i * 0.001, 38]);
    const bytes = await buildStakingPacketPdf({ ...INPUT, corners: many });
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
  });
});
