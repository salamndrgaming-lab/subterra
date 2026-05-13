/**
 * Real-data client for active mining claims published by BLM through the
 * National Mining Claims feature service.
 *
 * Endpoint:
 *   https://gis.blm.gov/arcgis/rest/services/mining/BLM_Natl_Mining_Claims/MapServer
 *
 * Layer 0 = active lode/placer/mill/tunnel-site claims (geometry: polygon).
 * Field reference (BLM MLRS extract):
 *   CASE_RECORD_SERIAL_NR · CASE_DISP · CLAIM_TYPE · CLAIM_NAME ·
 *   CLAIMANT_NAME · COMMODITY · STATE · COUNTY · LOCATION_DT ·
 *   RECORDATION_DT · LAST_ASSESS_YR · ACREAGE
 */

import type { BBoxArray, GeoJSONFeatureCollection, GeoJSONMultiPolygon } from '@subterra/shared';
import { arcgisQuery } from './arcgis.js';
import { cached } from './cache.js';

const ENDPOINT =
  process.env.BLM_CLAIMS_LAYER ??
  'https://gis.blm.gov/arcgis/rest/services/mining/BLM_Natl_Mining_Claims/MapServer/0/query';

export interface BlmClaimProps {
  serialNumber: string;
  claimName: string | null;
  claimType: string | null;
  status: string | null;
  ownerName: string | null;
  commodity: string | null;
  state: string | null;
  county: string | null;
  locationDate: string | null;
  recordationDate: string | null;
  lastAssessmentYear: number | null;
  acreage: number | null;
  meridian: string | null;
  township: string | null;
  range: string | null;
  section: number | null;
}

interface BlmRaw {
  CASE_RECORD_SERIAL_NR?: string;
  SERIAL_NR?: string;
  CLAIM_NAME?: string | null;
  CLAIM_TYPE?: string | null;
  CASE_DISP?: string | null;
  CLAIMANT_NAME?: string | null;
  CASE_NAME?: string | null;
  COMMODITY?: string | null;
  STATE?: string | null;
  COUNTY?: string | null;
  LOCATION_DT?: number | string | null;
  RECORDATION_DT?: number | string | null;
  LAST_ASSESS_YR?: number | null;
  ACREAGE?: number | null;
  MERIDIAN?: string | null;
  TOWNSHIP?: string | null;
  RANGE?: string | null;
  SECTION?: number | null;
}

export interface BlmClaimsQuery {
  bbox?: BBoxArray;
  state?: string;
  status?: string;       // 'active' (default) | 'closed'
  commodity?: string;
  limit?: number;
}

export async function fetchBlmClaims(q: BlmClaimsQuery): Promise<GeoJSONFeatureCollection<BlmClaimProps> & { meta?: { unavailable?: string; endpoint?: string } }> {
  const where = buildWhere(q);
  const key = `blm:claims:${where}:${(q.bbox ?? []).join(',')}:${q.limit ?? 1000}`;
  try {
    return await cached(key, 300, async () => {
      const raw = await arcgisQuery<BlmRaw>(ENDPOINT, {
        where,
        bbox: q.bbox,
        resultRecordCount: q.limit ?? 1000,
      });
      return {
        type: 'FeatureCollection' as const,
        features: raw.features.map((f) => ({
          type: 'Feature' as const,
          geometry: f.geometry as GeoJSONMultiPolygon,
          properties: normalize(f.properties),
        })),
      };
    });
  } catch (err) {
    console.warn(`[blm-claims] upstream failed: ${(err as Error).message.slice(0, 200)}`);
    return {
      type: 'FeatureCollection',
      features: [],
      meta: {
        unavailable: 'blm_national_mining_claims',
        endpoint: ENDPOINT,
      },
    };
  }
}

function buildWhere(q: BlmClaimsQuery): string {
  const parts: string[] = [];
  const status = (q.status ?? 'active').toLowerCase();
  parts.push(`UPPER(CASE_DISP) = '${status.toUpperCase()}'`);
  if (q.state) parts.push(`UPPER(STATE) = '${q.state.toUpperCase()}'`);
  if (q.commodity) parts.push(`UPPER(COMMODITY) LIKE '%${q.commodity.toUpperCase()}%'`);
  return parts.join(' AND ');
}

function normalize(r: BlmRaw): BlmClaimProps {
  const serial = r.CASE_RECORD_SERIAL_NR ?? r.SERIAL_NR ?? '';
  return {
    serialNumber: serial,
    claimName: r.CLAIM_NAME ?? null,
    claimType: lowerOrNull(r.CLAIM_TYPE),
    status: lowerOrNull(r.CASE_DISP),
    ownerName: r.CLAIMANT_NAME ?? r.CASE_NAME ?? null,
    commodity: r.COMMODITY ?? null,
    state: r.STATE ?? null,
    county: r.COUNTY ?? null,
    locationDate: dateOrNull(r.LOCATION_DT),
    recordationDate: dateOrNull(r.RECORDATION_DT),
    lastAssessmentYear: r.LAST_ASSESS_YR ?? null,
    acreage: r.ACREAGE ?? null,
    meridian: r.MERIDIAN ?? null,
    township: r.TOWNSHIP ?? null,
    range: r.RANGE ?? null,
    section: r.SECTION ?? null,
  };
}

function lowerOrNull(v: unknown): string | null {
  if (v == null) return null;
  return String(v).trim().toLowerCase() || null;
}

function dateOrNull(v: number | string | null | undefined): string | null {
  if (v == null) return null;
  if (typeof v === 'number') {
    // ArcGIS returns dates as epoch milliseconds.
    if (!Number.isFinite(v)) return null;
    return new Date(v).toISOString().slice(0, 10);
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export async function fetchBlmClaimById(serial: string): Promise<BlmClaimProps & { geom: GeoJSONMultiPolygon } | null> {
  const key = `blm:claim:${serial}`;
  try {
    return await cached(key, 600, async () => {
      const raw = await arcgisQuery<BlmRaw>(ENDPOINT, {
        where: `CASE_RECORD_SERIAL_NR = '${serial.replace(/'/g, "''")}' OR SERIAL_NR = '${serial.replace(/'/g, "''")}'`,
        resultRecordCount: 1,
      });
      const f = raw.features[0];
      if (!f) return null;
      return { ...normalize(f.properties), geom: f.geometry as GeoJSONMultiPolygon };
    });
  } catch (err) {
    console.warn(`[blm-claim-detail] upstream failed: ${(err as Error).message.slice(0, 200)}`);
    return null;
  }
}
