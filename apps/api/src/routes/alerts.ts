import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { query } from '../db.js';

export const alertsRouter = Router();

const AlertBody = z.object({
  name: z.string().min(1).max(120),
  eventKind: z.enum([
    'new_claim_filed', 'claim_dropped', 'permit_filed', 'permit_approved',
    'well_spudded', 'production_change', 'lease_filed', 'price_threshold',
  ]),
  projectId: z.string().uuid().nullable().optional(),
  aoiId: z.string().uuid().nullable().optional(),
  bbox: z.object({
    type: z.literal('Polygon'),
    coordinates: z.array(z.array(z.tuple([z.number(), z.number()]))),
  }).nullable().optional(),
  filters: z.record(z.unknown()).optional(),
  delivery: z.array(z.enum(['email', 'sms', 'webhook', 'in_app'])).default(['in_app']),
  webhookUrl: z.string().url().nullable().optional(),
  isEnabled: z.boolean().default(true),
});

alertsRouter.use(requireAuth);

interface AlertRow {
  id: string;
  user_id: string;
  project_id: string | null;
  name: string;
  event_kind: string;
  aoi_id: string | null;
  bbox: unknown;
  filters: Record<string, unknown>;
  delivery: string[];
  webhook_url: string | null;
  is_enabled: boolean;
  last_fired_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const select = `
  SELECT id, user_id, project_id, name, event_kind::text, aoi_id,
         CASE WHEN bbox IS NULL THEN NULL ELSE ST_AsGeoJSON(bbox)::jsonb END AS bbox,
         filters, delivery, webhook_url, is_enabled,
         last_fired_at, created_at, updated_at
    FROM alerts
`;

function rowToJson(r: AlertRow) {
  return {
    id: r.id,
    userId: r.user_id,
    projectId: r.project_id,
    name: r.name,
    eventKind: r.event_kind,
    aoiId: r.aoi_id,
    bbox: r.bbox,
    filters: r.filters,
    delivery: r.delivery,
    webhookUrl: r.webhook_url,
    isEnabled: r.is_enabled,
    lastFiredAt: r.last_fired_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

alertsRouter.get('/', async (req, res, next) => {
  try {
    const result = await query<AlertRow>(
      `${select} WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user!.id],
    );
    res.json({ alerts: result.rows.map(rowToJson) });
  } catch (err) {
    next(err);
  }
});

alertsRouter.post('/', async (req, res, next) => {
  try {
    const body = AlertBody.parse(req.body);
    const bboxGeoJson = body.bbox ? JSON.stringify(body.bbox) : null;
    const result = await query<AlertRow>(
      `INSERT INTO alerts
         (user_id, project_id, name, event_kind, aoi_id, bbox, filters, delivery, webhook_url, is_enabled)
       VALUES ($1, $2, $3, $4::alert_event_kind, $5,
               CASE WHEN $6::text IS NULL THEN NULL ELSE ST_GeomFromGeoJSON($6) END,
               $7::jsonb, $8::text[], $9, $10)
       RETURNING id, user_id, project_id, name, event_kind::text, aoi_id,
                 CASE WHEN bbox IS NULL THEN NULL ELSE ST_AsGeoJSON(bbox)::jsonb END AS bbox,
                 filters, delivery, webhook_url, is_enabled,
                 last_fired_at, created_at, updated_at`,
      [
        req.user!.id, body.projectId ?? null, body.name, body.eventKind,
        body.aoiId ?? null, bboxGeoJson, JSON.stringify(body.filters ?? {}),
        body.delivery, body.webhookUrl ?? null, body.isEnabled,
      ],
    );
    res.status(201).json({ alert: rowToJson(result.rows[0]!) });
  } catch (err) {
    next(err);
  }
});

alertsRouter.patch('/:id', async (req, res, next) => {
  try {
    const partial = AlertBody.partial().parse(req.body);
    const fields: string[] = [];
    const params: unknown[] = [req.params.id, req.user!.id];

    const push = (column: string, value: unknown, cast?: string) => {
      params.push(value);
      fields.push(cast ? `${column} = $${params.length}${cast}` : `${column} = $${params.length}`);
    };

    if (partial.name !== undefined) push('name', partial.name);
    if (partial.eventKind !== undefined) push('event_kind', partial.eventKind, '::alert_event_kind');
    if (partial.projectId !== undefined) push('project_id', partial.projectId);
    if (partial.aoiId !== undefined) push('aoi_id', partial.aoiId);
    if (partial.bbox !== undefined) {
      params.push(partial.bbox ? JSON.stringify(partial.bbox) : null);
      fields.push(`bbox = CASE WHEN $${params.length}::text IS NULL THEN NULL ELSE ST_GeomFromGeoJSON($${params.length}) END`);
    }
    if (partial.filters !== undefined) push('filters', JSON.stringify(partial.filters), '::jsonb');
    if (partial.delivery !== undefined) push('delivery', partial.delivery, '::text[]');
    if (partial.webhookUrl !== undefined) push('webhook_url', partial.webhookUrl);
    if (partial.isEnabled !== undefined) push('is_enabled', partial.isEnabled);

    if (!fields.length) {
      const r = await query<AlertRow>(`${select} WHERE id = $1 AND user_id = $2`, [req.params.id, req.user!.id]);
      if (!r.rows.length) throw new HttpError(404, 'not_found', 'Alert not found');
      res.json({ alert: rowToJson(r.rows[0]!) });
      return;
    }

    const result = await query<AlertRow>(
      `UPDATE alerts SET ${fields.join(', ')} WHERE id = $1 AND user_id = $2
       RETURNING id, user_id, project_id, name, event_kind::text, aoi_id,
                 CASE WHEN bbox IS NULL THEN NULL ELSE ST_AsGeoJSON(bbox)::jsonb END AS bbox,
                 filters, delivery, webhook_url, is_enabled,
                 last_fired_at, created_at, updated_at`,
      params,
    );
    if (!result.rows.length) throw new HttpError(404, 'not_found', 'Alert not found');
    res.json({ alert: rowToJson(result.rows[0]!) });
  } catch (err) {
    next(err);
  }
});

alertsRouter.delete('/:id', async (req, res, next) => {
  try {
    const result = await query(`DELETE FROM alerts WHERE id = $1 AND user_id = $2`, [req.params.id, req.user!.id]);
    if (!result.rowCount) throw new HttpError(404, 'not_found', 'Alert not found');
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
