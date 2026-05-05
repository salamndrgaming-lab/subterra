import { Router } from 'express';
import { z } from 'zod';
import { fetchBlmClaims } from '../sources/blm-claims.js';
import { fetchMrds } from '../sources/usgs-mrds.js';
import { fetchWells } from '../sources/wells.js';
import { parseBBox } from '../lib/geo.js';
import { query } from '../db.js';

export const searchRouter = Router();

const SearchQuery = z.object({
  q: z.string().optional(),
  state: z.string().length(2).optional(),
  county: z.string().optional(),
  commodity: z.string().optional(),
  bbox: z.string().optional(),
  types: z.string().optional(),     // comma list: 'wells,claims,parcels,occurrences'
  limit: z.coerce.number().int().positive().max(500).default(100),
});

interface Result {
  kind: string;
  id: string;
  label: string;
  subtitle?: string;
  coordinates?: [number, number];
  meta?: Record<string, unknown>;
}

searchRouter.get('/', async (req, res, next) => {
  try {
    const q = SearchQuery.parse(req.query);
    const bbox = parseBBox(q.bbox) ?? undefined;
    const types = (q.types ?? 'wells,claims,parcels,occurrences').split(',').map((t) => t.trim());
    const term = q.q?.toLowerCase().trim() || null;

    const results: Result[] = [];

    if (types.includes('wells')) {
      const wells = await fetchWells({ bbox, state: q.state, county: q.county, limit: 200 });
      for (const f of wells.features) {
        const p = f.properties;
        if (term && !matchAny(term, [p.wellName, p.operator, p.apiNumber])) continue;
        results.push({
          kind: 'well',
          id: p.apiNumber ?? '',
          label: p.wellName ?? p.apiNumber ?? 'Unnamed well',
          subtitle: `${p.operator ?? ''} · ${p.state} ${p.county ?? ''}`.trim(),
          coordinates: f.geometry.coordinates as [number, number],
          meta: { apiNumber: p.apiNumber, status: p.status, source: p.source },
        });
      }
    }

    if (types.includes('claims')) {
      const claims = await fetchBlmClaims({ bbox, state: q.state, commodity: q.commodity, limit: 200 });
      for (const f of claims.features) {
        const p = f.properties;
        if (term && !matchAny(term, [p.serialNumber, p.claimName, p.ownerName])) continue;
        const ring = f.geometry.coordinates[0]?.[0];
        const centroid = ring && ring.length ? avgCoords(ring) : null;
        results.push({
          kind: 'claim',
          id: p.serialNumber,
          label: p.claimName ?? p.serialNumber,
          subtitle: `${p.commodity ?? ''} · ${p.state ?? ''} ${p.county ?? ''} · ${p.status ?? ''}`.trim(),
          coordinates: centroid ?? undefined,
          meta: { serialNumber: p.serialNumber, owner: p.ownerName },
        });
      }
    }

    if (types.includes('occurrences')) {
      const occ = await fetchMrds({ bbox, state: q.state, commodity: q.commodity, limit: 200 });
      for (const f of occ.features) {
        const p = f.properties;
        if (term && !matchAny(term, [p.siteName, p.mrdsId])) continue;
        results.push({
          kind: 'occurrence',
          id: p.mrdsId,
          label: p.siteName ?? p.mrdsId,
          subtitle: `${p.primaryCommodity ?? ''} · ${p.state ?? ''} ${p.county ?? ''}`.trim(),
          coordinates: f.geometry.coordinates as [number, number],
          meta: { developmentStatus: p.developmentStatus },
        });
      }
    }

    if (types.includes('parcels')) {
      const params: unknown[] = [];
      const where: string[] = [];
      if (q.state) { params.push(q.state); where.push(`state = $${params.length}`); }
      if (q.county) { params.push(q.county); where.push(`county ILIKE $${params.length}`); }
      if (term) {
        params.push(`%${term}%`);
        where.push(`(LOWER(owner_name) LIKE $${params.length} OR LOWER(parcel_number) LIKE $${params.length})`);
      }
      params.push(q.limit);
      const rows = await query<{
        id: string; parcel_number: string | null; owner_name: string | null;
        state: string; county: string; acreage: string | null; estimated_value: string | null;
        lng: number; lat: number;
      }>(
        `SELECT id, parcel_number, owner_name, state, county, acreage, estimated_value,
                ST_X(centroid) AS lng, ST_Y(centroid) AS lat
           FROM parcels
           ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
           LIMIT $${params.length}`,
        params,
      );
      for (const r of rows.rows) {
        results.push({
          kind: 'parcel',
          id: r.id,
          label: r.parcel_number ?? 'Parcel',
          subtitle: `${r.owner_name ?? ''} · ${r.state} ${r.county}`.trim(),
          coordinates: [r.lng, r.lat],
          meta: { acreage: r.acreage == null ? null : Number(r.acreage), estimatedValue: r.estimated_value == null ? null : Number(r.estimated_value) },
        });
      }
    }

    res.json({ count: results.length, results: results.slice(0, q.limit) });
  } catch (err) {
    next(err);
  }
});

function matchAny(term: string, candidates: Array<string | null | undefined>): boolean {
  for (const c of candidates) {
    if (c && c.toLowerCase().includes(term)) return true;
  }
  return false;
}

function avgCoords(ring: number[][]): [number, number] {
  let sx = 0, sy = 0, n = 0;
  for (const pt of ring) {
    if (pt.length < 2) continue;
    sx += pt[0]!; sy += pt[1]!; n++;
  }
  return n ? [sx / n, sy / n] : [0, 0];
}
