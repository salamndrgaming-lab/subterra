/**
 * Entrypoint that runs every ETL job in the right order. Used by `npm run etl`.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const jobs = [
  'ingest-blm-claims.ts',
  'ingest-wells.ts',
  'ingest-usgs-mrds.ts',
  'refresh-production.ts',
  'score-parcels.ts',
];

async function run(file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', path.join(here, file)], { stdio: 'inherit' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${file} exited ${code}`))));
  });
}

(async () => {
  for (const job of jobs) {
    console.log(`\n=== running ${job} ===\n`);
    await run(job);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
