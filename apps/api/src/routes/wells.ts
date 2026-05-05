import { Router } from 'express';
import { fetchWellByApi } from '../sources/wells.js';
import { fetchProductionByApi } from '../sources/production.js';
import { HttpError } from '../middleware/error.js';
import { query } from '../db.js';

export const wellsRouter = Router();

/**
 * Detail lookup. We try the well in PostGIS first (populated by ETL); if not
 * present we fall back to the live state ArcGIS endpoint. Production volumes
 * come exclusively from `well_production` (loaded by the production ETL).
 * Decline-curve fits are computed from those real volumes only.
 */
wellsRouter.get('/:id', async (req, res, next) => {
  try {
    const id = req.params.id;

    const dbRow = await query<{
      id: string; api_number: string | null; well_name: string | null; operator: string | null;
      state: string; county: string | null; basin: string | null; formation: string | null;
      well_type: string | null; status: string | null; spud_date: Date | null;
      completion_date: Date | null; plug_date: Date | null;
      total_depth_ft: number | null; true_vertical_depth_ft: number | null; lateral_length_ft: number | null;
      surface_lat: string | null; surface_lng: string | null;
      plss_township: string | null; plss_range: string | null; plss_section: number | null;
      source: string | null; source_updated_at: Date | null;
      geom: unknown;
    }>(
      `SELECT id, api_number, well_name, operator, state, county, basin, formation,
              well_type::text, status::text,
              spud_date, completion_date, plug_date,
              total_depth_ft, true_vertical_depth_ft, lateral_length_ft,
              surface_lat, surface_lng, plss_township, plss_range, plss_section,
              source, source_updated_at,
              ST_AsGeoJSON(geom)::jsonb AS geom
         FROM wells WHERE id::text = $1 OR api_number = $1
         LIMIT 1`,
      [id],
    );

    let well: Record<string, unknown> | null = null;
    let apiNumber: string | null = null;

    if (dbRow.rows.length > 0) {
      const r = dbRow.rows[0]!;
      apiNumber = r.api_number;
      well = {
        id: r.id,
        apiNumber: r.api_number,
        wellName: r.well_name,
        operator: r.operator,
        state: r.state,
        county: r.county,
        basin: r.basin,
        formation: r.formation,
        wellType: r.well_type,
        status: r.status,
        spudDate: r.spud_date?.toISOString().slice(0, 10) ?? null,
        completionDate: r.completion_date?.toISOString().slice(0, 10) ?? null,
        plugDate: r.plug_date?.toISOString().slice(0, 10) ?? null,
        totalDepthFt: r.total_depth_ft,
        trueVerticalDepthFt: r.true_vertical_depth_ft,
        lateralLengthFt: r.lateral_length_ft,
        surfaceLat: r.surface_lat == null ? null : Number(r.surface_lat),
        surfaceLng: r.surface_lng == null ? null : Number(r.surface_lng),
        plssTownship: r.plss_township,
        plssRange: r.plss_range,
        plssSection: r.plss_section,
        source: r.source,
        sourceUpdatedAt: r.source_updated_at?.toISOString() ?? null,
        geom: r.geom,
      };
    } else {
      const live = await fetchWellByApi(id);
      if (live) {
        apiNumber = live.apiNumber;
        well = { ...live, source: live.source, geom: live.geom };
      }
    }

    if (!well) throw new HttpError(404, 'not_found', 'Well not found in PostGIS or upstream state ArcGIS endpoints');

    const production = apiNumber ? await fetchProductionByApi(apiNumber) : null;

    const offsets = apiNumber
      ? (
          await query<{ id: string; well_name: string | null; operator: string | null; status: string | null; spud_date: Date | null; lateral_length_ft: number | null; }>(
            `SELECT w2.id, w2.well_name, w2.operator, w2.status::text, w2.spud_date, w2.lateral_length_ft
               FROM wells w1
               JOIN wells w2 ON w2.id <> w1.id AND w2.basin = w1.basin AND w2.formation = w1.formation
              WHERE w1.api_number = $1
                AND ST_DWithin(w1.geom::geography, w2.geom::geography, 25000)
              ORDER BY ST_Distance(w1.geom::geography, w2.geom::geography)
              LIMIT 8`,
            [apiNumber],
          )
        ).rows.map((o) => ({
          id: o.id,
          wellName: o.well_name,
          operator: o.operator,
          status: o.status,
          spudDate: o.spud_date?.toISOString().slice(0, 10) ?? null,
          lateralLengthFt: o.lateral_length_ft,
        }))
      : [];

    res.json({
      well,
      production: production ?? {
        wellId: apiNumber ?? null,
        monthly: [],
        cumulative: { oilBbl: 0, gasMcf: 0, waterBbl: 0 },
        meta: 'No production data ingested yet. Run scripts/etl/refresh-production.ts to load monthly volumes from the relevant state commission.',
      },
      offsets,
    });
  } catch (err) {
    next(err);
  }
});
