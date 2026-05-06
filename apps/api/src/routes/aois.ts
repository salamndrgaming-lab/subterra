import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { query } from '../db.js';

export const aoisRouter = Router();

aoisRouter.use(requireAuth);

const Geometry = z.object({
  type: z.literal('Polygon'),
  coordinates: z.array(z.array(z.tuple([z.number(), z.number()]))),
});

const AoiBody = z.object({
  name: z.string().min(1).max(120),
  notes: z.string().max(2000).nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  geometry: Geometry,
});

interface AoiRow {
  id: string;
  user_id: string;
  project_id: string | null;
  name: string;
  notes: string | null;
  area_acres: string | null;
  geom: unknown;
  centroid: unknown;
  created_at: Date;
  updated_at: Date;
}

const select = `
  SELECT id, user_id, project_id, name, notes, area_acres,
         ST_AsGeoJSON(geom)::jsonb AS geom,
         ST_AsGeoJSON(centroid)::jsonb AS centroid,
         created_at, updated_at
    FROM aois
`;

function rowToJson(r: AoiRow) {
  return {
    id: r.id,
    userId: r.user_id,
    projectId: r.project_id,
    name: r.name,
    notes: r.notes,
    areaAcres: r.area_acres == null ? null : Number(r.area_acres),
    geom: r.geom,
    centroid: r.centroid,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

aoisRouter.get('/', async (req, res, next) => {
  try {
    const projectId = typeof req.query['projectId'] === 'string' ? req.query['projectId'] : null;
    const params: unknown[] = [req.user!.id];
    let where = `WHERE user_id = $1`;
    if (projectId) { params.push(projectId); where += ` AND project_id = $${params.length}`; }
    const result = await query<AoiRow>(`${select} ${where} ORDER BY updated_at DESC LIMIT 500`, params);
    res.json({ aois: result.rows.map(rowToJson) });
  } catch (err) {
    next(err);
  }
});

aoisRouter.get('/:id', async (req, res, next) => {
  try {
    const result = await query<AoiRow>(`${select} WHERE id = $1 AND user_id = $2`, [req.params.id, req.user!.id]);
    if (!result.rows.length) throw new HttpError(404, 'not_found', 'AOI not found');
    res.json({ aoi: rowToJson(result.rows[0]!) });
  } catch (err) {
    next(err);
  }
});

aoisRouter.post('/', async (req, res, next) => {
  try {
    const body = AoiBody.parse(req.body);
    const result = await query<AoiRow>(
      `INSERT INTO aois (user_id, project_id, name, notes, geom, area_acres)
       SELECT $1, $2, $3, $4,
              ST_Multi(ST_GeomFromGeoJSON($5)),
              ST_Area(ST_Multi(ST_GeomFromGeoJSON($5))::geography) / 4046.8564224
       RETURNING id, user_id, project_id, name, notes, area_acres,
                 ST_AsGeoJSON(geom)::jsonb AS geom,
                 ST_AsGeoJSON(centroid)::jsonb AS centroid,
                 created_at, updated_at`,
      [req.user!.id, body.projectId ?? null, body.name, body.notes ?? null, JSON.stringify(body.geometry)],
    );
    res.status(201).json({ aoi: rowToJson(result.rows[0]!) });
  } catch (err) {
    next(err);
  }
});

aoisRouter.patch('/:id', async (req, res, next) => {
  try {
    const partial = AoiBody.partial().parse(req.body);
    const fields: string[] = [];
    const params: unknown[] = [req.params.id, req.user!.id];

    if (partial.name !== undefined) { params.push(partial.name); fields.push(`name = $${params.length}`); }
    if (partial.notes !== undefined) { params.push(partial.notes); fields.push(`notes = $${params.length}`); }
    if (partial.projectId !== undefined) { params.push(partial.projectId); fields.push(`project_id = $${params.length}`); }
    if (partial.geometry !== undefined) {
      params.push(JSON.stringify(partial.geometry));
      fields.push(`geom = ST_Multi(ST_GeomFromGeoJSON($${params.length}))`);
      fields.push(`area_acres = ST_Area(ST_Multi(ST_GeomFromGeoJSON($${params.length}))::geography) / 4046.8564224`);
    }

    if (!fields.length) {
      const r = await query<AoiRow>(`${select} WHERE id = $1 AND user_id = $2`, [req.params.id, req.user!.id]);
      if (!r.rows.length) throw new HttpError(404, 'not_found', 'AOI not found');
      res.json({ aoi: rowToJson(r.rows[0]!) });
      return;
    }

    const result = await query<AoiRow>(
      `UPDATE aois SET ${fields.join(', ')} WHERE id = $1 AND user_id = $2
       RETURNING id, user_id, project_id, name, notes, area_acres,
                 ST_AsGeoJSON(geom)::jsonb AS geom,
                 ST_AsGeoJSON(centroid)::jsonb AS centroid,
                 created_at, updated_at`,
      params,
    );
    if (!result.rows.length) throw new HttpError(404, 'not_found', 'AOI not found');
    res.json({ aoi: rowToJson(result.rows[0]!) });
  } catch (err) {
    next(err);
  }
});

aoisRouter.delete('/:id', async (req, res, next) => {
  try {
    const result = await query(`DELETE FROM aois WHERE id = $1 AND user_id = $2`, [req.params.id, req.user!.id]);
    if (!result.rowCount) throw new HttpError(404, 'not_found', 'AOI not found');
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
