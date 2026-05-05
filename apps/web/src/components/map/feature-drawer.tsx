'use client';

import { useQuery } from '@tanstack/react-query';
import { useMapStore } from '@/stores/map-store';
import { api } from '@/lib/api';
import { ProductionChart } from '@/components/charts/production-chart';
import { DeclineCurveChart } from '@/components/charts/decline-curve-chart';
import { cn } from '@/lib/cn';

export function FeatureDrawer() {
  const selected = useMapStore((s) => s.selected);
  const selectFeature = useMapStore((s) => s.selectFeature);

  if (!selected) return null;

  return (
    <aside className="absolute right-0 top-0 z-20 flex h-full w-[440px] animate-slide-in-right flex-col border-l border-border bg-bg-surface shadow-panel">
      <header className="flex h-10 items-center justify-between border-b border-border px-3">
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-text-muted">
          <span className={cn('h-1.5 w-1.5 rounded-full', kindColor(selected.kind))} />
          {selected.kind} detail
        </div>
        <button
          onClick={() => selectFeature(null)}
          className="rounded-md border border-border bg-bg-panel px-2 py-0.5 font-mono text-[10px] text-text-subtle hover:text-text"
          aria-label="Close drawer"
        >
          Close ✕
        </button>
      </header>
      <div className="flex-1 overflow-y-auto">
        {selected.kind === 'well' && <WellDetail id={selected.id} />}
        {selected.kind === 'claim' && <ClaimDetail id={selected.id} />}
        {selected.kind === 'parcel' && <ParcelDetail id={selected.id} />}
        {selected.kind === 'occurrence' && <OccurrenceDetail id={selected.id} />}
      </div>
    </aside>
  );
}

function kindColor(kind: string): string {
  switch (kind) {
    case 'well': return 'bg-success';
    case 'claim': return 'bg-accent';
    case 'parcel': return 'bg-info';
    case 'occurrence': return 'bg-info';
    default: return 'bg-text-muted';
  }
}

