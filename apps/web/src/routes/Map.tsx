import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { LAYERS, LAYER_GROUPS, type LayerDef, type TileManifest } from '@subterra/shared';
import { cn } from '@/lib/cn';
import { fetchManifest } from '@/lib/manifest';
import { useLayerVisibility } from '@/stores/layers';

const BASE_STYLE =
  import.meta.env.VITE_MAP_STYLE_URL ?? 'https://tiles.openfreemap.org/styles/dark';

/**
 * Map page.
 *
 * Boots a MapLibre canvas, fetches the published tile manifest, and
 * lazily wires every layer from the shared registry against the single
 * PMTiles vector source it points at. Layer visibility flows from the
 * Zustand store; the sidebar toggles only ever flip `layout.visibility`
 * on layers that already exist — no add/remove churn at runtime.
 */
export function MapPage(): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [styleLoaded, setStyleLoaded] = useState(false);
  const visibility = useLayerVisibility((s) => s.visibility);
  const toggle = useLayerVisibility((s) => s.toggle);

  const manifestQuery = useQuery({
    queryKey: ['manifest'],
    queryFn: fetchManifest,
    staleTime: 5 * 60_000,
  });

  // 1. Mount the map exactly once.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: BASE_STYLE,
      center: [-117.06, 38.66],
      zoom: 7.5,
      attributionControl: false,
    });

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-left');
    map.addControl(
      new maplibregl.AttributionControl({
        compact: true,
        customAttribution:
          '<a href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a> · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap</a> · BLM, USGS',
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

  // 2. When the manifest lands, add the pmtiles source + all registry layers.
  useEffect(() => {
    const map = mapRef.current;
    const manifest = manifestQuery.data;
    if (!map || !manifest) return;

    const install = (): void => {
      if (!map.getSource('subterra')) {
        map.addSource('subterra', {
          type: 'vector',
          url: `pmtiles://${manifest.pmtilesUrl}`,
          attribution: 'BLM · USGS · EPA · HIFLD',
        });
      }
      for (const def of LAYERS) {
        if (map.getLayer(def.id)) continue;
        const layer = buildLayer(def, visibility[def.id] ?? def.defaultVisible);
        map.addLayer(layer);
      }
    };
    if (map.isStyleLoaded()) install();
    else map.once('load', install);
  }, [manifestQuery.data]); // visibility tracked separately below

  // 3. Sync visibility — flip `layout.visibility` whenever the user toggles.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = (): void => {
      for (const def of LAYERS) {
        if (!map.getLayer(def.id)) continue;
        map.setLayoutProperty(
          def.id,
          'visibility',
          visibility[def.id] ? 'visible' : 'none',
        );
      }
    };
    if (map.isStyleLoaded()) apply();
    else map.once('load', apply);
  }, [visibility]);

  const claimsLoaded = (manifestQuery.data?.counts.mining_claims ?? 0) > 0;

  return (
    <div className="grid h-full w-full grid-cols-[280px_minmax(0,1fr)] grid-rows-[48px_minmax(0,1fr)] overflow-hidden bg-bg text-text">
      <header className="col-span-2 flex h-12 items-center justify-between border-b border-border bg-bg-surface px-3">
        <Link to="/" className="flex items-center gap-2 px-1.5">
          <Logo />
          <span className="font-mono text-sm tracking-tight text-text">Subterra</span>
        </Link>

        <div className="flex items-center gap-3 font-mono text-[10px]">
          <StatusPill label={styleLoaded ? 'basemap loaded' : 'loading basemap…'} ok={styleLoaded} />
          <StatusPill
            label={
              manifestQuery.isLoading
                ? 'fetching manifest…'
                : manifestQuery.data
                  ? `tiles v${manifestQuery.data.version}`
                  : 'no tiles yet'
            }
            ok={!!manifestQuery.data}
          />
          {manifestQuery.data && (
            <StatusPill
              label={claimsLoaded ? `${manifestQuery.data.counts.mining_claims} claims` : '0 claims'}
              ok={claimsLoaded}
            />
          )}
        </div>
      </header>

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
                  <LayerRow
                    key={l.id}
                    id={l.id}
                    label={l.label}
                    visible={visibility[l.id] ?? false}
                    count={manifestQuery.data?.counts[l.tilesetLayer] ?? 0}
                    onToggle={() => toggle(l.id)}
                  />
                ))}
              </Section>
            );
          })}
        </div>

        {!manifestQuery.data && !manifestQuery.isLoading && (
          <div className="border-t border-border bg-bg px-3 py-2 font-mono text-[10px] leading-relaxed text-text-muted">
            No tiles published yet. Run{' '}
            <code className="rounded bg-bg-panel px-1 text-accent">python etl/refresh.py</code>{' '}
            locally or trigger the ETL workflow in GitHub Actions.
          </div>
        )}
      </aside>

      <div className="relative h-full w-full">
        <div ref={containerRef} className="absolute inset-0 h-full w-full" data-testid="map-container" />
      </div>
    </div>
  );
}

