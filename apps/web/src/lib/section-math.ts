/** Pure geometry helpers for the cross-section view.
 *
 * All inputs/outputs are `[lng, lat]` pairs in WGS84 degrees and
 * distances in meters. For short distances (< ~100km) the helpers
 * treat the lat/lng grid as a local plane with cos(lat) longitude
 * correction — accurate enough for cross-section visualization without
 * pulling in turf.js (a 200KB dep for what's <80 lines of math).
 *
 * Pure functions, no side effects — unit-tested in
 * tests/unit/section-math.test.ts. */

export type LngLat = [number, number];

const EARTH_RADIUS_M = 6_371_008.8;
const DEG = Math.PI / 180;

/** Great-circle distance between two points, meters. Haversine. */
export function distanceMeters(a: LngLat, b: LngLat): number {
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const dLat = (lat2 - lat1) * DEG;
  const dLng = (lng2 - lng1) * DEG;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial bearing from a → b, degrees, 0=N clockwise. */
export function bearingDeg(a: LngLat, b: LngLat): number {
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const φ1 = lat1 * DEG;
  const φ2 = lat2 * DEG;
  const Δλ = (lng2 - lng1) * DEG;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const θ = Math.atan2(y, x);
  return ((θ / DEG) + 360) % 360;
}

/** N+1 evenly-spaced points along the AB line, inclusive of both
 *  endpoints. Linear interp in lng/lat — fine for short cross-section
 *  distances. n must be >= 1. */
export function interpolateLine(a: LngLat, b: LngLat, n: number): LngLat[] {
  if (n < 1) throw new Error('interpolateLine requires n >= 1');
  const out: LngLat[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

/** Scalar projection of point p onto the line segment AB.
 *  Returns:
 *    - distanceAlong: meters from A along AB (clamped to [0, |AB|])
 *    - distanceFrom:  perpendicular distance from p to AB (meters)
 *    - t:             fractional position 0..1 along AB
 *  Treats the local area as a plane with cos(midLat) longitude
 *  correction; accurate for short segments (<100km) at non-polar lats. */
export function projectOntoLine(
  p: LngLat,
  a: LngLat,
  b: LngLat,
): { distanceAlong: number; distanceFrom: number; t: number } {
  const midLat = (a[1] + b[1]) / 2;
  const kx = EARTH_RADIUS_M * DEG * Math.cos(midLat * DEG);
  const ky = EARTH_RADIUS_M * DEG;
  const ax = a[0] * kx;
  const ay = a[1] * ky;
  const bx = b[0] * kx;
  const by = b[1] * ky;
  const px = p[0] * kx;
  const py = p[1] * ky;
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    const fromDist = Math.hypot(px - ax, py - ay);
    return { distanceAlong: 0, distanceFrom: fromDist, t: 0 };
  }
  const tRaw = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  const t = Math.max(0, Math.min(1, tRaw));
  const closestX = ax + t * dx;
  const closestY = ay + t * dy;
  const distanceFrom = Math.hypot(px - closestX, py - closestY);
  const lineLen = Math.sqrt(lenSq);
  return { distanceAlong: t * lineLen, distanceFrom, t };
}

/** Build a rectangular perpendicular buffer polygon around the AB
 *  line. Used as a visible outline while picking, and as the spatial
 *  filter for projecting MRDS occurrences onto the section. Returns
 *  a closed 5-vertex GeoJSON-style polygon ring. */
export function perpendicularBufferRing(
  a: LngLat,
  b: LngLat,
  halfWidthMeters: number,
): LngLat[] {
  const midLat = (a[1] + b[1]) / 2;
  const kx = EARTH_RADIUS_M * DEG * Math.cos(midLat * DEG);
  const ky = EARTH_RADIUS_M * DEG;
  const dx = (b[0] - a[0]) * kx;
  const dy = (b[1] - a[1]) * ky;
  const len = Math.hypot(dx, dy) || 1;
  // Perpendicular unit vector in projected space.
  const px = -dy / len;
  const py = dx / len;
  // Offset both endpoints by ± halfWidth perpendicular, then unproject
  // back to lng/lat.
  const ox = (px * halfWidthMeters) / kx;
  const oy = (py * halfWidthMeters) / ky;
  const a1: LngLat = [a[0] + ox, a[1] + oy];
  const a2: LngLat = [a[0] - ox, a[1] - oy];
  const b1: LngLat = [b[0] + ox, b[1] + oy];
  const b2: LngLat = [b[0] - ox, b[1] - oy];
  return [a1, b1, b2, a2, a1];
}
