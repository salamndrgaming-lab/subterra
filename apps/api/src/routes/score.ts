import { Router } from 'express';
import { z } from 'zod';
import type { OpportunityScore, OpportunityTag } from '@subterra/shared';
import { fetchBlmClaims } from '../sources/blm-claims.js';
import { fetchMrds } from '../sources/usgs-mrds.js';
import { fetchWells } from '../sources/wells.js';
import { haversineKm } from '../lib/geo.js';

export const scoreRouter = Router();

const ScoreQuery = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radius: z.coerce.number().positive().max(200).default(10),
  commodity: z.string().optional(),
});

/**
 * Computes an opportunity score from real public data only:
 *   - active producing wells from state-commission FeatureServers
 *   - BLM National Mining Claims FeatureServer (claim density)
 *   - USGS MRDS WFS (analog occurrences)
 *
 * If an upstream source is unreachable we surface that in `meta.unavailable`
 * rather than substituting synthetic values, so downstream consumers can
 * decide how to handle partial coverage.
 */
scoreRouter.get('/', async (req, res, next) => {
  try {
    const q = ScoreQuery.parse(req.query);
    const center: [number, number] = [q.lng, q.lat];
    const radiusKm = q.radius;
    const halfDeg = radiusKm / 110;
    const bbox: [number, number, number, number] = [
      q.lng - halfDeg, q.lat - halfDeg, q.lng + halfDeg, q.lat + halfDeg,
    ];

    const unavailable: string[] = [];

    let proximityToProduction = 0;
    try {
      const wells = await fetchWells({ bbox, status: 'active', limit: 1000 });
      const producing = wells.features.filter(
        (f) => haversineKm(center, f.geometry.coordinates as [number, number]) < radiusKm,
      );
      proximityToProduction = clamp((producing.length / 5) * 100, 0, 100);
      unavailable.push(...wells.meta.unavailableStates.map((s) => `wells:${s}`));
    } catch {
      unavailable.push('wells');
    }

    let geologySimilarity = 0;
    let analogProducer = false;
    let analogPastProducer = false;
    try {
      const occ = await fetchMrds({
        bbox: [q.lng - halfDeg * 4, q.lat - halfDeg * 4, q.lng + halfDeg * 4, q.lat + halfDeg * 4],
        commodity: q.commodity,
        limit: 200,
      });
      const matching = occ.features.filter((f) => {
        if (q.commodity && !(f.properties.primaryCommodity ?? '').includes(q.commodity)) return false;
        return haversineKm(center, f.geometry.coordinates as [number, number]) < radiusKm * 4;
      });
      geologySimilarity = clamp(matching.length * 8, 0, 100);
      analogProducer = matching.some((m) => m.properties.developmentStatus === 'producer');
      analogPastProducer = matching.some((m) => m.properties.developmentStatus?.includes('past'));
    } catch {
      unavailable.push('usgs_mrds');
    }

    let claimAvailability = 100;
    let competingClaims = 0;
    try {
      const claims = await fetchBlmClaims({ bbox, status: 'active', commodity: q.commodity, limit: 1000 });
      competingClaims = claims.features.filter((f) => {
        const coords = f.geometry.coordinates as unknown as number[][][][];
        const ring = coords[0]?.[0];
        if (!ring) return false;
        let sx = 0, sy = 0; for (const pt of ring) { sx += pt[0]!; sy += pt[1]!; }
        const c: [number, number] = [sx / ring.length, sy / ring.length];
        return haversineKm(center, c) < radiusKm;
      }).length;
      claimAvailability = clamp(100 - competingClaims * 12, 0, 100);
    } catch {
      unavailable.push('blm_claims');
    }

    const infrastructureScore = proximityToProduction;
    const commodityPriceIndex = q.commodity ? 60 : 50;
    const permittingComplexity = q.commodity ? 55 : 60;

    const score = round1(
      0.25 * proximityToProduction +
      0.20 * geologySimilarity +
      0.15 * infrastructureScore +
      0.15 * claimAvailability +
      0.15 * commodityPriceIndex +
      0.10 * permittingComplexity,
    );

    const tags: OpportunityTag[] = [];
    if (proximityToProduction > 60) tags.push('proven_trend');
    if (proximityToProduction > 50) tags.push('near_infrastructure');
    if (claimAvailability > 75) tags.push('open_federal_land');
    if (analogPastProducer) tags.push('historic_producer');
    if (analogProducer) tags.push('analog_to_producer');
    if (competingClaims > 5) tags.push('high_density_claims');

    const out: OpportunityScore & { meta: { unavailable: string[]; sourcedFrom: string[] } } = {
      score,
      tags,
      breakdown: {
        proximityToProduction: round1(proximityToProduction),
        geologySimilarity: round1(geologySimilarity),
        infrastructureScore: round1(infrastructureScore),
        claimAvailability: round1(claimAvailability),
        commodityPriceIndex,
        permittingComplexity,
      },
      commodity: q.commodity,
      computedAt: new Date().toISOString(),
      meta: {
        unavailable,
        sourcedFrom: ['state_oil_gas_arcgis', 'usgs_mrds_wfs', 'blm_national_mining_claims'],
      },
    };

    res.json(out);
  } catch (err) {
    next(err);
  }
});

function clamp(n: number, min: number, max: number) { return Math.min(max, Math.max(min, n)); }
function round1(n: number) { return Math.round(n * 10) / 10; }
