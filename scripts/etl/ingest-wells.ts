/**
 * Ingests oil & gas wells from state-commission ArcGIS FeatureServers into
 * PostGIS `wells`. Sources used:
 *   - ND DMR (NDIC) public Oil_and_Gas_Well_Locations layer
 *   - CO ECMC Wells_Spatial FeatureServer
 *   - WY WOGCC Wyoming_Oil_and_Gas_Wells FeatureServer
 *
 * Texas RRC, NM OCD, and OK OCC do not publish open FeatureServer endpoints.
 * For those states this script logs a clear "no public spatial endpoint"
 * message and skips them — it does not generate data.
 *
 * Run:  npx tsx scripts/etl/ingest-wells.ts [--state ND]
 */
import 'dotenv/config';
import { query } from './lib/db.js';
import { log, timed } from './lib/log.js';

interface SourceConfig {
  state: string;
  source: string;
  url: string;
  apiField: string;
  nameField: string;
  operatorField: string;
  statusField: string;
  typeField?: string;
  countyField: string;
  spudField: string;
  totalDepthField?: string;
}

const SOURCES: SourceConfig[] = [
  {
    state: 'TX',
    source: 'tx_rrc',
    url: 'https://gis2.rrc.texas.gov/arcgis/rest/services/Wells/Wells/MapServer/0/query',
    apiField: 'API',
    nameField: 'LeaseName',
    operatorField: 'OperatorName',
    statusField: 'WellStatus',
    typeField: 'WellType',
    countyField: 'CountyName',
    spudField: 'SpudDate',
    totalDepthField: 'TotalDepth',
  },
  {
    state: 'ND',
    source: 'ndic',
    url: 'https://ndgishub.nd.gov/arcgis/rest/services/All_GIS_Data_OilGas/Oil_and_Gas_Well_Locations/MapServer/0/query',
    apiField: 'API_NO',
    nameField: 'Well_Name',
    operatorField: 'Current_Operator',
    statusField: 'Well_Status',
    typeField: 'Well_Type',
    countyField: 'County',
    spudField: 'Spud_Date',
    totalDepthField: 'Total_Depth',
  },
  {
    state: 'CO',
    source: 'cogcc',
    url: 'https://services1.arcgis.com/zTagxbhxHBVOIYW6/arcgis/rest/services/Wells_Spatial/FeatureServer/0/query',
    apiField: 'API',
    nameField: 'Facility_Name',
    operatorField: 'Operator',
    statusField: 'Facil_Status',
    typeField: 'Facility_Type',
    countyField: 'County',
    spudField: 'Spud_Date',
    totalDepthField: 'Max_TVD',
  },
  {
    state: 'WY',
    source: 'wogcc',
    url: 'https://services.arcgis.com/RmCCgQtiZLDFtw04/arcgis/rest/services/Wyoming_Oil_and_Gas_Wells/FeatureServer/0/query',
    apiField: 'API_NUM',
    nameField: 'WELL_NAME',
    operatorField: 'OPERATOR',
    statusField: 'STATUS',
    typeField: 'TYPE',
    countyField: 'COUNTY',
    spudField: 'SPUD_DATE',
    totalDepthField: 'TD',
  },
];

const STATES_WITHOUT_PUBLIC_FEATURE_SERVER: Record<string, string> = {
  NM: 'New Mexico OCD publishes wells via OCD Online — non-spatial. No public FeatureServer.',
  OK: 'Oklahoma OCC publishes WIMS data, no public FeatureServer with geometry.',
};

interface ArcGISFeature {
  properties: Record<string, unknown>;
  geometry: { type: 'Point'; coordinates: [number, number] } | null;
}

async function fetchAllPaginated(cfg: SourceConfig): Promise<ArcGISFeature[]> {
  const out: ArcGISFeature[] = [];
  let offset = 0;
  const pageSize = 2000;
  while (true) {
    const params = new URLSearchParams({
      where: '1=1',
      outFields: '*',
      returnGeometry: 'true',
      outSR: '4326',
      f: 'geojson',
      resultRecordCount: String(pageSize),
      resultOffset: String(offset),
    });
    const url = `${cfg.url}?${params.toString()}`;
    const res = await fetch(url);
    if (!res.ok) {
      log.warn(`HTTP ${res.status} from ${cfg.source}; stopping pagination.`);
      break;
    }
    const body = (await res.json()) as { features?: ArcGISFeature[]; exceededTransferLimit?: boolean };
    const features = body.features ?? [];
    out.push(...features);
    log.info(`fetched ${features.length}`, { source: cfg.source, offset, total: out.length });
    if (features.length < pageSize) break;
    offset += pageSize;
    if (offset > 200_000) {
      log.warn('safety cap of 200k reached', { source: cfg.source });
      break;
    }
  }
  return out;
}

