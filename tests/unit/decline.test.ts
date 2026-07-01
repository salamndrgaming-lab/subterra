import { describe, expect, it } from 'vitest';

import {
  fitDecline,
  forecastRate,
  eur,
  annualDeclinePct,
  declineRegime,
  type DeclinePoint,
} from '../../apps/web/src/lib/decline';

/** Generate a clean Arps series for a known (qi, di, b). */
function synth(qi: number, di: number, b: number, months = 36): DeclinePoint[] {
  const pts: DeclinePoint[] = [];
  for (let t = 0; t < months; t++) {
    const q = b <= 1e-6 ? qi * Math.exp(-di * t) : qi / Math.pow(1 + b * di * t, 1 / b);
    pts.push({ t, q });
  }
  return pts;
}

describe('Arps decline fit', () => {
  it('recovers hyperbolic parameters from a clean series', () => {
    const fit = fitDecline(synth(1000, 0.08, 0.9));
    expect(fit).not.toBeNull();
    expect(fit!.qi).toBeCloseTo(1000, -1); // within ~10s
    expect(fit!.di).toBeGreaterThan(0.05);
    expect(fit!.di).toBeLessThan(0.12);
    expect(fit!.b).toBeGreaterThan(0.6); // grid lands near 0.9
    expect(fit!.r2).toBeGreaterThan(0.98);
  });

  it('recovers an exponential decline (b≈0)', () => {
    const fit = fitDecline(synth(500, 0.05, 0));
    expect(fit).not.toBeNull();
    expect(fit!.qi).toBeCloseTo(500, -1);
    expect(fit!.b).toBeLessThanOrEqual(0.1);
    expect(declineRegime(fit!)).toBe('exponential');
  });

  it('forecast matches the model forward in time', () => {
    const fit = fitDecline(synth(1000, 0.08, 0.5))!;
    // rate always declines
    expect(forecastRate(fit, 0)).toBeGreaterThan(forecastRate(fit, 12));
    expect(forecastRate(fit, 12)).toBeGreaterThan(forecastRate(fit, 60));
  });

  it('EUR is positive, finite, and grows with horizon', () => {
    const fit = fitDecline(synth(1000, 0.08, 0.5))!;
    const e5 = eur(fit, 60);
    const e30 = eur(fit, 360);
    expect(e5).toBeGreaterThan(0);
    expect(Number.isFinite(e30)).toBe(true);
    expect(e30).toBeGreaterThan(e5);
  });

  it('annual decline % is di*12*100', () => {
    const fit = fitDecline(synth(1000, 0.05, 0.3))!;
    expect(annualDeclinePct(fit)).toBeCloseTo(fit.di * 1200, 5);
  });

  it('returns null for too-few points', () => {
    expect(fitDecline([{ t: 0, q: 100 }, { t: 1, q: 90 }])).toBeNull();
  });

  it('returns null for a rising (non-declining) series', () => {
    const rising: DeclinePoint[] = Array.from({ length: 12 }, (_, t) => ({ t, q: 100 + t * 10 }));
    expect(fitDecline(rising)).toBeNull();
  });

  it('ignores zero/negative months when fitting', () => {
    const pts = synth(800, 0.06, 0.7);
    pts.splice(3, 0, { t: 3, q: 0 }); // a shut-in month
    const fit = fitDecline(pts);
    expect(fit).not.toBeNull();
    expect(fit!.qi).toBeGreaterThan(0);
  });
});
