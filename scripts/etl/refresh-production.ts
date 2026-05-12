/**
 * Pulls monthly production volumes from the public state-commission flat-file
 * extracts and upserts into `well_production`.
 *
 *   - North Dakota DMR: monthly Production Statistics CSV at
 *     https://www.dmr.nd.gov/oilgas/feeservices/getmonthlyproduction.asp
 *     (free, no auth)
 *   - Colorado ECMC: production CSV downloads at
 *     https://ecmc.state.co.us/data2.html
 *
 * Each agency ships a different CSV schema; we normalize to the shared
 * (api_number, report_month, oil_bbl, gas_mcf, water_bbl, days_produced).
 *
 * Run:  npx tsx scripts/etl/refresh-production.ts --state ND --month 2026-04 --csv ./data/raw/nd-202604.csv
 */
import 'dotenv/config';
import fs from 'node:fs';
import readline from 'node:readline';
import { query } from './lib/db.js';
import { log, timed } from './lib/log.js';

interface Row {
  apiNumber: string;
  reportMonth: string;
  oilBbl: number | null;
  gasMcf: number | null;
  waterBbl: number | null;
  daysProduced: number | null;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (const ch of line) {
    if (ch === '"') { q = !q; continue; }
    if (ch === ',' && !q) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

async function* readCsv(path: string): AsyncGenerator<Record<string, string>> {
  const stream = fs.createReadStream(path);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let header: string[] | null = null;
  for await (const line of rl) {
    if (!line.trim()) continue;
    const cols = parseCsvLine(line);
    if (!header) { header = cols.map((h) => h.trim().toLowerCase()); continue; }
    const row: Record<string, string> = {};
    for (let i = 0; i < header.length; i++) row[header[i]!] = cols[i] ?? '';
    yield row;
  }
}

function num(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number(v.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

async function* normalizeNd(rows: AsyncIterable<Record<string, string>>, month: string): AsyncGenerator<Row> {
  // ND header sample: api_no, oil, gas, water, days, file_no.
  // The ND extract is single-month, so reportMonth is supplied externally.
  for await (const r of rows) {
    const api = r['api_no'] ?? r['api'] ?? '';
    if (!api) continue;
    yield {
      apiNumber: api,
      reportMonth: month,
      oilBbl: num(r['oil']),
      gasMcf: num(r['gas']),
      waterBbl: num(r['water']),
      daysProduced: num(r['days']),
    };
  }
}

async function* normalizeCo(rows: AsyncIterable<Record<string, string>>): AsyncGenerator<Row> {
  // CO header sample: api_num, prod_period, oil_prod, gas_prod, water_prod, days_prod.
  for await (const r of rows) {
    const api = r['api_num'] ?? r['api'] ?? '';
    const period = r['prod_period'] ?? r['report_month'] ?? '';
    if (!api || !period) continue;
    yield {
      apiNumber: api,
      reportMonth: period.length >= 7 ? `${period.slice(0, 7)}-01` : period,
      oilBbl: num(r['oil_prod']),
      gasMcf: num(r['gas_prod']),
      waterBbl: num(r['water_prod']),
      daysProduced: num(r['days_prod']),
    };
  }
}

async function upsert(row: Row) {
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
    [row.apiNumber, row.reportMonth, row.oilBbl, row.gasMcf, row.waterBbl, row.daysProduced, 'production_extract'],
  );
}

async function main() {
  const argIndex = (name: string) => process.argv.indexOf(name);
  const state = argIndex('--state') >= 0 ? process.argv[argIndex('--state') + 1]?.toUpperCase() : null;
  const monthArg = argIndex('--month') >= 0 ? process.argv[argIndex('--month') + 1] : null;
  const csv = argIndex('--csv') >= 0 ? process.argv[argIndex('--csv') + 1] : null;

  if (!csv) {
    log.warn(
      'No --csv path provided. Download the monthly production extract from the relevant state commission and rerun:',
    );
    log.warn('  ND: https://www.dmr.nd.gov/oilgas/feeservices/getmonthlyproduction.asp');
    log.warn('  CO: https://ecmc.state.co.us/data2.html');
    return;
  }

  const month = monthArg ? `${monthArg}-01` : null;
  if (state === 'ND' && !month) throw new Error('ND extract is single-month; pass --month YYYY-MM');

  await timed(`production · ${state} · ${month ?? 'multi-month'}`, async () => {
    let count = 0;
    if (state === 'ND') {
      for await (const row of normalizeNd(readCsv(csv), month!)) {
        await upsert(row); count++;
      }
    } else if (state === 'CO') {
      for await (const row of normalizeCo(readCsv(csv))) {
        await upsert(row); count++;
      }
    } else {
      throw new Error(`Unsupported --state ${state}. Currently wired: ND, CO.`);
    }
    log.info(`upserted ${count} production rows`);
  });
}

main().catch((err) => {
  log.error('refresh-production failed', err);
  process.exit(1);
});
