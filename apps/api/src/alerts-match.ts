/**
 * Alert matching engine — pure, unit-tested.
 *
 * The recurring-engagement loop: the weekly ETL publishes a diff of what
 * changed (new/dropped mining claims, new drilling permits). For each of a
 * user's alerts — scoped to a saved AOI and optionally filtered by state or
 * operator — we find the newly-added features that fall inside the AOI and
 * pass the filters. Those become the alert digest email.
 *
 * Kept dependency-free so the route handler, the scheduled cron, and the
 * tests all share exactly one matcher.
 */

export interface AlertBbox {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** A newly-added feature from a diff payload (claim or permit). Claims carry
 *  `serial`; permits carry `permitNo` + `operator`. Both carry lng/lat/state. */
export interface DiffFeature {
  lng: number;
  lat: number;
  state?: string;
  serial?: string;
  permitNo?: string;
  operator?: string;
  wellName?: string;
  formation?: string;
}

export interface AlertFilters {
  /** USPS state code, exact match (case-insensitive). */
  state?: string;
  /** Operator substring, case-insensitive (permits). */
  operator?: string;
}

/** True if (lng,lat) is inside the bbox (inclusive edges). */
export function pointInBbox(lng: number, lat: number, b: AlertBbox): boolean {
  return lng >= b.west && lng <= b.east && lat >= b.south && lat <= b.north;
}

/** Filter `added` features to those inside `bbox` that also satisfy the
 *  optional state/operator filters. Returns a new array (never mutates). */
export function matchDiffFeatures(
  added: readonly DiffFeature[],
  bbox: AlertBbox,
  filters: AlertFilters = {},
): DiffFeature[] {
  const wantState = filters.state?.trim().toUpperCase() || null;
  const wantOperator = filters.operator?.trim().toLowerCase() || null;
  return added.filter((f) => {
    if (!Number.isFinite(f.lng) || !Number.isFinite(f.lat)) return false;
    if (!pointInBbox(f.lng, f.lat, bbox)) return false;
    if (wantState && (f.state ?? '').trim().toUpperCase() !== wantState) return false;
    if (wantOperator && !(f.operator ?? '').toLowerCase().includes(wantOperator)) return false;
    return true;
  });
}

/** Parse a filters JSON blob (stored as TEXT in D1) into AlertFilters,
 *  tolerating malformed input. */
export function parseAlertFilters(json: string | null | undefined): AlertFilters {
  if (!json) return {};
  try {
    const obj = JSON.parse(json) as Record<string, unknown>;
    const out: AlertFilters = {};
    if (typeof obj.state === 'string') out.state = obj.state;
    if (typeof obj.operator === 'string') out.operator = obj.operator;
    return out;
  } catch {
    return {};
  }
}
