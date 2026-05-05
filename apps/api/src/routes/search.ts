import { Router } from 'express';
import { z } from 'zod';
import { MOCK_WELLS } from '../mocks/wells.js';
import { MOCK_MINING_CLAIMS } from '../mocks/claims.js';
import { MOCK_PARCELS } from '../mocks/parcels.js';
import { parseBBox, pointInBBox } from '../lib/geo.js';

export const searchRouter = Router();

const SearchQuery = z.object({
  q: z.string().optional(),
  state: z.string().length(2).optional(),
  county: z.string().optional(),
  commodity: z.string().optional(),
  bbox: z.string().optional(),
  types: z.string().optional(),     // comma list: 'wells,claims,parcels'
  limit: z.coerce.number().int().positive().max(500).default(100),
});

searchRouter.get('/', (req, res, next) => {
  try {
    const q = SearchQuery.parse(req.query);
    const bbox = parseBBox(q.bbox);
    const types = (q.types ?? 'wells,claims,parcels').split(',').map((t) => t.trim());
    const term = q.q?.toLowerCase();

    const results: Array<{ kind: string; id: string; label: string; subtitle?: string; coordinates?: [number, number]; meta?: Record<string, unknown> }> = [];

    if (types.includes('wells')) {
      let wells = MOCK_WELLS;
      if (bbox) wells = wells.filter((w) => pointInBBox(w.geom, bbox));
      if (q.state) wells = wells.filter((w) => w.state === q.state);
      if (q.county) wells = wells.filter((w) => w.county?.toLowerCase() === q.county!.toLowerCase());
      if (term) wells = wells.filter((w) =>
        w.wellName?.toLowerCase().includes(term) ||
        w.operator?.toLowerCase().includes(term) ||
        w.apiNumber?.toLowerCase().includes(term),
      );
      for (const w of wells) {
        results.push({
          kind: 'well',
          id: w.id,
          label: w.wellName ?? w.apiNumber ?? 'Unnamed well',
          subtitle: `${w.operator ?? ''} · ${w.basin ?? ''} · ${w.formation ?? ''}`,
          coordinates: w.geom.coordinates as [number, number],
          meta: { state: w.state, county: w.county, status: w.status, apiNumber: w.apiNumber },
        });
      }
    }

    if (types.includes('claims')) {
      let claims = MOCK_MINING_CLAIMS;
      if (bbox) claims = claims.filter((c) => pointInBBox(c.centroid, bbox));
      if (q.state) claims = claims.filter((c) => c.state === q.state);
      if (q.county) claims = claims.filter((c) => c.county?.toLowerCase() === q.county!.toLowerCase());
      if (q.commodity) claims = claims.filter((c) => c.commodity === q.commodity);
      if (term) claims = claims.filter((c) =>
        c.claimName?.toLowerCase().includes(term) ||
        c.ownerName?.toLowerCase().includes(term) ||
        c.serialNumber.toLowerCase().includes(term),
      );
      for (const c of claims) {
        results.push({
          kind: 'claim',
          id: c.id,
          label: c.claimName ?? c.serialNumber,
          subtitle: `${c.commodity ?? ''} · ${c.state} ${c.county ?? ''} · ${c.status ?? ''}`,
          coordinates: c.centroid.coordinates as [number, number],
          meta: { serialNumber: c.serialNumber, owner: c.ownerName },
        });
      }
    }

    if (types.includes('parcels')) {
      let parcels = MOCK_PARCELS;
      if (bbox) parcels = parcels.filter((p) => pointInBBox(p.centroid, bbox));
      if (q.state) parcels = parcels.filter((p) => p.state === q.state);
      if (q.county) parcels = parcels.filter((p) => p.county.toLowerCase() === q.county!.toLowerCase());
      if (term) parcels = parcels.filter((p) =>
        p.ownerName?.toLowerCase().includes(term) ||
        p.parcelNumber?.toLowerCase().includes(term),
      );
      for (const p of parcels) {
        results.push({
          kind: 'parcel',
          id: p.id,
          label: p.parcelNumber ?? 'Parcel',
          subtitle: `${p.ownerName ?? ''} · ${p.state} ${p.county} · ${p.acreage?.toFixed(0) ?? '—'} ac`,
          coordinates: p.centroid.coordinates as [number, number],
          meta: { acreage: p.acreage, estimatedValue: p.estimatedValue },
        });
      }
    }

    res.json({ count: results.length, results: results.slice(0, q.limit) });
  } catch (err) {
    next(err);
  }
});
