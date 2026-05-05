import { Router } from 'express';
import { MOCK_MINING_CLAIMS, MOCK_MINERAL_OCCURRENCES } from '../mocks/claims.js';
import { HttpError } from '../middleware/error.js';
import { haversineKm } from '../lib/geo.js';

export const claimsRouter = Router();

claimsRouter.get('/:id', (req, res, next) => {
  try {
    const claim = MOCK_MINING_CLAIMS.find((c) => c.id === req.params.id || c.serialNumber === req.params.id);
    if (!claim) throw new HttpError(404, 'not_found', 'Claim not found');

    const claimPoint = claim.centroid.coordinates as [number, number];
    const nearbyOccurrences = MOCK_MINERAL_OCCURRENCES
      .map((m) => ({
        ...m,
        distanceKm: haversineKm(claimPoint, m.geom.coordinates as [number, number]),
      }))
      .filter((m) => m.distanceKm < 50)
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, 5);

    const filingHistory = [
      { event: 'Notice of Location filed', date: claim.locationDate, agency: 'BLM' },
      { event: 'Recorded with county', date: claim.recordationDate, agency: claim.county },
      ...(claim.lastAssessmentYear
        ? [{ event: `Annual maintenance fee paid (FY${claim.lastAssessmentYear})`, date: `${claim.lastAssessmentYear}-08-31`, agency: 'BLM' }]
        : []),
    ];

    res.json({ claim, nearbyOccurrences, filingHistory });
  } catch (err) {
    next(err);
  }
});
