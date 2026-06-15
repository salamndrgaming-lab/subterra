import { describe, expect, it } from 'vitest';

import {
  bearingDeg,
  distanceMeters,
  interpolateLine,
  perpendicularBufferRing,
  polylineCrossings,
  projectOntoLine,
  segmentIntersection,
  type LngLat,
} from '../../apps/web/src/lib/section-math';

// Test pair: Reno NV → Yerington NV, roughly 80 km southeast.
const RENO: LngLat = [-119.8138, 39.5296];
const YERINGTON: LngLat = [-119.1635, 38.9854];

describe('distanceMeters', () => {
  it('returns 0 for identical points', () => {
    expect(distanceMeters(RENO, RENO)).toBe(0);
  });
  it('matches haversine reference for Reno → Yerington (~83 km)', () => {
    const m = distanceMeters(RENO, YERINGTON);
    expect(m).toBeGreaterThan(82_000);
    expect(m).toBeLessThan(85_000);
  });
  it('is symmetric', () => {
    expect(distanceMeters(RENO, YERINGTON)).toBeCloseTo(distanceMeters(YERINGTON, RENO), 6);
  });
});

describe('bearingDeg', () => {
  it('is 0 (N) for a due-north step', () => {
    expect(bearingDeg([0, 0], [0, 1])).toBeCloseTo(0, 4);
  });
  it('is 90 (E) for a due-east step', () => {
    expect(bearingDeg([0, 0], [1, 0])).toBeCloseTo(90, 4);
  });
  it('is 180 (S) for a due-south step', () => {
    expect(bearingDeg([0, 0], [0, -1])).toBeCloseTo(180, 4);
  });
  it('returns Reno → Yerington bearing in the SE quadrant (~140°)', () => {
    const b = bearingDeg(RENO, YERINGTON);
    expect(b).toBeGreaterThan(130);
    expect(b).toBeLessThan(160);
  });
});

describe('interpolateLine', () => {
  it('returns n+1 points including both endpoints', () => {
    const pts = interpolateLine(RENO, YERINGTON, 10);
    expect(pts).toHaveLength(11);
    expect(pts[0]).toEqual(RENO);
    expect(pts[10]).toEqual(YERINGTON);
  });
  it('midpoint is the average of endpoints for even n', () => {
    const pts = interpolateLine([0, 0], [10, 4], 2);
    expect(pts[1]).toEqual([5, 2]);
  });
  it('throws for n < 1', () => {
    expect(() => interpolateLine(RENO, YERINGTON, 0)).toThrow();
  });
});

describe('projectOntoLine', () => {
  it('projects a midpoint onto AB with t≈0.5 and ~0 perpendicular distance', () => {
    const mid: LngLat = [(RENO[0] + YERINGTON[0]) / 2, (RENO[1] + YERINGTON[1]) / 2];
    const { t, distanceAlong, distanceFrom } = projectOntoLine(mid, RENO, YERINGTON);
    expect(t).toBeCloseTo(0.5, 3);
    expect(distanceFrom).toBeLessThan(50); // within 50m of the line
    const ab = distanceMeters(RENO, YERINGTON);
    expect(distanceAlong).toBeCloseTo(ab / 2, -1); // -1 = ±10m tolerance
  });
  it('clamps t to [0, 1] for points beyond endpoints', () => {
    // Point well past B in the same direction.
    const past: LngLat = [-118.5, 38.5];
    const { t } = projectOntoLine(past, RENO, YERINGTON);
    expect(t).toBe(1);
  });
  it('returns sensible perpendicular distance for a 1km-offset point', () => {
    // A point ~1km perpendicular off the AB midpoint.
    const mid: LngLat = [(RENO[0] + YERINGTON[0]) / 2, (RENO[1] + YERINGTON[1]) / 2];
    // Step ~0.01° N — at lat 39 that's ~1.1km.
    const off: LngLat = [mid[0], mid[1] + 0.01];
    const { distanceFrom } = projectOntoLine(off, RENO, YERINGTON);
    expect(distanceFrom).toBeGreaterThan(500);
    expect(distanceFrom).toBeLessThan(1500);
  });
  it('handles A == B by returning 0/0/distance-from-A', () => {
    const { t, distanceAlong, distanceFrom } = projectOntoLine([0, 0.01], [0, 0], [0, 0]);
    expect(t).toBe(0);
    expect(distanceAlong).toBe(0);
    expect(distanceFrom).toBeGreaterThan(0);
  });
});

describe('segmentIntersection', () => {
  it('finds the crossing of two perpendicular segments', () => {
    const hit = segmentIntersection([-117.1, 38.0], [-116.9, 38.0], [-117.0, 37.9], [-117.0, 38.1]);
    expect(hit).not.toBeNull();
    expect(hit![0]).toBeCloseTo(-117.0, 6);
    expect(hit![1]).toBeCloseTo(38.0, 6);
  });
  it('returns null for parallel segments', () => {
    expect(
      segmentIntersection([-117.1, 38.0], [-116.9, 38.0], [-117.1, 38.1], [-116.9, 38.1]),
    ).toBeNull();
  });
  it('returns null when segments would only cross if extended', () => {
    expect(
      segmentIntersection([-117.1, 38.0], [-117.05, 38.0], [-117.0, 37.9], [-117.0, 38.1]),
    ).toBeNull();
  });
});

describe('polylineCrossings', () => {
  it('finds two crossings of a zigzag fault trace', () => {
    const a: LngLat = [-117.2, 38.0];
    const b: LngLat = [-116.8, 38.0];
    // Trace dips below the AB line, comes back up, crossing twice.
    const trace: LngLat[] = [
      [-117.15, 38.05],
      [-117.1, 37.95],
      [-117.0, 38.05],
    ];
    const ts = polylineCrossings(a, b, trace);
    expect(ts).toHaveLength(2);
    expect(ts[0]!).toBeLessThan(ts[1]!);
    for (const t of ts) {
      expect(t).toBeGreaterThan(0);
      expect(t).toBeLessThan(1);
    }
  });
  it('returns empty for a trace that never crosses', () => {
    const ts = polylineCrossings(
      [-117.2, 38.0],
      [-116.8, 38.0],
      [
        [-117.1, 38.2],
        [-117.0, 38.3],
      ],
    );
    expect(ts).toHaveLength(0);
  });
});

describe('perpendicularBufferRing', () => {
  it('returns a closed 5-vertex ring', () => {
    const ring = perpendicularBufferRing(RENO, YERINGTON, 1000);
    expect(ring).toHaveLength(5);
    expect(ring[0]).toEqual(ring[4]); // closed
  });
  it('buffer corners lie within ~5% of the requested half-width from the AB line', () => {
    const half = 1500;
    const ring = perpendicularBufferRing(RENO, YERINGTON, half);
    // Skip the closing duplicate vertex.
    for (const corner of ring.slice(0, 4)) {
      const { distanceFrom } = projectOntoLine(corner, RENO, YERINGTON);
      expect(distanceFrom).toBeGreaterThan(half * 0.95);
      expect(distanceFrom).toBeLessThan(half * 1.05);
    }
  });
});
