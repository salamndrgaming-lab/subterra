/**
 * Pure query builders + types for the features.db client.
 *
 * Split out from features-db.ts so it has ZERO runtime dependencies
 * (no sql.js-httpvfs, no `?url` asset imports) and can be unit-tested in
 * the node/jsdom test env without pulling a Web Worker + wasm bundle.
 * features-db.ts re-exports everything here.
 */

import type { TileManifest } from '@subterra/shared';

export interface Bbox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface OperatorRollup {
  operator: string;
  count: number;
  /** Comma-joined distinct layers this operator appears in (e.g. "wells,leases"). */
  layers: string;
}

export interface FeatureRow {
  id: number;
  layer: string;
  name: string | null;
  operator: string | null;
  lng: number;
  lat: number;
  /** Raw property bag as a JSON string (parse on demand). */
  props: string;
}

export interface ProductionRow {
  period: string;
  oil_bbl: number | null;
  gas_mcf: number | null;
  water_bbl: number | null;
  days: number | null;
}

/** True when the ETL has actually built + published the db (non-empty
 *  checksum). Lets the UI avoid a slow, doomed worker init before the
 *  first features.db lands in R2. */
export function isFeaturesDbAvailable(manifest: TileManifest | null | undefined): boolean {
  return !!manifest?.checksums?.featuresDb;
}

/** Clamp an untrusted limit to a sane integer — it's inlined into SQL
 *  (not a bound param) so it must be validated to a plain number. */
export function safeLimit(limit: number, fallback = 25): number {
  const n = Math.floor(limit);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, 1000);
}

/** SQL for the operator rollup within a bbox across the given layers.
 *  Bbox + layers are bound params (in this order): west, east, south,
 *  north, ...layers. `limit` is validated + inlined. */
export function viewportOperatorSql(layers: readonly string[], limit: number): string {
  const inClause = layers.map(() => '?').join(', ');
  return (
    'SELECT f.operator AS operator, COUNT(*) AS count, ' +
    'GROUP_CONCAT(DISTINCT f.layer) AS layers ' +
    'FROM features f JOIN features_rtree r ON f.id = r.id ' +
    'WHERE r.minx >= ? AND r.maxx <= ? AND r.miny >= ? AND r.maxy <= ? ' +
    "AND f.operator IS NOT NULL AND f.operator <> '' " +
    `AND f.layer IN (${inClause}) ` +
    'GROUP BY f.operator ORDER BY count DESC ' +
    `LIMIT ${safeLimit(limit)}`
  );
}

/** SQL for raw features of one layer within a bbox. Params: west, east,
 *  south, north, layer. `limit` validated + inlined. */
export function viewportFeaturesSql(limit: number): string {
  return (
    'SELECT f.id, f.layer, f.name, f.operator, f.lng, f.lat, f.props ' +
    'FROM features f JOIN features_rtree r ON f.id = r.id ' +
    'WHERE r.minx >= ? AND r.maxx <= ? AND r.miny >= ? AND r.maxy <= ? ' +
    'AND f.layer = ? ' +
    `LIMIT ${safeLimit(limit)}`
  );
}

/** SQL for the single nearest feature of `layer` to a click point, within
 *  a small bbox around it. Params: west, east, south, north (the bbox),
 *  then lng, lng, lat, lat (for the squared-distance order-by). Used to
 *  pull the FULL property bag from features.db for a clicked feature —
 *  the tiles drop properties to stay small, so the drawer can show more
 *  than the click gave us. */
export function nearestFeatureSql(): string {
  return (
    'SELECT f.id, f.layer, f.name, f.operator, f.lng, f.lat, f.props ' +
    'FROM features f JOIN features_rtree r ON f.id = r.id ' +
    'WHERE r.minx >= ? AND r.maxx <= ? AND r.miny >= ? AND r.maxy <= ? ' +
    'AND f.layer = ? ' +
    'ORDER BY (f.lng - ?)*(f.lng - ?) + (f.lat - ?)*(f.lat - ?) ASC ' +
    'LIMIT 1'
  );
}

/** SQL for a well's monthly production series, oldest first. Param:
 *  well_api. Powers the well-detail sparkline + cumulative. */
export function productionForWellSql(): string {
  return (
    'SELECT period, oil_bbl, gas_mcf, water_bbl, days ' +
    'FROM production WHERE well_api = ? ORDER BY period ASC'
  );
}
