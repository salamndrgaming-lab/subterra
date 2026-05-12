'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useMapStore } from '@/stores/map-store';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';

/**
 * Top-bar search. Hits the API's combined search endpoint, which fans out to
 * Nominatim (places) + BLM claims + state oil/gas FeatureServers + USGS
 * MRDS + PostGIS parcels. Selecting a hit flies the map to its coordinates
 * (and bbox if Nominatim returned one).
 */
export function SearchBox() {
  const setView = useMapStore((s) => s.setView);
  const mapInstance = useMapStore((s) => s.mapInstance);
  const selectFeature = useMapStore((s) => s.selectFeature);

  const [term, setTerm] = useState('');
  const [open, setOpen] = useState(false);
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const id = setTimeout(() => setDebounced(term), 250);
    return () => clearTimeout(id);
  }, [term]);

  const q = useQuery({
    queryKey: ['search', debounced],
    queryFn: () => api.search({ q: debounced, types: 'places,wells,claims,occurrences' }),
    enabled: debounced.length >= 2,
  });

  const choose = (hit: { kind: string; id: string; coordinates?: [number, number]; meta?: Record<string, unknown> }) => {
    setOpen(false);
    setTerm('');
    if (!hit.coordinates) return;
    const [lng, lat] = hit.coordinates;

    if (hit.kind === 'place') {
      const bbox = (hit.meta?.['bbox'] as [number, number, number, number] | null) ?? null;
      if (bbox && mapInstance) {
        mapInstance.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 60, duration: 700 });
      } else if (mapInstance) {
        mapInstance.flyTo({ center: [lng, lat], zoom: 12, duration: 700 });
      } else {
        setView({ longitude: lng, latitude: lat, zoom: 12 });
      }
      return;
    }

    // Feature hits: fly to point and open the right drawer
    if (mapInstance) mapInstance.flyTo({ center: [lng, lat], zoom: 13, duration: 700 });
    else setView({ longitude: lng, latitude: lat, zoom: 13 });

    if (hit.kind === 'well') selectFeature({ kind: 'well', id: hit.id });
    else if (hit.kind === 'claim') selectFeature({ kind: 'claim', id: hit.id });
    else if (hit.kind === 'occurrence') selectFeature({ kind: 'occurrence', id: hit.id });
  };

  return (
    <div className="relative w-full max-w-xl">
      <input
        type="search"
        value={term}
        onChange={(e) => { setTerm(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Search places, wells, claims, MRDS sites…"
        className="h-8 w-full rounded-md border border-border bg-bg-panel pl-9 pr-3 font-mono text-xs text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
      />
      <svg
        aria-hidden
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted"
        width="14" height="14" viewBox="0 0 14 14" fill="none"
      >
        <circle cx="6" cy="6" r="4.25" stroke="currentColor" strokeWidth="1.2" />
        <path d="M9.5 9.5L12 12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      </svg>

      {open && debounced.length >= 2 && (
        <div className="absolute left-0 right-0 top-9 z-40 max-h-[70vh] overflow-y-auto rounded-md border border-border bg-bg-surface/98 shadow-panel backdrop-blur">
          {q.isLoading ? (
            <div className="px-3 py-2 font-mono text-xs text-text-muted">Searching…</div>
          ) : q.data?.results.length ? (
            <ul>
              {q.data.results.map((r, idx) => (
                <li key={`${r.kind}-${r.id}-${idx}`}>
                  <button
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => choose(r)}
                    className={cn('flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition hover:bg-bg-panel/80')}
                  >
                    <div className="min-w-0">
                      <div className="truncate font-mono text-xs text-text">{r.label}</div>
                      {r.subtitle && <div className="truncate font-mono text-[10px] text-text-muted">{r.subtitle}</div>}
                    </div>
                    <KindBadge kind={r.kind} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="px-3 py-2 font-mono text-xs text-text-muted">No matches.</div>
          )}
        </div>
      )}
    </div>
  );
}

function KindBadge({ kind }: { kind: string }) {
  const palette: Record<string, string> = {
    place: 'border-info/30 text-info bg-info/10',
    well: 'border-success/30 text-success bg-success/10',
    claim: 'border-accent/30 text-accent bg-accent/10',
    parcel: 'border-info/30 text-info bg-info/10',
    occurrence: 'border-info/30 text-info bg-info/10',
  };
  return (
    <span className={cn('rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase', palette[kind] ?? 'border-border text-text-subtle')}>
      {kind}
    </span>
  );
}
