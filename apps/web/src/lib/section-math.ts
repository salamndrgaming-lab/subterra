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

/** Intersection point of segments AB and CD, or null when they don't
 *  cross. Works in a local plane with cos(midLat) longitude correction
 *  — accurate for the short distances cross-sections cover. Endpoint
 *  touches count as intersections. Used to find where a fault trace
 *  crosses the section line. */
export function segmentIntersection(
  a: LngLat,
  b: LngLat,
  c: LngLat,
  d: LngLat,
): LngLat | null {
  const midLat = (a[1] + b[1] + c[1] + d[1]) / 4;
  const kx = EARTH_RADIUS_M * DEG * Math.cos(midLat * DEG);
  const ky = EARTH_RADIUS_M * DEG;
  const ax = a[0] * kx, ay = a[1] * ky;
  const bx = b[0] * kx, by = b[1] * ky;
  const cx = c[0] * kx, cy = c[1] * ky;
  const dx2 = d[0] * kx, dy2 = d[1] * ky;

  const r = { x: bx - ax, y: by - ay };
  const s = { x: dx2 - cx, y: dy2 - cy };
  const denom = r.x * s.y - r.y * s.x;
  if (Math.abs(denom) < 1e-12) return null; // parallel / collinear
  const t = ((cx - ax) * s.y - (cy - ay) * s.x) / denom;
  const u = ((cx - ax) * r.y - (cy - ay) * r.x) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  const ix = ax + t * r.x;
  const iy = ay + t * r.y;
  return [ix / kx, iy / ky];
}

/** All crossings of a polyline with segment AB, as fractional positions
 *  t (0..1) along AB, sorted ascending. A fault trace can wiggle across
 *  the section line more than once. */
export function polylineCrossings(a: LngLat, b: LngLat, line: LngLat[]): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < line.length; i++) {
    const hit = segmentIntersection(a, b, line[i]!, line[i + 1]!);
    if (!hit) continue;
    const { t } = projectOntoLine(hit, a, b);
    out.push(t);
  }
  return out.sort((x, y) => x - y);
}

// ─── Multi-segment (polyline) section helpers ───────────────────────
//
// For bent-line cross-sections (3+ vertices), every helper above
// operates on a single A→B segment. The polyline equivalents below
// concatenate per-segment results into a single 1-D coordinate space
// where 0 is the first vertex and `totalLength` is the last vertex.
// All distances/projections are in that unrolled coordinate space.

/** Per-segment metadata for a polyline. */
export interface PolylineSegment {
  a: LngLat;
  b: LngLat;
  lengthM: number;
  bearingDeg: number;
  /** Distance from the polyline's first vertex to this segment's start
   *  (the cumulative length of all preceding segments). */
  startOffsetM: number;
}

/** Total length in meters of a polyline (chain of LngLat vertices). */
export function polylineLength(vertices: LngLat[]): number {
  let sum = 0;
  for (let i = 0; i + 1 < vertices.length; i++) {
    sum += distanceMeters(vertices[i]!, vertices[i + 1]!);
  }
  return sum;
}

/** Per-segment {a, b, lengthM, bearingDeg, startOffsetM}. Empty when
 *  fewer than 2 vertices. Use as the canonical "unrolled" coordinate
 *  basis for everything else. */
export function polylineSegments(vertices: LngLat[]): PolylineSegment[] {
  const out: PolylineSegment[] = [];
  let acc = 0;
  for (let i = 0; i + 1 < vertices.length; i++) {
    const a = vertices[i]!;
    const b = vertices[i + 1]!;
    const lengthM = distanceMeters(a, b);
    out.push({
      a,
      b,
      lengthM,
      bearingDeg: bearingDeg(a, b),
      startOffsetM: acc,
    });
    acc += lengthM;
  }
  return out;
}

/** N+1 evenly-spaced points along the polyline, inclusive of both
 *  endpoints. Distributes by length so each point's "distance along"
 *  is i * totalLength / n. Falls back to interpolateLine(a, b, n) for
 *  the degenerate 2-vertex case so callers can use the polyline
 *  variant uniformly without paying a perf cost. */
