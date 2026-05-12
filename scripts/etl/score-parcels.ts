/**
 * Batch-scores parcels with the opportunity engine. Writes to
 * `opportunity_scores` with a 7-day TTL.
 *
 * Usage:  npx tsx scripts/etl/score-parcels.ts [--state TX] [--commodity gold]
 */
import { query } from './lib/db.js';
import { log, timed } from './lib/log.js';

interface Parcel {
  id: string;
  lat: number;
  lng: number;
}

const RADIUS_KM = 10;

async function loadParcels(state: string | null): Promise<Parcel[]> {
  const where = state ? `WHERE state = $1` : '';
  const params = state ? [state] : [];
  const result = await query<{ id: string; lat: number; lng: number }>(
    `SELECT id, ST_Y(centroid) AS lat, ST_X(centroid) AS lng
       FROM parcels ${where}
       LIMIT 5000`,
    params,
  );
  return result.rows;
}

interface BasicScore {
  proximity: number;
  geology: number;
  infrastructure: number;
  availability: number;
}

async function scoreOne(p: Parcel, _commodity: string | null): Promise<BasicScore> {
  // proximity to active wells in same radius
  const proximity = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM wells
       WHERE status = 'active'
         AND ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3 * 1000)`,
    [p.lng, p.lat, RADIUS_KM],
  );

  const geology = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM mineral_occurrences
       WHERE ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3 * 1000)`,
    [p.lng, p.lat, RADIUS_KM * 4],
  );

  const claims = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM mining_claims
       WHERE status = 'active'
         AND ST_DWithin(centroid::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3 * 1000)`,
    [p.lng, p.lat, RADIUS_KM],
  );

  return {
    proximity: clamp((proximity.rows[0]?.n ?? 0) * 20, 0, 100),
    geology: clamp((geology.rows[0]?.n ?? 0) * 25, 0, 100),
    infrastructure: clamp(60 + (proximity.rows[0]?.n ?? 0) * 5, 0, 100),
    availability: clamp(100 - (claims.rows[0]?.n ?? 0) * 12, 0, 100),
  };
}

function clamp(n: number, min: number, max: number) { return Math.min(max, Math.max(min, n)); }

async function main() {
  const stateArg = process.argv.includes('--state') ? process.argv[process.argv.indexOf('--state') + 1] : null;
  const commodityArg = process.argv.includes('--commodity') ? process.argv[process.argv.indexOf('--commodity') + 1] : null;

  await timed('score-parcels', async () => {
    const parcels = await loadParcels(stateArg ?? null);
    log.info(`loaded ${parcels.length} parcels`, { state: stateArg, commodity: commodityArg });
    let i = 0;
    for (const p of parcels) {
      const s = await scoreOne(p, commodityArg ?? null);
      const blended = 0.30 * s.proximity + 0.25 * s.geology + 0.20 * s.infrastructure + 0.25 * s.availability;
      await query(
        `INSERT INTO opportunity_scores
           (entity_type, entity_id, commodity, score,
            proximity_to_production, geology_similarity, infrastructure_score,
            claim_availability, commodity_price_index, permitting_complexity,
            geom, computed_at, expires_at)
         VALUES ('parcel', $1, $2, $3,
                 $4, $5, $6, $7, 60, 55,
                 ST_SetSRID(ST_MakePoint($9, $8), 4326), now(), now() + interval '7 days')
         ON CONFLICT (entity_type, entity_id, commodity)
         DO UPDATE SET score = EXCLUDED.score,
                       proximity_to_production = EXCLUDED.proximity_to_production,
                       geology_similarity = EXCLUDED.geology_similarity,
                       infrastructure_score = EXCLUDED.infrastructure_score,
                       claim_availability = EXCLUDED.claim_availability,
                       computed_at = now(),
                       expires_at = now() + interval '7 days'`,
        [
          p.id, commodityArg, blended,
          s.proximity, s.geology, s.infrastructure, s.availability,
          p.lat, p.lng,
        ],
      );
      if (++i % 500 === 0) log.info('progress', { i });
    }
  });
}

main().catch((err) => {
  log.error('score-parcels failed', err);
  process.exit(1);
});
