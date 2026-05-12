/**
 * Helpers for talking to public ArcGIS REST FeatureServer / MapServer endpoints.
 *
 * Most BLM and state-agency GIS portals expose layers as ArcGIS REST endpoints.
 * Esri 10.4+ supports `f=geojson` directly; for older deployments we fall back
 * to Esri JSON and convert client-side.
 */

import type {
  GeoJSONFeatureCollection,
  GeoJSONGeometry,
  GeoJSONMultiPolygon,
  GeoJSONLineString,
  GeoJSONPoint,
  Position,
  BBoxArray,
} from '@subterra/shared';

export interface ArcGISQuery {
  /** Where clause; defaults to `1=1`. */
  where?: string;
  /** Fields to return; default `*`. */
  outFields?: string;
  /** Optional bounding box `[west,south,east,north]` in EPSG:4326. */
  bbox?: BBoxArray;
  /** Max records (server-side cap usually 1000-2000). */
  resultRecordCount?: number;
  /** For pagination beyond 2000. */
  resultOffset?: number;
}

export class ArcGISError extends Error {
  constructor(public readonly url: string, public readonly status: number, body: string) {
    super(`ArcGIS ${status} ${url} :: ${body.slice(0, 240)}`);
  }
}

interface EsriRing {
  rings?: number[][][];
  paths?: number[][][];
  x?: number;
  y?: number;
  spatialReference?: { wkid?: number; latestWkid?: number };
}

interface EsriFeature {
  attributes: Record<string, unknown>;
  geometry?: EsriRing;
}

interface EsriResponse {
  features?: EsriFeature[];
  fields?: Array<{ name: string }>;
  geometryType?: string;
  exceededTransferLimit?: boolean;
  error?: { code: number; message: string };
}

/**
 * Run an ArcGIS REST query and return a GeoJSON FeatureCollection. We always
 * request `f=geojson`; if the server rejects it we retry with `f=json` and
 * convert the Esri geometries to GeoJSON manually.
 */
export async function arcgisQuery<P = Record<string, unknown>>(
  endpoint: string,
  q: ArcGISQuery = {},
  init?: RequestInit,
): Promise<GeoJSONFeatureCollection<P>> {
  const url = buildQueryUrl(endpoint, q, 'geojson');
  const res = await fetch(url, { ...init, headers: { accept: 'application/json', ...(init?.headers ?? {}) } });

  if (res.ok) {
    const text = await res.text();
    // Some servers return JSON even when geojson is requested if there's an
    // error envelope; sniff the body before trusting it.
    if (text.startsWith('{') && text.includes('"FeatureCollection"')) {
      return JSON.parse(text) as GeoJSONFeatureCollection<P>;
    }
    // fall through to esri-json conversion
    const esriUrl = buildQueryUrl(endpoint, q, 'json');
    const esriRes = await fetch(esriUrl);
    if (!esriRes.ok) throw new ArcGISError(esriUrl, esriRes.status, await esriRes.text());
    const esri = (await esriRes.json()) as EsriResponse;
    if (esri.error) throw new ArcGISError(esriUrl, 500, esri.error.message);
    return esriToGeoJson<P>(esri);
  }

  throw new ArcGISError(url, res.status, await res.text());
}

function buildQueryUrl(endpoint: string, q: ArcGISQuery, format: 'geojson' | 'json'): string {
  const params = new URLSearchParams({
    where: q.where ?? '1=1',
    outFields: q.outFields ?? '*',
    returnGeometry: 'true',
    outSR: '4326',
    f: format,
    resultRecordCount: String(q.resultRecordCount ?? 2000),
  });
  if (q.resultOffset) params.set('resultOffset', String(q.resultOffset));
  if (q.bbox) {
    const [w, s, e, n] = q.bbox;
    params.set('geometry', JSON.stringify({ xmin: w, ymin: s, xmax: e, ymax: n, spatialReference: { wkid: 4326 } }));
    params.set('geometryType', 'esriGeometryEnvelope');
    params.set('inSR', '4326');
    params.set('spatialRel', 'esriSpatialRelIntersects');
  }
  const sep = endpoint.includes('?') ? '&' : '?';
  return `${endpoint}${sep}${params.toString()}`;
}

function esriToGeoJson<P = Record<string, unknown>>(esri: EsriResponse): GeoJSONFeatureCollection<P> {
  const features: GeoJSONFeatureCollection<P>['features'] = [];
  for (const f of esri.features ?? []) {
    const geometry = esriGeometry(f.geometry, esri.geometryType);
    if (!geometry) continue;
    features.push({
      type: 'Feature',
      geometry,
      properties: f.attributes as P,
    });
  }
  return { type: 'FeatureCollection', features };
}

function esriGeometry(g: EsriRing | undefined, kind: string | undefined): GeoJSONGeometry | null {
  if (!g) return null;
  if (g.rings && g.rings.length) {
    const polygons = splitEsriRings(g.rings);
    const mp: GeoJSONMultiPolygon = {
      type: 'MultiPolygon',
      coordinates: polygons as unknown as GeoJSONMultiPolygon['coordinates'],
    };
    return mp;
  }
  if (g.paths && g.paths.length) {
    const ls: GeoJSONLineString = { type: 'LineString', coordinates: g.paths[0] as Position[] };
    return ls;
  }
  if (typeof g.x === 'number' && typeof g.y === 'number') {
    const pt: GeoJSONPoint = { type: 'Point', coordinates: [g.x, g.y] };
    return pt;
  }
  // Some servers omit geometry for tabular layers; skip silently.
  if (kind === 'esriGeometryNull') return null;
  return null;
}

/**
 * Esri rings: each ring is a closed polygon. Outer rings are clockwise,
 * inner (holes) are counter-clockwise. We use the area-sign heuristic to
 * group rings into MultiPolygon coordinates.
 */
function splitEsriRings(rings: number[][][]): number[][][][] {
  const polygons: number[][][][] = [];
  let current: number[][][] | null = null;
  for (const ring of rings) {
    const cw = signedArea(ring) < 0;
    if (cw || !current) {
      current = [ring];
      polygons.push(current);
    } else {
      current.push(ring);
    }
  }
  return polygons;
}

function signedArea(ring: number[][]): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (!a || !b) continue;
    sum += (b[0]! - a[0]!) * (b[1]! + a[1]!);
  }
  return sum / 2;
}
