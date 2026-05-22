#!/usr/bin/env node
/**
 * Cross-platform production deploy.
 *
 * Builds the workspace, resolves the D1 database id, substitutes it into
 * apps/api/wrangler.toml, deploys the Worker, then deploys Pages. Always
 * restores wrangler.toml's placeholder on exit so `git status` stays clean.
 *
 * D1 id resolution (in order):
 *   1. .cf-deploy.json   — cached from a previous run
 *   2. wrangler d1 list  — if wrangler can see your auth (works after
 *                          `npx wrangler login` in some setups)
 *   3. interactive prompt — paste it once, we cache it forever
 *
 * Prereqs:
 *   - Run `npx wrangler login` once (browser OAuth)
 *   - Create the D1 database: `npx wrangler d1 create subterra`
 *   - Create the R2 bucket:   `npx wrangler r2 bucket create subterra-tiles`
 *
 * Usage:
 *   npm run deploy:prod
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER_TOML = resolve(ROOT, 'apps/api/wrangler.toml');
const CACHE_FILE = resolve(ROOT, '.cf-deploy.json');
const PLACEHOLDER_DB_ID = '00000000-0000-0000-0000-000000000000';

const isWindows = process.platform === 'win32';
const NPX = isWindows ? 'npx.cmd' : 'npx';

function readCache() {
  if (!existsSync(CACHE_FILE)) return {};
  try { return JSON.parse(readFileSync(CACHE_FILE, 'utf8')); } catch { return {}; }
}
function writeCache(obj) {
  writeFileSync(CACHE_FILE, JSON.stringify(obj, null, 2) + '\n');
}

function run(args, opts = {}) {
  const printable = ['npx', ...args].join(' ');
  console.log(`\n▸ ${printable}`);
  const r = spawnSync(NPX, args, { stdio: 'inherit', shell: isWindows, ...opts });
  if (r.status !== 0) {
    throw new Error(`Command failed (exit ${r.status}): ${printable}`);
  }
}

function tryWranglerD1List() {
  // Inherit stdin so wrangler's TTY check sees an interactive shell on
  // platforms where that's enough to unlock saved OAuth credentials.
  const r = spawnSync(
    NPX,
    ['--yes', 'wrangler@3', 'd1', 'list', '--json'],
    { encoding: 'utf8', shell: isWindows, stdio: ['inherit', 'pipe', 'pipe'] },
  );
  if (r.status !== 0) return null;
  const trimmed = (r.stdout || '').trim();
  if (!trimmed.startsWith('[')) return null;
  try {
    const list = JSON.parse(trimmed);
    const hit = list.find((d) => d.name === 'subterra');
    return hit ? hit.uuid : null;
  } catch {
    return null;
  }
}

async function promptForD1Id() {
  console.log('');
  console.log("Couldn't auto-detect your D1 database id from the wrangler CLI.");
  console.log('To find it, open another terminal and run:');
  console.log('    npx wrangler d1 list');
  console.log('Look for the row where name = "subterra" and copy its uuid.');
  console.log('We\'ll cache it in .cf-deploy.json so you only do this once.');
  console.log('');
  const rl = createInterface({ input: stdin, output: stdout });
  const raw = (await rl.question('subterra D1 uuid: ')).trim();
  rl.close();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
    throw new Error(`That doesn't look like a UUID: "${raw}"`);
  }
  return raw;
}

async function findD1Id() {
  const cache = readCache();
  if (cache.d1Id) {
    console.log(`▸ D1 id (cached): ${cache.d1Id}`);
    return cache.d1Id;
  }
  console.log('▸ resolving D1 database id…');
  const fromCli = tryWranglerD1List();
  if (fromCli) {
    console.log(`  found via wrangler: ${fromCli}`);
    writeCache({ ...cache, d1Id: fromCli });
    return fromCli;
  }
  const fromPrompt = await promptForD1Id();
  writeCache({ ...cache, d1Id: fromPrompt });
  console.log(`  cached for next run → .cf-deploy.json`);
  return fromPrompt;
}

function patchToml(id) {
  const before = readFileSync(WRANGLER_TOML, 'utf8');
  if (!before.includes(PLACEHOLDER_DB_ID)) {
    throw new Error(`apps/api/wrangler.toml has no placeholder ${PLACEHOLDER_DB_ID} to replace.`);
  }
  writeFileSync(WRANGLER_TOML, before.replaceAll(PLACEHOLDER_DB_ID, id));
  return before;
}

async function main() {
  const id = await findD1Id();
  const original = patchToml(id);
  try {
    run(['--yes', 'wrangler@3', 'deploy'], { cwd: resolve(ROOT, 'apps/api') });
    run([
      '--yes', 'wrangler@3', 'pages', 'deploy', 'apps/web/dist',
      '--project-name=subterra', '--branch=main',
    ]);
  } finally {
    writeFileSync(WRANGLER_TOML, original);
    console.log('▸ restored wrangler.toml to committed state');
  }
  console.log('');
  console.log('✅ Deploy complete.');
  console.log('   Map (web):   https://subterra.pages.dev/map');
  console.log('   API health:  https://subterra-api.<your-account>.workers.dev/health');
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
});
