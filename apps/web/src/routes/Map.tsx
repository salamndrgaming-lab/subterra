import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { COMMODITIES, COMMODITY_CATEGORY_COLORS, LAYERS, LAYER_GROUPS, type LayerDef } from '@subterra/shared';
import { cn } from '@/lib/cn';
import { fetchManifest } from '@/lib/manifest';
import { useLayerVisibility } from '@/stores/layers';
import { geocode, type GeocodeHit } from '@/lib/geocode';
import { pointInPolygon, polygonAreaAcres, ringBbox, type LngLat } from '@/lib/geo';

/** Primary vector basemap (OpenFreeMap dark). If this URL ever 403s or
 *  fails to fetch (CDN outage, blocking, etc.) the map falls back to the
 *  inline OSM raster style below — never depends on a third-party style
 *  server staying up. */
const PRIMARY_STYLE =
  import.meta.env.VITE_MAP_STYLE_URL ?? 'https://tiles.openfreemap.org/styles/dark';

/** Fallback basemap: inline MapLibre style spec backed by CartoDB Dark
 *  Matter raster tiles. Used by 1M+ websites, permissive CORS, no key,
 *  no rate limit for public use. Looks like a dark-themed map matching
 *  our color scheme. */
const FALLBACK_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    basemap: {
      type: 'raster',
      tiles: [
        'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
        'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
        'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
        'https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
      ],
      tileSize: 256,
      attribution:
        '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
      maxzoom: 19,
    },
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#0a0c10' } },
    { id: 'basemap', type: 'raster', source: 'basemap' },
  ],
};

