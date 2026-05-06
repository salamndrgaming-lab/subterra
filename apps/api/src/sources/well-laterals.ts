/**
 * Real-data client for well-bore lateral linestrings. Several state oil & gas
 * commissions publish a separate "well lines" feature layer alongside the
 * point layer; we proxy them here so the map can overlay actual lateral
 * trajectories rather than just the surface point.
 *
 *   - North Dakota: Wellbore_Lines layer in NDIC's GIS Hub service
 *   - Colorado:    Wells_Lines FeatureServer (ECMC)
 *   - Wyoming:     Wyoming_Oil_and_Gas_Wells_Lines FeatureServer (WOGCC)
 *
 * Texas and other states do not publish a separate line layer (laterals are
 * derived from bottom-hole + surface points). For TX we synthesize nothing.
 */

import type { BBoxArray, GeoJSONFeatureCollection, GeoJSONLineString } from '@subterra/shared';
import { arcgisQuery } from './arcgis.js';
import { cached } from './cache.js';

interface SourceConfig {
  state: string;
  source: string;
  url: string;
  apiField: string;
  nameField: string;
  operatorField: string;
}

const SOURCES: Record<string, SourceConfig> = {
  ND: {
    state: 'ND',
    source: 'ndic',
    url:
      process.env.ND_WELL_LINES_LAYER ??
      'https://ndgishub.nd.gov/arcgis/rest/services/All_GIS_Data_OilGas/Wellbore_Lines/MapServer/0/query',
    apiField: 'API_NO',
    nameField: 'Well_Name',
    operatorField: 'Current_Operator',
  },
  CO: {
    state: 'CO',
    source: 'cogcc',
    url:
      process.env.CO_WELL_LINES_LAYER ??
      'https://services1.arcgis.com/zTagxbhxHBVOIYW6/arcgis/rest/services/Wells_Lines/FeatureServer/0/query',
    apiField: 'API',
    nameField: 'Facility_Name',
    operatorField: 'Operator',
  },
};

export interface WellLateralProps {
  apiNumber: string | null;
  wellName: string | null;
  operator: string | null;
  state: string;
  source: string;
}

export async function fetchWellLaterals(q: { bbox?: BBoxArray; state?: string; limit?: number }): Promise<GeoJSONFeatureCollection<WellLateralProps> & { meta: { sources: string[]; unavailableStates: string[] } }> {
  const targets = q.state ? [q.state.toUpperCase()] : Object.keys(SOURCES);
  const features: GeoJSONFeatureCollection<WellLateralProps>['features'] = [];
  const sources: string[] = [];
  const unavailable: string[] = [];

  for (const state of targets) {
    const cfg = SOURCES[state];
    if (!cfg) { unavailable.push(state); continue; }
    const key = `well-laterals:${state}:${(q.bbox ?? []).join(',')}:${q.limit ?? 500}`;
    try {
      const fc = await cached(key, 300, () =>
        arcgisQuery<Record<string, unknown>>(cfg.url, {
          bbox: q.bbox,
          resultRecordCount: q.limit ?? 500,
        }),
      );
      sources.push(cfg.source);
      for (const f of fc.features) {
        if (!f.geometry || f.geometry.type !== 'LineString') continue;
        features.push({
          type: 'Feature',
          geometry: f.geometry as GeoJSONLineString,
          properties: {
            apiNumber: (f.properties[cfg.apiField] as string) ?? null,
            wellName: (f.properties[cfg.nameField] as string) ?? null,
            operator: (f.properties[cfg.operatorField] as string) ?? null,
            state: cfg.state,
            source: cfg.source,
          },
        });
      }
    } catch (err) {
      console.warn(`[well-laterals] ${cfg.source} failed`, err);
      unavailable.push(state);
    }
  }

  return { type: 'FeatureCollection', features, meta: { sources, unavailableStates: unavailable } };
}
