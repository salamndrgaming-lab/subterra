import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { LAYERS, LAYER_GROUPS, type LayerDef } from '@subterra/shared';
import { cn } from '@/lib/cn';
import { fetchManifest } from '@/lib/manifest';
import { useLayerVisibility } from '@/stores/layers';
import { geocode, type GeocodeHit } from '@/lib/geocode';

const BASE_STYLE =
  import.meta.env.VITE_MAP_STYLE_URL ?? 'https://tiles.openfreemap.org/styles/dark';

interface SelectedFeature {
  layerId: string;
  layerLabel: string;
  properties: Record<string, unknown>;
  lng: number;
  lat: number;
}

/**
 * Map page.
 *
 * Boots a MapLibre canvas, fetches the published tile manifest, and
 * lazily wires every layer from the shared registry against the single
 * PMTiles vector source it points at. Layer visibility flows from the
 * Zustand store; clicks on rendered features open a detail drawer; the
 * header search box flies to OSM-geocoded places.
 */
export function MapPage() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [styleLoaded, setStyleLoaded] = useState(false);
  const [selected, setSelected] = useState<SelectedFeature | null>(null);
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
      console.warn('[maplibre]', e?.error?.message ?? e);
    });
    map.once('load', () => setStyleLoaded(true));

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // 2. When the manifest lands, add the pmtiles source + all registry layers,
  //    plus click/hover handlers that open the detail drawer.
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
        map.on('mouseenter', def.id, () => {
          map.getCanvas().style.cursor = 'pointer';
        });
        map.on('mouseleave', def.id, () => {
          map.getCanvas().style.cursor = '';
        });
      }

      map.on('click', (e) => {
        const liveLayerIds = LAYERS.map((l) => l.id).filter((id) => !!map.getLayer(id));
        const hits = map.queryRenderedFeatures(e.point, { layers: liveLayerIds });
        if (hits.length === 0) {
          setSelected(null);
          return;
        }
        const f = hits[0]!;
        const def = LAYERS.find((l) => l.id === f.layer.id);
        const point =
          f.geometry.type === 'Point'
            ? (f.geometry.coordinates as [number, number])
            : ([e.lngLat.lng, e.lngLat.lat] as [number, number]);
        setSelected({
          layerId: f.layer.id,
          layerLabel: def?.label ?? f.layer.id,
          properties: (f.properties ?? {}) as Record<string, unknown>,
          lng: point[0],
          lat: point[1],
        });
      });
    };
    if (map.isStyleLoaded()) install();
    else map.once('load', install);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- visibility is synced by a separate effect below; including it here would cause unnecessary re-installs of every layer on every toggle.
  }, [manifestQuery.data]);

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

  function flyTo(hit: GeocodeHit): void {
    const map = mapRef.current;
    if (!map) return;
    if (hit.bbox) {
      map.fitBounds(
        [
          [hit.bbox[0], hit.bbox[1]],
          [hit.bbox[2], hit.bbox[3]],
        ],
        { padding: 60, duration: 1200, maxZoom: 11 },
      );
    } else {
      map.flyTo({ center: [hit.lng, hit.lat], zoom: 10, duration: 1200 });
    }
  }

  return (
    <div className="grid h-full w-full grid-cols-[280px_minmax(0,1fr)] grid-rows-[48px_minmax(0,1fr)] overflow-hidden bg-bg text-text">
      <header className="col-span-2 flex h-12 items-center justify-between gap-3 border-b border-border bg-bg-surface px-3">
        <Link to="/" className="flex items-center gap-2 px-1.5">
          <Logo />
          <span className="font-mono text-sm tracking-tight text-text">Subterra</span>
        </Link>

        <SearchBox onPick={flyTo} />

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
        {selected && <DetailDrawer feature={selected} onClose={() => setSelected(null)} />}
      </div>
    </div>
  );
}

