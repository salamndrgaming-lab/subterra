/**
 * Probes every external data source Subterra talks to and prints a table
 * of status, HTTP code, and latency. Use this to verify env-configured
 * URLs are reachable from your machine before launching the app.
 *
 *   npm run probe                # tests defaults
 *   npm run probe -- --verbose   # prints first 200 chars of failure bodies
 */
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
dotenv.config({ path: path.join(repoRoot, '.env.defaults') });
dotenv.config({ path: path.join(repoRoot, '.env'), override: true });

interface Source {
  id: string;
  name: string;
  url: string;
  init?: RequestInit;
}

const STATE_WELL_VARS = [
  'TX', 'ND', 'CO', 'WY', 'NM', 'OK', 'KS', 'LA', 'CA', 'AK', 'UT', 'MT',
  'PA', 'OH', 'WV', 'MI', 'IL', 'MS', 'AL', 'AR', 'TN', 'KY', 'IN', 'VA',
  'NY', 'FL', 'NV', 'AZ', 'ID', 'OR', 'WA', 'SD', 'NE',
];

function stateWellSources(): Source[] {
  const out: Source[] = [];
  for (const s of STATE_WELL_VARS) {
    const url = process.env[`${s}_WELLS_LAYER`];
    // Skip unset / empty so the report stays focused on configured sources.
    if (!url || !url.trim()) continue;
    out.push({
      id: `wells_${s.toLowerCase()}`,
      name: `${s} state wells`,
      url: url.replace(/\/query$/, '') + '?f=json',
    });
  }
  return out;
}

const verbose = process.argv.includes('--verbose');

const sources: Source[] = [
  // Base map
  {
    id: 'openfreemap',
    name: 'OpenFreeMap dark style',
    url: process.env.NEXT_PUBLIC_MAP_STYLE_URL ?? 'https://tiles.openfreemap.org/styles/dark',
  },

  // BLM rasters (already known-good — used by the map as raster overlays)
  {
    id: 'blm_sma',
    name: 'BLM Surface Management (raster MapServer)',
    url: 'https://gis.blm.gov/arcgis/rest/services/lands/BLM_Natl_SMA_LimitedScale/MapServer?f=json',
  },
  {
    id: 'blm_plss',
    name: 'BLM PLSS Cadastral (raster MapServer)',
    url: 'https://gis.blm.gov/arcgis/rest/services/Cadastral/BLM_Natl_PLSS_CadNSDI/MapServer?f=json',
  },
  {
    id: 'usgs_topo',
    name: 'USGS National Map topo basemap',
    url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer?f=json',
  },

  // Feature endpoints — these are the ones that frequently move
  {
    id: 'blm_claims',
    name: 'BLM National Mining Claims (FeatureServer)',
    url: (process.env.BLM_CLAIMS_LAYER ?? 'https://gis.blm.gov/arcgis/rest/services/mining/BLM_Natl_Mining_Claims/MapServer/0').replace(/\/query$/, '') + '?f=json',
  },
  {
    id: 'usgs_mrds_wfs',
    name: 'USGS MRDS WFS GetCapabilities',
    url: `${process.env.USGS_MRDS_WFS ?? 'https://mrdata.usgs.gov/services/wfs/mrds'}?service=WFS&request=GetCapabilities`,
  },
  {
    id: 'usgs_mrds_alt',
    name: 'USGS MRDS WFS (alt /wfs path)',
    url: 'https://mrdata.usgs.gov/wfs/mrds?service=WFS&request=GetCapabilities',
  },

  // Pipelines (HIFLD)
  {
    id: 'hifld_natgas',
    name: 'HIFLD Natural Gas Pipelines',
    url: 'https://services1.arcgis.com/Hp6G80Pky0om7QvQ/arcgis/rest/services/Natural_Gas_Pipelines/FeatureServer/0?f=json',
  },

  // EPA Facility Registry — nationwide oil/gas + mining fallback
  {
    id: 'epa_frs',
    name: 'EPA Facility Registry (nationwide)',
    url: (process.env.EPA_FRS_LAYER ?? 'https://geopub.epa.gov/arcgis/rest/services/EMEF/FRS_INTERESTS/MapServer/0').replace(/\/query$/, '') + '?f=json',
  },

  // Truly key-less feature feed — POSTing a tiny query to verify the
  // interpreter endpoint actually accepts our headers. We supply a
  // browser-like User-Agent because Overpass mirrors return 406 for the
  // default Node/undici UA.
  {
    id: 'overpass',
    name: 'OSM Overpass API',
    url: (process.env.OVERPASS_URL ?? 'https://overpass-api.de/api/interpreter') +
      '?data=' + encodeURIComponent('[out:json][timeout:5];node[man_made=mineshaft](38.0,-117.5,38.1,-117.4);out 1;'),
    init: {
      headers: {
        'User-Agent': 'Mozilla/5.0 Subterra/0.1 (+https://github.com/salamndrgaming-lab/subterra)',
        accept: 'application/json',
      },
    },
  },

  // Every state oil/gas commission URL the user has configured in .env.
  // Probes only the ones with a non-empty value so the report stays focused.
  ...stateWellSources(),

  // Geocoder
  {
    id: 'nominatim',
    name: 'OSM Nominatim geocoder',
    url: 'https://nominatim.openstreetmap.org/status?format=json',
    init: { headers: { 'User-Agent': process.env.NOMINATIM_USER_AGENT ?? 'Subterra/0.1 source-probe' } },
  },
];

