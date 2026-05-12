/**
 * Ingests active mining claims from BLM MLRS public extracts into `mining_claims`.
 *
 * BLM publishes weekly shapefile + CSV extracts of active claims. The MLRS
 * site (https://reports.blm.gov/reports/MLRS) returns one extract per state.
 * For Phase 2 we'll switch to the FeatureServer at:
 *   https://gis.blm.gov/arcgis/rest/services/mining/BLM_Natl_Mining_Claims/MapServer
 *
 * Run:  npx tsx scripts/etl/ingest-blm-claims.ts [--state NV]
 */
import { query, withTransaction } from './lib/db.js';
import { log, timed } from './lib/log.js';

const FEATURE_SERVER =
  'https://gis.blm.gov/arcgis/rest/services/mining/BLM_Natl_Mining_Claims/MapServer/0/query';

interface ArcGISFeature {
  attributes: Record<string, unknown>;
  geometry: { rings: number[][][] };
}

async function fetchClaimsByState(state: string): Promise<ArcGISFeature[]> {
  const params = new URLSearchParams({
    where: `STATE='${state}' AND CASE_DISP='ACTIVE'`,
    outFields: '*',
    returnGeometry: 'true',
    f: 'json',
    outSR: '4326',
    resultRecordCount: '2000',
  });
  const url = `${FEATURE_SERVER}?${params.toString()}`;
  log.info('GET BLM claims', { state, url });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`BLM MapServer ${res.status}`);
  const body = (await res.json()) as { features: ArcGISFeature[] };
  return body.features ?? [];
}

function ringsToWKT(rings: number[][][]): string {
  const polygons = rings.map((ring) => `((${ring.map(([x, y]) => `${x} ${y}`).join(', ')}))`);
  return `MULTIPOLYGON(${polygons.join(', ')})`;
}

async function upsertClaim(f: ArcGISFeature): Promise<void> {
  const a = f.attributes;
  const wkt = ringsToWKT(f.geometry.rings);
  await query(
    `INSERT INTO mining_claims
       (serial_number, claim_name, claim_type, status, owner_name, commodity,
        state, county, location_date, recordation_date, last_assessment_year,
        acreage, geom, source, source_updated_at)
     VALUES ($1, $2, $3, $4, $5, $6,
             $7, $8, $9, $10, $11,
             $12, ST_Multi(ST_GeomFromText($13, 4326)), 'blm_mlrs', now())
     ON CONFLICT (serial_number) DO UPDATE SET
       status = EXCLUDED.status,
       owner_name = EXCLUDED.owner_name,
       last_assessment_year = EXCLUDED.last_assessment_year,
       acreage = EXCLUDED.acreage,
       geom = EXCLUDED.geom,
       source_updated_at = now()`,
    [
      a['SERIAL_NR'] ?? a['CASE_RECORD_SERIAL_NR'],
      a['CLAIM_NAME'],
      String(a['CLAIM_TYPE'] ?? '').toLowerCase() || null,
      String(a['CASE_DISP'] ?? '').toLowerCase() || null,
      a['CLAIMANT_NAME'] ?? a['CASE_NAME'],
      a['COMMODITY'] ?? null,
      a['STATE'],
      a['COUNTY'],
      a['LOCATION_DT'] ?? null,
      a['RECORDATION_DT'] ?? null,
      a['LAST_ASSESS_YR'] ?? null,
      a['ACREAGE'] ?? null,
      wkt,
    ],
  );
}

async function main() {
  const stateArg = process.argv.includes('--state') ? process.argv[process.argv.indexOf('--state') + 1] : null;
  const states = stateArg ? [stateArg] : ['NV', 'AZ', 'CO', 'UT', 'NM', 'WY', 'MT', 'ID', 'CA', 'AK'];

  for (const state of states) {
    await timed(`BLM claims · ${state}`, async () => {
      const features = await fetchClaimsByState(state);
      log.info(`fetched ${features.length} active claims`, { state });
      await withTransaction(async () => {
        for (const f of features) await upsertClaim(f);
      });
    });
  }
}

main().catch((err) => {
  log.error('ingest-blm-claims failed', err);
  process.exit(1);
});
