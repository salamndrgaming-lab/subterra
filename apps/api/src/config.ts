import 'dotenv/config';

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
