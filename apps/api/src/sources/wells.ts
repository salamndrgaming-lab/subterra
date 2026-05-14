/**
 * Real-data client for oil & gas wells. Each state oil/gas commission
 * publishes a different ArcGIS REST endpoint; we pick the one that matches
 * the requested state and normalize attributes into the shared schema.
 *
 * Currently wired:
 *   - Texas (RRC)         — https://gis2.rrc.texas.gov/arcgis/rest/services/...
 *   - North Dakota (NDIC) — https://ndgishub.nd.gov/arcgis/rest/services
 *   - Colorado (ECMC)     — https://services1.arcgis.com/.../Wells_Spatial/FeatureServer
 *   - Wyoming (WOGCC)     — https://services.arcgis.com/.../Wyoming_Oil_and_Gas_Wells
 *
 * New Mexico OCD and Oklahoma OCC do not publish open FeatureServer
 * endpoints with geometry. Requests for those states return an empty
 * FeatureCollection with `meta.unavailableStates` populated so the UI
 * surfaces the gap instead of silently rendering nothing.
 */

import type { BBoxArray, GeoJSONFeatureCollection, GeoJSONPoint } from '@subterra/shared';
import { arcgisQuery } from './arcgis.js';
import { cached } from './cache.js';

export interface WellProps {
  apiNumber: string | null;
  wellName: string | null;
  operator: string | null;
  status: string | null;
  wellType: string | null;
  state: string;
  county: string | null;
  spudDate: string | null;
  totalDepthFt: number | null;
  source: string;
}

export interface WellsQuery {
  bbox?: BBoxArray;
  state?: string;
  county?: string;
  status?: string;
  limit?: number;
}

interface SourceConfig {
  url: string | undefined;        // undefined = skip (no public endpoint configured)
  state: string;
  source: string;
  map: (raw: Record<string, unknown>) => WellProps;
  whereForStatus?: (status: string) => string;
}

const ND: SourceConfig = {
  // ND DMR / NDIC oil & gas wells, statewide, points.
  // The historical URL is in .env.defaults but the service has been
  // restructured; we treat it as opt-in until a working endpoint is wired.
  url: process.env.ND_WELLS_LAYER || undefined,
  state: 'ND',
  source: 'ndic',
  map: (r) => ({
    apiNumber: (r['API_NO'] as string) ?? (r['API'] as string) ?? null,
    wellName: (r['Well_Name'] as string) ?? (r['WellName'] as string) ?? null,
    operator: (r['Current_Operator'] as string) ?? (r['Operator'] as string) ?? null,
    status: lower((r['Well_Status'] as string) ?? (r['Status'] as string) ?? null),
    wellType: lower((r['Well_Type'] as string) ?? null),
    state: 'ND',
    county: (r['County'] as string) ?? null,
    spudDate: dateOrNull(r['Spud_Date'] ?? r['SpudDate']),
    totalDepthFt: numberOrNull(r['Total_Depth'] ?? r['TotalDepth']),
    source: 'ndic',
  }),
  whereForStatus: (s) => `UPPER(Well_Status) = '${s.toUpperCase()}'`,
};

const CO: SourceConfig = {
  // Colorado ECMC public Wells_Spatial layer (opt-in; URL must be supplied).
  url: process.env.CO_WELLS_LAYER || undefined,
  state: 'CO',
  source: 'cogcc',
  map: (r) => ({
    apiNumber: (r['API'] as string) ?? (r['API_Label'] as string) ?? null,
    wellName: (r['Facility_Name'] as string) ?? (r['Well_Name'] as string) ?? null,
    operator: (r['Operator'] as string) ?? null,
    status: lower((r['Facil_Status'] as string) ?? (r['Status'] as string) ?? null),
    wellType: lower((r['Facility_Type'] as string) ?? null),
    state: 'CO',
    county: (r['County'] as string) ?? null,
    spudDate: dateOrNull(r['Spud_Date']),
    totalDepthFt: numberOrNull(r['Max_TVD'] ?? r['Measured_Depth']),
    source: 'cogcc',
  }),
  whereForStatus: (s) => `UPPER(Facil_Status) = '${s.toUpperCase()}'`,
};

const WY: SourceConfig = {
  // WOGCC oil & gas wells (opt-in; URL must be supplied).
  url: process.env.WY_WELLS_LAYER || undefined,
  state: 'WY',
  source: 'wogcc',
  map: (r) => ({
    apiNumber: (r['API_NUM'] as string) ?? (r['API'] as string) ?? null,
    wellName: (r['WELL_NAME'] as string) ?? null,
    operator: (r['OPERATOR'] as string) ?? null,
    status: lower((r['STATUS'] as string) ?? null),
    wellType: lower((r['TYPE'] as string) ?? null),
    state: 'WY',
    county: (r['COUNTY'] as string) ?? null,
    spudDate: dateOrNull(r['SPUD_DATE']),
    totalDepthFt: numberOrNull(r['TD']),
    source: 'wogcc',
  }),
  whereForStatus: (s) => `UPPER(STATUS) = '${s.toUpperCase()}'`,
};

