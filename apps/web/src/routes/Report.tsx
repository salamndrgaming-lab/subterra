/** Public prospect report — read-only view of a shared AOI summary at
 *  /r/:token. No auth, no map tiles; renders the snapshot the sharer
 *  captured. Doubles as a marketing surface (CTA back to the app). */

import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import { fetchShare, type SharePayload } from '@/lib/shares';

const CATEGORY_LABEL: Record<string, string> = {
  precious: 'Precious',
  critical: 'Critical',
  base: 'Base',
  energy: 'Energy',
  industrial: 'Industrial',
  unknown: 'Other',
};
const CATEGORY_COLOR: Record<string, string> = {
  precious: '#fbbf24',
  critical: '#f472b6',
  base: '#60a5fa',
  energy: '#a3e635',
  industrial: '#94a3b8',
  unknown: '#64748b',
};

export function ReportPage() {
  const { token = '' } = useParams();
  const q = useQuery({
    queryKey: ['share', token],
    queryFn: () => fetchShare(token),
    retry: 0,
  });

  return (
    <div className="min-h-screen bg-bg p-6 text-text">
      <div className="mx-auto max-w-2xl">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[11px] uppercase tracking-wider text-accent">
            Subterra · Prospect report
          </span>
          <Link
            to="/map"
            className="rounded border border-border px-3 py-1 font-mono text-[11px] text-text-muted hover:text-text"
          >
            Open the map →
          </Link>
        </div>

        {q.isLoading && (
          <div className="mt-10 font-mono text-[12px] text-text-muted">Loading report…</div>
        )}
        {q.isError && (
          <div className="mt-10 rounded-lg border border-border bg-bg-surface p-6 text-center font-mono text-[12px] text-text-muted">
            This report link is invalid or has been removed.
          </div>
        )}
        {q.data && <ReportBody title={q.data.title} payload={q.data.payload} />}
      </div>
    </div>
  );
}

function ReportBody({ title, payload }: { title: string; payload: SharePayload | null }) {
  if (!payload) {
    return (
      <div className="mt-10 font-mono text-[12px] text-text-muted">Report data unavailable.</div>
    );
  }
  const totalCommodity = Object.values(payload.mrdsByCategory ?? {}).reduce((a, b) => a + b, 0);
  const cats = Object.entries(payload.mrdsByCategory ?? {})
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);

  const stat = (label: string, value: string, tone = 'text-text') => (
    <div className="rounded-lg border border-border bg-bg-surface p-4">
      <div className="font-mono text-[10px] uppercase tracking-wider text-text-muted">{label}</div>
      <div className={`mt-1 font-mono text-xl ${tone}`}>{value}</div>
    </div>
  );

  return (
    <div className="mt-4">
      <h1 className="font-mono text-2xl text-text">{title}</h1>
      <div className="mt-1 font-mono text-[11px] text-text-muted">
        {payload.centroid[1].toFixed(4)}°, {payload.centroid[0].toFixed(4)}° ·{' '}
        {payload.acres.toLocaleString(undefined, { maximumFractionDigits: 0 })} acres
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {stat('Area', `${payload.acres.toLocaleString(undefined, { maximumFractionDigits: 0 })} ac`)}
        {stat('Mineral occurrences', payload.mrdsInside.toLocaleString())}
        {stat(
          'Active claims',
          payload.claimsInside.toLocaleString(),
          payload.claimsInside === 0 ? 'text-lime-400' : 'text-amber-400',
        )}
        {stat('Claims to stake', `${payload.lodeClaims.toLocaleString()} × 20 ac`)}
        {stat(
          'Year-1 cost',
          `$${payload.year1CostLow.toLocaleString()}–${payload.year1CostHigh.toLocaleString()}`,
        )}
        {stat('Annual maint.', `$${payload.annualCost.toLocaleString()}/yr`)}
      </div>

      {cats.length > 0 && (
        <div className="mt-6">
          <div className="font-mono text-[11px] uppercase tracking-wider text-text-muted">
            Commodity mix
          </div>
          <div className="mt-2 flex h-3 w-full overflow-hidden rounded">
            {cats.map(([cat, n]) => (
              <div
                key={cat}
                title={`${CATEGORY_LABEL[cat] ?? cat}: ${n}`}
                style={{
                  width: `${(100 * n) / totalCommodity}%`,
                  backgroundColor: CATEGORY_COLOR[cat] ?? '#64748b',
                }}
              />
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px]">
            {cats.map(([cat, n]) => (
              <span key={cat} className="flex items-center gap-1.5 text-text">
                <span
                  aria-hidden
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: CATEGORY_COLOR[cat] ?? '#64748b' }}
                />
                {CATEGORY_LABEL[cat] ?? cat}
                <span className="text-text-muted">
                  {Math.round((100 * n) / totalCommodity)}%
                </span>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="mt-8 rounded-lg border border-accent/30 bg-accent/5 p-5 text-center">
        <div className="font-mono text-[13px] text-text">
          Explore this area — and stake-ability, geology, and cost anywhere in the West.
        </div>
        <Link
          to="/map"
          className="mt-3 inline-block rounded border border-accent bg-accent/10 px-4 py-2 font-mono text-[12px] text-accent hover:bg-accent/20"
        >
          Open Subterra
        </Link>
      </div>

      <div className="mt-4 font-mono text-[9px] leading-relaxed text-text-muted">
        Snapshot at share time · counts reflect data rendered at the sharer&rsquo;s zoom · cost
        estimates per 43 CFR 3833 + industry ranges. Not legal or investment advice.
      </div>
    </div>
  );
}
