import { describe, expect, it } from 'vitest';

import {
  pointInBbox,
  matchDiffFeatures,
  parseAlertFilters,
  type DiffFeature,
  type AlertBbox,
} from '../../apps/api/src/alerts-match';

const NV_BOX: AlertBbox = { west: -117, south: 39, east: -116, north: 40 };

const FEATURES: DiffFeature[] = [
  { serial: 'NMC1', lng: -116.5, lat: 39.5, state: 'NV' }, // inside
  { serial: 'NMC2', lng: -116.9, lat: 39.9, state: 'NV' }, // inside
  { serial: 'AZ1', lng: -111.0, lat: 34.0, state: 'AZ' }, // outside bbox
  { permitNo: 'P1', lng: -116.2, lat: 39.2, state: 'NV', operator: 'EOG RESOURCES' }, // inside
  { permitNo: 'P2', lng: -116.3, lat: 39.3, state: 'NV', operator: 'XTO ENERGY' }, // inside
];

describe('alert matching', () => {
  it('pointInBbox respects inclusive edges', () => {
    expect(pointInBbox(-116.5, 39.5, NV_BOX)).toBe(true);
    expect(pointInBbox(-117, 39, NV_BOX)).toBe(true); // corner
    expect(pointInBbox(-115.9, 39.5, NV_BOX)).toBe(false); // east of box
    expect(pointInBbox(-116.5, 41, NV_BOX)).toBe(false); // north of box
  });

  it('matches only features inside the bbox', () => {
    const m = matchDiffFeatures(FEATURES, NV_BOX);
    expect(m.length).toBe(4); // all but the AZ one
    expect(m.every((f) => f.state === 'NV')).toBe(true);
  });

  it('applies a state filter', () => {
    const m = matchDiffFeatures(FEATURES, { west: -120, south: 30, east: -110, north: 45 }, {
      state: 'az',
    });
    expect(m.length).toBe(1);
    expect(m[0]!.serial).toBe('AZ1');
  });

  it('applies an operator substring filter (case-insensitive)', () => {
    const m = matchDiffFeatures(FEATURES, NV_BOX, { operator: 'eog' });
    expect(m.length).toBe(1);
    expect(m[0]!.permitNo).toBe('P1');
  });

  it('drops features with non-finite coordinates', () => {
    const bad = [{ serial: 'X', lng: Number.NaN, lat: 39.5, state: 'NV' }];
    expect(matchDiffFeatures(bad, NV_BOX).length).toBe(0);
  });

  it('never mutates the input array', () => {
    const copy = [...FEATURES];
    matchDiffFeatures(FEATURES, NV_BOX, { operator: 'eog' });
    expect(FEATURES).toEqual(copy);
  });

  it('parseAlertFilters tolerates junk + extracts state/operator', () => {
    expect(parseAlertFilters(null)).toEqual({});
    expect(parseAlertFilters('not json')).toEqual({});
    expect(parseAlertFilters('{"state":"NV","operator":"EOG","x":1}')).toEqual({
      state: 'NV',
      operator: 'EOG',
    });
  });
});
