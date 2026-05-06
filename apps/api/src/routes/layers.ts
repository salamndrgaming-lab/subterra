import { Router } from 'express';
import { z } from 'zod';
import { fetchBlmClaims } from '../sources/blm-claims.js';
import { fetchMrds } from '../sources/usgs-mrds.js';
import { fetchWells } from '../sources/wells.js';
import { fetchWellLaterals } from '../sources/well-laterals.js';
import { parseBBox } from '../lib/geo.js';
import { query } from '../db.js';

export const layersRouter = Router();

const LayerQuery = z.object({
  bbox: z.string().optional(),
  state: z.string().length(2).optional(),
  county: z.string().optional(),
  status: z.string().optional(),
  commodity: z.string().optional(),
  limit: z.coerce.number().int().positive().max(5000).default(1000),
});

layersRouter.get('/wells', async (req, res, next) => {
  try {
    const q = LayerQuery.parse(req.query);
    const fc = await fetchWells({
      bbox: parseBBox(q.bbox) ?? undefined,
      state: q.state,
      county: q.county,
      status: q.status,
      limit: q.limit,
    });
    res.json(fc);
  } catch (err) {
    next(err);
  }
});

layersRouter.get('/well-laterals', async (req, res, next) => {
  try {
    const q = LayerQuery.parse(req.query);
    const fc = await fetchWellLaterals({
      bbox: parseBBox(q.bbox) ?? undefined,
      state: q.state,
      limit: q.limit,
    });
    res.json(fc);
  } catch (err) {
    next(err);
  }
});

layersRouter.get('/claims', async (req, res, next) => {
  try {
    const q = LayerQuery.parse(req.query);
    const fc = await fetchBlmClaims({
      bbox: parseBBox(q.bbox) ?? undefined,
      state: q.state,
      status: q.status,
      commodity: q.commodity,
      limit: q.limit,
    });
    res.json(fc);
  } catch (err) {
    next(err);
  }
});

layersRouter.get('/mineral-occurrences', async (req, res, next) => {
  try {
    const q = LayerQuery.parse(req.query);
    const fc = await fetchMrds({
      bbox: parseBBox(q.bbox) ?? undefined,
      state: q.state,
      commodity: q.commodity,
      limit: q.limit,
    });
    res.json(fc);
  } catch (err) {
    next(err);
  }
});

/**
 * Parcels live in PostGIS only. County assessor + Regrid extracts must be
 * loaded via ETL before this endpoint returns features. We never synthesize
 * parcel records.
 */
layersRouter.get('/parcels', async (req, res, next) => {
  try {
    const q = LayerQuery.parse(req.query);
    const bbox = parseBBox(q.bbox);
    const params: unknown[] = [];
    const where: string[] = [];

    if (q.state) { params.push(q.state); where.push(`state = $${params.length}`); }
    if (q.county) { params.push(q.county); where.push(`county ILIKE $${params.length}`); }
    if (bbox) {
      params.push(bbox[0], bbox[1], bbox[2], bbox[3]);
      const i = params.length;
      where.push(`geom && ST_MakeEnvelope($${i - 3}, $${i - 2}, $${i - 1}, $${i}, 4326)`);
    }
    params.push(q.limit);
    const sql = `
      SELECT id, parcel_number, owner_name, state, county, acreage,
             estimated_value, land_use, surface_rights, mineral_rights,
             ST_AsGeoJSON(geom)::jsonb AS geom,
             ST_AsGeoJSON(centroid)::jsonb AS centroid
        FROM parcels
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        LIMIT $${params.length}
    `;
    const rows = await query<{
      id: string; parcel_number: string | null; owner_name: string | null;
      state: string; county: string; acreage: string | null; estimated_value: string | null;
      land_use: string | null; surface_rights: boolean | null; mineral_rights: boolean | null;
      geom: unknown; centroid: unknown;
    }>(sql, params);

    res.json({
      type: 'FeatureCollection',
      features: rows.rows.map((r) => ({
        type: 'Feature',
        id: r.id,
        geometry: r.geom,
        properties: {
          id: r.id,
          parcelNumber: r.parcel_number,
          ownerName: r.owner_name,
          state: r.state,
          county: r.county,
          acreage: r.acreage == null ? null : Number(r.acreage),
          estimatedValue: r.estimated_value == null ? null : Number(r.estimated_value),
          landUse: r.land_use,
          surfaceRights: r.surface_rights,
          mineralRights: r.mineral_rights,
          centroid: r.centroid,
        },
      })),
      meta: { source: 'postgis', note: rows.rows.length === 0 ? 'No parcels ingested for the requested area. Run scripts/etl/ingest-parcels.ts.' : undefined },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Permits are fed by `scripts/etl/ingest-permits.ts` (BLM ePlanning + state
 * commissions). Returns whatever has been ingested; never synthesized.
 */
layersRouter.get('/permits', async (req, res, next) => {
  try {
    const q = LayerQuery.parse(req.query);
    const bbox = parseBBox(q.bbox);
    const params: unknown[] = [];
    const where: string[] = [];
    if (q.state) { params.push(q.state); where.push(`state = $${params.length}`); }
    if (q.status) { params.push(q.status); where.push(`status = $${params.length}::permit_status`); }
    if (bbox) {
      params.push(bbox[0], bbox[1], bbox[2], bbox[3]);
      const i = params.length;
      where.push(`geom && ST_MakeEnvelope($${i - 3}, $${i - 2}, $${i - 1}, $${i}, 4326)`);
    }
    params.push(q.limit);
    const rows = await query<{
      id: string; permit_number: string | null; permit_type: string; agency: string | null;
      operator: string | null; title: string | null; status: string | null;
      decision_date: Date | null; geom: unknown;
    }>(
      `SELECT id, permit_number, permit_type, agency, operator, title, status,
              decision_date, ST_AsGeoJSON(geom)::jsonb AS geom
         FROM permits
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         LIMIT $${params.length}`,
      params,
    );

    res.json({
      type: 'FeatureCollection',
      features: rows.rows.map((r) => ({
        type: 'Feature',
        id: r.id,
        geometry: r.geom,
        properties: {
          id: r.id,
          permitNumber: r.permit_number,
          permitType: r.permit_type,
          agency: r.agency,
          operator: r.operator,
          title: r.title,
          status: r.status,
          decisionDate: r.decision_date?.toISOString().slice(0, 10) ?? null,
        },
      })),
    });
  } catch (err) {
    next(err);
  }
});
