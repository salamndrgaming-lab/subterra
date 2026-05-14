/**
 * One-command bootstrap. Runs every step needed to take a fresh checkout to
 * a working dev environment:
 *
 *   1. Copy .env.example -> .env (root + apps/web) if missing
 *   2. Wait for PostgreSQL on DATABASE_URL (up to 60s)
 *   3. Apply db/schema.sql (idempotent)
 *   4. Run scripts/seed.ts to ingest a small bbox of real BLM + USGS data
 *
 * Usage:  npm run setup
 *
 * Re-running this is safe — every step is idempotent.
 */
import dotenv from 'dotenv';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(repoRoot, '.env.defaults') });
dotenv.config({ path: path.join(repoRoot, '.env'), override: true });

function step(n: number, msg: string) { console.log(`\n[setup] (${n}) ${msg}`); }
function info(msg: string) { console.log(`        ${msg}`); }
function ok(msg: string) { console.log(`        ✓ ${msg}`); }

async function copyIfMissing(src: string, dest: string, label: string) {
  const a = path.join(repoRoot, src);
  const b = path.join(repoRoot, dest);
  if (existsSync(b)) { ok(`${label} already exists`); return; }
  if (!existsSync(a)) throw new Error(`${a} not found`);
  copyFileSync(a, b);
  ok(`${label} copied from ${src}`);
}

async function waitForPostgres(url: string, timeoutSec = 60) {
  const start = Date.now();
  while (Date.now() - start < timeoutSec * 1000) {
    try {
      const c = new pg.Client({ connectionString: url });
      await c.connect();
      await c.query('SELECT 1');
      await c.end();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw new Error(`PostgreSQL not reachable at ${url} after ${timeoutSec}s. Is Docker running? Try: docker compose up -d`);
}

async function applySchema(url: string) {
  const sql = readFileSync(path.join(repoRoot, 'db/schema.sql'), 'utf8');
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}

function spawnNpx(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', args, { cwd: repoRoot, stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`npx ${args.join(' ')} exited ${code}`))));
  });
}

async function main() {
  const url = process.env.DATABASE_URL ?? 'postgresql://subterra:subterra@localhost:5432/subterra';

  step(1, 'Ensuring env files exist');
  await copyIfMissing('.env.example', '.env', '.env');
  await copyIfMissing('apps/web/.env.example', 'apps/web/.env.local', 'apps/web/.env.local');

  step(2, `Waiting for PostgreSQL at ${url.replace(/:[^:@]*@/, ':***@')}`);
  await waitForPostgres(url);
  ok('PostgreSQL is up');

  step(3, 'Applying db/schema.sql');
  await applySchema(url);
  ok('schema applied (idempotent — safe to re-run)');

  step(4, 'Seeding real BLM + USGS MRDS data for the western US bbox');
  try {
    await spawnNpx(['tsx', 'scripts/seed.ts']);
    ok('seed complete');
  } catch (err) {
    info(`seed failed: ${(err as Error).message}`);
    info('You can rerun later with: npx tsx scripts/seed.ts');
  }

  console.log('\n[setup] ✓ done. Start the dev servers with:  npm run dev');
}

main().catch((err) => {
  console.error('\n[setup] ✗ failed:', err.message);
  process.exit(1);
});
