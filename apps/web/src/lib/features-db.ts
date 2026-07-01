/**
 * features.db client — lazy, range-request SQLite queries in the browser.
 *
 * The vector tiles can render features but can't *aggregate* them: MapLibre
 * only sees the current viewport's tiles and can't answer "which operators
 * hold the most wells in view." features.db (built by etl/build_features.py,
 * served range-aware from the Worker's /features route) fills that gap.
 *
 * We use sql.js-httpvfs, which issues HTTP range requests for only the
 * SQLite pages a query touches — so a query reads a few KB (index pages +
 * matching rows) instead of downloading a multi-hundred-MB database. The
 * R-tree index in the schema is what makes viewport queries cheap. No
 * SharedArrayBuffer / COOP-COEP needed: the worker uses synchronous XHR.
 *
 * Pure query builders + types live in ./features-db-sql (no runtime deps,
 * unit-tested); this module adds the worker lifecycle + async helpers.
 * Everything degrades gracefully: if the db isn't published yet or the
 * worker fails to init, the helpers return empty and the UI shows an
 * "unavailable" state rather than throwing.
 */

import { createDbWorker, type WorkerHttpvfs } from 'sql.js-httpvfs';
import workerUrl from 'sql.js-httpvfs/dist/sqlite.worker.js?url';
import wasmUrl from 'sql.js-httpvfs/dist/sql-wasm.wasm?url';

import {
  viewportOperatorSql,
  viewportFeaturesSql,
  type Bbox,
  type OperatorRollup,
  type FeatureRow,
} from './features-db-sql';

export {
  isFeaturesDbAvailable,
  viewportOperatorSql,
  viewportFeaturesSql,
  type Bbox,
  type OperatorRollup,
  type FeatureRow,
} from './features-db-sql';

// ─── lazy worker singleton ────────────────────────────────────────────
// Keyed on dbUrl so a manifest version bump (new ?v=) re-inits against
// the fresh db. A failed init resets the promise so a later call retries
// (e.g. once the db is published after the next ETL run).
let currentUrl: string | null = null;
let workerPromise: Promise<WorkerHttpvfs | null> | null = null;

async function getWorker(dbUrl: string): Promise<WorkerHttpvfs | null> {
  if (dbUrl !== currentUrl) {
    currentUrl = dbUrl;
    workerPromise = null;
  }
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    try {
      return await createDbWorker(
        [
          {
            from: 'inline',
            config: {
              serverMode: 'full',
              url: dbUrl,
              // Match the sqlite page size (default 4096) so each range
              // request maps cleanly onto a page.
              requestChunkSize: 4096,
            },
          },
        ],
        workerUrl,
        wasmUrl,
      );
    } catch (err) {
      console.warn('[features-db] worker init failed — feature queries disabled', err);
      workerPromise = null; // allow a retry on the next call
      currentUrl = null;
      return null;
    }
  })();
  return workerPromise;
}

async function runQuery<T>(dbUrl: string, sql: string, params: unknown[]): Promise<T[]> {
  const w = await getWorker(dbUrl);
  if (!w) return [];
  try {
    return (await w.db.query(sql, ...params)) as T[];
  } catch (err) {
    console.warn('[features-db] query failed', err);
    return [];
  }
}

/** Top operators (by feature count) within `bbox` across `layers`. */
export function topOperatorsInView(
  dbUrl: string,
  bbox: Bbox,
  layers: readonly string[],
  limit = 25,
): Promise<OperatorRollup[]> {
  if (layers.length === 0) return Promise.resolve([]);
  const sql = viewportOperatorSql(layers, limit);
  const params = [bbox.west, bbox.east, bbox.south, bbox.north, ...layers];
  return runQuery<OperatorRollup>(dbUrl, sql, params);
}

/** Raw features of one layer within `bbox`. */
export function featuresInView(
  dbUrl: string,
  bbox: Bbox,
  layer: string,
  limit = 200,
): Promise<FeatureRow[]> {
  const sql = viewportFeaturesSql(limit);
  const params = [bbox.west, bbox.east, bbox.south, bbox.north, layer];
  return runQuery<FeatureRow>(dbUrl, sql, params);
}