interface SelectedFeature {
  layerId: string;
  layerLabel: string;
  properties: Record<string, unknown>;
  lng: number;
  lat: number;
  /** Active BLM mining claims that cover this point (other than the
   *  feature itself, if a claim was the click target). Empty array means
   *  the point is open ground for staking purposes. */
  overlappingClaims: Array<{ serial: string; claimant: string; acreage: string }>;
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
  const [mapError, setMapError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SelectedFeature | null>(null);
  const [commodityFilter, setCommodityFilter] = useState<Set<string>>(new Set());
  const [drawMode, setDrawMode] = useState<'off' | 'drawing' | 'done'>('off');
  const [aoiVertices, setAoiVertices] = useState<LngLat[]>([]);
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
      style: PRIMARY_STYLE,
      center: [-117.06, 38.66],
      zoom: 7.5,
      attributionControl: false,
    });

    // If the primary style fails to fetch (OpenFreeMap CDN outage,
    // upstream 403, network block, etc.), swap to the inline OSM
    // raster fallback within a few seconds so the user never sees a
    // permanent black screen.
    let primaryLoaded = false;
    map.once('load', () => {
      console.info('[basemap] primary loaded');
      primaryLoaded = true;
    });
    setTimeout(() => {
      if (primaryLoaded) return;
      console.warn('[basemap] primary style timed out, swapping to CartoDB fallback');
      try {
        map.setStyle(FALLBACK_STYLE);
        setMapError((prev) => prev ?? 'Primary basemap unreachable — using CartoDB fallback');
      } catch (err) {
        console.error('[basemap] fallback setStyle failed', err);
      }
    }, 4000);

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
      const err = e?.error ?? e;
      const errAny = err as { message?: string; url?: string; status?: number };
      const url = errAny.url;
      const status = errAny.status;
      const msg = errAny.message ?? String(err);
      const full = [msg, url && `url=${url}`, status && `status=${status}`]
        .filter(Boolean)
        .join(' · ');
      console.warn('[maplibre]', full);
      if (!/Source image could not be decoded|HTTPError.*404/i.test(msg)) {
        setMapError((prev) => prev ?? full);
      }
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

        // Stake-ability: collect every active claim polygon at this point
        // other than (if applicable) the one that was clicked. Used in the
        // detail drawer's "Stake-ability" section.
        const claimHits = map.getLayer('mining-claims')
          ? map.queryRenderedFeatures(e.point, { layers: ['mining-claims'] })
          : [];
        const selfSerial = f.layer.id === 'mining-claims' ? f.properties?.serial : undefined;
        const seen = new Set<string>();
        const overlappingClaims = claimHits
          .filter((h) => {
            const s = String(h.properties?.serial ?? '');
            if (!s) return false;
            if (selfSerial && s === String(selfSerial)) return false;
            if (seen.has(s)) return false;
            seen.add(s);
            return true;
          })
          .slice(0, 8)
          .map((h) => ({
            serial: String(h.properties?.serial ?? ''),
            claimant: String(h.properties?.claimant ?? ''),
            acreage: String(h.properties?.acreage ?? ''),
          }));

        setSelected({
          layerId: f.layer.id,
          layerLabel: def?.label ?? f.layer.id,
          properties: (f.properties ?? {}) as Record<string, unknown>,
          lng: point[0],
          lat: point[1],
          overlappingClaims,
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

  // 4. Sync commodity filter — applied as a MapLibre filter on the MRDS
  //    layer (case-insensitive substring match per selected commodity).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getLayer('mrds')) return;
    if (commodityFilter.size === 0) {
      map.setFilter('mrds', null);
      return;
    }
    // MapLibre filter: OR across substring matches on the commodity property.
    const subFilters = Array.from(commodityFilter).map((label) => [
      'in',
      label,
      ['get', 'commodity'],
    ]);
    map.setFilter('mrds', ['any', ...subFilters] as maplibregl.FilterSpecification);
  }, [commodityFilter, manifestQuery.data]);

  // 5. Drawing: maintain temporary GeoJSON sources for vertices, the
  //    in-progress polyline, and the finished polygon. Wire click + dblclick
  //    handlers only while drawMode is active so normal clicks pass through.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const ensureAoiLayers = (): void => {
      if (!map.getSource('aoi')) {
        map.addSource('aoi', { type: 'geojson', data: emptyFC() });
        map.addLayer({
          id: 'aoi-fill',
          source: 'aoi',
          type: 'fill',
          filter: ['==', ['geometry-type'], 'Polygon'],
          paint: { 'fill-color': '#a3e635', 'fill-opacity': 0.18 },
        });
        map.addLayer({
          id: 'aoi-line',
          source: 'aoi',
          type: 'line',
          filter: ['!=', ['geometry-type'], 'Point'],
          paint: { 'line-color': '#a3e635', 'line-width': 2 },
        });
        map.addLayer({
          id: 'aoi-vertex',
          source: 'aoi',
          type: 'circle',
          filter: ['==', ['geometry-type'], 'Point'],
          paint: {
            'circle-radius': 4,
            'circle-color': '#a3e635',
            'circle-stroke-color': '#0a0c10',
            'circle-stroke-width': 1.5,
          },
        });
      }
    };
    if (map.isStyleLoaded()) ensureAoiLayers();
    else map.once('load', ensureAoiLayers);

    const onClick = (e: maplibregl.MapMouseEvent): void => {
      if (drawMode !== 'drawing') return;
      // While drawing, suppress the feature-pick click handler entirely.
      e.preventDefault?.();
      setAoiVertices((prev) => [...prev, [e.lngLat.lng, e.lngLat.lat]]);
    };
    const onDblClick = (e: maplibregl.MapMouseEvent): void => {
      if (drawMode !== 'drawing') return;
      e.preventDefault();
      if (aoiVertices.length < 3) return; // need a real polygon
      setDrawMode('done');
    };
    const onKey = (e: KeyboardEvent): void => {
      if (drawMode === 'drawing' && e.key === 'Escape') {
        setAoiVertices([]);
        setDrawMode('off');
      }
    };

    map.on('click', onClick);
    map.on('dblclick', onDblClick);
    document.addEventListener('keydown', onKey);

    // Disable native double-click-zoom while drawing so a final dblclick
    // finishes the polygon instead of zooming.
    if (drawMode === 'drawing') map.doubleClickZoom.disable();
    else map.doubleClickZoom.enable();

    // Cursor cue.
    map.getCanvas().style.cursor = drawMode === 'drawing' ? 'crosshair' : '';

    return () => {
      map.off('click', onClick);
      map.off('dblclick', onDblClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [drawMode, aoiVertices.length]);

  // 6. Push the current vertex list into the aoi source on every change.
  useEffect(() => {
    const map = mapRef.current;
    const src = map?.getSource('aoi') as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    src.setData(aoiGeoJson(aoiVertices, drawMode));
  }, [aoiVertices, drawMode]);

  // AOI summary: compute counts/area whenever the polygon finalizes.
  const aoiSummary = useMemo(() => {
    if (drawMode !== 'done' || aoiVertices.length < 3) return null;
    return computeAoiSummary(mapRef.current, aoiVertices);
  }, [drawMode, aoiVertices]);

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

        <CommodityFilter selected={commodityFilter} onChange={setCommodityFilter} />

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
                    color={l.color ?? '#94a3b8'}
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
        {mapError && (
          <div
            data-testid="map-error-banner"
            className="absolute left-1/2 top-3 z-20 max-w-2xl -translate-x-1/2 rounded-md border border-red-500/60 bg-red-500/10 px-3 py-2 font-mono text-[11px] text-red-300 shadow-xl backdrop-blur"
          >
            <span className="font-semibold">map error:</span> {mapError}
            <button
              type="button"
              onClick={() => setMapError(null)}
              className="ml-3 text-text-muted hover:text-text"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        )}
        <Legend mrdsVisible={visibility['mrds'] ?? true} />
        <AoiControls
          mode={drawMode}
          vertexCount={aoiVertices.length}
          onStart={() => {
            setSelected(null);
            setAoiVertices([]);
            setDrawMode('drawing');
          }}
          onFinish={() => aoiVertices.length >= 3 && setDrawMode('done')}
          onClear={() => {
            setAoiVertices([]);
            setDrawMode('off');
          }}
        />
        {aoiSummary && <AoiPanel summary={aoiSummary} onClose={() => { setAoiVertices([]); setDrawMode('off'); }} />}
        {selected && !aoiSummary && <DetailDrawer feature={selected} onClose={() => setSelected(null)} />}
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
  color,
  visible,
  count,
  onToggle,
}: {
  id: string;
  label: string;
  color: string;
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
          ? 'bg-bg-panel text-text'
          : 'border-border bg-bg-panel text-text-subtle hover:border-border-strong hover:text-text',
      )}
      style={visible ? { borderColor: `${color}66` } : undefined}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{
            backgroundColor: visible ? color : 'var(--color-border-strong, #475569)',
            boxShadow: visible ? `0 0 8px ${color}99` : undefined,
          }}
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

