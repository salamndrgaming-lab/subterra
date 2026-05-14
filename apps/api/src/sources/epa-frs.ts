/**
 * EPA Facility Registry Service (FRS) — nationwide. Free, no key.
 *
 * EPA publishes a hosted FeatureServer with every regulated facility in
 * the US, including oil/gas wells, refineries, mines, processing plants,
 * and storage terminals. We filter by NAICS code:
 *   211    Oil and Gas Extraction
 *   2111   Crude Petroleum & Natural Gas Extraction
 *   2121   Coal Mining
 *   2122   Metal Ore Mining
 *   2123   Nonmetallic Mineral Mining & Quarrying
 *
 * Service:
 *   https://geopub.epa.gov/arcgis/rest/services/EMEF/FRS_INTERESTS/MapServer
 *
 * This is the canonical "always works" nationwide oil/gas + mining source.
 */

import type { BBoxArray, GeoJSONFeatureCollection, GeoJSONPoint } from '@subterra/shared';
import { arcgisQuery } from './arcgis.js';
import { cached } from './cache.js';

const ENDPOINT =
  process.env.EPA_FRS_LAYER ??
  'https://geopub.epa.gov/arcgis/rest/services/EMEF/FRS_INTERESTS/MapServer/0/query';

export interface EpaFrsProps {
  facilityId: string | null;
  name: string | null;
  state: string | null;
  county: string | null;
  city: string | null;
  naicsCode: string | null;
  naicsName: string | null;
  sicCode: string | null;
  programs: string | null;
}

export type EpaFrsKind = 'oilgas' | 'mining' | 'all';

// NAICS prefixes per category
const NAICS_FILTERS: Record<EpaFrsKind, string[]> = {
  oilgas: ['211'],                          // Oil & Gas Extraction
  mining: ['2121', '2122', '2123'],         // Coal, Metal Ore, Nonmetallic Mining
  all: ['211', '2121', '2122', '2123'],
};

export async function fetchEpaFrs(
  kind: EpaFrsKind,
  q: { bbox?: BBoxArray; state?: string; limit?: number } = {},
): Promise<GeoJSONFeatureCollection<EpaFrsProps> & { meta?: { unavailable?: string; endpoint?: string } }> {
  const naics = NAICS_FILTERS[kind];
  // EPA FRS uses several NAICS-related field names depending on the service.
  // We OR across the candidates so the where works regardless. If a field
  // doesn't exist on this service version, ArcGIS raises a clearer error
  // than 500 (which we then surface as meta.unavailable).
  const orFor = (prefix: string) =>
    [`NAICS LIKE '${prefix}%'`, `PGM_NAICS LIKE '${prefix}%'`, `NAICS_CODES LIKE '%${prefix}%'`].join(' OR ');
  const naicsClauses = naics.map((p) => `(${orFor(p)})`).join(' OR ');
  const where = [`(${naicsClauses})`, q.state ? `STATE_CODE = '${q.state.toUpperCase()}'` : null]
    .filter(Boolean)
    .join(' AND ');

  const key = `epa-frs:${kind}:${where}:${(q.bbox ?? []).join(',')}:${q.limit ?? 2000}`;
  try {
    return await cached(key, 600, async () => {
      const raw = await arcgisQuery<Record<string, unknown>>(ENDPOINT, {
        where,
        bbox: q.bbox,
        resultRecordCount: q.limit ?? 2000,
        // Restrict outFields so a non-existent column doesn't 500 the query.
        outFields: 'REGISTRY_ID,PRIMARY_NAME,STATE_CODE,COUNTY_NAME,CITY_NAME,NAICS,PGM_NAICS',
      });
      return {
        type: 'FeatureCollection' as const,
        features: raw.features
          .filter((f) => f.geometry?.type === 'Point')
          .map((f) => ({
            type: 'Feature' as const,
            geometry: f.geometry as GeoJSONPoint,
            properties: normalize(f.properties),
          })),
      };
    });
  } catch (err) {
    console.warn(`[epa-frs:${kind}] upstream failed: ${(err as Error).message.slice(0, 200)}`);
    return {
      type: 'FeatureCollection',
      features: [],
      meta: { unavailable: `epa-frs:${kind}`, endpoint: ENDPOINT },
    };
  }
}

function normalize(p: Record<string, unknown>): EpaFrsProps {
  return {
    facilityId: (p['REGISTRY_ID'] as string) ?? (p['FRS_FACILITY_ID'] as string) ?? null,
    name: (p['PRIMARY_NAME'] as string) ?? (p['FACILITY_NAME'] as string) ?? null,
    state: (p['STATE_CODE'] as string) ?? null,
    county: (p['COUNTY_NAME'] as string) ?? null,
    city: (p['CITY_NAME'] as string) ?? null,
    naicsCode: (p['NAICS_CODES'] as string) ?? null,
    naicsName: (p['NAICS_NAMES'] as string) ?? null,
    sicCode: (p['SIC_CODES'] as string) ?? null,
    programs: (p['INTEREST_TYPES'] as string) ?? null,
  };
}