const TX: SourceConfig = {
  // Texas RRC publishes a public Wells map service via their GIS backend
  // (opt-in; URL must be supplied — the gis2.rrc.texas.gov host is
  // frequently unreachable from outside Texas state networks).
  url: process.env.TX_WELLS_LAYER || undefined,
  state: 'TX',
  source: 'tx_rrc',
  map: (r) => ({
    apiNumber: (r['API'] as string) ?? (r['API_NO'] as string) ?? null,
    wellName: (r['LeaseName'] as string) ?? (r['WellName'] as string) ?? null,
    operator: (r['OperatorName'] as string) ?? (r['Operator'] as string) ?? null,
    status: lower((r['WellStatus'] as string) ?? (r['Status'] as string) ?? null),
    wellType: lower((r['WellType'] as string) ?? null),
    state: 'TX',
    county: (r['CountyName'] as string) ?? (r['County'] as string) ?? null,
    spudDate: dateOrNull(r['SpudDate'] ?? r['Spud_Date']),
    totalDepthFt: numberOrNull(r['TotalDepth'] ?? r['MeasuredDepth']),
    source: 'tx_rrc',
  }),
  whereForStatus: (s) => `UPPER(WellStatus) = '${s.toUpperCase()}'`,
};

const SOURCES: Record<string, SourceConfig> = { TX, ND, CO, WY };

const STATES_WITHOUT_PUBLIC_FEATURE_SERVER = new Set(['NM', 'OK']);

export async function fetchWells(q: WellsQuery): Promise<GeoJSONFeatureCollection<WellProps> & { meta: { sources: string[]; unavailableStates: string[] } }> {
  const targets = q.state ? [q.state.toUpperCase()] : Object.keys(SOURCES);
  const unavailable: string[] = [];
  const sources: string[] = [];
  const allFeatures: GeoJSONFeatureCollection<WellProps>['features'] = [];

  for (const state of targets) {
    if (STATES_WITHOUT_PUBLIC_FEATURE_SERVER.has(state)) {
      unavailable.push(state);
      continue;
    }
    const cfg = SOURCES[state];
    if (!cfg) continue;
    if (!cfg.url) { unavailable.push(state); continue; }

    const where = buildWhere(cfg, q);
    const key = `wells:${state}:${where}:${(q.bbox ?? []).join(',')}:${q.limit ?? 1000}`;

    try {
      const fc = await cached(key, 180, () =>
        arcgisQuery<Record<string, unknown>>(cfg.url!, {
          where,
          bbox: q.bbox,
          resultRecordCount: q.limit ?? 1000,
        }),
      );
      sources.push(cfg.source);
      for (const f of fc.features) {
        if (!f.geometry || f.geometry.type !== 'Point') continue;
        allFeatures.push({
          type: 'Feature',
          geometry: f.geometry as GeoJSONPoint,
          properties: cfg.map(f.properties as Record<string, unknown>),
        });
      }
    } catch (err) {
      console.warn(`[wells] upstream ${cfg.source} failed`, err);
      unavailable.push(state);
    }
  }

  return {
    type: 'FeatureCollection',
    features: allFeatures,
    meta: { sources, unavailableStates: unavailable },
  };
}

function buildWhere(cfg: SourceConfig, q: WellsQuery): string {
  const parts: string[] = [];
  if (q.status && cfg.whereForStatus) parts.push(cfg.whereForStatus(q.status));
  if (q.county) parts.push(`UPPER(County) = '${q.county.toUpperCase()}'`);
  return parts.length ? parts.join(' AND ') : '1=1';
}

export async function fetchWellByApi(api: string): Promise<(WellProps & { geom: GeoJSONPoint }) | null> {
  const key = `wells:detail:${api}`;
  return cached(key, 600, async () => {
    for (const cfg of Object.values(SOURCES)) {
      if (!cfg.url) continue;
      try {
        const fc = await arcgisQuery<Record<string, unknown>>(cfg.url, {
          where: `API = '${api.replace(/'/g, "''")}' OR API_NO = '${api.replace(/'/g, "''")}' OR API_NUM = '${api.replace(/'/g, "''")}'`,
          resultRecordCount: 1,
        });
        const f = fc.features[0];
        if (f && f.geometry?.type === 'Point') {
          return { ...cfg.map(f.properties as Record<string, unknown>), geom: f.geometry as GeoJSONPoint };
        }
      } catch (err) {
        console.warn(`[wells:detail] ${cfg.source} failed`, err);
      }
    }
    return null;
  });
}

function lower(v: string | null): string | null {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  return s || null;
}

function numberOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function dateOrNull(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v).toISOString().slice(0, 10);
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
