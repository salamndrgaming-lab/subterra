/**
 * Pulls last-month production volumes per state oil & gas commission and
 * upserts into `well_production`. Run nightly via cron.
 *
 * Each state ships monthly volumes ~30 days after the production month.
 *
 * Run:  npx tsx scripts/etl/refresh-production.ts [--state TX] [--month 2026-04]
 */
import { query } from './lib/db.js';
import { log, timed } from './lib/log.js';

interface ProductionRow {
  apiNumber: string;
  reportMonth: string; // YYYY-MM-01
  oilBbl: number | null;
  gasMcf: number | null;
  waterBbl: number | null;
  daysProduced: number | null;
  source: string;
}

async function fetchTexasMonth(_month: string): Promise<ProductionRow[]> {
  log.warn('Texas RRC monthly production fetch is stubbed.');
  return [];
}
async function fetchNDICMonth(_month: string): Promise<ProductionRow[]> {
  log.warn('NDIC monthly production fetch is stubbed.');
  return [];
}
async function fetchColoradoMonth(_month: string): Promise<ProductionRow[]> {
  log.warn('CO ECMC monthly production fetch is stubbed.');
  return [];
}

async function upsert(row: ProductionRow) {
  await query(
    `INSERT INTO well_production
       (well_id, report_month, oil_bbl, gas_mcf, water_bbl, days_produced, source)
     SELECT id, $2::date, $3, $4, $5, $6, $7
       FROM wells WHERE api_number = $1
     ON CONFLICT (well_id, report_month) DO UPDATE SET
       oil_bbl = EXCLUDED.oil_bbl,
       gas_mcf = EXCLUDED.gas_mcf,
       water_bbl = EXCLUDED.water_bbl,
       days_produced = EXCLUDED.days_produced`,
    [row.apiNumber, row.reportMonth, row.oilBbl, row.gasMcf, row.waterBbl, row.daysProduced, row.source],
  );
}

async function main() {
  const stateArg = process.argv.includes('--state') ? process.argv[process.argv.indexOf('--state') + 1] : null;
  const monthArg = process.argv.includes('--month') ? process.argv[process.argv.indexOf('--month') + 1] : null;
  const month = monthArg ? `${monthArg}-01` : lastFullMonth();
  const states = stateArg ? [stateArg] : ['TX', 'ND', 'CO'];

  for (const state of states) {
    await timed(`production · ${state} · ${month}`, async () => {
      const rows = state === 'TX' ? await fetchTexasMonth(month)
        : state === 'ND' ? await fetchNDICMonth(month)
        : state === 'CO' ? await fetchColoradoMonth(month)
        : [];
      for (const r of rows) await upsert(r);
      log.info(`upserted ${rows.length} production rows`, { state, month });
    });
  }
}

function lastFullMonth(): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return d.toISOString().slice(0, 8) + '01';
}

main().catch((err) => {
  log.error('refresh-production failed', err);
  process.exit(1);
});
