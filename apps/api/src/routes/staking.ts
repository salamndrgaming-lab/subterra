import { Router } from 'express';
import { z } from 'zod';
import { MOCK_MINING_CLAIMS } from '../mocks/claims.js';

export const stakingRouter = Router();

/**
 * Returns BLM lands considered "open" — i.e. surface-managed by BLM, no active
 * mining claim within the bbox, and not in a withdrawn area. Phase 1 returns a
 * stub FeatureCollection; Phase 2 wires BLM SMA + MLRS layers.
 */
stakingRouter.get('/open-land', (_req, res) => {
  res.json({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 'open-land-stub-1',
        properties: { agency: 'BLM', stateOffice: 'NV', withdrawn: false, sourceNote: 'stub' },
        geometry: {
          type: 'Polygon',
          coordinates: [[
            [-117.30, 38.04],
            [-117.20, 38.04],
            [-117.20, 38.09],
            [-117.30, 38.09],
            [-117.30, 38.04],
          ]],
        },
      },
    ],
  });
});

const PolygonBody = z.object({
  geometry: z.object({
    type: z.literal('Polygon'),
    coordinates: z.array(z.array(z.tuple([z.number(), z.number()]))),
  }),
});

/**
 * Conflict checker — returns active claims whose centroid falls inside the
 * supplied polygon. Phase 2 will use PostGIS ST_Intersects.
 */
stakingRouter.post('/check-conflict', (req, res, next) => {
  try {
    const { geometry } = PolygonBody.parse(req.body);
    const ring = geometry.coordinates[0] ?? [];
    const conflicts = MOCK_MINING_CLAIMS
      .filter((c) => c.status === 'active')
      .filter((c) => pointInPolygon(c.centroid.coordinates as [number, number], ring as [number, number][]));

    const acreage = polygonAcreage(ring as [number, number][]);
    res.json({
      acreage: Number(acreage.toFixed(2)),
      conflictCount: conflicts.length,
      conflicts: conflicts.map((c) => ({
        id: c.id,
        serialNumber: c.serialNumber,
        claimName: c.claimName,
        owner: c.ownerName,
        commodity: c.commodity,
        acreage: c.acreage,
      })),
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
  locator: z.object({
    name: z.string(),
    address: z.string(),
  }),
  discoveryDate: z.string(),
});

stakingRouter.post('/export', (req, res, next) => {
  try {
    const body = ExportBody.parse(req.body);
    const ring = body.geometry.coordinates[0] ?? [];
    const corners = (ring as [number, number][]).slice(0, -1).map((pt, idx) => ({
      label: `Corner ${idx + 1}`,
      lng: pt[0],
      lat: pt[1],
    }));
    const acreage = polygonAcreage(ring as [number, number][]);
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

// ---------- helpers ----------

function pointInPolygon(point: [number, number], ring: [number, number][]): boolean {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (!a || !b) continue;
    const [xi, yi] = a;
    const [xj, yj] = b;
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function polygonAcreage(ring: [number, number][]): number {
  // shoelace area in degrees → approximate to acres at midpoint latitude
  if (ring.length < 4) return 0;
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (!a || !b) continue;
    area += (b[0] + a[0]) * (b[1] - a[1]);
  }
  area = Math.abs(area / 2);
  // rough scaling: 1 degree latitude ≈ 111 km. longitude scales by cos(lat).
  let sumLat = 0;
  for (const pt of ring) sumLat += pt[1];
  const meanLat = sumLat / ring.length;
  const kmPerDegLat = 111;
  const kmPerDegLng = 111 * Math.cos((meanLat * Math.PI) / 180);
  // computed area is in deg^2. Convert via the lat/lng scales.
  const sqKm = area * kmPerDegLat * kmPerDegLng;
  return sqKm * 247.105;
}

function addDays(d: Date, days: number) {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  return out;
}
