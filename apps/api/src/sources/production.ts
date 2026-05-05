/**
 * Real-data client for monthly oil & gas production volumes.
 *
 * Production volumes are not exposed by any public ArcGIS FeatureServer; the
 * authoritative sources are state-commission flat-file extracts that the
 * `scripts/etl/refresh-production.ts` pipeline ingests into the
 * `well_production` table. This client returns whatever the ETL has stored
 * for a given well API and never synthesizes data.
 */

import { query } from '../db.js';
import type { WellProductionMonth, WellProductionSeries } from '@subterra/shared';

export async function fetchProductionByApi(apiNumber: string): Promise<WellProductionSeries | null> {
  const result = await query<{
    report_month: Date;
    oil_bbl: string | null;
    gas_mcf: string | null;
    water_bbl: string | null;
    days_produced: number | null;
  }>(
    `SELECT wp.report_month, wp.oil_bbl, wp.gas_mcf, wp.water_bbl, wp.days_produced
       FROM well_production wp
       JOIN wells w ON w.id = wp.well_id
      WHERE w.api_number = $1
      ORDER BY wp.report_month ASC`,
    [apiNumber],
  );

  if (!result.rows.length) return null;

  const monthly: WellProductionMonth[] = result.rows.map((r) => ({
    reportMonth: r.report_month.toISOString().slice(0, 10),
    oilBbl: r.oil_bbl == null ? null : Number(r.oil_bbl),
    gasMcf: r.gas_mcf == null ? null : Number(r.gas_mcf),
    waterBbl: r.water_bbl == null ? null : Number(r.water_bbl),
    daysProduced: r.days_produced ?? null,
  }));

  const cumulative = monthly.reduce(
    (acc, m) => ({
      oilBbl: acc.oilBbl + (m.oilBbl ?? 0),
      gasMcf: acc.gasMcf + (m.gasMcf ?? 0),
      waterBbl: acc.waterBbl + (m.waterBbl ?? 0),
    }),
    { oilBbl: 0, gasMcf: 0, waterBbl: 0 },
  );

  return { wellId: apiNumber, monthly, cumulative };
}
