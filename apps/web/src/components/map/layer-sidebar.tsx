'use client';

import { useMemo } from 'react';
import { LAYER_DEFINITIONS, LAYER_GROUPS, COMMODITIES } from '@subterra/shared';
import { useMapStore } from '@/stores/map-store';
import { cn } from '@/lib/cn';

export function LayerSidebar() {
  const sidebarOpen = useMapStore((s) => s.sidebarOpen);
  const layerVisibility = useMapStore((s) => s.layerVisibility);
  const toggleLayer = useMapStore((s) => s.toggleLayer);
  const filters = useMapStore((s) => s.filters);
  const setFilters = useMapStore((s) => s.setFilters);
  const clearFilters = useMapStore((s) => s.clearFilters);

  const grouped = useMemo(() => {
    const map: Record<string, typeof LAYER_DEFINITIONS> = {};
    for (const l of LAYER_DEFINITIONS) {
      const list = (map[l.group] ??= []);
      list.push(l);
    }
    return map;
  }, []);

  if (!sidebarOpen) return <div />;

  return (
    <aside className="flex h-full flex-col border-r border-border bg-bg-surface">
      <div className="border-b border-border px-4 py-3">
        <div className="font-mono text-[10px] uppercase tracking-wider text-text-muted">Layers &amp; filters</div>
        <div className="mt-1 font-display text-sm text-text">Map controls</div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <Section title="Filters">
          <FilterField label="State">
            <select
              value={filters.state ?? ''}
              onChange={(e) => setFilters({ state: e.target.value || undefined })}
              className="w-full rounded-md border border-border bg-bg-panel px-2 py-1 font-mono text-xs text-text focus:border-accent focus:outline-none"
            >
              <option value="">Any</option>
              {US_STATES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </FilterField>
          <FilterField label="County">
            <input
              type="text"
              value={filters.county ?? ''}
              onChange={(e) => setFilters({ county: e.target.value || undefined })}
              placeholder="Midland, Mountrail, ..."
              className="w-full rounded-md border border-border bg-bg-panel px-2 py-1 font-mono text-xs text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
            />
          </FilterField>
          <FilterField label="Commodity">
            <select
              value={filters.commodity ?? ''}
              onChange={(e) => setFilters({ commodity: e.target.value || undefined })}
              className="w-full rounded-md border border-border bg-bg-panel px-2 py-1 font-mono text-xs text-text focus:border-accent focus:outline-none"
            >
              <option value="">Any</option>
              {COMMODITIES.map((c) => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
            </select>
          </FilterField>
          <FilterField label="Status">
            <select
              value={filters.status ?? ''}
              onChange={(e) => setFilters({ status: e.target.value || undefined })}
              className="w-full rounded-md border border-border bg-bg-panel px-2 py-1 font-mono text-xs text-text focus:border-accent focus:outline-none"
            >
              <option value="">Any</option>
              <option value="active">Active</option>
              <option value="permitted">Permitted</option>
              <option value="plugged">Plugged / closed</option>
            </select>
          </FilterField>
          <button
            onClick={clearFilters}
            className="mt-1 w-full rounded-md border border-border bg-bg-panel px-2 py-1.5 font-mono text-xs text-text-subtle hover:border-border-strong hover:text-text"
          >
            Clear filters
          </button>
        </Section>

        {Object.entries(grouped).map(([group, layers]) => (
          <Section key={group} title={LAYER_GROUPS[group as keyof typeof LAYER_GROUPS]}>
            <div className="space-y-1">
              {layers.map((l) => (
                <LayerToggle
                  key={l.id}
                  id={l.id}
                  label={l.label}
                  visible={!!layerVisibility[l.id]}
                  onToggle={() => toggleLayer(l.id)}
                />
              ))}
            </div>
          </Section>
        ))}
      </div>

      <div className="border-t border-border bg-bg p-3 font-mono text-[10px] leading-relaxed text-text-muted">
        Sources: BLM SMA, BLM PLSS, USGS Topo, USGS MRDS · State oil &amp; gas commissions (TX RRC, NDIC, CO ECMC)
      </div>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="mb-1.5 px-1 font-mono text-[10px] uppercase tracking-wider text-text-muted">{title}</div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block font-mono text-[10px] text-text-subtle">{label}</span>
      {children}
    </label>
  );
}

function LayerToggle({
  id,
  label,
  visible,
  onToggle,
}: {
  id: string;
  label: string;
  visible: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        'group flex w-full items-center justify-between rounded-md border px-2.5 py-1.5 text-left transition',
        visible
          ? 'border-accent/40 bg-accent/5 text-text'
          : 'border-border bg-bg-panel text-text-subtle hover:border-border-strong hover:text-text',
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span
          className={cn(
            'h-1.5 w-1.5 shrink-0 rounded-full',
            visible ? 'bg-accent shadow-[0_0_8px_rgba(245,158,11,0.6)]' : 'bg-border-strong',
          )}
          aria-hidden
        />
        <span className="truncate font-mono text-xs" title={label}>
          {label}
        </span>
      </span>
      <span className="font-mono text-[10px] text-text-muted">{id}</span>
    </button>
  );
}

const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA',
  'HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
  'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
  'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY',
];
