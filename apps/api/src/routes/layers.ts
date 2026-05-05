import { Router } from 'express';
import { z } from 'zod';
import { MOCK_WELLS } from '../mocks/wells.js';
import { MOCK_MINING_CLAIMS, MOCK_MINERAL_OCCURRENCES } from '../mocks/claims.js';
import { MOCK_PARCELS } from '../mocks/parcels.js';
import { asFeatureCollection, parseBBox, pointInBBox } from '../lib/geo.js';

export const layersRouter = Router();

const LayerQuery = z.object({
  bbox: z.string().optional(),
  state: z.string().length(2).optional(),
  county: z.string().optional(),
  status: z.string().optional(),
  commodity: z.string().optional(),
  limit: z.coerce.number().int().positive().max(5000).default(1000),
});

layersRouter.get('/wells', (req, res, next) => {
  try {
    const q = LayerQuery.parse(req.query);
    const bbox = parseBBox(q.bbox);
    let wells = MOCK_WELLS;
    if (bbox) wells = wells.filter((w) => pointInBBox(w.geom, bbox));
    if (q.state) wells = wells.filter((w) => w.state === q.state);
    if (q.county) wells = wells.filter((w) => w.county?.toLowerCase() === q.county!.toLowerCase());
    if (q.status) wells = wells.filter((w) => w.status === q.status);
    res.json(asFeatureCollection(wells.slice(0, q.limit)));
  } catch (err) {
    next(err);
  }
});

layersRouter.get('/claims', (req, res, next) => {
  try {
    const q = LayerQuery.parse(req.query);
    const bbox = parseBBox(q.bbox);
    let claims = MOCK_MINING_CLAIMS;
    if (bbox) claims = claims.filter((c) => pointInBBox(c.centroid, bbox));
    if (q.state) claims = claims.filter((c) => c.state === q.state);
    if (q.county) claims = claims.filter((c) => c.county?.toLowerCase() === q.county!.toLowerCase());
    if (q.status) claims = claims.filter((c) => c.status === q.status);
    if (q.commodity) claims = claims.filter((c) => c.commodity === q.commodity);
    res.json(asFeatureCollection(claims.slice(0, q.limit)));
  } catch (err) {
    next(err);
  }
});

layersRouter.get('/parcels', (req, res, next) => {
  try {
    const q = LayerQuery.parse(req.query);
    const bbox = parseBBox(q.bbox);
    let parcels = MOCK_PARCELS;
    if (bbox) parcels = parcels.filter((p) => pointInBBox(p.centroid, bbox));
    if (q.state) parcels = parcels.filter((p) => p.state === q.state);
    if (q.county) parcels = parcels.filter((p) => p.county.toLowerCase() === q.county!.toLowerCase());
    res.json(asFeatureCollection(parcels.slice(0, q.limit)));
  } catch (err) {
    next(err);
  }
});

layersRouter.get('/mineral-occurrences', (req, res, next) => {
  try {
    const q = LayerQuery.parse(req.query);
    const bbox = parseBBox(q.bbox);
    let mocs = MOCK_MINERAL_OCCURRENCES;
    if (bbox) mocs = mocs.filter((m) => pointInBBox(m.geom, bbox));
    if (q.state) mocs = mocs.filter((m) => m.state === q.state);
    if (q.commodity) mocs = mocs.filter((m) => m.primaryCommodity === q.commodity);
    res.json(asFeatureCollection(mocs.slice(0, q.limit)));
  } catch (err) {
    next(err);
  }
});

layersRouter.get('/permits', (_req, res) => {
  // Stubbed in Phase 1.
  res.json({ type: 'FeatureCollection', features: [] });
});
