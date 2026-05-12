'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useMapStore } from '@/stores/map-store';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';

type Tab = 'wells' | 'claims' | 'occurrences';

export function BottomPanel() {
  const { bottomPanelOpen, setBottomPanelOpen, filters, selectFeature } = useMapStore();
  const [tab, setTab] = useTabState();

  return (
    <section className="border-t border-border bg-bg-surface">
      <header className="flex h-9 items-center justify-between border-b border-border px-3">
        <div className="flex items-center gap-1">
          <TabButton active={tab === 'wells'} onClick={() => setTab('wells')}>Wells</TabButton>
          <TabButton active={tab === 'claims'} onClick={() => setTab('claims')}>Claims</TabButton>
          <TabButton active={tab === 'occurrences'} onClick={() => setTab('occurrences')}>Occurrences</TabButton>
        </div>
        <button
          onClick={() => setBottomPanelOpen(!bottomPanelOpen)}
          className="rounded-md border border-border bg-bg-panel px-2 py-0.5 font-mono text-[10px] text-text-subtle hover:text-text"
        >
          {bottomPanelOpen ? 'Collapse ↓' : 'Expand ↑'}
        </button>
      </header>

      {bottomPanelOpen && (
        <div className="h-[calc(280px-36px)] overflow-auto">
          {tab === 'wells' && <WellsTable filters={filters} onSelect={(id) => selectFeature({ kind: 'well', id })} />}
          {tab === 'claims' && <ClaimsTable filters={filters} onSelect={(id) => selectFeature({ kind: 'claim', id })} />}
          {tab === 'occurrences' && <OccurrencesTable filters={filters} onSelect={(id) => selectFeature({ kind: 'occurrence', id })} />}
        </div>
      )}
    </section>
  );
}

function useTabState() {
  const [state, setState] = useState<Tab>('wells');
  return [state, setState] as const;
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'rounded-md px-3 py-1 font-mono text-xs transition',
        active ? 'bg-bg-panel text-text border border-border' : 'text-text-subtle hover:text-text',
      )}
    >
      {children}
    </button>
  );
}

function WellsTable({
  filters,
  onSelect,
}: {
  filters: { state?: string; county?: string; status?: string };
  onSelect: (id: string) => void;
}) {
  const q = useQuery({
    queryKey: ['bp-wells', filters],
    queryFn: () => api.layers.wells({ state: filters.state, county: filters.county, status: filters.status }),
  });

  if (q.isLoading) return <Empty>Loading wells…</Empty>;
  const meta = (q.data as unknown as { meta?: { unavailableStates?: string[]; sources?: string[] } })?.meta;
  if (!q.data?.features.length) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center font-mono text-xs text-text-muted">
        <span>No wells match the current filters.</span>
        {meta?.unavailableStates?.length ? (
          <span>States without a public spatial endpoint: {meta.unavailableStates.join(', ')}</span>
        ) : null}
      </div>
    );
  }

  return (
    <Table
      headers={['Well', 'Operator', 'API #', 'State', 'County', 'Status', 'Spud', 'Total depth (ft)']}
      rows={q.data.features.map((f, idx) => {
        const p = f.properties as {
          wellName: string | null;
          operator: string | null;
          apiNumber: string | null;
          state: string | null;
          county: string | null;
          status: string | null;
          spudDate: string | null;
          totalDepthFt: number | null;
        };
        return {
          id: p.apiNumber ?? `well-${idx}`,
          cells: [
            p.wellName ?? '—',
            p.operator ?? '—',
            p.apiNumber ?? '—',
            p.state ?? '—',
            p.county ?? '—',
            <StatusPill key="s" status={p.status} />,
            p.spudDate ?? '—',
            p.totalDepthFt ? p.totalDepthFt.toLocaleString() : '—',
          ],
        };
      })}
      onSelect={onSelect}
    />
  );
}

