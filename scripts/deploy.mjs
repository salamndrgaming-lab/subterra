#!/usr/bin/env node
/**
 * Cross-platform production deploy.
 *
 * Runs from any shell on Windows, macOS, or Linux without sed / bash /
 * subshells. Auto-discovers the D1 database id by listing the user's
 * Cloudflare account, substitutes it into apps/api/wrangler.toml, then
 * deploys the Worker and the Pages SPA. Always restores wrangler.toml
 * to its committed placeholder state on exit so `git status` stays clean.
 *
 * Prereqs:
 *   - You're authenticated: `npx wrangler login` (one-time browser OAuth)
 *   - You created a D1 database named "subterra" (per the manual setup)
 *   - You created an R2 bucket named "subterra-tiles"
 *
 * Usage from your repo root (any OS):
 *   npm run deploy:prod
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER_TOML = resolve(ROOT, 'apps/api/wrangler.toml');
const PLACEHOLDER_DB_ID = '00000000-0000-0000-0000-000000000000';

const isWindows = process.platform === 'win32';
const NPX = isWindows ? 'npx.cmd' : 'npx';

function run(args, opts = {}) {
  const printable = ['npx', ...args].join(' ');
  console.log(`\n▸ ${printable}`);
  const r = spawnSync(NPX, args, { stdio: 'inherit', shell: isWindows, ...opts });
  if (r.status !== 0) {
    throw new Error(`Command failed (exit ${r.status}): ${printable}`);
  }
}

function capture(args, opts = {}) {
  const r = spawnSync(NPX, args, { encoding: 'utf8', shell: isWindows, ...opts });
  if (r.status !== 0) {
    process.stderr.write(r.stderr || '');
    throw new Error(`Command failed (exit ${r.status}): npx ${args.join(' ')}`);
  }
  return r.stdout;
}

function findD1Id() {
  console.log('▸ resolving D1 database id…');
  const out = capture(['--yes', 'wrangler@3', 'd1', 'list', '--json']);
  let list;
  try { list = JSON.parse(out); } catch {
    throw new Error(`Could not parse 'wrangler d1 list --json' output:\n${out}`);
  }
  const hit = list.find((d) => d.name === 'subterra');
  if (!hit) {
    const names = list.map((d) => d.name).join(', ') || '(none)';
    throw new Error(
      `No D1 database named "subterra". Found: ${names}. ` +
      `Create one with: npx wrangler d1 create subterra`,
    );
  }
  console.log(`  found subterra → ${hit.uuid}`);
  return hit.uuid;
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
  const id = findD1Id();
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
  console.log('\n✅ Deploy complete.');
  console.log('   Worker:  https://subterra-api.<your-account>.workers.dev');
  console.log('   Pages:   https://subterra.pages.dev/map');
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
});