// ─── small components ──────────────────────────────────────────────────

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

function LayerRow({
  id,
  label,
  visible,
  count,
  onToggle,
}: {
  id: string;
  label: string;
  visible: boolean;
  count: number;
  onToggle: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onToggle}
      data-layer-id={id}
      data-visible={visible}
      className={cn(
        'flex w-full items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-left font-mono text-xs transition',
        visible
          ? 'border-accent/40 bg-accent/5 text-text'
          : 'border-border bg-bg-panel text-text-subtle hover:border-border-strong hover:text-text',
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden
          className={cn(
            'h-1.5 w-1.5 shrink-0 rounded-full',
            visible ? 'bg-accent shadow-[0_0_8px_rgba(245,158,11,0.6)]' : 'bg-border-strong',
          )}
        />
        <span className="truncate">{label}</span>
      </span>
      <span className="font-mono text-[10px] text-text-muted">{count > 0 ? count.toLocaleString() : '·'}</span>
    </button>
  );
}

function StatusPill({ label, ok }: { label: string; ok: boolean }): JSX.Element {
  return (
    <span
      data-testid={`pill-${label.split(' ')[0]}`}
      className={cn(
        'flex items-center gap-1.5 rounded-md border bg-bg-panel px-2 py-1',
        ok ? 'border-success/30 text-success' : 'border-border text-text-muted',
      )}
    >
      <span
        aria-hidden
        className={cn('h-1.5 w-1.5 rounded-full', ok ? 'bg-success' : 'bg-text-muted animate-pulse')}
      />
      {label}
    </span>
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

// ─── MapLibre layer factory ────────────────────────────────────────────

/** Build the MapLibre layer spec for a registry entry. One source-layer
 * inside the pmtiles per LayerDef.tilesetLayer. Paint is determined by
 * geometry kind + group — keeps the layer registry the only place styling
 * decisions live. */
function buildLayer(def: LayerDef, defaultVisible: boolean): maplibregl.LayerSpecification {
  const visibility = defaultVisible ? 'visible' : 'none';
  const common = {
    id: def.id,
    source: 'subterra',
    'source-layer': def.tilesetLayer,
    minzoom: def.minZoom,
    layout: { visibility } as { visibility: 'visible' | 'none' },
  };

  if (def.geometry === 'point') {
    return {
      ...common,
      type: 'circle',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 3, 9, 5, 14, 8],
        'circle-color': PAINT_BY_GROUP[def.group].point,
        'circle-stroke-color': '#0a0c10',
        'circle-stroke-width': 1,
        'circle-opacity': 0.9,
      },
    };
  }
  if (def.geometry === 'line') {
    return {
      ...common,
      type: 'line',
      paint: {
        'line-color': PAINT_BY_GROUP[def.group].line,
        'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.6, 12, 1.6],
        'line-opacity': 0.85,
      },
    };
  }
  // polygon
  return {
    ...common,
    type: 'fill',
    paint: {
      'fill-color': PAINT_BY_GROUP[def.group].fill,
      'fill-opacity': 0.22,
      'fill-outline-color': PAINT_BY_GROUP[def.group].line,
    },
  };
}

const PAINT_BY_GROUP: Record<LayerDef['group'], { point: string; line: string; fill: string }> = {
  federal: { point: '#22c55e', line: '#22c55e', fill: '#22c55e' },
  cadastral: { point: '#94a3b8', line: '#94a3b8', fill: '#94a3b8' },
  oilgas: { point: '#10b981', line: '#10b981', fill: '#10b981' },
  mining: { point: '#f59e0b', line: '#f59e0b', fill: '#f59e0b' },
  infrastructure: { point: '#3b82f6', line: '#3b82f6', fill: '#3b82f6' },
};
