import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load committed public defaults first, then user .env (which overrides).
// repoRoot is two levels up from this file when running compiled (dist) or
// source (src) — both resolve to apps/api, then ../.. = repo root.
// here = apps/api/src/  (or apps/api/dist/ when packaged)
// repoRoot is three levels up.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
dotenv.config({ path: path.join(repoRoot, '.env.defaults') });
dotenv.config({ path: path.join(repoRoot, '.env'), override: true });

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const config = {
  port: Number(optional('API_PORT', '4000')),
  host: optional('API_HOST', '0.0.0.0'),
  databaseUrl: optional('DATABASE_URL', 'postgresql://subterra:subterra@localhost:5432/subterra'),
  redisUrl: optional('REDIS_URL', 'redis://localhost:6379'),
  jwt: {
    accessSecret: optional('JWT_SECRET', 'dev-only-access-secret-change-me'),
    refreshSecret: optional('JWT_REFRESH_SECRET', 'dev-only-refresh-secret-change-me'),
    accessTtlSeconds: 60 * 15,
    refreshTtlSeconds: 60 * 60 * 24 * 30,
  },
  cors: {
    origin: optional('CORS_ORIGIN', 'http://localhost:3000'),
  },
  isProd: process.env.NODE_ENV === 'production',
} as const;

export { required };
