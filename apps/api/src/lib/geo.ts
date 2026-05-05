/**
 * Lightweight geo helpers used across routes.
 * For real workloads we delegate to PostGIS via SQL, but the scaffold
 * filters mock arrays in JS.
 */
import type { BBoxArray, GeoJSONFeature, GeoJSONFeatureCollection, GeoJSONPoint } from '@subterra/shared';

export function parseBBox(input: string | undefined): BBoxArray | null {
  if (!input) return null;
  const parts = input.split(',').map((s) => Number(s.trim()));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return null;
  return parts as BBoxArray;
}

export function pointInBBox(point: GeoJSONPoint, bbox: BBoxArray): boolean {
  const [west, south, east, north] = bbox;
  const [lng, lat] = point.coordinates;
  return lng >= west && lng <= east && lat >= south && lat <= north;
}

export function asFeatureCollection<T extends { id: string; geom: GeoJSONPoint | { type: string; coordinates: unknown } }>(
  items: T[],
): GeoJSONFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: items.map((item) => {
      const { geom, ...rest } = item;
      return {
        type: 'Feature',
        id: item.id,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        geometry: geom as any,
        properties: rest as Record<string, unknown>,
      } satisfies GeoJSONFeature;
    }),
  };
}

const EARTH_RADIUS_KM = 6371;

export function haversineKm(a: [number, number], b: [number, number]): number {
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const toRad = (n: number) => (n * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(s));
}