function WellDetail({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['well', id], queryFn: () => api.wells.detail(id) });
  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <ErrorBlock />;

  const { well, production, offsets } = q.data;

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <h2 className="font-display text-lg text-text">{well.wellName ?? well.apiNumber ?? 'Well'}</h2>
        <div className="mt-0.5 font-mono text-xs text-text-subtle">
          {well.operator} · {well.basin} · {well.formation}
        </div>
      </div>

      <KeyValueGrid
        items={[
          ['API #', well.apiNumber ?? '—'],
          ['Status', well.status ?? '—'],
          ['Type', well.wellType ?? '—'],
          ['State / County', `${well.state} · ${well.county ?? '—'}`],
          ['Spud date', well.spudDate ?? '—'],
          ['Completed', well.completionDate ?? '—'],
          ['TVD (ft)', well.trueVerticalDepthFt?.toLocaleString() ?? '—'],
          ['Lateral (ft)', well.lateralLengthFt?.toLocaleString() ?? '—'],
          ['Total depth (ft)', well.totalDepthFt?.toLocaleString() ?? '—'],
          ['PLSS', `T${well.plssTownship ?? '?'} R${well.plssRange ?? '?'} S${well.plssSection ?? '?'}`],
        ]}
      />

      <Section title="Production · last 36 mo">
        <ProductionChart data={production.monthly} />
        <div className="mt-2 grid grid-cols-3 gap-2 font-mono text-[10px] text-text-subtle">
          <Stat label="Cum. oil (bbl)" value={production.cumulative.oilBbl.toLocaleString()} />
          <Stat label="Cum. gas (mcf)" value={production.cumulative.gasMcf.toLocaleString()} />
          <Stat label="Cum. water (bbl)" value={production.cumulative.waterBbl.toLocaleString()} />
        </div>
      </Section>

      <Section title="Decline curve · Arps hyperbolic">
        <DeclineCurveChart data={production.monthly} />
      </Section>

      <Section title={`Offset wells (${offsets.length})`}>
        {offsets.length === 0 ? (
          <div className="font-mono text-xs text-text-muted">No same-formation offsets in mock dataset.</div>
        ) : (
          <ul className="space-y-1.5">
            {offsets.map((o) => (
              <li key={o.id} className="flex items-center justify-between rounded-md border border-border bg-bg-panel px-2 py-1.5 font-mono text-xs">
                <div className="min-w-0">
                  <div className="truncate text-text">{o.wellName ?? '—'}</div>
                  <div className="truncate text-text-muted">{o.operator} · spud {o.spudDate ?? '—'}</div>
                </div>
                <div className="text-text-subtle">{o.lateralLengthFt?.toLocaleString() ?? '—'} ft</div>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function ClaimDetail({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['claim', id], queryFn: () => api.claims.detail(id) });
  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <ErrorBlock />;
  const { claim, nearbyOccurrences, filingHistory } = q.data;

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <h2 className="font-display text-lg text-text">{claim.claimName ?? claim.serialNumber}</h2>
        <div className="mt-0.5 font-mono text-xs text-text-subtle">{claim.serialNumber} · {claim.commodity ?? 'commodity n/a'}</div>
      </div>
      <KeyValueGrid items={[
        ['Type', claim.claimType ?? '—'],
        ['Status', claim.status ?? '—'],
        ['Owner', claim.ownerName ?? '—'],
        ['Address', claim.ownerAddress ?? '—'],
        ['State / County', `${claim.state} · ${claim.county ?? '—'}`],
        ['Acreage', claim.acreage?.toFixed(2) ?? '—'],
        ['Located', claim.locationDate ?? '—'],
        ['Recorded', claim.recordationDate ?? '—'],
        ['Last assess. (FY)', String(claim.lastAssessmentYear ?? '—')],
        ['PLSS', `T${claim.plssTownship ?? '?'} R${claim.plssRange ?? '?'} S${claim.plssSection ?? '?'} · ${claim.meridian ?? '—'}`],
      ]} />

      <Section title="Filing history">
        <ul className="space-y-1.5 font-mono text-xs">
          {filingHistory.map((h, i) => (
            <li key={i} className="rounded-md border border-border bg-bg-panel px-2 py-1.5">
              <div className="text-text">{h.event}</div>
              <div className="text-text-muted">{h.date ?? '—'} · {h.agency ?? '—'}</div>
            </li>
          ))}
        </ul>
      </Section>

      <Section title={`Nearby occurrences (${nearbyOccurrences.length})`}>
        {nearbyOccurrences.length === 0 ? (
          <div className="font-mono text-xs text-text-muted">No MRDS sites within 50 km.</div>
        ) : (
          <ul className="space-y-1.5 font-mono text-xs">
            {nearbyOccurrences.map((m) => (
              <li key={m.id} className="flex items-center justify-between rounded-md border border-border bg-bg-panel px-2 py-1.5">
                <div className="min-w-0">
                  <div className="truncate text-text">{m.siteName ?? '—'}</div>
                  <div className="truncate text-text-muted">{m.primaryCommodity ?? '—'} · {m.depositType ?? '—'}</div>
                </div>
                <div className="text-text-subtle">{m.distanceKm.toFixed(1)} km</div>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function ParcelDetail({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['parcel', id], queryFn: () => api.parcels.detail(id) });
  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <ErrorBlock />;
  const { parcel, activity } = q.data;

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <h2 className="font-display text-lg text-text">Parcel · {parcel.parcelNumber ?? parcel.id.slice(0, 8)}</h2>
        <div className="mt-0.5 font-mono text-xs text-text-subtle">{parcel.state} · {parcel.county}</div>
      </div>
      <KeyValueGrid items={[
        ['Owner', parcel.ownerName ?? '—'],
        ['Acreage', parcel.acreage?.toFixed(2) ?? '—'],
        ['Est. value (USD)', parcel.estimatedValue?.toLocaleString() ?? '—'],
        ['Land use', parcel.landUse ?? '—'],
        ['Surface rights', parcel.surfaceRights ? 'yes' : '—'],
        ['Mineral rights', parcel.mineralRights === null ? 'unknown' : parcel.mineralRights ? 'yes' : 'no'],
        ['Last sale', parcel.lastSaleDate ? `${parcel.lastSaleDate} · $${parcel.lastSalePrice?.toLocaleString() ?? ''}` : '—'],
        ['Legal', parcel.legalDescription ?? '—'],
      ]} />

      <Section title={`Nearby wells (${activity.nearbyWells.length})`}>
        {activity.nearbyWells.length === 0 ? <Empty>None within 10 km.</Empty> : (
          <ul className="space-y-1 font-mono text-xs">
            {activity.nearbyWells.map((w) => (
              <li key={w.id} className="flex justify-between rounded border border-border bg-bg-panel px-2 py-1">
                <span className="truncate text-text">{w.wellName ?? '—'}</span>
                <span className="text-text-subtle">{w.distanceKm} km</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={`Nearby claims (${activity.nearbyClaims.length})`}>
        {activity.nearbyClaims.length === 0 ? <Empty>None within 10 km.</Empty> : (
          <ul className="space-y-1 font-mono text-xs">
            {activity.nearbyClaims.map((c) => (
              <li key={c.id} className="flex justify-between rounded border border-border bg-bg-panel px-2 py-1">
                <span className="truncate text-text">{c.claimName ?? c.serialNumber}</span>
                <span className="text-text-subtle">{c.distanceKm} km</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function OccurrenceDetail({ id }: { id: string }) {
  // Phase 1 stub — Phase 2 wires /api/occurrences/:id.
  return (
    <div className="p-4 font-mono text-xs text-text-subtle">
      Mineral occurrence <span className="text-accent">{id}</span> · detail endpoint pending in Phase 2.
    </div>
  );
}

function KeyValueGrid({ items }: { items: Array<[string, React.ReactNode]> }) {
  return (
    <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 rounded-lg border border-border bg-bg-panel p-3 font-mono text-xs">
      {items.map(([k, v]) => (
        <div key={k} className="flex flex-col">
          <dt className="text-[10px] uppercase tracking-wider text-text-muted">{k}</dt>
          <dd className="data-value text-text">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-text-muted">{title}</div>
      {children}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-bg-panel px-2 py-1.5">
      <div className="text-[10px] uppercase text-text-muted">{label}</div>
      <div className="data-value text-text">{value}</div>
    </div>
  );
}

function Loading() {
  return <div className="p-4 font-mono text-xs text-text-muted">Loading…</div>;
}
function ErrorBlock() {
  return <div className="p-4 font-mono text-xs text-danger">Failed to load. Try again.</div>;
}
function Empty({ children }: { children: React.ReactNode }) {
  return <div className="font-mono text-xs text-text-muted">{children}</div>;
}
