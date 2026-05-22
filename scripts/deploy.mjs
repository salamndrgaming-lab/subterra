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

async function findD1Id() {
  // 1. CLI arg
  const argHit = process.argv.find((a) => a.startsWith('--d1-id='));
  if (argHit) {
    const v = argHit.slice('--d1-id='.length).trim();
    if (!isUuid(v)) throw new Error(`--d1-id is not a valid UUID: "${v}"`);
    writeCache({ ...readCache(), d1Id: v });
    console.log(`▸ D1 id from --d1-id: ${v}`);
    return v;
  }
  // 2. Env var (set CLOUDFLARE_D1_DATABASE_ID=…)
  const envHit = process.env.CLOUDFLARE_D1_DATABASE_ID;
  if (envHit && isUuid(envHit)) {
    writeCache({ ...readCache(), d1Id: envHit });
    console.log(`▸ D1 id from env: ${envHit}`);
    return envHit;
  }
  // 3. Cache from previous run
  const cache = readCache();
  if (cache.d1Id && isUuid(cache.d1Id)) {
    console.log(`▸ D1 id (cached): ${cache.d1Id}`);
    return cache.d1Id;
  }
  // 4. Interactive prompt — run BEFORE any other spawn so stdin is untouched
  console.log('');
  console.log('Need your D1 database UUID. To find it, in another terminal:');
  console.log('    npx wrangler d1 list');
  console.log('(Look for name = "subterra" and copy the uuid column.)');
  console.log('Or re-run with:  npm run deploy:prod -- --d1-id=<uuid>');
  console.log('');
  const rl = createInterface({ input: stdin, output: stdout });
  const raw = (await rl.question('subterra D1 uuid: ')).trim();
  rl.close();
  if (!isUuid(raw)) {
    throw new Error(`That doesn't look like a UUID: "${raw}"`);
  }
  writeCache({ ...cache, d1Id: raw });
  console.log(`  cached in .cf-deploy.json — won't ask again`);
  return raw;
}

function isUuid(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
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
  // Prompt FIRST (before any spawn touches stdin — that's what broke
  // the prior version: on Windows, `npm run build && node deploy.mjs`
  // leaves stdin in a non-blocking state by the time readline tries
  // to read).
  const id = await findD1Id();

  // Build now that we have the id; build steps spawn lots of child
  // processes but no longer need to read stdin.
  console.log('\n▸ building (shared → api → web)…');
  const NPM = isWindows ? 'npm.cmd' : 'npm';
  const buildSteps = [
    ['run', 'build:shared'],
    ['run', 'build:api'],
    ['run', 'build:web'],
  ];
  for (const args of buildSteps) {
    const r = spawnSync(NPM, args, { stdio: 'inherit', shell: isWindows, cwd: ROOT });
    if (r.status !== 0) {
      throw new Error(`Build step \`npm ${args.join(' ')}\` failed (exit ${r.status}).`);
    }
  }

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
