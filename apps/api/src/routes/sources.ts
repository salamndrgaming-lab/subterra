/**
 * Live health probe of the public upstream sources we depend on. Each probe
 * issues a tiny query (`returnCountOnly`-style) and reports HTTP status,
 * latency, and any error body. Used by the operations dashboard so we can
 * tell at a glance whether BLM/USGS/state ArcGIS endpoints are reachable.
 */
import { Router } from 'express';
import { DATA_SOURCES } from '@subterra/shared';
import { FEDERAL_LAND_RASTERS, LEASE_RASTERS, PIPELINE_RASTERS } from '../sources/federal-lands.js';

export const sourcesRouter = Router();

sourcesRouter.get('/rasters', (_req, res) => {
  res.json({
    federalLands: FEDERAL_LAND_RASTERS,
    leases: LEASE_RASTERS,
    pipelines: PIPELINE_RASTERS,
    base: {
      blmSurfaceMgmt: { mapServer: DATA_SOURCES.blm.surfaceManagement, attribution: 'BLM' },
      plss: { mapServer: DATA_SOURCES.blm.plssCadnsdi, attribution: 'BLM Cadastral' },
      usgsTopo: { mapServer: DATA_SOURCES.usgs.topo, attribution: 'USGS' },
    },
  });
});

interface ProbeResult {
  id: string;
  name: string;
  url: string;
  status: 'ok' | 'degraded' | 'down';
  httpStatus: number | null;
  latencyMs: number | null;
  error: string | null;
}

async function probe(id: string, name: string, url: string, accept = 'application/json'): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const res = await fetch(url, { headers: { accept }, signal: AbortSignal.timeout(8000) });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      return {
        id, name, url,
        status: 'down', httpStatus: res.status, latencyMs,
        error: (await res.text()).slice(0, 200) || res.statusText,
      };
    }
    return { id, name, url, status: latencyMs < 3000 ? 'ok' : 'degraded', httpStatus: res.status, latencyMs, error: null };
  } catch (err) {
    return {
      id, name, url,
      status: 'down', httpStatus: null, latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

sourcesRouter.get('/health', async (_req, res) => {
  const probes: Array<Promise<ProbeResult>> = [
    probe('blm_sma', 'BLM Surface Management', `${DATA_SOURCES.blm.surfaceManagement}?f=json`),
    probe('blm_plss', 'BLM PLSS Cadastral', `${DATA_SOURCES.blm.plssCadnsdi}?f=json`),
    probe(
      'blm_claims',
      'BLM National Mining Claims',
      `${DATA_SOURCES.blm.miningClaims}/0?f=json`,
    ),
    probe(
      'usgs_topo',
      'USGS Topo basemap',
      `${DATA_SOURCES.usgs.topo}?f=json`,
    ),
    probe(
      'usgs_mrds',
      'USGS MRDS WFS',
      'https://mrdata.usgs.gov/wfs/mrds?service=WFS&request=GetCapabilities',
      'application/xml',
    ),
    probe(
      'nd_wells',
      'ND DMR oil & gas wells',
      'https://ndgishub.nd.gov/arcgis/rest/services/All_GIS_Data_OilGas/Oil_and_Gas_Well_Locations/MapServer/0?f=json',
    ),
    probe(
      'co_wells',
      'CO ECMC Wells_Spatial',
      'https://services1.arcgis.com/zTagxbhxHBVOIYW6/arcgis/rest/services/Wells_Spatial/FeatureServer/0?f=json',
    ),
    probe(
      'wy_wells',
      'WY WOGCC oil & gas wells',
      'https://services.arcgis.com/RmCCgQtiZLDFtw04/arcgis/rest/services/Wyoming_Oil_and_Gas_Wells/FeatureServer/0?f=json',
    ),
  ];

  const results = await Promise.all(probes);
  const overall = results.every((r) => r.status === 'ok')
    ? 'ok'
    : results.some((r) => r.status === 'down')
      ? 'degraded'
      : 'ok';

  res.json({
    overall,
    checkedAt: new Date().toISOString(),
    sources: results,
  });
});