function ClaimsTable({
  filters,
  onSelect,
}: {
  filters: { state?: string; county?: string; status?: string; commodity?: string };
  onSelect: (id: string) => void;
}) {
  const q = useQuery({
    queryKey: ['bp-claims', filters],
    queryFn: () => api.layers.claims(filters),
  });
  if (q.isLoading) return <Empty>Loading claims…</Empty>;
  if (!q.data?.features.length) return <Empty>No claims match the current filters.</Empty>;

  return (
    <Table
      headers={['Serial', 'Claim', 'Owner', 'Commodity', 'Status', 'Acres', 'Located', 'Last assess.']}
      rows={q.data.features.map((f, idx) => {
        const p = f.properties as {
          serialNumber: string;
          claimName: string | null;
          ownerName: string | null;
          commodity: string | null;
          status: string | null;
          acreage: number | null;
          locationDate: string | null;
          lastAssessmentYear: number | null;
        };
        return {
          id: p.serialNumber ?? `claim-${idx}`,
          cells: [
            p.serialNumber,
            p.claimName ?? '—',
            p.ownerName ?? '—',
            p.commodity ?? '—',
            <StatusPill key="s" status={p.status} />,
            p.acreage?.toFixed(1) ?? '—',
            p.locationDate ?? '—',
            p.lastAssessmentYear ?? '—',
          ],
        };
      })}
      onSelect={onSelect}
    />
  );
}

function OccurrencesTable({
  filters,
  onSelect,
}: {
  filters: { state?: string; commodity?: string };
  onSelect: (id: string) => void;
}) {
  const q = useQuery({
    queryKey: ['bp-occ', filters],
    queryFn: () => api.layers.mineralOccurrences(filters),
  });
  if (q.isLoading) return <Empty>Loading occurrences…</Empty>;
  if (!q.data?.features.length) return <Empty>No mineral occurrences in view.</Empty>;

  return (
    <Table
      headers={['Site', 'MRDS', 'State', 'County', 'Commodity', 'Type', 'Status', 'Discovered']}
      rows={q.data.features.map((f, idx) => {
        const p = f.properties as {
          mrdsId: string;
          siteName: string | null;
          state: string | null;
          county: string | null;
          primaryCommodity: string | null;
          depositType: string | null;
          developmentStatus: string | null;
          discoveryYear: number | null;
        };
        return {
          id: p.mrdsId ?? `mrds-${idx}`,
          cells: [
            p.siteName ?? '—',
            p.mrdsId ?? '—',
            p.state ?? '—',
            p.county ?? '—',
            p.primaryCommodity ?? '—',
            p.depositType ?? '—',
            <StatusPill key="s" status={p.developmentStatus} />,
            p.discoveryYear ?? '—',
          ],
        };
      })}
      onSelect={onSelect}
    />
  );
}

function Table({
  headers,
  rows,
  onSelect,
}: {
  headers: string[];
  rows: { id: string; cells: React.ReactNode[] }[];
  onSelect: (id: string) => void;
}) {
  return (
    <table className="w-full border-collapse font-mono text-xs">
      <thead className="sticky top-0 bg-bg-surface">
        <tr className="border-b border-border">
          {headers.map((h) => (
            <th key={h} className="whitespace-nowrap px-3 py-2 text-left text-[10px] uppercase tracking-wider text-text-muted">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr
            key={r.id}
            onClick={() => onSelect(r.id)}
            className="cursor-pointer border-b border-border/60 transition hover:bg-bg-panel/60"
          >
            {r.cells.map((c, i) => (
              <td key={i} className="whitespace-nowrap px-3 py-2 text-text">
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function StatusPill({ status }: { status: string | null }) {
  if (!status) return <span className="text-text-muted">—</span>;
  const palette: Record<string, string> = {
    active: 'bg-success/15 text-success border-success/30',
    permitted: 'bg-accent/15 text-accent border-accent/30',
    plugged: 'bg-text-muted/15 text-text-muted border-border-strong',
    closed: 'bg-text-muted/15 text-text-muted border-border-strong',
    producer: 'bg-success/15 text-success border-success/30',
    past_producer: 'bg-info/15 text-info border-info/30',
    prospect: 'bg-accent/15 text-accent border-accent/30',
    occurrence: 'bg-text-muted/15 text-text-muted border-border-strong',
  };
  return (
    <span className={cn('rounded-full border px-2 py-0.5 text-[10px] uppercase', palette[status] ?? 'border-border text-text-subtle')}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center font-mono text-xs text-text-muted">{children}</div>;
}
