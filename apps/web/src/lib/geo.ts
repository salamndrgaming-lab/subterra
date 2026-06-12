/**
 * Lightweight planar polygon utilities for AOI sizing + spatial filtering.
 *
 * No turf dependency — for small AOIs (the staking use case is rarely more
 * than a few thousand acres) the equirectangular projection at the AOI's
 * centroid latitude gives meter accuracy that's well below the precision
 * the underlying tile geometry was simplified to anyway.
 */

export type LngLat = [number, number];

const EARTH_RADIUS_M = 6_378_137;
const SQM_PER_ACRE = 4046.8564224;

/** Returns the AOI area in acres. Coordinates are [lng, lat] in WGS84.
 *  Polygon must be closed (last point == first); we close it ourselves
 *  if not. */
export function polygonAreaAcres(ring: LngLat[]): number {
  if (ring.length < 3) return 0;
  const closed = ring[0]![0] === ring[ring.length - 1]![0] && ring[0]![1] === ring[ring.length - 1]![1]
    ? ring
    : [...ring, ring[0]!];
  // Equirectangular projection at average latitude.
  let sumLat = 0;
  for (const p of closed) sumLat += p[1];
  const meanLat = sumLat / closed.length;
  const latToM = (Math.PI / 180) * EARTH_RADIUS_M;
  const lngToM = latToM * Math.cos((meanLat * Math.PI) / 180);
  // Shoelace in projected meters.
  let twiceSignedArea = 0;
  for (let i = 0; i < closed.length - 1; i++) {
    const a = closed[i]!;
    const b = closed[i + 1]!;
    twiceSignedArea += (a[0] * lngToM) * (b[1] * latToM) - (b[0] * lngToM) * (a[1] * latToM);
  }
  const sqm = Math.abs(twiceSignedArea / 2);
  return sqm / SQM_PER_ACRE;
}

/** Ray-casting point-in-polygon test. Polygon is an outer ring of [lng,lat]. */
export function pointInPolygon(point: LngLat, ring: LngLat[]): boolean {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Tight bounding box of a ring: [west, south, east, north]. */
export function ringBbox(ring: LngLat[]): [number, number, number, number] {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [lng, lat] of ring) {
    if (lng < w) w = lng;
    if (lng > e) e = lng;
    if (lat < s) s = lat;
    if (lat > n) n = lat;
  }
  return [w, s, e, n];
}

/** Best-effort centroid for a GeoJSON Polygon or MultiPolygon — used
 *  when a feature returned by queryRenderedFeatures only has a polygon
 *  geometry but the caller needs a single representative point (e.g.
 *  to project onto the cross-section line). Averages the outer ring
 *  vertices; for a MultiPolygon, uses the first polygon. Returns null
 *  for any other geometry shape. */
export function polygonCentroid(geom: GeoJSON.Geometry | undefined): LngLat | null {
  if (!geom) return null;
  if (geom.type === 'Polygon') return ringCentroid(geom.coordinates[0] as LngLat[] | undefined);
  if (geom.type === 'MultiPolygon') {
    const poly = geom.coordinates[0];
    if (!poly) return null;
    return ringCentroid(poly[0] as LngLat[] | undefined);
  }
  return null;
}

function ringCentroid(ring: LngLat[] | undefined): LngLat | null {
  if (!ring || ring.length === 0) return null;
  let sumLng = 0;
  let sumLat = 0;
  let n = 0;
  for (const [lng, lat] of ring) {
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    sumLng += lng;
    sumLat += lat;
    n++;
  }
  if (n === 0) return null;
  return [sumLng / n, sumLat / n];
}
