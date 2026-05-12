'use client';

import { useMemo } from 'react';

interface Props {
  acres: number;
  basin?: string;
  /** Comparable lease bonuses recently filed in the area, $/acre */
  comparableBonuses?: number[];
  /** Comparable royalty fractions recently filed (e.g. 0.1875, 0.20) */
  comparableRoyalties?: number[];
}

const DEFAULT_BONUSES_BY_BASIN: Record<string, number[]> = {
  Permian: [12000, 18500, 24000, 32000],
  Bakken: [3500, 5500, 7800, 9200],
  'Eagle Ford': [9000, 14500, 18000, 21000],
  Niobrara: [3500, 6000, 9000, 12500],
  'Powder River': [1200, 2400, 4800, 7000],
};

const DEFAULT_ROYALTIES = [0.1875, 0.20, 0.225, 0.25];

export function LeaseValuationCard({ acres, basin, comparableBonuses, comparableRoyalties }: Props) {
  const bonuses = comparableBonuses ?? (basin ? DEFAULT_BONUSES_BY_BASIN[basin] ?? [] : []);
  const royalties = comparableRoyalties ?? DEFAULT_ROYALTIES;

  const stats = useMemo(() => {
    if (!bonuses.length) return null;
    const sorted = [...bonuses].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    const low = sorted[0] ?? 0;
    const high = sorted[sorted.length - 1] ?? 0;
    return {
      bonusLow: low * acres,
      bonusMedian: median * acres,
      bonusHigh: high * acres,
      royaltyLow: royalties[0] ?? 0,
      royaltyHigh: royalties[royalties.length - 1] ?? 0,
    };
  }, [bonuses, royalties, acres]);

  return (
    <div className="rounded-lg border border-border bg-bg-panel p-4">
      <div className="font-mono text-[10px] uppercase tracking-wider text-text-muted">Lease valuation · {basin ?? 'unspecified basin'}</div>
      <div className="mt-2 grid grid-cols-3 gap-2 font-mono text-xs">
        <div>
          <div className="text-text-muted">Bonus low</div>
          <div className="data-value text-text">{stats ? `$${Math.round(stats.bonusLow).toLocaleString()}` : '—'}</div>
        </div>
        <div>
          <div className="text-text-muted">Bonus median</div>
          <div className="data-value text-accent">{stats ? `$${Math.round(stats.bonusMedian).toLocaleString()}` : '—'}</div>
        </div>
        <div>
          <div className="text-text-muted">Bonus high</div>
          <div className="data-value text-text">{stats ? `$${Math.round(stats.bonusHigh).toLocaleString()}` : '—'}</div>
        </div>
      </div>
      <div className="mt-3 font-mono text-xs text-text-subtle">
        Royalty range: <span className="text-text">{(stats?.royaltyLow ?? 0) * 100}% – {(stats?.royaltyHigh ?? 0) * 100}%</span> · Acreage: <span className="text-text">{acres.toFixed(1)}</span>
      </div>
    </div>
  );
}