// ─── AOI drawing ───────────────────────────────────────────────────────

interface AoiSummary {
  vertices: LngLat[];
  acres: number;
  mrdsInside: number;
  mrdsByCategory: Record<string, number>;
  claimsInside: number;
  claimsByClaimant: Array<{ claimant: string; count: number }>;
}

function emptyFC(): GeoJSON.FeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}

/** Render the in-progress vertices, the connecting polyline, and the
 *  closed polygon as separate features in one FeatureCollection — the
 *  3 AOI map layers filter by geometry type to pick the right one. */
function aoiGeoJson(vertices: LngLat[], mode: 'off' | 'drawing' | 'done'): GeoJSON.FeatureCollection {
  if (vertices.length === 0) return emptyFC();
  const features: GeoJSON.Feature[] = vertices.map((v) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: v },
    properties: {},
  }));
  if (mode === 'drawing' && vertices.length >= 2) {
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: vertices },
      properties: {},
    });
  }
  if (mode === 'done' && vertices.length >= 3) {
    features.push({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [[...vertices, vertices[0]!]] },
      properties: {},
    });
  }
  return { type: 'FeatureCollection', features };
}

function commodityCategoryFor(commodityField: unknown): keyof typeof COMMODITY_CATEGORY_COLORS {
  const s = String(commodityField ?? '').toLowerCase();
  const has = (...needles: string[]) => needles.some((n) => s.includes(n.toLowerCase()));
  if (has('gold', 'silver', 'platinum', 'palladium')) return 'precious';
  if (has('lithium', 'cobalt', 'nickel', 'rare earth', 'tungsten', 'tin', 'antimony')) return 'critical';
  if (has('copper', 'zinc', 'lead', 'molybdenum', 'iron')) return 'base';
  if (has('coal', 'uranium', 'oil', 'gas', 'helium')) return 'energy';
  if (has('potash', 'phosphate', 'sand', 'gravel', 'gypsum', 'sulfur')) return 'industrial';
  return 'unknown';
}