interface Result {
  id: string;
  name: string;
  url: string;
  status: 'ok' | 'slow' | 'down';
  httpStatus: number | null;
  latencyMs: number;
  error?: string;
}

async function probe(s: Source): Promise<Result> {
  const start = Date.now();
  try {
    const res = await fetch(s.url, {
      ...s.init,
      signal: AbortSignal.timeout(12_000),
    });
    const latencyMs = Date.now() - start;
    if (!res.ok) {
      return {
        id: s.id, name: s.name, url: s.url,
        status: 'down', httpStatus: res.status, latencyMs,
        error: verbose ? (await res.text()).slice(0, 200) : `HTTP ${res.status}`,
      };
    }
    return {
      id: s.id, name: s.name, url: s.url,
      status: latencyMs > 4000 ? 'slow' : 'ok',
      httpStatus: res.status, latencyMs,
    };
  } catch (err) {
    return {
      id: s.id, name: s.name, url: s.url,
      status: 'down', httpStatus: null, latencyMs: Date.now() - start,
      error: (err as Error).message,
    };
  }
}

function format(r: Result): string {
  const icon = r.status === 'ok' ? '✓' : r.status === 'slow' ? '⚠' : '✗';
  const code = r.httpStatus ? String(r.httpStatus).padStart(3) : '---';
  const latency = `${String(r.latencyMs).padStart(5)}ms`;
  const name = r.name.padEnd(46);
  const err = r.error ? `  (${r.error})` : '';
  return `${icon} ${name}  ${code}  ${latency}${err}`;
}

async function main() {
  console.log('Probing data sources...\n');
  const results = await Promise.all(sources.map(probe));
  const ok = results.filter((r) => r.status === 'ok').length;
  const slow = results.filter((r) => r.status === 'slow').length;
  const down = results.filter((r) => r.status === 'down').length;

  for (const r of results) console.log(format(r));
  console.log(`\nSummary: ${ok} ok · ${slow} slow · ${down} down`);
  if (down > 0) {
    console.log('\nFor each `down` source, paste a working URL into .env and re-run:');
    for (const r of results.filter((x) => x.status === 'down')) {
      console.log(`  # ${r.name}\n  #   ${r.url}`);
    }
  }
  process.exit(down > 0 ? 1 : 0);
}

main();
