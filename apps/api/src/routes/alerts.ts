import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import type { Alert } from '@subterra/shared';

export const alertsRouter = Router();

// In-memory alerts store for the scaffold.
const memAlerts = new Map<string, Alert>();

const AlertBody = z.object({
  name: z.string().min(1).max(120),
  eventKind: z.enum(['new_claim_filed', 'claim_dropped', 'permit_filed', 'permit_approved', 'well_spudded', 'production_change', 'lease_filed', 'price_threshold']),
  projectId: z.string().uuid().nullable().optional(),
  aoiId: z.string().uuid().nullable().optional(),
  bbox: z.object({ type: z.literal('Polygon'), coordinates: z.array(z.array(z.tuple([z.number(), z.number()]))) }).nullable().optional(),
  filters: z.record(z.unknown()).optional(),
  delivery: z.array(z.enum(['email', 'sms', 'webhook', 'in_app'])).default(['in_app']),
  webhookUrl: z.string().url().nullable().optional(),
  isEnabled: z.boolean().default(true),
});

alertsRouter.use(requireAuth);

alertsRouter.get('/', (req, res) => {
  const userAlerts = [...memAlerts.values()].filter((a) => a.userId === req.user!.id);
  res.json({ alerts: userAlerts });
});

alertsRouter.post('/', (req, res, next) => {
  try {
    const body = AlertBody.parse(req.body);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const alert: Alert = {
      id,
      userId: req.user!.id,
      projectId: body.projectId ?? null,
      name: body.name,
      eventKind: body.eventKind,
      aoiId: body.aoiId ?? null,
      bbox: body.bbox ?? null,
      filters: body.filters ?? {},
      delivery: body.delivery,
      webhookUrl: body.webhookUrl ?? null,
      isEnabled: body.isEnabled,
      lastFiredAt: null,
      createdAt: now,
      updatedAt: now,
    };
    memAlerts.set(id, alert);
    res.status(201).json({ alert });
  } catch (err) {
    next(err);
  }
});

alertsRouter.patch('/:id', (req, res, next) => {
  try {
    const alert = memAlerts.get(req.params.id);
    if (!alert || alert.userId !== req.user!.id) throw new HttpError(404, 'not_found', 'Alert not found');
    const partial = AlertBody.partial().parse(req.body);
    const updated: Alert = { ...alert, ...partial, updatedAt: new Date().toISOString() } as Alert;
    memAlerts.set(alert.id, updated);
    res.json({ alert: updated });
  } catch (err) {
    next(err);
  }
});

alertsRouter.delete('/:id', (req, res, next) => {
  try {
    const alert = memAlerts.get(req.params.id);
    if (!alert || alert.userId !== req.user!.id) throw new HttpError(404, 'not_found', 'Alert not found');
    memAlerts.delete(alert.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
