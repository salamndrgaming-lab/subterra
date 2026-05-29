/**
 * "Find Optimal Acre" picker logic.
 *
 * Takes the ranked-by-score top-N hotspots from the manifest and answers
 * the question: given commodity X, max budget $Y, optionally in state Z,
 * what's the best 100-acre piece of land to stake?
 *
 * The picker doesn't query anything live — it works entirely off the
 * precomputed hotspots data shipped in the version manifest. That means
 * results are instant and offline-tolerant: useful for a demo + fast
 * iteration on inputs.
 *
 * Returns top-3 picks ranked by an adjusted score that re-weights the
 * raw hotspot score with commodity-fit, budget-fit, and a competition
 * penalty so a low-overall-score cell that's the ONLY good lithium
 * option beats a high-overall-score cell with no lithium.
 */

import type { TopHotspot } from '@subterra/shared';

export interface OptimalQuery {
  /** Single commodity symbol (Au, Cu, Li …) or null for "any". */
  commodity: string | null;
  /** Hard cap on `costHigh` — picks above this are filtered out. */
  maxBudget: number;
  /** 2-letter state code or null for "anywhere in the West". */
  state: string | null;
}

export interface OptimalPick {
  hotspot: TopHotspot;
  rank: 1 | 2 | 3;
  /** Re-ranking score after commodity/budget/competition adjustments.
   *  Same 0-130ish scale as the underlying score; only meaningful
   *  relative to other picks in the same result set. */
  adjustedScore: number;
  /** Plain-English bullets the UI surfaces under "Why this one". */
  reasons: string[];
  recommendedAcres: number;
  /** GeoJSON Polygon for the recommended stake — drawn on the map
   *  as a lime overlay when this pick is selected. */
  stakePolygon: {
    type: 'Polygon';
    coordinates: number[][][];
  };
}

/** Parse the manifest's `topCommodities: "AU:5,AG:3,CU:1"` string back
 *  into a {commodity: count} dict. Unknown formats yield an empty dict
 *  (cell still survives but contributes no commodity-specific signal). */
export function parseCommodityCounts(s: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of s.split(',')) {
    const m = part.trim().match(/^([A-Za-z]+):(\d+)$/);
    if (m) out[m[1]!.toUpperCase()] = parseInt(m[2]!, 10);
  }
  return out;
}

/** Build a square polygon centered on (lng, lat) covering the given
 *  acreage. 1 acre = 4046.86 m². Uses local-degree conversion that
 *  corrects longitude for latitude — at lat 45° the cosine factor
 *  matters (1° lng ≈ 78 km, not 111 km). */
export function buildStakePolygon(
  lng: number,
  lat: number,
  acres: number,
): OptimalPick['stakePolygon'] {
  const m2 = acres * 4046.86;
  const sideM = Math.sqrt(m2);
  const halfM = sideM / 2;
  const dLat = halfM / 111_000;
  const dLng = halfM / (111_000 * Math.cos((lat * Math.PI) / 180));
  return {
    type: 'Polygon',
    coordinates: [[
      [lng - dLng, lat - dLat],
      [lng + dLng, lat - dLat],
      [lng + dLng, lat + dLat],
      [lng - dLng, lat + dLat],
      [lng - dLng, lat - dLat],
    ]],
  };
}

/** Rough state bbox lookup for the western US. Used to FILTER picks by
 *  state — false positives near borders (e.g. Four Corners) are fine
 *  since we're narrowing candidates, not adjudicating jurisdiction.
 *  A truly correct check would intersect cell centroids against state
 *  polygons; that's overkill for a 100-cell picker. */
const STATE_BBOX: Record<string, readonly [number, number, number, number]> = {
  // [west, south, east, north]
  CA: [-124.5, 32.5, -114.0, 42.1],
  NV: [-120.0, 35.0, -114.0, 42.1],
  AZ: [-115.0, 31.3, -109.0, 37.1],
  UT: [-114.1, 36.9, -109.0, 42.1],
  CO: [-109.1, 37.0, -102.0, 41.1],
  NM: [-109.1, 31.3, -103.0, 37.1],
  WY: [-111.1, 41.0, -104.0, 45.1],
  MT: [-116.1, 45.0, -104.0, 49.1],
  ID: [-117.1, 42.0, -111.0, 49.1],
  WA: [-124.5, 45.5, -116.9, 49.1],
  OR: [-124.5, 42.0, -116.5, 46.4],
  ND: [-104.1, 45.9, -96.5, 49.1],
  SD: [-104.1, 42.5, -96.4, 46.0],
};

