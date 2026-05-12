import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

let dbWarned = false;
pool.on('error', (err) => {
  if (!dbWarned) {
    console.warn(`[db] pool error — DB-backed routes will return 503 until reachable.`, (err as Error).message);
    dbWarned = true;
  }
});

export async function dbStatus(): Promise<'ok' | 'unavailable'> {
  try {
    const r = await pool.query('SELECT 1 AS ok');
    return r.rowCount === 1 ? 'ok' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  const start = Date.now();
  const result = await pool.query<T>(text, params as never);
  const duration = Date.now() - start;
  if (duration > 500) {
    console.warn(`[db] slow query (${duration}ms):`, text.slice(0, 100));
  }
  return result;
}

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