function lower(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  return s || null;
}

function dateOrNull(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v).toISOString().slice(0, 10);
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function numberOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const STATUS_MAP: Record<string, string> = {
  active: 'active', producing: 'active', flowing: 'active',
  inactive: 'inactive',
  plugged: 'plugged', 'plugged & abandoned': 'plugged', 'p & a': 'plugged',
  permitted: 'permitted', approved: 'permitted', 'permit issued': 'permitted',
  drilling: 'drilling',
  completed: 'completed',
  abandoned: 'abandoned',
  'shut in': 'shut_in', 'shut-in': 'shut_in', 'shut_in': 'shut_in',
};

function normalizeStatus(raw: string | null): string | null {
  if (!raw) return null;
  return STATUS_MAP[raw.toLowerCase()] ?? null;
}

const TYPE_MAP: Record<string, string> = {
  oil: 'oil', gas: 'gas', 'oil & gas': 'oil_gas', 'oil and gas': 'oil_gas', 'oil/gas': 'oil_gas',
  injection: 'injection', disposal: 'disposal', water: 'water',
  'dry hole': 'dry_hole', service: 'service', observation: 'observation',
};

function normalizeType(raw: string | null): string | null {
  if (!raw) return null;
  return TYPE_MAP[raw.toLowerCase()] ?? null;
}

async function ingestSource(cfg: SourceConfig): Promise<number> {
  const features = await fetchAllPaginated(cfg);
  let count = 0;
  for (const f of features) {
    if (!f.geometry || f.geometry.type !== 'Point') continue;
    const [lng, lat] = f.geometry.coordinates;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;

    const apiNumber = (f.properties[cfg.apiField] as string) ?? null;
    if (!apiNumber) continue;

    const status = normalizeStatus(lower(f.properties[cfg.statusField]));
    const wellType = cfg.typeField ? normalizeType(lower(f.properties[cfg.typeField])) : null;

    await query(
      `INSERT INTO wells
         (api_number, well_name, operator, state, county, status, well_type,
          spud_date, total_depth_ft, surface_lat, surface_lng,
          geom, source, source_updated_at)
       VALUES ($1, $2, $3, $4, $5,
               $6::well_status, $7::well_type,
               $8, $9, $10, $11,
               ST_SetSRID(ST_MakePoint($11, $10), 4326), $12, now())
       ON CONFLICT (api_number) DO UPDATE SET
         status = EXCLUDED.status,
         operator = EXCLUDED.operator,
         total_depth_ft = EXCLUDED.total_depth_ft,
         geom = EXCLUDED.geom,
         source_updated_at = now()`,
      [
        apiNumber,
        f.properties[cfg.nameField] ?? null,
        f.properties[cfg.operatorField] ?? null,
        cfg.state,
        f.properties[cfg.countyField] ?? null,
        status,
        wellType,
        dateOrNull(f.properties[cfg.spudField]),
        cfg.totalDepthField ? numberOrNull(f.properties[cfg.totalDepthField]) : null,
        lat, lng,
        cfg.source,
      ],
    );
    count++;
  }
  return count;
}

async function main() {
  const stateArg = process.argv.includes('--state') ? process.argv[process.argv.indexOf('--state') + 1] : null;
  const targets = stateArg ? SOURCES.filter((s) => s.state === stateArg.toUpperCase()) : SOURCES;
  const skipped = stateArg && STATES_WITHOUT_PUBLIC_FEATURE_SERVER[stateArg.toUpperCase()];
  if (skipped) {
    log.warn(skipped, { state: stateArg });
    return;
  }

  for (const cfg of targets) {
    await timed(`wells ETL · ${cfg.state}`, async () => {
      const inserted = await ingestSource(cfg);
      log.info(`upserted ${inserted} wells from ${cfg.source}`);
    });
  }

  for (const [state, reason] of Object.entries(STATES_WITHOUT_PUBLIC_FEATURE_SERVER)) {
    if (stateArg && stateArg.toUpperCase() !== state) continue;
    log.warn(`${state}: ${reason}`);
  }
}

main().catch((err) => {
  log.error('ingest-wells failed', err);
  process.exit(1);
});
