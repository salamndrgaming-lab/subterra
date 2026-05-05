'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { COMMODITIES } from '@subterra/shared';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';

type Kind = 'wells' | 'claims' | 'parcels';

interface Props {
  title: React.ReactNode;
  description: string;
  kind: Kind;
}

export function ExploreShell({ title, description, kind }: Props) {
  const [filters, setFilters] = useState<{ state?: string; county?: string; commodity?: string; status?: string }>({});

  const q = useQuery({
    queryKey: ['explore', kind, filters],
    queryFn: () => {
      if (kind === 'wells') return api.layers.wells(filters);
      if (kind === 'claims') return api.layers.claims(filters);
      return api.layers.parcels(filters);
    },
  });

  return (
    <main className="flex-1 overflow-hidden">
      <div className="mx-auto grid h-full max-w-7xl grid-cols-[260px_1fr] gap-4 px-6 py-6">
        <aside className="space-y-3 overflow-y-auto rounded-lg border border-border bg-bg-surface p-3">
          <div>
            <h1 className="font-display text-2xl text-text">{title}</h1>
            <p className="mt-1 text-sm text-text-subtle">{description}</p>
          </div>

          <Field label="State">
            <input
              value={filters.state ?? ''}
              onChange={(e) => setFilters((f) => ({ ...f, state: e.target.value.toUpperCase() || undefined }))}
              placeholder="TX"
              maxLength={2}
              className="w-full rounded border border-border bg-bg-panel px-2 py-1 font-mono text-xs text-text uppercase focus:border-accent focus:outline-none"
            />
          </Field>
          <Field label="County">
            <input
              value={filters.county ?? ''}
              onChange={(e) => setFilters((f) => ({ ...f, county: e.target.value || undefined }))}
              placeholder="Midland"
              className="w-full rounded border border-border bg-bg-panel px-2 py-1 font-mono text-xs text-text focus:border-accent focus:outline-none"
            />
          </Field>
          {kind === 'claims' && (
            <Field label="Commodity">
              <select
                value={filters.commodity ?? ''}
                onChange={(e) => setFilters((f) => ({ ...f, commodity: e.target.value || undefined }))}
                className="w-full rounded border border-border bg-bg-panel px-2 py-1 font-mono text-xs text-text focus:border-accent focus:outline-none"
              >
                <option value="">Any</option>
                {COMMODITIES.map((c) => (<option key={c.id} value={c.id}>{c.label}</option>))}
              </select>
            </Field>
          )}
          {(kind === 'wells' || kind === 'claims') && (
            <Field label="Status">
              <select
                value={filters.status ?? ''}
                onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value || undefined }))}
                className="w-full rounded border border-border bg-bg-panel px-2 py-1 font-mono text-xs text-text focus:border-accent focus:outline-none"
              >
                <option value="">Any</option>
                <option value="active">Active</option>
                <option value="permitted">Permitted</option>
                <option value="plugged">Plugged</option>
                <option value="closed">Closed</option>
              </select>
            </Field>
          )}

          <button
            onClick={() => setFilters({})}
            className="w-full rounded border border-border bg-bg-panel px-2 py-1.5 font-mono text-xs text-text-subtle hover:text-text"
          >
            Clear filters
          </button>

          <Link href="/map" className="block w-full rounded bg-accent px-2 py-1.5 text-center font-mono text-xs text-bg hover:brightness-110">
            View on map →
          </Link>
        </aside>

        <section className="overflow-y-auto rounded-lg border border-border bg-bg-surface">
          <header className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-bg-surface px-3 py-2 font-mono text-xs">
            <span className="text-text-subtle">{q.isLoading ? 'Loading…' : `${q.data?.features.length ?? 0} results`}</span>
            <span className="text-text-muted">Phase 1 · mock data</span>
          </header>
          {q.isLoading ? (
            <div className="p-6 font-mono text-xs text-text-muted">Loading…</div>
          ) : (
            <ul className="divide-y divide-border/60">
              {q.data?.features.map((f) => (
                <ResultRow key={String(f.id)} kind={kind} props={f.properties as Record<string, unknown>} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-text-muted">{label}</span>
      {children}
    </label>
  );
}

function ResultRow({ kind, props }: { kind: Kind; props: Record<string, unknown> }) {
  if (kind === 'wells') {
    const p = props as { id: string; wellName?: string; operator?: string; basin?: string; formation?: string; status?: string; apiNumber?: string; state?: string; county?: string };
    return (
      <li className={cn('flex items-center justify-between gap-3 px-3 py-2.5 font-mono text-xs hover:bg-bg-panel/60')}>
        <div className="min-w-0">
          <div className="truncate text-text">{p.wellName ?? p.apiNumber ?? '—'}</div>
          <div className="truncate text-text-muted">{p.operator} · {p.basin} · {p.formation}</div>
        </div>
        <div className="text-right">
          <div className="text-text-subtle">{p.state} {p.county}</div>
          <div className="text-text-muted">{p.status}</div>
        </div>
      </li>
    );
  }
  if (kind === 'claims') {
    const p = props as { id: string; serialNumber: string; claimName?: string; ownerName?: string; commodity?: string; status?: string; acreage?: number; state?: string; county?: string };
    return (
      <li className="flex items-center justify-between gap-3 px-3 py-2.5 font-mono text-xs hover:bg-bg-panel/60">
        <div className="min-w-0">
          <div className="truncate text-text">{p.claimName ?? p.serialNumber}</div>
          <div className="truncate text-text-muted">{p.serialNumber} · {p.commodity ?? '—'} · {p.ownerName ?? '—'}</div>
        </div>
        <div className="text-right">
          <div className="text-text-subtle">{p.state} {p.county}</div>
          <div className="text-text-muted">{p.acreage?.toFixed(1) ?? '—'} ac · {p.status}</div>
        </div>
      </li>
    );
  }
  const p = props as { id: string; parcelNumber?: string; ownerName?: string; acreage?: number; estimatedValue?: number; state?: string; county?: string };
  return (
    <li className="flex items-center justify-between gap-3 px-3 py-2.5 font-mono text-xs hover:bg-bg-panel/60">
      <div className="min-w-0">
        <div className="truncate text-text">{p.parcelNumber ?? '—'}</div>
        <div className="truncate text-text-muted">{p.ownerName ?? '—'}</div>
      </div>
      <div className="text-right">
        <div className="text-text-subtle">{p.state} {p.county}</div>
        <div className="text-text-muted">{p.acreage?.toFixed(1) ?? '—'} ac · ${p.estimatedValue?.toLocaleString() ?? '—'}</div>
      </div>
    </li>
  );
}