export function interpolatePolyline(vertices: LngLat[], n: number): LngLat[] {
  if (n < 1) throw new Error('interpolatePolyline requires n >= 1');
  if (vertices.length < 2) throw new Error('interpolatePolyline requires >= 2 vertices');
  if (vertices.length === 2) return interpolateLine(vertices[0]!, vertices[1]!, n);
  const segs = polylineSegments(vertices);
  const total = segs[segs.length - 1]!.startOffsetM + segs[segs.length - 1]!.lengthM;
  const out: LngLat[] = [];
  let segIdx = 0;
  for (let i = 0; i <= n; i++) {
    const targetDist = (i / n) * total;
    // Advance to the segment containing targetDist.
    while (segIdx + 1 < segs.length && targetDist > segs[segIdx]!.startOffsetM + segs[segIdx]!.lengthM) {
      segIdx++;
    }
    const seg = segs[segIdx]!;
    const tLocal = seg.lengthM > 0 ? (targetDist - seg.startOffsetM) / seg.lengthM : 0;
    out.push([
      seg.a[0] + (seg.b[0] - seg.a[0]) * tLocal,
      seg.a[1] + (seg.b[1] - seg.a[1]) * tLocal,
    ]);
  }
  return out;
}

/** Project point p onto a polyline. Returns the best (smallest
 *  perpendicular distance) projection across all segments, with the
 *  along-polyline distance accumulated correctly. */
export function projectOntoPolyline(
  p: LngLat,
  vertices: LngLat[],
): { distanceAlong: number; distanceFrom: number; segmentIndex: number; t: number } {
  if (vertices.length < 2) {
    return { distanceAlong: 0, distanceFrom: Infinity, segmentIndex: 0, t: 0 };
  }
  if (vertices.length === 2) {
    const r = projectOntoLine(p, vertices[0]!, vertices[1]!);
    return { distanceAlong: r.distanceAlong, distanceFrom: r.distanceFrom, segmentIndex: 0, t: r.t };
  }
  const segs = polylineSegments(vertices);
  let best = {
    distanceAlong: 0,
    distanceFrom: Infinity,
    segmentIndex: 0,
    t: 0,
  };
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    const r = projectOntoLine(p, seg.a, seg.b);
    if (r.distanceFrom < best.distanceFrom) {
      best = {
        distanceAlong: seg.startOffsetM + r.distanceAlong,
        distanceFrom: r.distanceFrom,
        segmentIndex: i,
        t: r.t,
      };
    }
  }
  return best;
}

/** Fault-trace crossings against a polyline. Returns distances along
 *  the polyline (meters from the first vertex), sorted ascending. */
export function polylineCrossingsAll(vertices: LngLat[], faultLine: LngLat[]): number[] {
  if (vertices.length < 2) return [];
  const segs = polylineSegments(vertices);
  const out: number[] = [];
  for (const seg of segs) {
    for (let i = 0; i + 1 < faultLine.length; i++) {
      const hit = segmentIntersection(seg.a, seg.b, faultLine[i]!, faultLine[i + 1]!);
      if (!hit) continue;
      const { distanceAlong } = projectOntoLine(hit, seg.a, seg.b);
      out.push(seg.startOffsetM + distanceAlong);
    }
  }
  return out.sort((x, y) => x - y);
}

/** Given a distance along the polyline, return the LngLat at that
 *  point + which segment it falls on. Used to deep-link to fault
 *  midpoints, render endpoint markers, etc. */
export function lngLatAtDistance(
  vertices: LngLat[],
  distM: number,
): { lngLat: LngLat; segmentIndex: number } {
  if (vertices.length < 2) {
    return { lngLat: vertices[0] ?? [0, 0], segmentIndex: 0 };
  }
  const segs = polylineSegments(vertices);
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    if (distM <= seg.startOffsetM + seg.lengthM || i === segs.length - 1) {
      const tLocal = seg.lengthM > 0
        ? Math.max(0, Math.min(1, (distM - seg.startOffsetM) / seg.lengthM))
        : 0;
      return {
        lngLat: [
          seg.a[0] + (seg.b[0] - seg.a[0]) * tLocal,
          seg.a[1] + (seg.b[1] - seg.a[1]) * tLocal,
        ],
        segmentIndex: i,
      };
    }
  }
  return { lngLat: vertices[vertices.length - 1]!, segmentIndex: segs.length - 1 };
}
