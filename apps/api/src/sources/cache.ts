/**
 * In-memory + Redis fallback cache for upstream public-data calls. Real public
 * GIS endpoints are rate-limited and slow; we cache responses by canonical key.
 */
import { cacheGet, cacheSet } from '../redis.js';

interface Entry<T> { value: T; expiresAt: number }

const mem = new Map<string, Entry<unknown>>();

export async function cached<T>(
  key: string,
  ttlSeconds: number,
  load: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const local = mem.get(key);
  if (local && local.expiresAt > now) return local.value as T;

  const remote = await cacheGet<T>(key);
  if (remote) {
    mem.set(key, { value: remote, expiresAt: now + ttlSeconds * 1000 });
    return remote;
  }

  const value = await load();
  mem.set(key, { value, expiresAt: now + ttlSeconds * 1000 });
  await cacheSet(key, value, ttlSeconds);
  return value;
}
