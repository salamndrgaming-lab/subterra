import { Router } from 'express';
import { MOCK_WELLS, generateMockProduction } from '../mocks/wells.js';
import { HttpError } from '../middleware/error.js';

export const wellsRouter = Router();

wellsRouter.get('/:id', (req, res, next) => {
  try {
    const well = MOCK_WELLS.find((w) => w.id === req.params.id || w.apiNumber === req.params.id);
    if (!well) throw new HttpError(404, 'not_found', 'Well not found');

    const production = generateMockProduction(well.id, 36);
    const cumulative = production.reduce(
      (acc, m) => ({
        oilBbl: acc.oilBbl + (m.oilBbl ?? 0),
        gasMcf: acc.gasMcf + (m.gasMcf ?? 0),
        waterBbl: acc.waterBbl + (m.waterBbl ?? 0),
      }),
      { oilBbl: 0, gasMcf: 0, waterBbl: 0 },
    );

    // offset wells: same basin/formation within ~25km
    const offsets = MOCK_WELLS
      .filter((w) => w.id !== well.id && w.basin === well.basin && w.formation === well.formation)
      .slice(0, 8)
      .map((w) => ({
        id: w.id,
        wellName: w.wellName,
        operator: w.operator,
        status: w.status,
        spudDate: w.spudDate,
        lateralLengthFt: w.lateralLengthFt,
      }));

    res.json({ well, production: { wellId: well.id, monthly: production, cumulative }, offsets });
  } catch (err) {
    next(err);
  }
});
