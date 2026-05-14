'use client';

import { useQuery } from '@tanstack/react-query';
import { useMapStore } from '@/stores/map-store';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';

/**
 * Small live-data indicator pinned to the bottom-right of the map. Shows
 * counts for each visible layer + a pulsing dot while queries are in
 * flight. Gives the user immediate feedback even when Overpass is slow.
 */
export function DataStatus() {
  const view = useMapStore((s) => s.view);
  const visibility = useMapStore((s) => s.layerVisibility);
  const filters = useMapStore((s) => s.filters);

  const halfDeg = Math.min(180 / Math.pow(2, view.zoom), 0.5);
  const osmBbox: [number, number, number, number] = [
    Math.round((view.longitude - halfDeg) * 10) / 10,
    Math.round((view.latitude - halfDeg) * 10) / 10,
    Math.round((view.longitude + halfDeg) * 10) / 10,
    Math.round((view.latitude + halfDeg) * 10) / 10,
  ];

  const osmMines = useQuery({
    queryKey: ['layers', 'osm-mines', osmBbox],
    queryFn: () => api.layers.osmFeatures('mining', osmBbox),
    enabled: !!visibility['osm-mines'] && view.zoom >= 5,
    staleTime: 10 * 60 * 1000,
  });
  const osmOil = useQuery({
    queryKey: ['layers', 'osm-oilgas', osmBbox],
    queryFn: () => api.layers.osmFeatures('oilgas', osmBbox),
    enabled: !!visibility['osm-oilgas'] && view.zoom >= 5,
    staleTime: 10 * 60 * 1000,
  });
  const wells = useQuery({
    queryKey: ['layers', 'wells', filters],
    queryFn: () => api.layers.wells({ state: filters.state, county: filters.county, status: filters.status }),
  });
  const claims = useQuery({
    queryKey: ['layers', 'claims', filters],
    queryFn: () => api.layers.claims(filters),
  });

  const anyLoading = osmMines.isLoading || osmOil.isLoading || wells.isLoading || claims.isLoading;

  return (
    <div className="pointer-events-none absolute bottom-10 left-3 z-20 select-none rounded-md border border-border bg-bg-surface/90 px-3 py-2 font-mono text-[11px] text-text-subtle shadow-panel backdrop-blur">
      <div className="mb-1.5 flex items-center gap-2 text-[9px] uppercase tracking-wider text-text-muted">
        <span className={cn('h-1.5 w-1.5 rounded-full', anyLoading ? 'bg-info animate-pulse-glow' : 'bg-success')} />
        Live features
      </div>
      <Row label="OSM mines" q={osmMines} dim={!visibility['osm-mines']} hint={view.zoom < 5 ? 'zoom in (≥5)' : null} />
      <Row label="OSM oil/gas" q={osmOil} dim={!visibility['osm-oilgas']} hint={view.zoom < 5 ? 'zoom in (≥5)' : null} />
      <Row label="State wells" q={wells} dim={!visibility['wells-active']} />
      <Row label="BLM claims" q={claims} dim={!visibility['claims-active']} />
    </div>
  );
}

function Row({
  label,
  q,
  dim,
  hint,
}: {
  label: string;
  q: { isLoading: boolean; isError: boolean; data?: { features: unknown[]; meta?: { unavailable?: string } } };
  dim: boolean;
  hint?: string | null;
}) {
  let value: string;
  if (dim) value = 'off';
  else if (hint) value = hint;
  else if (q.isLoading) value = 'loading…';
  else if (q.isError) value = 'error';
  else if (q.data?.meta?.unavailable) value = 'unavailable';
  else value = `${q.data?.features.length ?? 0}`;

  return (
    <div className={cn('flex items-baseline justify-between gap-4', dim && 'opacity-50')}>
      <span className="text-text-muted">{label}</span>
      <span className={cn('data-value', q.isLoading ? 'text-info' : q.data?.features.length ? 'text-text' : 'text-text-subtle')}>{value}</span>
    </div>
  );
}
