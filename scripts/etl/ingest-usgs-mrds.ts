/**
 * Ingests USGS Mineral Resources Data System (MRDS) point occurrences.
 *
 * Source: https://mrdata.usgs.gov/mrds/
 * The full bulk export is published as a single CSV (~300k records). For
 * Phase 1 the script accepts either the bulk CSV path on disk or the
 * record-by-record JSON endpoint.
 *
 * Run:  npx tsx scripts/etl/ingest-usgs-mrds.ts [--csv ./data/raw/mrds.csv]
 */
import fs from 'node:fs';
import readline from 'node:readline';
import { query } from './lib/db.js';
import { log, timed } from './lib/log.js';

interface MrdsRow {
  mrdsId: string;
  siteName: string;
  state: string | null;
  county: string | null;
  primaryCommodity: string | null;
  developmentStatus: string | null;
  discoveryYear: number | null;
  lastProductionYear: number | null;
  lat: number;
  lng: number;
}

async function* readCsv(path: string): AsyncGenerator<MrdsRow> {
  const stream = fs.createReadStream(path);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let header: string[] | null = null;

  for await (const line of rl) {
    const cols = parseCsvRow(line);
    if (!header) {
      header = cols;
      continue;
    }
    const get = (name: string) => cols[header!.indexOf(name)] ?? null;
    const lat = Number(get('latitude'));
    const lng = Number(get('longitude'));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    yield {
      mrdsId: String(get('dep_id') ?? get('site_id') ?? ''),
      siteName: String(get('site_name') ?? ''),
      state: get('state'),
      county: get('county'),
      primaryCommodity: get('commod1'),
      developmentStatus: get('dev_stat')?.toLowerCase() ?? null,
      discoveryYear: numberOrNull(get('discovery_year')),
      lastProductionYear: numberOrNull(get('last_prod_year')),
      lat,
      lng,
    };
  }
}

function parseCsvRow(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ',' && !inQuotes) { out.push(current); current = ''; continue; }
    current += ch;
  }
  out.push(current);
  return out;
}

function numberOrNull(v: string | null): number | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function upsert(row: MrdsRow) {
  await query(
    `INSERT INTO mineral_occurrences
       (mrds_id, site_name, state, county, primary_commodity,
        development_status, discovery_year, last_production_year,
        geom, source, source_updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
             ST_SetSRID(ST_MakePoint($10, $9), 4326), 'usgs_mrds', now())
     ON CONFLICT (mrds_id) DO UPDATE SET
       primary_commodity = EXCLUDED.primary_commodity,
       development_status = EXCLUDED.development_status,
       last_production_year = EXCLUDED.last_production_year,
       geom = EXCLUDED.geom,
       source_updated_at = now()`,
    [
      row.mrdsId, row.siteName, row.state, row.county, row.primaryCommodity,
      row.developmentStatus, row.discoveryYear, row.lastProductionYear,
      row.lat, row.lng,
    ],
  );
}

async function main() {
  const csvIdx = process.argv.indexOf('--csv');
  const csvPath = csvIdx >= 0 ? process.argv[csvIdx + 1] : null;
  if (!csvPath) {
    log.warn('No --csv path provided. Download the MRDS bulk extract from https://mrdata.usgs.gov/mrds/ and rerun.');
    return;
  }
  await timed('usgs mrds', async () => {
    let count = 0;
    for await (const row of readCsv(csvPath)) {
      if (!row.mrdsId) continue;
      await upsert(row);
      count++;
      if (count % 1000 === 0) log.info(`progress`, { count });
    }
    log.info('mrds ingest complete', { count });
  });
}

main().catch((err) => {
  log.error('ingest-usgs-mrds failed', err);
  process.exit(1);
});
