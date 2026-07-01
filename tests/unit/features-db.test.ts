import { describe, expect, it } from 'vitest';

import {
  viewportOperatorSql,
  viewportFeaturesSql,
  nearestFeatureSql,
  productionForWellSql,
  isFeaturesDbAvailable,
} from '../../apps/web/src/lib/features-db-sql';

describe('features-db SQL builders', () => {
  it('operator rollup: one placeholder per layer, R-tree join, grouped + ordered', () => {
    const sql = viewportOperatorSql(['wells', 'drilling_permits'], 20);
    expect(sql).toContain('JOIN features_rtree r ON f.id = r.id');
    // 4 bbox placeholders + 2 layer placeholders
    expect((sql.match(/\?/g) ?? []).length).toBe(6);
    expect(sql).toContain('f.layer IN (?, ?)');
    expect(sql).toContain('GROUP BY f.operator');
    expect(sql).toContain('ORDER BY count DESC');
    expect(sql).toContain('LIMIT 20');
    // never aggregates null/empty operators
    expect(sql).toContain('f.operator IS NOT NULL');
  });

  it('operator rollup: placeholder count scales with layer count', () => {
    const sql = viewportOperatorSql(['wells', 'drilling_permits', 'refineries'], 5);
    expect(sql).toContain('f.layer IN (?, ?, ?)');
    expect((sql.match(/\?/g) ?? []).length).toBe(7); // 4 bbox + 3 layers
  });

  it('limit is validated + inlined (no injection, clamped)', () => {
    expect(viewportOperatorSql(['wells'], 0)).toContain('LIMIT 25'); // <1 → fallback
    expect(viewportOperatorSql(['wells'], 99999)).toContain('LIMIT 1000'); // clamp
    expect(viewportOperatorSql(['wells'], Number.NaN)).toContain('LIMIT 25');
    // a hostile "limit" can't reach the SQL — it's floored to a number
    expect(viewportOperatorSql(['wells'], 3.9)).toContain('LIMIT 3');
  });

  it('viewport features: 4 bbox params + 1 layer param, single layer filter', () => {
    const sql = viewportFeaturesSql(200);
    expect((sql.match(/\?/g) ?? []).length).toBe(5);
    expect(sql).toContain('f.layer = ?');
    expect(sql).toContain('LIMIT 200');
    expect(sql).toContain('SELECT f.id, f.layer, f.name, f.operator, f.lng, f.lat, f.props');
  });

  it('nearest feature: bbox filter + layer + squared-distance order, single row', () => {
    const sql = nearestFeatureSql();
    // 4 bbox + 1 layer + 4 distance placeholders = 9
    expect((sql.match(/\?/g) ?? []).length).toBe(9);
    expect(sql).toContain('f.layer = ?');
    expect(sql).toContain('ORDER BY (f.lng - ?)*(f.lng - ?) + (f.lat - ?)*(f.lat - ?) ASC');
    expect(sql).toContain('LIMIT 1');
  });

  it('production query: by well_api, chronological', () => {
    const sql = productionForWellSql();
    expect((sql.match(/\?/g) ?? []).length).toBe(1);
    expect(sql).toContain('FROM production WHERE well_api = ?');
    expect(sql).toContain('ORDER BY period ASC');
    expect(sql).toContain('oil_bbl');
    expect(sql).toContain('gas_mcf');
  });

  it('isFeaturesDbAvailable keys off a non-empty checksum', () => {
    expect(isFeaturesDbAvailable(null)).toBe(false);
    expect(isFeaturesDbAvailable(undefined)).toBe(false);
    // @ts-expect-error minimal partial manifest for the check
    expect(isFeaturesDbAvailable({ checksums: { featuresDb: '' } })).toBe(false);
    // @ts-expect-error minimal partial manifest for the check
    expect(isFeaturesDbAvailable({ checksums: { featuresDb: 'abc123' } })).toBe(true);
  });
});
