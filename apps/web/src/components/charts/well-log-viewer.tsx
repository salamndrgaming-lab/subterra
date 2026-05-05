'use client';

import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceArea } from 'recharts';

interface Props {
  /** Depth domain in feet, e.g. [4000, 9500] */
  depth: number[];
  /** Curve readings keyed by mnemonic — common: GR (gamma ray API), RT (resistivity, log scale) */
  curves: Record<string, number[]>;
  /** Optional formation tops to annotate */
  tops?: Array<{ name: string; depth: number }>;
  height?: number;
}

/**
 * Lightweight LAS curve viewer. Phase 3 will swap in a streaming LAS parser.
 */
export function WellLogViewer({ depth, curves, tops, height = 360 }: Props) {
  const data = depth.map((d, i) => {
    const row: Record<string, number> = { depth: d };
    for (const [k, vals] of Object.entries(curves)) row[k] = vals[i] ?? 0;
    return row;
  });

  const gr = curves['GR'] ? 'GR' : Object.keys(curves)[0];
  const rt = curves['RT'] ? 'RT' : Object.keys(curves)[1];

  return (
    <div className="grid grid-cols-2 gap-2 rounded-lg border border-border bg-bg-panel p-2">
      <Track title={`Gamma ray (${gr})`} dataKey={gr} data={data} height={height} stroke="#10b981" tops={tops} />
      <Track title={`Resistivity (${rt})`} dataKey={rt ?? gr} data={data} height={height} stroke="#f59e0b" logScale tops={tops} />
    </div>
  );
}

function Track({
  title,
  dataKey,
  data,
  stroke,
  height,
  logScale,
  tops,
}: {
  title: string;
  dataKey: string | undefined;
  data: Array<Record<string, number>>;
  stroke: string;
  height: number;
  logScale?: boolean;
  tops?: Array<{ name: string; depth: number }>;
}) {
  if (!dataKey) return null;
  return (
    <div>
      <div className="px-1 pb-1 font-mono text-[10px] uppercase tracking-wider text-text-muted">{title}</div>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
          <CartesianGrid stroke="#1e2430" />
          <XAxis
            type="number"
            dataKey={dataKey}
            tick={{ fontSize: 9, fill: '#64748b' }}
            stroke="#1e2430"
            scale={logScale ? 'log' : 'linear'}
            domain={['auto', 'auto']}
            orientation="top"
          />
          <YAxis
            dataKey="depth"
            type="number"
            reversed
            tick={{ fontSize: 9, fill: '#64748b' }}
            stroke="#1e2430"
            width={48}
          />
          <Tooltip
            contentStyle={{ backgroundColor: '#161a22', border: '1px solid #1e2430', fontSize: 11 }}
            labelStyle={{ color: '#e2e8f0' }}
            itemStyle={{ color: '#e2e8f0' }}
          />
          {tops?.map((t) => (
            <ReferenceArea key={t.name} y1={t.depth - 8} y2={t.depth + 8} fill="#3b82f6" fillOpacity={0.18} label={{ value: t.name, fontSize: 9, fill: '#94a3b8' }} />
          ))}
          <Line dataKey={dataKey} stroke={stroke} dot={false} strokeWidth={1} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