// ─── small components ──────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
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
}) {
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

function StatusPill({ label, ok }: { label: string; ok: boolean }) {
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

function Logo() {
  return (
    <svg width="18" height="18" viewBox="0 0 22 22" fill="none" aria-hidden>
      <path d="M11 2 L20 18 L2 18 Z" stroke="#f59e0b" strokeWidth="1.5" />
      <circle cx="11" cy="11" r="1.2" fill="#f59e0b" />
    </svg>
  );
}

// ─── Search box ────────────────────────────────────────────────────────

function SearchBox({ onPick }: { onPick: (h: GeocodeHit) => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<GeocodeHit[] | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!q.trim()) return;
    setLoading(true);
    try {
      const results = await geocode(q);
      setHits(results);
      setOpen(true);
      if (results.length === 1) {
        onPick(results[0]!);
        setOpen(false);
      }
    } catch (err) {
      console.warn('[geocode]', err);
      setHits([]);
      setOpen(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="relative flex flex-1 max-w-md items-center">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => hits && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Search place (e.g. Tonopah, NV)…"
        data-testid="search-input"
        className="w-full rounded-md border border-border bg-bg-panel px-3 py-1.5 font-mono text-xs text-text placeholder:text-text-muted focus:border-accent/60 focus:outline-none"
      />
      {loading && (
        <span className="absolute right-2 font-mono text-[10px] text-text-muted">…</span>
      )}
      {open && hits && (
        <ul
          data-testid="search-results"
          className="absolute left-0 right-0 top-[calc(100%+4px)] z-20 max-h-80 overflow-y-auto rounded-md border border-border bg-bg-surface shadow-xl"
        >
          {hits.length === 0 ? (
            <li className="px-3 py-2 font-mono text-[11px] text-text-muted">No results.</li>
          ) : (
            hits.map((h) => (
              <li key={`${h.lat},${h.lng}`}>
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault(); // keep input focus, avoid blur race
                    onPick(h);
                    setOpen(false);
                  }}
                  className="block w-full truncate px-3 py-2 text-left font-mono text-[11px] text-text hover:bg-bg-panel"
                  title={h.display}
                >
                  {h.display}
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </form>
  );
}

// ─── Detail drawer ─────────────────────────────────────────────────────

const PROPERTY_LABELS: Record<string, string> = {
  mrds_id: 'MRDS ID',
  name: 'Name',
  state: 'State',
  county: 'County',
  commodity: 'Commodity',
  deposit_type: 'Deposit type',
  development_status: 'Development status',
  discovery_year: 'Discovery year',
  serial: 'Serial #',
  claim_type: 'Claim type',
  status: 'Status',
  owner: 'Owner',
  acreage: 'Acreage',
  located_at: 'Located',
  recorded_at: 'Recorded',
};

function DetailDrawer({
  feature,
  onClose,
}: {
  feature: SelectedFeature;
  onClose: () => void;
}) {
  const entries = Object.entries(feature.properties).filter(
    ([, v]) => v !== null && v !== '' && v !== undefined,
  );
  const headline =
    (feature.properties.name as string | undefined) ||
    (feature.properties.serial as string | undefined) ||
    feature.layerLabel;
  return (
    <aside
      data-testid="detail-drawer"
      className="absolute right-3 top-3 bottom-3 z-10 flex w-[360px] flex-col rounded-lg border border-border bg-bg-surface/95 shadow-2xl backdrop-blur"
    >
      <header className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <div className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
            {feature.layerLabel}
          </div>
          <div className="mt-0.5 truncate font-mono text-sm text-text" title={headline}>
            {headline || '(unnamed)'}
          </div>
          <div className="mt-0.5 font-mono text-[10px] text-text-muted">
            {feature.lat.toFixed(5)}, {feature.lng.toFixed(5)}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded-md border border-border bg-bg-panel px-2 py-1 font-mono text-[10px] text-text-muted hover:text-text"
        >
          ✕
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        <dl className="grid grid-cols-[120px_minmax(0,1fr)] gap-y-1 font-mono text-[11px]">
          {entries.map(([key, value]) => (
            <Row key={key} label={PROPERTY_LABELS[key] ?? key} value={value} />
          ))}
        </dl>
      </div>

      <footer className="flex items-center justify-between gap-2 border-t border-border px-4 py-2 font-mono text-[10px] text-text-muted">
        <a
          href={`https://www.google.com/maps?q=${feature.lat},${feature.lng}`}
          target="_blank"
          rel="noreferrer"
          className="text-accent hover:underline"
        >
          Open in Google Maps ↗
        </a>
        <span>Click another point to inspect</span>
      </footer>
    </aside>
  );
}

function Row({ label, value }: { label: string; value: unknown }) {
  return (
    <>
      <dt className="truncate text-text-muted" title={label}>{label}</dt>
      <dd className="truncate text-text" title={String(value)}>{String(value)}</dd>
    </>
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
