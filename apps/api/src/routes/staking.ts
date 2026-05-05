import { Router } from 'express';
import { z } from 'zod';
import { fetchBlmClaims } from '../sources/blm-claims.js';
import { arcgisQuery } from '../sources/arcgis.js';
import { cached } from '../sources/cache.js';
import { DATA_SOURCES } from '@subterra/shared';

export const stakingRouter = Router();

const PolygonBody = z.object({
  geometry: z.object({
    type: z.literal('Polygon'),
    coordinates: z.array(z.array(z.tuple([z.number(), z.number()]))),
  }),
});

/**
 * Returns BLM Surface Management features intersecting the requested bbox.
 * Phase 2 will combine this with the BLM withdrawals layer to mark which
 * cells are formally closed to mineral entry.
 */
stakingRouter.get('/open-land', async (req, res, next) => {
  try {
    const QueryShape = z.object({ bbox: z.string() });
    const { bbox } = QueryShape.parse(req.query);
    const parts = bbox.split(',').map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
      res.status(400).json({ error: 'invalid_bbox' });
      return;
    }
    const [w, s, e, n] = parts as [number, number, number, number];
    const key = `blm:sma:${w},${s},${e},${n}`;
    const fc = await cached(key, 600, () =>
      arcgisQuery<Record<string, unknown>>(
        `${DATA_SOURCES.blm.surfaceManagement}/0/query`,
        {
          where: `ADMIN_AGENCY_CODE = 'BLM'`,
          bbox: [w, s, e, n],
          resultRecordCount: 1000,
        },
      ),
    );
    res.json(fc);
  } catch (err) {
    next(err);
  }
});

/**
 * Conflict checker — fetches every active BLM mining claim whose envelope
 * intersects the polygon's bbox, then runs a point-in-polygon test on the
 * claim centroid.
 */
stakingRouter.post('/check-conflict', async (req, res, next) => {
  try {
    const { geometry } = PolygonBody.parse(req.body);
    const ring = (geometry.coordinates[0] ?? []) as [number, number][];
    if (ring.length < 4) {
      res.status(400).json({ error: 'polygon_too_small' });
      return;
    }
    const bbox = ringBbox(ring);
    const claims = await fetchBlmClaims({ bbox, status: 'active', limit: 2000 });

    const conflicts: Array<{ id: string; serialNumber: string; claimName: string | null; owner: string | null; commodity: string | null; acreage: number | null }> = [];

    for (const f of claims.features) {
      const r = f.geometry.coordinates[0]?.[0];
      if (!r) continue;
      let sx = 0, sy = 0;
      for (const pt of r) { sx += pt[0]!; sy += pt[1]!; }
      const centroid: [number, number] = [sx / r.length, sy / r.length];
      if (!pointInPolygon(centroid, ring)) continue;
      conflicts.push({
        id: f.properties.serialNumber,
        serialNumber: f.properties.serialNumber,
        claimName: f.properties.claimName,
        owner: f.properties.ownerName,
        commodity: f.properties.commodity,
        acreage: f.properties.acreage,
      });
    }

    res.json({
      acreage: Number(polygonAcreage(ring).toFixed(2)),
      conflictCount: conflicts.length,
      conflicts,
      source: 'blm_national_mining_claims',
    });
  } catch (err) {
    next(err);
  }
});

const ExportBody = z.object({
  geometry: z.object({
    type: z.literal('Polygon'),
    coordinates: z.array(z.array(z.tuple([z.number(), z.number()]))),
  }),
  claimName: z.string().min(1).max(100),
  claimType: z.enum(['lode', 'placer', 'mill_site', 'tunnel_site']),
  locator: z.object({ name: z.string(), address: z.string() }),
  discoveryDate: z.string(),
});

stakingRouter.post('/export', (req, res, next) => {
  try {
    const body = ExportBody.parse(req.body);
    const ring = (body.geometry.coordinates[0] ?? []) as [number, number][];
    const corners = ring.slice(0, -1).map((pt, idx) => ({
      label: `Corner ${idx + 1}`,
      lng: pt[0],
      lat: pt[1],
    }));
    const acreage = polygonAcreage(ring);
    const filingDeadline = addDays(new Date(body.discoveryDate), 90);

    res.json({
      claimName: body.claimName,
      claimType: body.claimType,
      locator: body.locator,
      acreage: Number(acreage.toFixed(2)),
      corners,
      filingDeadline: filingDeadline.toISOString().slice(0, 10),
      checklist: [
        'Erect monument at each corner with claim name + locator name',
        'Post Notice of Location on a conspicuous monument',
        'Record copy with county recorder within 90 days of location',
        'File with BLM state office within 90 days of location',
        'Pay $200/claim location fee to BLM',
        'Pay $20/claim recordation fee to BLM',
      ],
      formats: ['pdf', 'csv', 'geojson'],
    });
  } catch (err) {
    next(err);
  }
});

function ringBbox(ring: [number, number][]): [number, number, number, number] {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of ring) {
    if (x < w) w = x; if (x > e) e = x;
    if (y < s) s = y; if (y > n) n = y;
  }
  return [w, s, e, n];
}

function pointInPolygon(point: [number, number], ring: [number, number][]): boolean {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]; const b = ring[j];
    if (!a || !b) continue;
    const [xi, yi] = a; const [xj, yj] = b;
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function polygonAcreage(ring: [number, number][]): number {
  if (ring.length < 4) return 0;
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]; const b = ring[j];
    if (!a || !b) continue;
    area += (b[0] + a[0]) * (b[1] - a[1]);
  }
  area = Math.abs(area / 2);
  let sumLat = 0;
  for (const pt of ring) sumLat += pt[1];
  const meanLat = sumLat / ring.length;
  const kmPerDegLat = 111;
  const kmPerDegLng = 111 * Math.cos((meanLat * Math.PI) / 180);
  return area * kmPerDegLat * kmPerDegLng * 247.105;
}

function addDays(d: Date, days: number) {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  return out;
}
