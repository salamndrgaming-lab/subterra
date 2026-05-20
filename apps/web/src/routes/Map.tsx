import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Link } from 'react-router-dom';
import { LAYERS, LAYER_GROUPS } from '@subterra/shared';
import { cn } from '@/lib/cn';

const BASE_STYLE =
  import.meta.env.VITE_MAP_STYLE_URL ?? 'https://tiles.openfreemap.org/styles/dark';

/**
 * Phase 0 map page — boots MapLibre against the free OpenFreeMap dark
 * basemap and renders the layer sidebar derived from the shared layer
 * registry. No vector overlays yet (those arrive in Phase 1 once the
 * ETL publishes a PMTiles file to R2). The map renders correctly even
 * when no tiles are configured — proves the rendering wire is live.
 */
export function MapPage(): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [styleLoaded, setStyleLoaded] = useState(false);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: BASE_STYLE,
      center: [-117.06, 38.66], // Tonopah, NV — a known active mining district
      zoom: 7.5,
      attributionControl: false,
    });

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-left');
    map.addControl(
      new maplibregl.AttributionControl({
        compact: true,
        customAttribution:
          '<a href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a> · © OpenStreetMap',
      }),
      'bottom-right',
    );

    map.on('error', (e) => {
      // eslint-disable-next-line no-console
      console.warn('[maplibre]', e?.error?.message ?? e);
    });

    map.once('load', () => setStyleLoaded(true));

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  return (
    <div className="grid h-full w-full grid-cols-[280px_minmax(0,1fr)] grid-rows-[48px_minmax(0,1fr)] overflow-hidden bg-bg text-text">
      {/* top bar — spans both columns */}
      <header className="col-span-2 flex h-12 items-center justify-between border-b border-border bg-bg-surface px-3">
        <Link to="/" className="flex items-center gap-2 px-1.5">
          <Logo />
          <span className="font-mono text-sm tracking-tight text-text">Subterra</span>
        </Link>

        <div className="flex items-center gap-3 font-mono text-[10px] text-text-muted">
          <span
            className={cn(
              'flex items-center gap-1.5 rounded-md border border-border bg-bg-panel px-2 py-1',
              styleLoaded ? 'text-success' : 'text-accent',
            )}
            data-testid="map-status"
          >
            <span className={cn('h-1.5 w-1.5 rounded-full', styleLoaded ? 'bg-success' : 'bg-accent animate-pulse')} />
            {styleLoaded ? 'basemap loaded' : 'loading…'}
          </span>
          <span className="rounded-md border border-border bg-bg-panel px-2 py-1">Phase 0 · scaffold</span>
        </div>
      </header>

      {/* left sidebar */}
      <aside className="flex h-full min-h-0 flex-col border-r border-border bg-bg-surface">
        <div className="border-b border-border px-4 py-3">
          <div className="font-mono text-[10px] uppercase tracking-wider text-text-muted">Layers</div>
          <div className="mt-1 font-mono text-sm text-text">Map controls</div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {Object.entries(LAYER_GROUPS).map(([group, label]) => {
            const layersInGroup = LAYERS.filter((l) => l.group === group);
            if (layersInGroup.length === 0) return null;
            return (
              <Section key={group} title={label}>
                {layersInGroup.map((l) => (
                  <LayerRow key={l.id} id={l.id} label={l.label} />
                ))}
              </Section>
            );
          })}
        </div>

        <div className="border-t border-border bg-bg px-3 py-2 font-mono text-[10px] leading-relaxed text-text-muted">
          Tiles + features arrive in Phase 1 (next PR).
        </div>
      </aside>

      {/* map canvas */}
      <div className="relative h-full w-full">
        <div ref={containerRef} className="absolute inset-0 h-full w-full" data-testid="map-container" />
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="mb-4">
      <div className="mb-1.5 px-1 font-mono text-[10px] uppercase tracking-wider text-text-muted">
        {title}
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function LayerRow({ id, label }: { id: string; label: string }): JSX.Element {
  return (
    <div
      data-layer-id={id}
      className="flex items-center justify-between gap-2 rounded-md border border-border bg-bg-panel px-2.5 py-1.5 font-mono text-xs text-text-subtle"
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-border-strong" aria-hidden />
        <span className="truncate">{label}</span>
      </span>
      <span className="font-mono text-[9px] uppercase text-text-muted">phase 1</span>
    </div>
  );
}

function Logo(): JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 22 22" fill="none" aria-hidden>
      <path d="M11 2 L20 18 L2 18 Z" stroke="#f59e0b" strokeWidth="1.5" />
      <circle cx="11" cy="11" r="1.2" fill="#f59e0b" />
    </svg>
  );
}
