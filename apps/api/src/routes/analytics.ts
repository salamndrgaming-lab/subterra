import { Router } from 'express';
import { z } from 'zod';
import { fetchProductionByApi } from '../sources/production.js';
import { HttpError } from '../middleware/error.js';
import { query } from '../db.js';

export const analyticsRouter = Router();

/**
 * Production data is served exclusively from the `well_production` table,
 * populated by `scripts/etl/refresh-production.ts`. We never synthesize a
 * decline curve from scratch; if no real data exists we say so.
 */
analyticsRouter.get('/production/:wellId', async (req, res, next) => {
  try {
    const id = req.params.wellId;
    const r = await query<{ api_number: string | null }>(
      `SELECT api_number FROM wells WHERE id::text = $1 OR api_number = $1 LIMIT 1`,
      [id],
    );
    const apiNumber = r.rows[0]?.api_number ?? id;
    const series = await fetchProductionByApi(apiNumber);
    if (!series) {
      throw new HttpError(404, 'no_data', 'No production volumes ingested for this well. Run scripts/etl/refresh-production.ts.');
    }
    res.json(series);
  } catch (err) {
    next(err);
  }
});

const ValuationBody = z.object({
  ipBopd: z.number().positive(),
  declineYr1: z.number().min(0).max(1).default(0.6),
  bExponent: z.number().min(0).max(2).default(0.9),
  oilPriceUsdBbl: z.number().positive().default(72),
  gasPriceUsdMcf: z.number().positive().default(2.85),
  gor: z.number().min(0).default(2.5),
  royaltyRate: z.number().min(0).max(1).default(0.1875),
  workingInterest: z.number().min(0).max(1).default(0.75),
  opexUsdMonth: z.number().min(0).default(15000),
  capexUsd: z.number().min(0).default(8500000),
  discountRate: z.number().min(0).max(1).default(0.10),
  monthsHorizon: z.number().int().positive().max(360).default(180),
});

/**
 * Discounted-cashflow valuation. The user supplies all inputs (initial rate,
 * decline, prices, costs, royalty, WI, capex). Outputs are deterministic
 * functions of those inputs — no synthetic price decks or production
 * forecasts are baked in.
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
    let payoutMonth: number | null = null;
    let running = 0;
    for (let m = 0; m < monthly.length; m++) {
      running += monthly[m]!.netCashUsd;
      if (running >= i.capexUsd) { payoutMonth = m; break; }
    }

    res.json({
      inputs: i,
      summary: { npvUsd: npv, undiscountedReturnUsd: undiscountedReturn, payoutMonth },
      monthly,
    });
  } catch (err) {
    next(err);
  }
});
