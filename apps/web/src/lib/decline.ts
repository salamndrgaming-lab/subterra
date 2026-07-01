/**
 * Arps decline-curve fitting for well production.
 *
 * The classic petroleum-engineering model for how a well's rate falls
 * over time (Arps 1945):
 *
 *   q(t) = qi / (1 + b·Di·t)^(1/b)        (hyperbolic, 0 < b < 1)
 *   q(t) = qi / (1 + Di·t)                (harmonic,   b = 1)
 *   q(t) = qi · e^(−Di·t)                 (exponential, b → 0)
 *
 * where qi = initial rate, Di = initial nominal decline (per month here),
 * b = hyperbolic exponent (curvature). Fitting these three parameters to
 * a well's monthly history gives an EUR (estimated ultimate recovery) and
 * a forward forecast — the single most-requested reservoir-engineering
 * output and the core of every type-curve / valuation workflow.
 *
 * Fit method: grid-search b; for each b the model linearizes, so qi + Di
 * come from a closed-form least-squares line, and we keep the b with the
 * best R² on the original (untransformed) rates. Robust, dependency-free,
 * and unit-tested against synthetic curves.
 *
 * Units: t in months, q as a monthly rate (e.g. bbl/month). Di returned
 * per-month; helpers expose an annualized figure for display.
 */

export interface DeclinePoint {
  /** Months since first production (0-based). */
  t: number;
  /** Production rate that month (> 0). */
  q: number;
}

export interface DeclineFit {
  /** Initial rate (same units as input q). */
  qi: number;
  /** Initial nominal decline per month. */
  di: number;
  /** Hyperbolic exponent. 0 ≈ exponential, 1 = harmonic. */
  b: number;
  /** Goodness of fit on the original rates, 0..1. */
  r2: number;
}

/** Ordinary least-squares line y = a + m·x over [x,y] pairs. Returns null
 *  if degenerate. Iterates pairs (no indexed access) so it's clean under
 *  noUncheckedIndexedAccess. */
function linreg(pairs: Array<[number, number]>): { a: number; m: number } | null {
  const n = pairs.length;
  if (n < 2) return null;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const [x, y] of pairs) {
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  const m = (n * sxy - sx * sy) / denom;
  const a = (sy - m * sx) / n;
  return { a, m };
}

function rate(qi: number, di: number, b: number, t: number): number {
  if (b <= 1e-6) return qi * Math.exp(-di * t);
  return qi / Math.pow(1 + b * di * t, 1 / b);
}

function r2of(points: DeclinePoint[], qi: number, di: number, b: number): number {
  const mean = points.reduce((s, p) => s + p.q, 0) / points.length;
  let ssRes = 0;
  let ssTot = 0;
  for (const p of points) {
    const pred = rate(qi, di, b, p.t);
    ssRes += (p.q - pred) ** 2;
    ssTot += (p.q - mean) ** 2;
  }
  if (ssTot === 0) return 0;
  return 1 - ssRes / ssTot;
}

/**
 * Fit Arps to a well's monthly rates. Needs ≥ 4 positive points and a
 * genuine decline (rates trending down). Returns null when the data is
 * too sparse or noisy to fit a physically-sensible declining curve.
 */
export function fitDecline(points: DeclinePoint[]): DeclineFit | null {
  const clean = points.filter((p) => Number.isFinite(p.t) && Number.isFinite(p.q) && p.q > 0);
  if (clean.length < 4) return null;

  let best: DeclineFit | null = null;

  // Grid over the physically-common b range. b = 0 handled as the
  // exponential special case (ln-linear).
  for (let b = 0; b <= 1.5 + 1e-9; b += 0.05) {
    let qi: number;
    let di: number;
    if (b <= 1e-6) {
      // exponential: ln q = ln qi − Di·t
      const fit = linreg(clean.map((p) => [p.t, Math.log(p.q)]));
      if (!fit) continue;
      qi = Math.exp(fit.a);
      di = -fit.m;
    } else {
      // hyperbolic linearization: q^(−b) = qi^(−b) · (1 + b·Di·t) = A + B·t
      const fit = linreg(clean.map((p) => [p.t, Math.pow(p.q, -b)]));
      if (!fit || fit.a <= 0 || fit.m <= 0) continue;
      qi = Math.pow(fit.a, -1 / b);
      di = fit.m / (fit.a * b);
    }
    // Reject non-physical fits (rising or flat, absurd params).
    if (!(qi > 0) || !(di > 0) || !Number.isFinite(qi) || !Number.isFinite(di)) continue;
    const r2 = r2of(clean, qi, di, b);
    if (!best || r2 > best.r2) best = { qi, di, b, r2 };
  }

  // Require a decent fit — a poor R² means it isn't really declining
  // (or the history is too noisy to be useful).
  if (!best || best.r2 < 0.5) return null;
  return best;
}

/** Forecast rate at month t from a fit. */
export function forecastRate(fit: DeclineFit, t: number): number {
  return rate(fit.qi, fit.di, fit.b, t);
}

/**
 * Cumulative production (EUR) integrated to `horizonMonths`. Uses the
 * closed-form Arps cumulative per regime. Same units as qi × months.
 */
export function eur(fit: DeclineFit, horizonMonths = 360): number {
  const { qi, di, b } = fit;
  if (di <= 0) return 0;
  if (b <= 1e-6) {
    // exponential
    return (qi / di) * (1 - Math.exp(-di * horizonMonths));
  }
  if (Math.abs(b - 1) < 1e-6) {
    // harmonic
    return (qi / di) * Math.log(1 + di * horizonMonths);
  }
  // hyperbolic
  return (
    (qi / ((1 - b) * di)) * (1 - Math.pow(1 + b * di * horizonMonths, (b - 1) / b))
  );
}

/** Di expressed as an annual nominal percentage, for display. */
export function annualDeclinePct(fit: DeclineFit): number {
  return fit.di * 12 * 100;
}

/** Human label for the decline regime. */
export function declineRegime(fit: DeclineFit): string {
  if (fit.b <= 0.1) return 'exponential';
  if (fit.b >= 0.9) return 'harmonic';
  return 'hyperbolic';
}
