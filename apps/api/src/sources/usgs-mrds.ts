/**
 * Real-data client for USGS Mineral Resources Data System (MRDS) point
 * occurrences. We use the MRDS WFS endpoint, which exposes the entire
 * dataset and supports BBOX + property filters.
 *
 *   https://mrdata.usgs.gov/wfs/mrds?service=WFS&version=2.0.0
 *
 * For per-record detail we hit the MRDS show endpoint:
 *   https://mrdata.usgs.gov/mrds/show-mrds.php?dep_id=10001234
 */

import type { BBoxArray, GeoJSONFeatureCollection, GeoJSONPoint } from '@subterra/shared';
import { cached } from './cache.js';

const WFS_ENDPOINT = process.env.USGS_MRDS_WFS ?? 'https://mrdata.usgs.gov/wfs/mrds';
const SHOW_ENDPOINT = process.env.USGS_MRDS_SHOW ?? 'https://mrdata.usgs.gov/mrds/show-mrds.php';

export interface MrdsProps {
  mrdsId: string;
  siteName: string | null;
  state: string | null;
  county: string | null;
  primaryCommodity: string | null;
  developmentStatus: string | null;
  depositType: string | null;
  discoveryYear: number | null;
}

export interface MrdsQuery {
  bbox?: BBoxArray;
  state?: string;
  commodity?: string;
  limit?: number;
}

export async function fetchMrds(q: MrdsQuery): Promise<GeoJSONFeatureCollection<MrdsProps>> {
  const params = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeNames: 'mrds:mrds',
    outputFormat: 'application/json',
    srsName: 'EPSG:4326',
    count: String(q.limit ?? 1000),
  });

  if (q.bbox) {
    const [w, s, e, n] = q.bbox;
    params.set('bbox', `${s},${w},${n},${e},EPSG:4326`);
  }
  if (q.state) params.set('CQL_FILTER', `state='${q.state.toUpperCase()}'`);
  if (q.commodity) {
    const filter = `commod1 ILIKE '%${q.commodity}%'`;
    const existing = params.get('CQL_FILTER');
    params.set('CQL_FILTER', existing ? `${existing} AND ${filter}` : filter);
  }

  const url = `${WFS_ENDPOINT}?${params.toString()}`;
  const key = `mrds:wfs:${params.toString()}`;

  return cached(key, 300, async () => {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) {
      throw new Error(`USGS MRDS WFS ${res.status}: ${(await res.text()).slice(0, 240)}`);
    }
    const body = (await res.json()) as GeoJSONFeatureCollection<Record<string, unknown>>;
    return {
      type: 'FeatureCollection',
      features: (body.features ?? []).map((f) => ({
        type: 'Feature' as const,
        geometry: f.geometry as GeoJSONPoint,
        properties: normalize(f.properties),
      })),
    };
  });
}

function normalize(p: Record<string, unknown>): MrdsProps {
  return {
    mrdsId: String(p['dep_id'] ?? p['mrds_id'] ?? ''),
    siteName: (p['site_name'] as string) ?? null,
    state: (p['state'] as string) ?? null,
    county: (p['county'] as string) ?? null,
    primaryCommodity: ((p['commod1'] as string) ?? '').toLowerCase() || null,
    developmentStatus: ((p['dev_stat'] as string) ?? '').toLowerCase() || null,
    depositType: ((p['model'] as string) ?? (p['dep_type'] as string) ?? '').toLowerCase() || null,
    discoveryYear: numberOrNull(p['disc_yr']),
  };
}

function numberOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function fetchMrdsById(mrdsId: string): Promise<{ html: string } | null> {
  const url = `${SHOW_ENDPOINT}?dep_id=${encodeURIComponent(mrdsId)}&format=fgdc-plus`;
  const key = `mrds:show:${mrdsId}`;
  return cached(key, 3600, async () => {
    const res = await fetch(url);
    if (!res.ok) return null;
    return { html: await res.text() };
  });
}