export function stateFromCoords(lng: number, lat: number): string | null {
  for (const [code, [w, s, e, n]] of Object.entries(STATE_BBOX)) {
    if (lng >= w && lng <= e && lat >= s && lat <= n) return code;
  }
  return null;
}

export const SUPPORTED_STATES = Object.keys(STATE_BBOX) as readonly string[];

function explain(h: TopHotspot, q: OptimalQuery): string[] {
  const reasons: string[] = [];
  if (q.commodity) {
    const counts = parseCommodityCounts(h.topCommodities);
    const n = counts[q.commodity.toUpperCase()] ?? 0;
    if (n > 0) {
      reasons.push(`${n} historic ${q.commodity} site${n > 1 ? 's' : ''} inside the cell`);
    }
  }
  if (h.deposits >= 10) {
    reasons.push(`${h.deposits} total mineral occurrences — established mineral belt`);
  } else if (h.deposits > 0) {
    reasons.push(`${h.deposits} known occurrence${h.deposits > 1 ? 's' : ''} nearby`);
  }
  if (h.claims < 5) {
    reasons.push(`low claim competition (${h.claims} active claims in cell)`);
  } else if (h.claims < 20) {
    reasons.push(`moderate claim competition (${h.claims} active)`);
  }
  if (h.blmPolys >= 10) {
    reasons.push(`strong BLM coverage (${h.blmPolys} stake-able polygons)`);
  }
  const costMid = (h.costLow + h.costHigh) / 2;
  const headroom = q.maxBudget - costMid;
  if (headroom > 0) {
    reasons.push(`fits budget with ~$${Math.round(headroom).toLocaleString()} headroom`);
  }
  if (h.score >= 70) {
    reasons.push(`overall hotspot score ${Math.round(h.score)}/100`);
  }
  return reasons;
}

export function findOptimalPicks(
  hotspots: readonly TopHotspot[] | undefined,
  query: OptimalQuery,
): OptimalPick[] {
  if (!hotspots || hotspots.length === 0) return [];
  const targetCommodity = query.commodity?.toUpperCase() ?? null;

  // Filter: budget cap, optional commodity match, optional state match.
  const candidates = hotspots.filter((h) => {
    if (h.costHigh > query.maxBudget) return false;
    if (targetCommodity) {
      const counts = parseCommodityCounts(h.topCommodities);
      if ((counts[targetCommodity] ?? 0) === 0) return false;
    }
    if (query.state) {
      if (stateFromCoords(h.lng, h.lat) !== query.state) return false;
    }
    return true;
  });

  // Rank: composite score + boosts/penalties.
  const ranked = candidates.map((h) => {
    const counts = parseCommodityCounts(h.topCommodities);
    const commodityCount = targetCommodity ? (counts[targetCommodity] ?? 0) : 0;
    // Commodity boost: +6 per matching occurrence, capped at +30 so a
    // cell with 5 commodity hits doesn't dominate a cell with 4 hits +
    // better fundamentals.
    const commodityBoost = Math.min(commodityCount * 6, 30);
    const costMid = (h.costLow + h.costHigh) / 2;
    // Budget fit: rewards cells well under budget (more headroom for
    // permitting, exploration, contingency).
    const budgetFit = Math.max(0, 20 * (1 - costMid / Math.max(query.maxBudget, 1)));
    const competitionPenalty = h.claims >= 20 ? 12 : h.claims >= 10 ? 5 : 0;
    const adjustedScore = h.score + commodityBoost + budgetFit - competitionPenalty;
    return { h, adjustedScore };
  });
  ranked.sort((a, b) => b.adjustedScore - a.adjustedScore);

  return ranked.slice(0, 3).map(({ h, adjustedScore }, i) => ({
    hotspot: h,
    rank: (i + 1) as 1 | 2 | 3,
    adjustedScore,
    reasons: explain(h, query),
    recommendedAcres: 100,
    stakePolygon: buildStakePolygon(h.lng, h.lat, 100),
  }));
}
