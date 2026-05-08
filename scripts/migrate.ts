/**
 * Cross-platform schema migration. Reads db/schema.sql and applies it via
 * the `pg` client so we don't need a local psql binary on Windows or CI.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  const url = process.env.DATABASE_URL ?? 'postgresql://subterra:subterra@localhost:5432/subterra';
  const sql = readFileSync(path.join(repoRoot, 'db/schema.sql'), 'utf8');

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    console.log(`[migrate] applying schema to ${url.replace(/:[^:@]*@/, ':***@')}`);
    await client.query(sql);
    console.log('[migrate] ✓ schema applied (idempotent)');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('[migrate] ✗ failed:', err.message);
  process.exit(1);
});
