import { Router } from 'express';
import { z } from 'zod';
import type { OpportunityScore, OpportunityTag } from '@subterra/shared';
import { MOCK_WELLS } from '../mocks/wells.js';
import { MOCK_MINING_CLAIMS, MOCK_MINERAL_OCCURRENCES } from '../mocks/claims.js';
import { haversineKm } from '../lib/geo.js';

export const scoreRouter = Router();

const ScoreQuery = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radius: z.coerce.number().positive().max(200).default(10),
  commodity: z.string().optional(),
});

scoreRouter.get('/', (req, res, next) => {
  try {
    const q = ScoreQuery.parse(req.query);
    const center: [number, number] = [q.lng, q.lat];
    const radiusKm = q.radius;

    // proximity to production: count nearby active producing wells
    const producingNearby = MOCK_WELLS.filter(
      (w) => w.status === 'active' && haversineKm(center, w.geom.coordinates as [number, number]) < radiusKm,
    );
    const proximityToProduction = clamp((producingNearby.length / 5) * 100, 0, 100);

    // geology similarity: nearby USGS MRDS occurrences with matching commodity
    const matchingOccurrences = MOCK_MINERAL_OCCURRENCES.filter((m) => {
      if (q.commodity && m.primaryCommodity !== q.commodity) return false;
      return haversineKm(center, m.geom.coordinates as [number, number]) < radiusKm * 4;
    });
    const geologySimilarity = clamp(matchingOccurrences.length * 25, 0, 100);

    // claim availability: fewer active claims = more open ground
    const competingClaims = MOCK_MINING_CLAIMS.filter(
      (c) => c.status === 'active' && haversineKm(center, c.centroid.coordinates as [number, number]) < radiusKm,
    );
    const claimAvailability = clamp(100 - competingClaims.length * 12, 0, 100);

    // infrastructure: closeness to nearest active well as proxy
    const nearestWellKm = Math.min(
      ...MOCK_WELLS.map((w) => haversineKm(center, w.geom.coordinates as [number, number])),
      999,
    );
    const infrastructureScore = clamp(100 - (nearestWellKm / radiusKm) * 50, 0, 100);

    // commodity price index: mock seasonal/macro lift per commodity
    const priceIndex: Record<string, number> = {
      gold: 78, silver: 64, copper: 70, lithium: 55, oil: 60, gas: 45, uranium: 82, rare_earth: 88,
    };
    const commodityPriceIndex = q.commodity ? (priceIndex[q.commodity] ?? 50) : 60;

    // permitting complexity: lower for sand_gravel, higher for uranium/REE/lithium
    const permittingByCommodity: Record<string, number> = {
      sand_gravel: 90, gold: 60, silver: 60, copper: 55, lithium: 35, uranium: 25, rare_earth: 30, oil: 65, gas: 65,
    };
    const permittingComplexity = q.commodity ? (permittingByCommodity[q.commodity] ?? 55) : 55;

    // weighted blend
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
    if (infrastructureScore > 65) tags.push('near_infrastructure');
    if (claimAvailability > 75) tags.push('open_federal_land');
    if (matchingOccurrences.some((m) => m.developmentStatus === 'past_producer')) tags.push('historic_producer');
    if (matchingOccurrences.some((m) => m.developmentStatus === 'producer')) tags.push('analog_to_producer');
    if (commodityPriceIndex > 70) tags.push('price_tailwind');
    if (commodityPriceIndex < 50) tags.push('price_headwind');
    if (permittingComplexity > 70) tags.push('permitting_friendly');
    if (permittingComplexity < 40) tags.push('permitting_complex');
    if (competingClaims.length > 5) tags.push('high_density_claims');

    const out: OpportunityScore = {
      score,
      tags,
      breakdown: {
        proximityToProduction: round1(proximityToProduction),
        geologySimilarity: round1(geologySimilarity),
        infrastructureScore: round1(infrastructureScore),
        claimAvailability: round1(claimAvailability),
        commodityPriceIndex: round1(commodityPriceIndex),
        permittingComplexity: round1(permittingComplexity),
      },
      commodity: q.commodity,
      computedAt: new Date().toISOString(),
    };

    res.json(out);
  } catch (err) {
    next(err);
  }
});

function clamp(n: number, min: number, max: number) { return Math.min(max, Math.max(min, n)); }
function round1(n: number) { return Math.round(n * 10) / 10; }
