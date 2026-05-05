/**
 * Ingests oil & gas wells from state oil & gas commissions.
 *
 *   - Texas RRC      → https://www.rrc.texas.gov/oil-gas/research-and-statistics/
 *   - North Dakota   → https://www.dmr.nd.gov/oilgas/
 *   - Colorado ECMC  → https://ecmc.state.co.us/data2.html
 *
 * Each state ships a different schema; we normalize to the `wells` table.
 *
 * Run:  npx tsx scripts/etl/ingest-wells.ts [--state TX]
 */
import { query } from './lib/db.js';
import { log, timed } from './lib/log.js';

interface WellRow {
  apiNumber: string;
  wellName: string | null;
  operator: string | null;
  state: string;
  county: string | null;
  basin: string | null;
  formation: string | null;
  status: string | null;
  spudDate: string | null;
  totalDepthFt: number | null;
  surfaceLat: number;
  surfaceLng: number;
  source: string;
}

async function fetchTexasRRC(): Promise<WellRow[]> {
  // Texas publishes a monthly Wellbore Data Pull in pipe-delimited format.
  // For a real ingest, parse https://www.rrc.texas.gov/.../wellbore-data-pull.
  log.warn('Texas RRC fetch is stubbed — wire the wellbore data pull in Phase 2.');
  return [];
}

async function fetchNDIC(): Promise<WellRow[]> {
  log.warn('NDIC fetch is stubbed — wire the GIS Hub feature service in Phase 2.');
  return [];
}

async function fetchColoradoECMC(): Promise<WellRow[]> {
  log.warn('CO ECMC fetch is stubbed — wire the data2.html CSV exports in Phase 2.');
  return [];
}

async function upsertWell(w: WellRow) {
  await query(
    `INSERT INTO wells
       (api_number, well_name, operator, state, county, basin, formation,
        status, spud_date, total_depth_ft, surface_lat, surface_lng,
        geom, source, source_updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7,
             $8::well_status, $9, $10, $11, $12,
             ST_SetSRID(ST_MakePoint($12, $11), 4326), $13, now())
     ON CONFLICT (api_number) DO UPDATE SET
       status = EXCLUDED.status,
       operator = EXCLUDED.operator,
       total_depth_ft = EXCLUDED.total_depth_ft,
       geom = EXCLUDED.geom,
       source_updated_at = now()`,
    [
      w.apiNumber, w.wellName, w.operator, w.state, w.county, w.basin, w.formation,
      w.status, w.spudDate, w.totalDepthFt, w.surfaceLat, w.surfaceLng,
      w.source,
    ],
  );
}

async function main() {
  const arg = process.argv.includes('--state') ? process.argv[process.argv.indexOf('--state') + 1] : null;
  const states = arg ? [arg] : ['TX', 'ND', 'CO'];

  for (const state of states) {
    await timed(`wells · ${state}`, async () => {
      const rows = state === 'TX' ? await fetchTexasRRC()
        : state === 'ND' ? await fetchNDIC()
        : state === 'CO' ? await fetchColoradoECMC()
        : [];
      log.info(`upserting ${rows.length} wells`, { state });
      for (const w of rows) await upsertWell(w);
    });
  }
}

main().catch((err) => {
  log.error('ingest-wells failed', err);
  process.exit(1);
});
