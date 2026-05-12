'use client';

import {
  ResponsiveContainer,
  ComposedChart,
  XAxis,
  YAxis,
  Tooltip,
  Bar,
  Line,
  Legend,
  CartesianGrid,
} from 'recharts';
import type { WellProductionMonth } from '@subterra/shared';

interface Props {
  data: WellProductionMonth[];
  height?: number;
}

export function ProductionChart({ data, height = 200 }: Props) {
  const formatted = data.map((m) => ({
    month: m.reportMonth.slice(0, 7),
    oil: m.oilBbl ?? 0,
    gas: (m.gasMcf ?? 0) / 6, // boe-equivalent so axes are comparable
    water: m.waterBbl ?? 0,
  }));

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={formatted} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke="#1e2430" vertical={false} />
        <XAxis dataKey="month" tick={{ fontSize: 10, fill: '#64748b' }} stroke="#1e2430" interval={5} />
        <YAxis tick={{ fontSize: 10, fill: '#64748b' }} stroke="#1e2430" width={48} />
        <Tooltip
          contentStyle={{ backgroundColor: '#161a22', border: '1px solid #1e2430', fontSize: 11 }}
          labelStyle={{ color: '#e2e8f0' }}
          itemStyle={{ color: '#e2e8f0' }}
        />
        <Legend wrapperStyle={{ fontSize: 10, color: '#64748b' }} />
        <Bar dataKey="oil" fill="#10b981" name="Oil (bbl)" />
        <Bar dataKey="gas" fill="#f59e0b" name="Gas (boe)" />
        <Line dataKey="water" stroke="#3b82f6" name="Water (bbl)" dot={false} strokeWidth={1.5} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
