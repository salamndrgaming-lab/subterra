import type {
  GeoJSONFeatureCollection,
  Well,
  WellProductionSeries,
  MiningClaim,
  MineralOccurrence,
  Parcel,
  OpportunityScore,
} from '@subterra/shared';
import { useAuthStore } from '@/stores/auth-store';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = typeof window !== 'undefined' ? useAuthStore.getState().tokens?.accessToken : null;
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body || res.statusText}`);
  }
  return (await res.json()) as T;
}

export interface LayerQuery {
  bbox?: [number, number, number, number];
  state?: string;
  county?: string;
  status?: string;
  commodity?: string;
  limit?: number;
}

function qs(params: LayerQuery): string {
  const search = new URLSearchParams();
  if (params.bbox) search.set('bbox', params.bbox.join(','));
  if (params.state) search.set('state', params.state);
  if (params.county) search.set('county', params.county);
  if (params.status) search.set('status', params.status);
  if (params.commodity) search.set('commodity', params.commodity);
  if (params.limit) search.set('limit', String(params.limit));
  const s = search.toString();
  return s ? `?${s}` : '';
}

export const api = {
  layers: {
    wells: (q: LayerQuery = {}) =>
      request<GeoJSONFeatureCollection<Well> & { meta: { sources: string[]; unavailableStates: string[] } }>(
        `/api/layers/wells${qs(q)}`,
      ),
    claims: (q: LayerQuery = {}) =>
      request<GeoJSONFeatureCollection<MiningClaim>>(`/api/layers/claims${qs(q)}`),
    parcels: (q: LayerQuery = {}) =>
      request<GeoJSONFeatureCollection<Parcel>>(`/api/layers/parcels${qs(q)}`),
    mineralOccurrences: (q: LayerQuery = {}) =>
      request<GeoJSONFeatureCollection<MineralOccurrence>>(`/api/layers/mineral-occurrences${qs(q)}`),
  },
  wells: {
    detail: (id: string) =>
      request<{ well: Well; production: WellProductionSeries; offsets: Array<{ id: string; wellName: string | null; operator: string | null; status: string | null; spudDate: string | null; lateralLengthFt: number | null }> }>(`/api/wells/${id}`),
  },
  claims: {
    detail: (id: string) =>
      request<{ claim: MiningClaim; nearbyOccurrences: Array<MineralOccurrence & { distanceKm: number }>; filingHistory: Array<{ event: string; date: string | null; agency: string | null }> }>(`/api/claims/${id}`),
  },
  parcels: {
    detail: (id: string) =>
      request<{ parcel: Parcel; activity: { nearbyWells: Array<{ id: string; wellName: string | null; operator: string | null; status: string | null; distanceKm: number }>; nearbyClaims: Array<{ id: string; serialNumber: string; claimName: string | null; status: string | null; commodity: string | null; distanceKm: number }> } }>(`/api/parcels/${id}`),
  },
  search: (params: { q?: string; state?: string; county?: string; commodity?: string; bbox?: [number, number, number, number]; types?: string }) =>
    request<{ count: number; results: Array<{ kind: string; id: string; label: string; subtitle?: string; coordinates?: [number, number]; meta?: Record<string, unknown> }> }>(
      `/api/search?${new URLSearchParams(
        Object.entries({
          ...params,
          bbox: params.bbox?.join(','),
        }).filter(([, v]) => v !== undefined && v !== null) as [string, string][],
      ).toString()}`,
    ),
  score: (params: { lat: number; lng: number; radiusKm: number; commodity?: string }) =>
    request<OpportunityScore>(
      `/api/score?lat=${params.lat}&lng=${params.lng}&radius=${params.radiusKm}${params.commodity ? `&commodity=${params.commodity}` : ''}`,
    ),
  aois: {
    list: (projectId?: string) =>
      request<{ aois: SavedAoi[] }>(`/api/aois${projectId ? `?projectId=${projectId}` : ''}`),
    create: (body: { name: string; notes?: string | null; projectId?: string | null; geometry: { type: 'Polygon'; coordinates: number[][][] } }) =>
      request<{ aoi: SavedAoi }>(`/api/aois`, { method: 'POST', body: JSON.stringify(body) }),
    remove: (id: string) => request<void>(`/api/aois/${id}`, { method: 'DELETE' }),
  },
  sources: {
    health: () =>
      request<{ overall: 'ok' | 'degraded'; checkedAt: string; sources: SourceHealth[] }>(`/api/sources/health`),
    rasters: () =>
      request<{
        federalLands: RasterSource[];
        pipelines: RasterSource[];
        base: Record<string, { mapServer: string; attribution: string }>;
      }>(`/api/sources/rasters`),
  },
  staking: {
    checkConflict: (geometry: { type: 'Polygon'; coordinates: number[][][] }) =>
      request<{ acreage: number; conflictCount: number; conflicts: Array<{ serialNumber: string; claimName: string | null; owner: string | null; commodity: string | null; acreage: number | null }>; source: string }>(
        `/api/staking/check-conflict`, { method: 'POST', body: JSON.stringify({ geometry }) },
      ),
  },
};

export interface SavedAoi {
  id: string;
  userId: string;
  projectId: string | null;
  name: string;
  notes: string | null;
  areaAcres: number | null;
  geom: { type: 'MultiPolygon'; coordinates: number[][][][] };
  centroid: { type: 'Point'; coordinates: [number, number] };
  createdAt: string;
  updatedAt: string;
}

export interface SourceHealth {
  id: string;
  name: string;
  url: string;
  status: 'ok' | 'degraded' | 'down';
  httpStatus: number | null;
  latencyMs: number | null;
  error: string | null;
}

export interface RasterSource {
  id: string;
  label: string;
  mapServer: string;
  opacity: number;
  minZoom: number;
  attribution: string;
}
