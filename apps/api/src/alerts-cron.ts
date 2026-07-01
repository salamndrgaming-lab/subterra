/**
 * Weekly alert-digest cron.
 *
 * Runs after the Sunday ETL (wrangler.toml [triggers].crons). For every
 * enabled alert:
 *   1. load its AOI bbox,
 *   2. read the relevant diff payload from R2 (claims or permits),
 *   3. if the diff is newer than what we last emailed for this alert,
 *      match the newly-added features to the AOI + filters,
 *   4. email a digest of the matches and bump last_notified_version.
 *
 * The matcher itself is the pure, unit-tested matchDiffFeatures — this
 * module is just the D1 + R2 + email glue.
 */

import type { Env } from './index';
import { matchDiffFeatures, parseAlertFilters, type DiffFeature } from './alerts-match';
import { sendAlertDigestEmail } from './email';

interface DiffPayload {
  toVersion?: number;
  added?: DiffFeature[];
}

/** Which diff R2 key an alert's event kind reads from. Returns null for
 *  event kinds not yet backed by a diff feed. */
function diffKeyFor(eventKind: string): string | null {
  switch (eventKind) {
    case 'new_claim_filed':
    case 'claim_dropped':
      return 'diffs/latest.json';
    case 'permit_filed':
      return 'diffs/permits.json';
    default:
      return null; // well_spudded / production_change / price_threshold: future
  }
}

async function readDiff(env: Env, key: string): Promise<DiffPayload | null> {
  const obj = await env.TILES.get(key);
  if (!obj) return null;
  try {
    return (await obj.json()) as DiffPayload;
  } catch {
    return null;
  }
}

interface AlertRow {
  id: string;
  user_id: string;
  name: string;
  event_kind: string;
  aoi_id: string | null;
  filters_json: string;
  last_notified_version: number;
  email: string;
  bbox_west: number;
  bbox_south: number;
  bbox_east: number;
  bbox_north: number;
}

export async function runAlertCron(env: Env): Promise<{ processed: number; sent: number }> {
  // Join alerts → aois (for the bbox) → users (for the email). Only
  // enabled, AOI-scoped alerts.
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.user_id, a.name, a.event_kind, a.aoi_id, a.filters_json,
            a.last_notified_version, u.email,
            o.bbox_west, o.bbox_south, o.bbox_east, o.bbox_north
       FROM alerts a
       JOIN aois o ON o.id = a.aoi_id
       JOIN users u ON u.id = a.user_id
      WHERE a.is_enabled = 1`,
  ).all<AlertRow>();

  // Cache diff payloads across alerts so we read each R2 object once.
  const diffCache = new Map<string, DiffPayload | null>();
  let sent = 0;

  for (const a of results) {
    const key = diffKeyFor(a.event_kind);
    if (!key) continue;
    if (!diffCache.has(key)) diffCache.set(key, await readDiff(env, key));
    const diff = diffCache.get(key);
    if (!diff || typeof diff.toVersion !== 'number' || !Array.isArray(diff.added)) continue;
    // Already emailed for this ETL version — skip (idempotent cron).
    if (diff.toVersion <= a.last_notified_version) continue;

    const matches = matchDiffFeatures(
      diff.added,
      { west: a.bbox_west, south: a.bbox_south, east: a.bbox_east, north: a.bbox_north },
      parseAlertFilters(a.filters_json),
    );

    if (matches.length > 0) {
      await sendAlertDigestEmail(env, a.email, a.name, a.event_kind, matches);
      sent += 1;
    }
    // Bump the watermark whether or not there were matches, so an empty
    // week doesn't re-scan the same version next run.
    await env.DB.prepare('UPDATE alerts SET last_notified_version = ? WHERE id = ?')
      .bind(diff.toVersion, a.id)
      .run();
  }

  console.log(`[alerts-cron] processed ${results.length} alerts, sent ${sent} digests`);
  return { processed: results.length, sent };
}
