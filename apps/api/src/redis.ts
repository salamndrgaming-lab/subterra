import { Redis } from 'ioredis';
import { config } from './config.js';

/**
 * Redis client with aggressive lazy/silent failure semantics: the app must
 * keep serving the live ArcGIS layers even when Redis is unreachable, so we
 * downgrade cache misses to passthroughs and never throw out of cacheGet/Set.
 */
export const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  lazyConnect: true,
  retryStrategy: (times) => Math.min(times * 1000, 10_000),
});

let warned = false;
redis.on('error', (err) => {
  if (!warned) {
    console.warn(`[redis] unavailable at ${config.redisUrl} — running without upstream cache.`, (err as Error).message);
    warned = true;
  }
});

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const raw = await redis.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, value: unknown, ttlSeconds = 300): Promise<void> {
  try {
    await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch {
    // best-effort cache; ignore
  }
}

export async function redisStatus(): Promise<'ok' | 'unavailable'> {
  try {
    const reply = await redis.ping();
    return reply === 'PONG' ? 'ok' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}
