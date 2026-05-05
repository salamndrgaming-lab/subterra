import { Router } from 'express';
import { MOCK_PARCELS } from '../mocks/parcels.js';
import { MOCK_WELLS } from '../mocks/wells.js';
import { MOCK_MINING_CLAIMS } from '../mocks/claims.js';
import { HttpError } from '../middleware/error.js';
import { haversineKm } from '../lib/geo.js';

export const parcelsRouter = Router();

parcelsRouter.get('/:id', (req, res, next) => {
  try {
    const parcel = MOCK_PARCELS.find((p) => p.id === req.params.id || p.parcelNumber === req.params.id);
    if (!parcel) throw new HttpError(404, 'not_found', 'Parcel not found');

    const center = parcel.centroid.coordinates as [number, number];

    const nearbyWells = MOCK_WELLS
      .map((w) => ({ w, d: haversineKm(center, w.geom.coordinates as [number, number]) }))
      .filter(({ d }) => d < 10)
      .sort((a, b) => a.d - b.d)
      .slice(0, 10)
      .map(({ w, d }) => ({ id: w.id, wellName: w.wellName, operator: w.operator, status: w.status, distanceKm: Number(d.toFixed(2)) }));

    const nearbyClaims = MOCK_MINING_CLAIMS
      .map((c) => ({ c, d: haversineKm(center, c.centroid.coordinates as [number, number]) }))
      .filter(({ d }) => d < 10)
      .sort((a, b) => a.d - b.d)
      .slice(0, 10)
      .map(({ c, d }) => ({ id: c.id, serialNumber: c.serialNumber, claimName: c.claimName, status: c.status, commodity: c.commodity, distanceKm: Number(d.toFixed(2)) }));

    res.json({ parcel, activity: { nearbyWells, nearbyClaims } });
  } catch (err) {
    next(err);
  }
});
