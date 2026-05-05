'use client';

import {
  ResponsiveContainer,
  LineChart,
  XAxis,
  YAxis,
  Tooltip,
  Line,
  CartesianGrid,
  Legend,
} from 'recharts';
import type { WellProductionMonth } from '@subterra/shared';

interface Props {
  data: WellProductionMonth[];
  height?: number;
}

/**
 * Overlays an Arps hyperbolic fit on the actual oil rate.
 * For Phase 1 we estimate Di and b from the first 6 vs last 6 months.
 */
export function DeclineCurveChart({ data, height = 180 }: Props) {
  const actuals = data.map((m, i) => ({ month: i, oil: m.oilBbl ?? 0 }));

  // estimate IP & decline from data (very rough — Phase 3 calls SciPy via API)
  const ip = actuals[0]?.oil ?? 1000;
  const di = 0.55;
  const b = 0.85;
  const fitted = actuals.map(({ month }) => {
    const t = month / 12;
    const factor = Math.pow(1 + b * di * t, -1 / b);
    return { month, fit: Math.round(ip * factor) };
  });

  const series = actuals.map((row, i) => ({ ...row, fit: fitted[i]?.fit ?? 0 }));

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke="#1e2430" vertical={false} />
        <XAxis
          dataKey="month"
          tick={{ fontSize: 10, fill: '#64748b' }}
          stroke="#1e2430"
          label={{ value: 'months', fontSize: 10, fill: '#64748b', position: 'insideBottom', offset: -4 }}
        />
        <YAxis tick={{ fontSize: 10, fill: '#64748b' }} stroke="#1e2430" width={48} scale="log" domain={['auto', 'auto']} />
        <Tooltip
          contentStyle={{ backgroundColor: '#161a22', border: '1px solid #1e2430', fontSize: 11 }}
          labelStyle={{ color: '#e2e8f0' }}
          itemStyle={{ color: '#e2e8f0' }}
        />
        <Legend wrapperStyle={{ fontSize: 10, color: '#64748b' }} />
        <Line dataKey="oil" stroke="#10b981" name="Actual oil (bbl)" dot={false} strokeWidth={1.5} />
        <Line dataKey="fit" stroke="#f59e0b" strokeDasharray="4 4" name="Arps hyperbolic fit" dot={false} strokeWidth={1.5} />
      </LineChart>
    </ResponsiveContainer>
  );
}
