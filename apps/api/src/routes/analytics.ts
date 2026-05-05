import { Router } from 'express';
import { z } from 'zod';
import { MOCK_WELLS, generateMockProduction } from '../mocks/wells.js';
import { HttpError } from '../middleware/error.js';

export const analyticsRouter = Router();

analyticsRouter.get('/production/:wellId', (req, res, next) => {
  try {
    const well = MOCK_WELLS.find((w) => w.id === req.params.wellId);
    if (!well) throw new HttpError(404, 'not_found', 'Well not found');
    const production = generateMockProduction(well.id, 60);
    res.json({ wellId: well.id, monthly: production });
  } catch (err) {
    next(err);
  }
});

const ValuationBody = z.object({
  ipBopd: z.number().positive(),       // initial production, barrels of oil per day
  declineYr1: z.number().min(0).max(1).default(0.6),
  bExponent: z.number().min(0).max(2).default(0.9),
  oilPriceUsdBbl: z.number().positive().default(72),
  gasPriceUsdMcf: z.number().positive().default(2.85),
  gor: z.number().min(0).default(2.5),  // gas-oil ratio mcf/bbl
  royaltyRate: z.number().min(0).max(1).default(0.1875),
  workingInterest: z.number().min(0).max(1).default(0.75),
  opexUsdMonth: z.number().min(0).default(15000),
  capexUsd: z.number().min(0).default(8500000),
  discountRate: z.number().min(0).max(1).default(0.10),
  monthsHorizon: z.number().int().positive().max(360).default(180),
});

/**
 * Quick discounted-cashflow valuation under Arps hyperbolic decline.
 * Used by the <NPVCalculator /> client.
 */
analyticsRouter.post('/valuation', (req, res, next) => {
  try {
    const i = ValuationBody.parse(req.body);
    const monthly: Array<{ month: number; oilBbl: number; gasMcf: number; revenueUsd: number; netCashUsd: number; discountedNetUsd: number }> = [];

    let cumulativeNet = 0;
    let cumulativeDiscounted = -i.capexUsd;

    for (let m = 0; m < i.monthsHorizon; m++) {
      const t = m / 12;
      const declineFactor = Math.pow(1 + i.bExponent * i.declineYr1 * t, -1 / i.bExponent);
      const oilBbl = (i.ipBopd * 30.4) * declineFactor;
      const gasMcf = oilBbl * i.gor;
      const grossRevenue = oilBbl * i.oilPriceUsdBbl + gasMcf * i.gasPriceUsdMcf;
      const royalty = grossRevenue * i.royaltyRate;
      const workingShare = (grossRevenue - royalty) * i.workingInterest;
      const netCash = workingShare - i.opexUsdMonth;
      const monthlyDiscount = Math.pow(1 + i.discountRate, m / 12);
      const discountedNet = netCash / monthlyDiscount;
      cumulativeNet += netCash;
      cumulativeDiscounted += discountedNet;

      monthly.push({
        month: m,
        oilBbl: Math.round(oilBbl),
        gasMcf: Math.round(gasMcf),
        revenueUsd: Math.round(grossRevenue),
        netCashUsd: Math.round(netCash),
        discountedNetUsd: Math.round(discountedNet),
      });
    }

    const npv = Math.round(cumulativeDiscounted);
    const undiscountedReturn = Math.round(cumulativeNet - i.capexUsd);
    const payoutMonth = monthly.findIndex((row, idx, arr) =>
      arr.slice(0, idx + 1).reduce((a, r) => a + r.netCashUsd, 0) >= i.capexUsd,
    );

    res.json({
      inputs: i,
      summary: {
        npvUsd: npv,
        undiscountedReturnUsd: undiscountedReturn,
        payoutMonth: payoutMonth >= 0 ? payoutMonth : null,
      },
      monthly,
    });
  } catch (err) {
    next(err);
  }
});