function computeAoiSummary(map: maplibregl.Map | null, vertices: LngLat[]): AoiSummary | null {
  if (!map || vertices.length < 3) return null;
  const acres = polygonAreaAcres(vertices);
  const bbox = ringBbox(vertices);

  // Convert bbox to screen pixel rect for queryRenderedFeatures.
  const sw = map.project([bbox[0], bbox[1]]);
  const ne = map.project([bbox[2], bbox[3]]);
  // queryRenderedFeatures wants two corners in any order.
  const rect: [maplibregl.PointLike, maplibregl.PointLike] = [
    [Math.min(sw.x, ne.x), Math.min(sw.y, ne.y)],
    [Math.max(sw.x, ne.x), Math.max(sw.y, ne.y)],
  ];

  const mrdsHits = map.getLayer('mrds')
    ? map.queryRenderedFeatures(rect, { layers: ['mrds'] })
    : [];
  const mrdsByCategory: Record<string, number> = {};
  let mrdsInside = 0;
  for (const h of mrdsHits) {
    if (h.geometry.type !== 'Point') continue;
    const pt = h.geometry.coordinates as LngLat;
    if (!pointInPolygon(pt, vertices)) continue;
    mrdsInside++;
    const cat = commodityCategoryFor(h.properties?.commodity);
    mrdsByCategory[cat] = (mrdsByCategory[cat] ?? 0) + 1;
  }

  const claimHits = map.getLayer('mining-claims')
    ? map.queryRenderedFeatures(rect, { layers: ['mining-claims'] })
    : [];
  const seenSerials = new Set<string>();
  const claimantCounts = new Map<string, number>();
  for (const h of claimHits) {
    const serial = String(h.properties?.serial ?? '');
    if (!serial || seenSerials.has(serial)) continue;
    seenSerials.add(serial);
    const claimant = String(h.properties?.claimant ?? '(unknown)');
    claimantCounts.set(claimant, (claimantCounts.get(claimant) ?? 0) + 1);
  }
  const claimsByClaimant = Array.from(claimantCounts.entries())
    .map(([claimant, count]) => ({ claimant, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  return {
    vertices,
    acres,
    mrdsInside,
    mrdsByCategory,
    claimsInside: seenSerials.size,
    claimsByClaimant,
  };
}

function AoiControls({
  mode,
  vertexCount,
  onStart,
  onFinish,
  onClear,
}: {
  mode: 'off' | 'drawing' | 'done';
  vertexCount: number;
  onStart: () => void;
  onFinish: () => void;
  onClear: () => void;
}) {
  return (
    <div
      data-testid="aoi-controls"
      className="absolute right-3 top-3 z-10 flex flex-col items-end gap-2"
    >
      {mode === 'off' && (
        <button
          type="button"
          onClick={onStart}
          data-testid="aoi-draw-button"
          className="rounded-md border border-border bg-bg-surface/95 px-3 py-1.5 font-mono text-[11px] text-text shadow-lg backdrop-blur hover:border-accent/60"
        >
          ✎ draw AOI
        </button>
      )}
      {mode === 'drawing' && (
        <div className="flex flex-col items-end gap-1 rounded-md border border-accent/40 bg-bg-surface/95 px-3 py-2 font-mono text-[10px] text-text shadow-lg backdrop-blur">
          <div className="text-text-muted">
            click to add vertices · double-click to finish · esc to cancel
          </div>
          <div className="flex items-center gap-2">
            <span>{vertexCount} vertex{vertexCount === 1 ? '' : 'es'}</span>
            <button
              type="button"
              onClick={onFinish}
              disabled={vertexCount < 3}
              className="rounded border border-border bg-bg-panel px-2 py-0.5 disabled:opacity-40"
            >
              finish
            </button>
            <button
              type="button"
              onClick={onClear}
              className="rounded border border-border bg-bg-panel px-2 py-0.5"
            >
              cancel
            </button>
          </div>
        </div>
      )}
      {mode === 'done' && (
        <button
          type="button"
          onClick={onClear}
          className="rounded-md border border-border bg-bg-surface/95 px-3 py-1.5 font-mono text-[11px] text-text-muted shadow-lg backdrop-blur hover:text-text"
        >
          new AOI
        </button>
      )}
    </div>
  );
}

function AoiPanel({ summary, onClose }: { summary: AoiSummary; onClose: () => void }) {
  const categoryOrder: Array<keyof typeof COMMODITY_CATEGORY_COLORS> = [
    'precious',
    'critical',
    'base',
    'energy',
    'industrial',
    'unknown',
  ];
  const totalCommodityHits =
    summary.mrdsInside === 0
      ? 0
      : Object.values(summary.mrdsByCategory).reduce((a, b) => a + b, 0);
  return (
    <aside
      data-testid="aoi-panel"
      className="absolute right-3 top-16 bottom-3 z-10 flex w-[360px] flex-col rounded-lg border border-border bg-bg-surface/95 shadow-2xl backdrop-blur"
    >
      <header className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <div className="font-mono text-[10px] uppercase tracking-wider text-text-muted">Area of Interest</div>
          <div className="mt-0.5 font-mono text-sm text-text">
            {summary.acres.toLocaleString(undefined, { maximumFractionDigits: 1 })} acres
          </div>
          <div className="mt-0.5 font-mono text-[10px] text-text-muted">{summary.vertices.length} vertices</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close AOI"
          className="rounded-md border border-border bg-bg-panel px-2 py-1 font-mono text-[10px] text-text-muted hover:text-text"
        >
          ✕
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-3 font-mono text-[11px]">
        <Section title="MRDS deposits inside">
          {summary.mrdsInside === 0 ? (
            <div className="text-text-muted">No mineral occurrences in this AOI at the current zoom.</div>
          ) : (
            <div className="space-y-1">
              <div className="text-text">
                {summary.mrdsInside.toLocaleString()} deposit{summary.mrdsInside === 1 ? '' : 's'}
              </div>
              {categoryOrder.map((cat) => {
                const n = summary.mrdsByCategory[cat] ?? 0;
                if (n === 0) return null;
                return (
                  <div key={cat} className="flex items-center gap-2 text-text">
                    <span
                      aria-hidden
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ backgroundColor: COMMODITY_CATEGORY_COLORS[cat] }}
                    />
                    <span className="capitalize">{cat}</span>
                    <span className="ml-auto text-text-muted">
                      {n} ({totalCommodityHits > 0 ? Math.round((100 * n) / totalCommodityHits) : 0}%)
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </Section>

        <Section title="Active claims overlapping">
          {summary.claimsInside === 0 ? (
            <div className="text-lime-400">
              No active claims in this AOI — every acre here is open ground subject to surface management and withdrawal status.
            </div>
          ) : (
            <div className="space-y-1">
              <div className="text-text">
                {summary.claimsInside.toLocaleString()} claim{summary.claimsInside === 1 ? '' : 's'}, top claimants:
              </div>
              {summary.claimsByClaimant.map((c) => (
                <div key={c.claimant} className="flex items-center gap-2 text-text">
                  <span className="truncate" title={c.claimant}>{c.claimant}</span>
                  <span className="ml-auto text-text-muted">{c.count}</span>
                </div>
              ))}
            </div>
          )}
        </Section>

        <div className="mt-2 rounded-md border border-border bg-bg-panel px-3 py-2 text-[10px] leading-relaxed text-text-muted">
          AOI counts only include features rendered at the current zoom level. Zoom in or out and re-draw to refresh.
        </div>
      </div>
    </aside>
  );
}

// ─── Legend ────────────────────────────────────────────────────────────

function Legend({ mrdsVisible }: { mrdsVisible: boolean }) {
  const [collapsed, setCollapsed] = useState(false);
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        data-testid="legend-toggle"
        className="absolute bottom-3 left-3 z-10 rounded-md border border-border bg-bg-surface/90 px-2 py-1 font-mono text-[10px] text-text-muted shadow backdrop-blur hover:text-text"
      >
        legend ▾
      </button>
    );
  }
  return (
    <div
      data-testid="legend"
      className="absolute bottom-3 left-3 z-10 max-w-[220px] rounded-md border border-border bg-bg-surface/90 p-2 font-mono text-[10px] shadow-xl backdrop-blur"
    >
      <div className="mb-1 flex items-center justify-between">
        <span className="uppercase tracking-wider text-text-muted">legend</span>
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          aria-label="Collapse legend"
          className="text-text-muted hover:text-text"
        >
          ✕
        </button>
      </div>
      <div className="space-y-1">
        {LAYERS.filter((l) => l.tilesetLayer !== 'mrds').map((l) => (
          <Swatch key={l.id} color={l.color ?? '#94a3b8'} label={l.label} kind={l.geometry} />
        ))}
      </div>
      {mrdsVisible && (
        <div className="mt-2 border-t border-border pt-2">
          <div className="mb-1 uppercase tracking-wider text-text-muted">MRDS by commodity</div>
          <div className="space-y-1">
            <Swatch color={COMMODITY_CATEGORY_COLORS.precious!} label="Precious (Au · Ag · Pt · Pd)" kind="point" />
            <Swatch color={COMMODITY_CATEGORY_COLORS.critical!} label="Critical (Li · Co · Ni · REE)" kind="point" />
            <Swatch color={COMMODITY_CATEGORY_COLORS.base!} label="Base (Cu · Pb · Zn · Mo)" kind="point" />
            <Swatch color={COMMODITY_CATEGORY_COLORS.energy!} label="Energy (U · oil · gas · coal)" kind="point" />
            <Swatch color={COMMODITY_CATEGORY_COLORS.industrial!} label="Industrial" kind="point" />
          </div>
        </div>
      )}
      <div className="mt-2 border-t border-border pt-2">
        <div className="mb-1 uppercase tracking-wider text-text-muted">Federal lands by agency</div>
        <div className="space-y-1">
          <Swatch color="#22c55e" label="BLM" kind="polygon" />
          <Swatch color="#16a34a" label="USFS" kind="polygon" />
          <Swatch color="#b45309" label="NPS" kind="polygon" />
          <Swatch color="#9333ea" label="BIA" kind="polygon" />
        </div>
      </div>
    </div>
  );
}

function Swatch({
  color,
  label,
  kind,
}: {
  color: string;
  label: string;
  kind: 'point' | 'line' | 'polygon';
}) {
  return (
    <div className="flex items-center gap-2 text-text">
      <span
        aria-hidden
        className={cn(
          'shrink-0',
          kind === 'point' && 'h-2 w-2 rounded-full',
          kind === 'line' && 'h-0.5 w-4',
          kind === 'polygon' && 'h-2 w-3 rounded-sm border',
        )}
        style={{
          backgroundColor: kind === 'polygon' ? `${color}38` : color,
          borderColor: kind === 'polygon' ? color : undefined,
        }}
      />
      <span className="truncate text-[10px]" title={label}>{label}</span>
    </div>
  );
}

// ─── Commodity filter ──────────────────────────────────────────────────

function CommodityFilter({
  selected,
  onChange,
}: {
  selected: Set<string>;
  onChange: (s: Set<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const grouped = useMemo(() => {
    const byCat = new Map<string, typeof COMMODITIES[number][]>();
    for (const c of COMMODITIES) {
      const arr = byCat.get(c.category) ?? [];
      arr.push(c);
      byCat.set(c.category, arr);
    }
    return byCat;
  }, []);
  const label =
    selected.size === 0
      ? 'all commodities'
      : selected.size === 1
        ? Array.from(selected)[0]
        : `${selected.size} commodities`;

  function toggle(commodityLabel: string) {
    const next = new Set(selected);
    if (next.has(commodityLabel)) next.delete(commodityLabel);
    else next.add(commodityLabel);
    onChange(next);
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        data-testid="commodity-filter-button"
        className={cn(
          'flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 font-mono text-[11px] transition',
          selected.size > 0
            ? 'border-accent/40 bg-accent/5 text-text'
            : 'border-border bg-bg-panel text-text-subtle hover:text-text',
        )}
      >
        <span
          aria-hidden
          className={cn(
            'h-1.5 w-1.5 rounded-full',
            selected.size > 0 ? 'bg-accent' : 'bg-border-strong',
          )}
        />
        {label}
        <span aria-hidden className="text-text-muted">▾</span>
      </button>
      {open && (
        <div
          data-testid="commodity-filter-menu"
          className="absolute right-0 top-[calc(100%+4px)] z-20 w-72 rounded-md border border-border bg-bg-surface shadow-xl"
        >
          <div className="flex items-center justify-between border-b border-border px-3 py-2 font-mono text-[10px]">
            <span className="text-text-muted">filter MRDS deposits</span>
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(new Set());
              }}
              className="text-accent hover:underline"
            >
              clear
            </button>
          </div>
          <div className="max-h-80 overflow-y-auto px-2 py-2">
            {Array.from(grouped.entries()).map(([cat, items]) => (
              <div key={cat} className="mb-2 last:mb-0">
                <div className="px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-text-muted">
                  {cat}
                </div>
                {items.map((c) => (
                  <label
                    key={c.id}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 font-mono text-[11px] text-text hover:bg-bg-panel"
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(c.label)}
                      onMouseDown={(e) => e.preventDefault()}
                      onChange={() => toggle(c.label)}
                      className="h-3 w-3 accent-accent"
                    />
                    <span className="flex-1">{c.label}</span>
                    <span className="text-text-muted">{c.symbol}</span>
                  </label>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
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
  claimant: 'Claimant',
  owner: 'Owner',
  acreage: 'Acreage',
  located_at: 'Located',
  recorded_at: 'Recorded',
  last_assess_year: 'Last assessment',
  agency: 'Managing agency',
  lessee: 'Lessee',
  effective_at: 'Effective',
  expires_at: 'Expires',
  type: 'Type',
  plssid: 'PLSS ID',
  stateabbr: 'State',
  frstdivid: 'First-division ID',
  twnshpno: 'Township',
  rangeno: 'Range',
  meridian: 'Meridian',
  operator: 'Operator',
  source: 'Source',
  api: 'API number',
  spud_at: 'Spud date',
  first_prod_at: 'First production',
  depth_ft: 'Total depth (ft)',
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
        <StakeAbility feature={feature} />
        <dl className="mt-4 grid grid-cols-[120px_minmax(0,1fr)] gap-y-1 font-mono text-[11px]">
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

function StakeAbility({ feature }: { feature: SelectedFeature }) {
  // Don't show the section when the user clicked a federal-lands polygon
  // (the question doesn't apply — they're inspecting agency ownership, not
  // a deposit). Always show for everything else.
  if (feature.layerId === 'federal-lands') return null;

  const isMiningClaim = feature.layerId === 'mining-claims';
  const overlaps = feature.overlappingClaims;
  const headline = isMiningClaim
    ? overlaps.length === 0
      ? 'Active claim — no other overlapping claims here.'
      : `Active claim — also covered by ${overlaps.length} other claim${overlaps.length === 1 ? '' : 's'}.`
    : overlaps.length === 0
      ? 'OPEN — no active mining claim at this point.'
      : `COVERED — ${overlaps.length} active claim${overlaps.length === 1 ? '' : 's'} at this point.`;
  const tone =
    overlaps.length === 0 && !isMiningClaim
      ? { border: '#a3e635', bg: '#a3e63514', dot: '#a3e635' } // open ground (lime)
      : overlaps.length === 0 && isMiningClaim
        ? { border: '#f59e0b', bg: '#f59e0b14', dot: '#f59e0b' } // claim, sole
        : { border: '#ef4444', bg: '#ef444414', dot: '#ef4444' }; // contested
  return (
    <div
      data-testid="stake-ability"
      data-overlap-count={overlaps.length}
      className="rounded-md border px-3 py-2"
      style={{ borderColor: tone.border, backgroundColor: tone.bg }}
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="h-1.5 w-1.5 rounded-full"
          style={{ backgroundColor: tone.dot, boxShadow: `0 0 6px ${tone.dot}99` }}
        />
        <span className="font-mono text-[11px] text-text">{headline}</span>
      </div>
      {overlaps.length > 0 && (
        <ul className="mt-2 space-y-0.5 font-mono text-[10px] text-text-muted">
          {overlaps.map((c) => (
            <li key={c.serial} className="truncate" title={`${c.serial} — ${c.claimant} — ${c.acreage} acres`}>
              <span className="text-text">{c.serial}</span>
              {c.claimant && <span> · {c.claimant}</span>}
              {c.acreage && <span> · {c.acreage} ac</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
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
  const color = def.color ?? '#94a3b8';
  const common = {
    id: def.id,
    source: 'subterra',
    'source-layer': def.tilesetLayer,
    minzoom: def.minZoom,
    layout: { visibility } as { visibility: 'visible' | 'none' },
  };

  if (def.geometry === 'point') {
    // MRDS dots are color-coded by commodity category so the most useful
    // signal (what mineral) is visible at a glance. Other point layers
    // just use their registry color.
    const circleColor: maplibregl.DataDrivenPropertyValueSpecification<string> =
      def.tilesetLayer === 'mrds' ? mrdsCommodityColorExpr() : color;
    return {
      ...common,
      type: 'circle',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 3, 9, 5, 14, 8],
        'circle-color': circleColor,
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
        'line-color': color,
        'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.6, 12, 1.6],
        'line-opacity': 0.85,
      },
    };
  }

  // polygon — federal_lands is multi-color by agency; everything else uses
  // its registry color for both fill and outline.
  const fillColor: maplibregl.DataDrivenPropertyValueSpecification<string> =
    def.tilesetLayer === 'federal_lands'
      ? [
          'match',
          ['get', 'agency'],
          'BLM', '#22c55e',
          'USFS', '#16a34a',
          'NPS', '#b45309',
          'BIA', '#9333ea',
          color,
        ]
      : color;
  return {
    ...common,
    type: 'fill',
    paint: {
      'fill-color': fillColor,
      'fill-opacity': 0.22,
      'fill-outline-color': color,
    },
  };
}

/** MapLibre expression that returns the commodity-category color for an
 * MRDS feature based on the first commodity name it can match in the
 * `commodity` property string. MRDS often stores multiple commodities
 * comma-joined ("Gold, Silver, Lead"), so we substring-match against
 * the full string in priority order: precious > critical > base > energy. */
function mrdsCommodityColorExpr(): maplibregl.DataDrivenPropertyValueSpecification<string> {
  const matchAny = (needles: string[]) =>
    ['any', ...needles.map((n) => ['in', n, ['get', 'commodity']])];
  return [
    'case',
    matchAny(['Gold', 'Silver', 'Platinum', 'Palladium']),
    COMMODITY_CATEGORY_COLORS.precious!,
    matchAny(['Lithium', 'Cobalt', 'Nickel', 'Rare Earth', 'Tungsten', 'Tin', 'Antimony']),
    COMMODITY_CATEGORY_COLORS.critical!,
    matchAny(['Copper', 'Zinc', 'Lead', 'Molybdenum', 'Iron']),
    COMMODITY_CATEGORY_COLORS.base!,
    matchAny(['Coal', 'Uranium', 'Oil', 'Gas', 'Helium']),
    COMMODITY_CATEGORY_COLORS.energy!,
    matchAny(['Potash', 'Phosphate', 'Sand', 'Gravel', 'Gypsum', 'Sulfur']),
    COMMODITY_CATEGORY_COLORS.industrial!,
    COMMODITY_CATEGORY_COLORS.unknown!,
  ] as unknown as maplibregl.DataDrivenPropertyValueSpecification<string>;
}
