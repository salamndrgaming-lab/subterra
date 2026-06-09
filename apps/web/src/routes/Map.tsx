import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  COMMODITIES,
  COMMODITY_CATEGORY_COLORS,
  LAYERS,
  LAYER_GROUPS,
  type LayerDef,
  type TopHotspot,
  type CommodityPrices,
  type SourceStatus,
} from '@subterra/shared';
import { cn } from '@/lib/cn';
import { CrossSection, type CrossSectionMrds } from '@/components/CrossSection';
import { fetchManifest } from '@/lib/manifest';
import { checkPmtilesCached, precachePmtiles } from '@/lib/sw';
import { useLayerVisibility } from '@/stores/layers';
import { useViewMode } from '@/stores/view-mode';
import { geocode, type GeocodeHit } from '@/lib/geocode';
import { pointInPolygon, polygonAreaAcres, ringBbox, type LngLat } from '@/lib/geo';
import { columnImageUrl, fetchGeology, type GeologyAtPoint, type StratUnit } from '@/lib/macrostrat';
import { fetchElevation, type ElevationResult } from '@/lib/elevation';
import { estimateCosts, formatAmount, totalRange, type LineItem } from '@/lib/cost-estimate';
import {
  findOptimalPicks,
  SUPPORTED_STATES,
  type OptimalPick,
  type OptimalQuery,
} from '@/lib/optimal-acre';

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

/** Satellite basemap — Esri World Imagery raster tiles. Free for
 *  low-volume / non-commercial use with the attribution surfaced via
 *  the source `attribution`. When billing kicks in, swap the URL to a
 *  keyed provider (MapTiler Satellite, etc.) — one constant change. */
const IMAGERY_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    basemap: {
      type: 'raster',
      tiles: [
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      ],
      tileSize: 256,
      attribution:
        'Tiles © <a href="https://www.esri.com/" target="_blank" rel="noreferrer">Esri</a>, Maxar, Earthstar Geographics, and the GIS User Community',
      maxzoom: 19,
    },
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#0a0c10' } },
    { id: 'basemap', type: 'raster', source: 'basemap' },
  ],
};

/** Mapzen Terrarium DEM hosted on AWS — free public bucket, no key,
 *  no rate limit, well-attested for MapLibre `terrain` sources via the
 *  `terrarium` encoding. Used by setTerrain when viewMode.terrain3d is on. */
const DEM_TILES_URL =
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const DEM_SOURCE_ID = 'dem';
const TERRAIN_EXAGGERATION = 1.3;
const TERRAIN_PITCH_DEG = 50;

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
  /** Surface management agency at the click point, if the federal_lands
   *  layer is loaded and a polygon covers it. Drives the cost panel's
   *  restricted-vs-stakeable logic. */
  surfaceAgency?: string;
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
  // Tracks the last-applied imagery state so the toggle effect can skip
  // the no-op first run when the map's initial style already matches.
  const lastImageryRef = useRef<boolean | undefined>(undefined);
  const [styleLoaded, setStyleLoaded] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SelectedFeature | null>(null);
  const [commodityFilter, setCommodityFilter] = useState<Set<string>>(new Set());
  const [drawMode, setDrawMode] = useState<'off' | 'drawing' | 'done'>('off');
  const [aoiVertices, setAoiVertices] = useState<LngLat[]>([]);
  /** Offline cache state: 'unknown' before the SW reports; 'cached' if the
   *  PMTiles file is in the SW cache; 'uncached' otherwise. 'saving'
   *  while a Save-for-offline download is in flight. */
  const [offlineState, setOfflineState] = useState<'unknown' | 'cached' | 'uncached' | 'saving'>(
    'unknown',
  );
  const [offlineError, setOfflineError] = useState<string | null>(null);
  const [layerSearch, setLayerSearch] = useState('');
  /** "Find Optimal Acre" wizard state. `wizardOpen` controls the modal;
   *  `optimalPick` holds the chosen pick so the map can paint the
   *  recommended 100-acre square + open the explainer drawer. */
  const [wizardOpen, setWizardOpen] = useState(false);
  const [optimalPick, setOptimalPick] = useState<OptimalPick | null>(null);
  /** Cross-section picker state. 'off' = inactive; 'pickingA'/'pickingB'
   *  = waiting for the next click; 'open' = modal visible with chosen
   *  AB line + MRDS hits projected onto it. */
  const [csMode, setCsMode] = useState<'off' | 'pickingA' | 'pickingB' | 'open'>('off');
  const [csA, setCsA] = useState<LngLat | null>(null);
  const [csB, setCsB] = useState<LngLat | null>(null);
  const [csMrds, setCsMrds] = useState<CrossSectionMrds[]>([]);
  /** Mirror csMode + csA into refs so the mount-time click handler can
   *  read the latest value without re-binding. */
  const csModeRef = useRef<'off' | 'pickingA' | 'pickingB' | 'open'>('off');
  const csARef = useRef<LngLat | null>(null);
  const visibility = useLayerVisibility((s) => s.visibility);
  const toggle = useLayerVisibility((s) => s.toggle);
  const terrain3d = useViewMode((s) => s.terrain3d);
  const imagery = useViewMode((s) => s.imagery);
  const setTerrain3d = useViewMode((s) => s.setTerrain3d);
  const setImagery = useViewMode((s) => s.setImagery);

  const manifestQuery = useQuery({
    queryKey: ['manifest'],
    queryFn: fetchManifest,
    staleTime: 5 * 60_000,
  });

  // Subsurface geology lookup for the currently-selected point. Keyed by
  // ~3-decimal lat/lng so adjacent clicks share the cached response.
  const geologyKey =
    selected
      ? `${selected.lng.toFixed(3)},${selected.lat.toFixed(3)}`
      : null;
  const geologyQuery = useQuery({
    queryKey: ['geology', geologyKey],
    queryFn: () => fetchGeology(selected!.lng, selected!.lat),
    enabled: !!selected,
    staleTime: 60 * 60_000, // bedrock geology is forever
    retry: 1,
  });
  // Surface elevation at the clicked point. USGS EPQS is fast (~200 ms)
  // and the answer is location-stable, so cache aggressively too.
  const elevationQuery = useQuery({
    queryKey: ['elevation', geologyKey],
    queryFn: () => fetchElevation(selected!.lng, selected!.lat),
    enabled: !!selected,
    staleTime: 60 * 60_000,
    retry: 1,
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

  // 2. When the manifest lands, add the pmtiles source + all registry layers.
  //    Idempotent: also re-runs on every `style.load` so the basemap-swap
  //    effect (imagery toggle) gets its source+layers reinstalled after
  //    setStyle wipes them. Click + hover handlers live in their own
  //    effect (below) so re-install doesn't attach duplicates.
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
        // buildLayer returns one or two specs — fill polygons emit a
        // paired outline line layer. Click + hover only target the
        // main (def.id) layer; the outline is non-interactive.
        const specs = buildLayer(def, visibility[def.id] ?? def.defaultVisible);
        for (const spec of specs) map.addLayer(spec);
        // Per-layer mouseenter/mouseleave handlers are re-attached on
        // every install — maplibre drops layer-targeted listeners when
        // setStyle wipes the layer. Safe to re-add because each install
        // is gated on getLayer() above; we only get here when the layer
        // was just (re)created, so there's no prior listener to dedupe.
        map.on('mouseenter', def.id, () => {
          map.getCanvas().style.cursor = 'pointer';
        });
        map.on('mouseleave', def.id, () => {
          map.getCanvas().style.cursor = '';
        });
      }
    };
    if (map.isStyleLoaded()) install();
    else map.once('load', install);
    // Reinstall after every style swap. `style.load` fires whenever
    // setStyle finishes loading — that's our re-install signal.
    map.on('style.load', install);
    return () => {
      map.off('style.load', install);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- visibility is synced by a separate effect below; including it here would cause unnecessary re-installs of every layer on every toggle.
  }, [manifestQuery.data]);

  // 2b. Click handler — attached once at mount (no layer target, so it
  //     survives setStyle). Queries inside the handler against whatever
  //     layers currently exist.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const onClick = (e: maplibregl.MapMouseEvent): void => {
      // Cross-section picker intercepts feature clicks while picking
      // points A and B. ESC clears the mode via the keydown effect below.
      const csCur = csModeRef.current;
      if (csCur === 'pickingA') {
        const p: LngLat = [e.lngLat.lng, e.lngLat.lat];
        csARef.current = p;
        setCsA(p);
        setCsMode('pickingB');
        csModeRef.current = 'pickingB';
        return;
      }
      if (csCur === 'pickingB') {
        const aPt = csARef.current;
        if (!aPt) {
          setCsMode('off');
          csModeRef.current = 'off';
          return;
        }
        const bPt: LngLat = [e.lngLat.lng, e.lngLat.lat];
        // Reject A==B (or near it — same pixel) so the SVG isn't degenerate.
        if (Math.abs(bPt[0] - aPt[0]) < 1e-6 && Math.abs(bPt[1] - aPt[1]) < 1e-6) return;
        setCsB(bPt);
        // Sample MRDS within a generous queryRenderedFeatures rect over
        // the bbox of AB (buffer-padded). projectOntoLine in the modal
        // does the final distance-from-line filtering.
        const padDeg = 0.05; // ~5 km at mid-latitudes — slop for the buffer
        const bbox: [maplibregl.PointLike, maplibregl.PointLike] = [
          map.project([Math.min(aPt[0], bPt[0]) - padDeg, Math.min(aPt[1], bPt[1]) - padDeg]),
          map.project([Math.max(aPt[0], bPt[0]) + padDeg, Math.max(aPt[1], bPt[1]) + padDeg]),
        ];
        const mrdsHits = map.getLayer('mrds')
          ? map.queryRenderedFeatures(bbox, { layers: ['mrds'] })
          : [];
        const seen = new Set<string>();
        const collected: CrossSectionMrds[] = [];
        for (const h of mrdsHits) {
          const attrs = (h.properties ?? {}) as Record<string, unknown>;
          const key = String(attrs.dep_id ?? attrs.id ?? `${h.geometry.type}-${collected.length}`);
          if (seen.has(key)) continue;
          seen.add(key);
          if (h.geometry.type !== 'Point') continue;
          const coords = h.geometry.coordinates as [number, number];
          collected.push({
            lng: coords[0],
            lat: coords[1],
            name: String(attrs.name ?? attrs.site_name ?? '') || undefined,
            commodity: String(attrs.commodity ?? '') || undefined,
          });
        }
        setCsMrds(collected);
        setCsMode('open');
        csModeRef.current = 'open';
        return;
      }

      const liveLayerIds = LAYERS.map((l) => l.id).filter((id) => !!map.getLayer(id));
      const hits = map.queryRenderedFeatures(e.point, { layers: liveLayerIds });

      // Stake-ability check works whether or not a specific feature was
      // clicked — we collect overlapping active claims at the click pixel.
      const claimHits = map.getLayer('mining-claims')
        ? map.queryRenderedFeatures(e.point, { layers: ['mining-claims'] })
        : [];

      // Surface managing agency — drives the cost panel's restricted
      // (NPS/BIA) vs stakeable (BLM/USFS) branching. Read from
      // federal-lands first, fall back to open-blm-land (same source).
      const federalHits =
        (map.getLayer('federal-lands')
          ? map.queryRenderedFeatures(e.point, { layers: ['federal-lands'] })
          : []) ||
        (map.getLayer('open-blm-land')
          ? map.queryRenderedFeatures(e.point, { layers: ['open-blm-land'] })
          : []);
      const surfaceAgency =
        federalHits.length > 0
          ? (federalHits[0]!.properties?.agency as string | undefined)
          : undefined;
      const f = hits[0];
      const selfSerial = f?.layer.id === 'mining-claims' ? f.properties?.serial : undefined;
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

      // If a specific feature was clicked, use its centroid + properties.
      // Otherwise this is an empty-map click — still open the drawer at
      // that lat/lng so the user can see the subsurface geology there.
      if (f) {
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
          overlappingClaims,
          surfaceAgency,
        });
      } else {
        setSelected({
          layerId: '__point__',
          layerLabel: 'Point inspection',
          properties: {},
          lng: e.lngLat.lng,
          lat: e.lngLat.lat,
          overlappingClaims,
          surfaceAgency,
        });
      }
    };
    map.on('click', onClick);
    return () => {
      map.off('click', onClick);
    };
  }, []);

  // 2c. Imagery basemap toggle — setStyle swaps the basemap. The install
  //     effect's `style.load` listener re-adds the PMTiles source + layers
  //     once the new style finishes loading. Skips the no-op first render
  //     when the desired state already matches the map's initial style.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const prev = lastImageryRef.current;
    lastImageryRef.current = imagery;
    if (prev === undefined && imagery === false) return; // already there
    map.setStyle(imagery ? IMAGERY_STYLE : PRIMARY_STYLE);
  }, [imagery]);

  // 2d. 3D terrain toggle — add a DEM source + setTerrain, ease pitch.
  //     Re-applied on every style.load so terrain survives basemap swaps.
  //     `prefers-reduced-motion: reduce` collapses the easeTo into an
  //     instant setPitch so we don't motion-sick anyone.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const reduceMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const apply = (): void => {
      if (terrain3d) {
        if (!map.getSource(DEM_SOURCE_ID)) {
          map.addSource(DEM_SOURCE_ID, {
            type: 'raster-dem',
            tiles: [DEM_TILES_URL],
            tileSize: 256,
            encoding: 'terrarium',
            maxzoom: 15,
            attribution:
              'DEM: <a href="https://github.com/tilezen/joerd" target="_blank" rel="noreferrer">Mapzen Terrarium</a> via AWS',
          });
        }
        map.setTerrain({ source: DEM_SOURCE_ID, exaggeration: TERRAIN_EXAGGERATION });
        if (reduceMotion) map.setPitch(TERRAIN_PITCH_DEG);
        else map.easeTo({ pitch: TERRAIN_PITCH_DEG, duration: 600 });
      } else {
        // setTerrain(null) clears the DEM-driven elevation effect. Leave
        // the source in place — cheap, and any re-toggle skips re-add.
        map.setTerrain(null);
        if (reduceMotion) map.setPitch(0);
        else map.easeTo({ pitch: 0, duration: 600 });
      }
    };
    if (map.isStyleLoaded()) apply();
    else map.once('load', apply);
    map.on('style.load', apply);
    return () => {
      map.off('style.load', apply);
    };
  }, [terrain3d]);

  // 2e. Poll the service worker for offline-cache status on mount. The
  //     SW activates async; if it isn't ready on first call we retry
  //     once after a beat. Re-checks when the manifest version changes
  //     so a fresh ETL refresh demotes "cached" back to "uncached"
  //     (the old version's URL no longer matches the new ?v=N).
  useEffect(() => {
    const manifest = manifestQuery.data;
    if (!manifest) return;
    let cancelled = false;
    const check = async (): Promise<void> => {
      const status = await checkPmtilesCached();
      if (cancelled) return;
      if (status.cached && status.url === manifest.pmtilesUrl) {
        setOfflineState('cached');
      } else {
        setOfflineState('uncached');
      }
    };
    void check();
    // Re-check after a short delay — SW controller may be null on the
    // very first page load (registration is async + the page wasn't
    // controlled when this load started).
    const t = setTimeout(() => void check(), 1500);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [manifestQuery.data]);

  // Cross-section: ESC cancels at any non-'off' state; sync csMode ref
  // for the click handler. The cursor effect uses the mode too — same
  // override pattern as drawMode below.
  useEffect(() => {
    csModeRef.current = csMode;
  }, [csMode]);

  useEffect(() => {
    if (csMode === 'off') return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setCsMode('off');
        csModeRef.current = 'off';
        setCsA(null);
        csARef.current = null;
        setCsB(null);
        setCsMrds([]);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [csMode]);

  // Temp AB-line map layer for visual feedback while picking + after
  // capture. Uses a dedicated source ID; rebuilt on each csA/csB change
  // and torn down when csMode returns to 'off'.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const SRC = 'cs-line';
    const apply = (): void => {
      const removeAll = (): void => {
        if (map.getLayer(`${SRC}-line`)) map.removeLayer(`${SRC}-line`);
        if (map.getLayer(`${SRC}-endpoints`)) map.removeLayer(`${SRC}-endpoints`);
        if (map.getSource(SRC)) map.removeSource(SRC);
      };
      if (csMode === 'off' || !csA) {
        removeAll();
        return;
      }
      const lineCoords: LngLat[] = csB ? [csA, csB] : [csA, csA];
      const data: GeoJSON.FeatureCollection = {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: lineCoords },
            properties: { kind: 'line' },
          },
          ...[csA, csB].filter((p): p is LngLat => p != null).map((p) => ({
            type: 'Feature' as const,
            geometry: { type: 'Point' as const, coordinates: p },
            properties: { kind: 'endpoint' },
          })),
        ],
      };
      const existing = map.getSource(SRC) as maplibregl.GeoJSONSource | undefined;
      if (existing) {
        existing.setData(data);
      } else {
        map.addSource(SRC, { type: 'geojson', data });
        map.addLayer({
          id: `${SRC}-line`,
          source: SRC,
          type: 'line',
          filter: ['==', ['get', 'kind'], 'line'],
          paint: {
            'line-color': '#f59e0b',
            'line-width': 2.4,
            'line-dasharray': [2, 1.5],
          },
        });
        map.addLayer({
          id: `${SRC}-endpoints`,
          source: SRC,
          type: 'circle',
          filter: ['==', ['get', 'kind'], 'endpoint'],
          paint: {
            'circle-radius': 5,
            'circle-color': '#f59e0b',
            'circle-stroke-color': '#0a0c10',
            'circle-stroke-width': 1.5,
          },
        });
      }
    };
    if (map.isStyleLoaded()) apply();
    else map.once('load', apply);
  }, [csMode, csA, csB]);

  // Cursor cue while picking — crosshair through point-B click.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (csMode === 'pickingA' || csMode === 'pickingB') {
      map.getCanvas().style.cursor = 'crosshair';
    } else if (drawMode !== 'drawing') {
      map.getCanvas().style.cursor = '';
    }
  }, [csMode, drawMode]);

  const handleSaveForOffline = async (): Promise<void> => {
    const url = manifestQuery.data?.pmtilesUrl;
    if (!url) return;
    setOfflineError(null);
    setOfflineState('saving');
    const result = await precachePmtiles(url);
    if (result.ok) {
      setOfflineState('cached');
    } else {
      setOfflineState('uncached');
      setOfflineError(result.error ?? 'precache failed');
    }
  };

  // 3. Sync visibility — flip `layout.visibility` whenever the user toggles.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = (): void => {
      for (const def of LAYERS) {
        const vis = visibility[def.id] ? 'visible' : 'none';
        // Main layer + paired outline (polygons + hotspots) flip in
        // lockstep. getLayer() guards against the outline not being
        // present (e.g. point + line layers don't emit one).
        for (const id of [def.id, def.id + OUTLINE_SUFFIX]) {
          if (!map.getLayer(id)) continue;
          map.setLayoutProperty(id, 'visibility', vis);
        }
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
      // "Find Optimal Acre" recommendation source — populated when the
      // wizard returns a pick. Painted as a bright magenta square with
      // a pulsing-style halo so it's visually unmistakable from the
      // green AOI polygons (different intent: AOI = "tell me about this
      // area", recommended-stake = "this is what to stake").
      if (!map.getSource('recommended-stake')) {
        map.addSource('recommended-stake', { type: 'geojson', data: emptyFC() });
        map.addLayer({
          id: 'recommended-stake-halo',
          source: 'recommended-stake',
          type: 'fill',
          paint: { 'fill-color': '#f0abfc', 'fill-opacity': 0.15 },
        });
        map.addLayer({
          id: 'recommended-stake-fill',
          source: 'recommended-stake',
          type: 'fill',
          paint: { 'fill-color': '#d946ef', 'fill-opacity': 0.45 },
        });
        map.addLayer({
          id: 'recommended-stake-line',
          source: 'recommended-stake',
          type: 'line',
          paint: { 'line-color': '#f5d0fe', 'line-width': 3, 'line-opacity': 0.95 },
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

  // 7. Push the current recommended-stake polygon into its source so the
  //    map shows the picked acre as a bright magenta square. Cleared
  //    when the user closes the recommendation drawer.
  useEffect(() => {
    const map = mapRef.current;
    const src = map?.getSource('recommended-stake') as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    if (!optimalPick) {
      src.setData(emptyFC());
      return;
    }
    src.setData({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: optimalPick.stakePolygon,
        properties: { rank: optimalPick.rank },
      }],
    });
  }, [optimalPick]);

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

        <button
          type="button"
          onClick={() => setWizardOpen(true)}
          disabled={!manifestQuery.data?.topHotspots?.length}
          className="mt-2 w-full rounded-md border border-fuchsia-400/60 bg-fuchsia-500/10 px-3 py-2 font-mono text-[11px] text-fuchsia-100 hover:bg-fuchsia-500/20 disabled:cursor-not-allowed disabled:opacity-50"
          title={
            manifestQuery.data?.topHotspots?.length
              ? 'Pick the best 100-acre stake for a commodity + budget'
              : 'Hotspot data not loaded yet — needs the latest ETL refresh'
          }
        >
          ★ Find Optimal Acre
        </button>

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
          {manifestQuery.data && (
            <OfflineControl
              state={offlineState}
              error={offlineError}
              onSave={handleSaveForOffline}
            />
          )}
        </div>

        {manifestQuery.data?.commodityPrices && (
          <PriceTicker prices={manifestQuery.data.commodityPrices} />
        )}
      </header>

      <aside className="flex h-full min-h-0 flex-col border-r border-border bg-bg-surface">
        <div className="border-b border-border px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="font-mono text-[10px] uppercase tracking-wider text-text-muted">Layers</div>
            {manifestQuery.data?.publishedAt && (
              <span
                data-testid="layers-freshness"
                title={`Tileset v${manifestQuery.data.version} published ${manifestQuery.data.publishedAt}`}
                className="font-mono text-[9px] text-text-muted"
              >
                refreshed {humanizeAgo(manifestQuery.data.publishedAt)}
              </span>
            )}
          </div>
          <div className="mt-1 font-mono text-sm text-text">Map controls</div>
          <input
            type="search"
            value={layerSearch}
            onChange={(e) => setLayerSearch(e.target.value)}
            placeholder="Search layers…"
            data-testid="layer-search"
            className="mt-2 w-full rounded-md border border-border bg-bg-panel px-2 py-1 font-mono text-[11px] text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {Object.entries(LAYER_GROUPS).map(([group, label]) => {
            const layersInGroup = LAYERS.filter((l) => {
              if (l.group !== group) return false;
              if (!layerSearch.trim()) return true;
              return l.label.toLowerCase().includes(layerSearch.trim().toLowerCase());
            });
            if (layersInGroup.length === 0) return null;
            // Index per-source status by source name (matches tilesetLayer).
            const sourceStatus = new Map(
              (manifestQuery.data?.sources ?? []).map((s) => [s.name, s]),
            );
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
                    status={sourceStatus.get(l.tilesetLayer)}
                    onToggle={() => toggle(l.id)}
                  />
                ))}
              </Section>
            );
          })}
          {layerSearch.trim() &&
            LAYERS.every(
              (l) => !l.label.toLowerCase().includes(layerSearch.trim().toLowerCase()),
            ) && (
              <div
                data-testid="layer-search-empty"
                className="px-1 py-4 text-center font-mono text-[11px] text-text-muted"
              >
                No layers match &ldquo;{layerSearch}&rdquo;
              </div>
            )}

          {/* Top resource hotspots, precomputed by the ETL and shipped
              in the manifest. Click flies the map + opens the drawer
              with cost/revenue heuristics for that cell. */}
          {manifestQuery.data?.topHotspots && manifestQuery.data.topHotspots.length > 0 && (
            <Section title="Top Hotspots">
              <p className="mb-2 font-mono text-[10px] leading-snug text-text-muted">
                Precomputed prospecting candidates — ranked by deposit density,
                open federal land, and claim competition.
              </p>
              <ol className="space-y-1">
                {manifestQuery.data.topHotspots.slice(0, 10).map((h, i) => (
                  <li key={`${h.lng},${h.lat}`}>
                    <button
                      type="button"
                      onClick={() => {
                        const map = mapRef.current;
                        if (!map) return;
                        map.flyTo({ center: [h.lng, h.lat], zoom: 8, speed: 1.4 });
                        // Open the layer if it's not visible so user can see what
                        // they just flew to.
                        if (!visibility['hotspots']) toggle('hotspots');
                        setSelected({
                          layerId: 'hotspots',
                          layerLabel: `Hotspot #${i + 1}`,
                          properties: {
                            score: h.score,
                            deposits: h.deposits,
                            claims: h.claims,
                            blm_polys: h.blmPolys,
                            geochem_anom: h.geochemAnom ?? 0,
                            top_commodities: h.topCommodities,
                            cost_low: h.costLow,
                            cost_high: h.costHigh,
                            revenue_low: h.revenueLow,
                            revenue_high: h.revenueHigh,
                          },
                          lng: h.lng,
                          lat: h.lat,
                          overlappingClaims: [],
                          surfaceAgency: undefined,
                        });
                      }}
                      className="flex w-full items-center gap-2 rounded border border-border bg-bg-panel/40 px-2 py-1.5 text-left font-mono text-[10px] hover:border-accent hover:bg-bg-panel"
                    >
                      <span
                        aria-hidden
                        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[9px] font-bold text-white"
                        style={{ backgroundColor: hotspotScoreColor(h.score) }}
                      >
                        {Math.round(h.score)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-text">
                          {h.topCommodities || `${h.deposits} deposits`}
                        </span>
                        <span className="block text-text-muted">
                          {h.lat.toFixed(2)}°, {h.lng.toFixed(2)}° · {h.deposits} sites
                        </span>
                      </span>
                      <span className="shrink-0 text-text-muted">→</span>
                    </button>
                  </li>
                ))}
              </ol>
            </Section>
          )}
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
        <ViewModeControls
          terrain3d={terrain3d}
          imagery={imagery}
          onToggleTerrain={() => setTerrain3d(!terrain3d)}
          onToggleImagery={() => setImagery(!imagery)}
        />
        <CrossSectionControls
          mode={csMode}
          onStart={() => {
            setCsA(null);
            csARef.current = null;
            setCsB(null);
            setCsMrds([]);
            setCsMode('pickingA');
            csModeRef.current = 'pickingA';
          }}
          onCancel={() => {
            setCsMode('off');
            csModeRef.current = 'off';
            setCsA(null);
            csARef.current = null;
            setCsB(null);
            setCsMrds([]);
          }}
        />
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
        {selected && !aoiSummary && !optimalPick && (
          <DetailDrawer
            feature={selected}
            geology={geologyQuery.data}
            geologyLoading={geologyQuery.isFetching}
            geologyError={geologyQuery.error ? String(geologyQuery.error) : null}
            elevation={elevationQuery.data ?? null}
            onClose={() => setSelected(null)}
          />
        )}
        {optimalPick && (
          <RecommendedStakeDrawer
            pick={optimalPick}
            onClose={() => setOptimalPick(null)}
          />
        )}
        {wizardOpen && (
          <OptimalAcreWizard
            hotspots={manifestQuery.data?.topHotspots ?? []}
            onClose={() => setWizardOpen(false)}
            onPick={(pick) => {
              setWizardOpen(false);
              setSelected(null);
              setOptimalPick(pick);
              const map = mapRef.current;
              if (map) {
                map.flyTo({
                  center: [pick.hotspot.lng, pick.hotspot.lat],
                  zoom: 13,
                  speed: 1.6,
                });
              }
            }}
          />
        )}
        {csMode === 'open' && csA && csB && (
          <CrossSection
            a={csA}
            b={csB}
            mrds={csMrds}
            onClose={() => {
              setCsMode('off');
              csModeRef.current = 'off';
              setCsA(null);
              csARef.current = null;
              setCsB(null);
              setCsMrds([]);
            }}
          />
        )}
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
  status,
  onToggle,
}: {
  id: string;
  label: string;
  color: string;
  visible: boolean;
  count: number;
  status?: SourceStatus;
  onToggle: () => void;
}) {
  // 'failed' or 'empty' from the last ETL run are both reasons a toggled
  // layer paints nothing. Surfacing them inline turns a silent
  // "nothing happens when I click this" into a one-glance diagnosis.
  const isBroken = status?.status === 'failed' || status?.status === 'empty';
  const brokenTitle = isBroken
    ? `Last ETL run: ${status!.status}${status!.error ? ` — ${status!.error}` : ''}`
    : undefined;
  return (
    <button
      type="button"
      onClick={onToggle}
      data-layer-id={id}
      data-visible={visible}
      data-source-status={status?.status}
      title={brokenTitle}
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
      <span className="flex shrink-0 items-center gap-1 font-mono text-[10px] text-text-muted">
        {isBroken && (
          <span
            aria-hidden
            className={cn(
              'rounded px-1 py-px text-[9px]',
              status!.status === 'failed'
                ? 'bg-red-500/20 text-red-300'
                : 'bg-amber-500/20 text-amber-300',
            )}
          >
            {status!.status === 'failed' ? 'ETL ✕' : 'empty'}
          </span>
        )}
        <span>{count > 0 ? count.toLocaleString() : '·'}</span>
      </span>
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

/** Compact offline-cache widget for the header status row. Three visible
 *  states:
 *    - 'cached'   → green pill "offline ready", no button
 *    - 'saving'   → amber pill "downloading…" with a spinner
 *    - 'uncached' / 'unknown' → grey pill + "Save tiles for offline" button
 *  Errors surface as a small red tooltip-style line below the row. */
function OfflineControl({
  state,
  error,
  onSave,
}: {
  state: 'unknown' | 'cached' | 'uncached' | 'saving';
  error: string | null;
  onSave: () => void | Promise<void>;
}) {
  if (state === 'cached') {
    return (
      <span
        data-testid="pill-offline"
        data-state="cached"
        className="flex items-center gap-1.5 rounded-md border border-success/30 bg-bg-panel px-2 py-1 text-success"
      >
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-success" />
        offline ready
      </span>
    );
  }
  if (state === 'saving') {
    return (
      <span
        data-testid="pill-offline"
        data-state="saving"
        className="flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-bg-panel px-2 py-1 text-amber-300"
      >
        <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
        downloading tiles…
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => void onSave()}
        title={error ?? 'Download tiles so the map keeps working offline'}
        data-testid="btn-save-offline"
        data-state={state}
        className={cn(
          'rounded-md border bg-bg-panel px-2 py-1 transition hover:border-accent hover:text-accent',
          error ? 'border-red-500/40 text-red-300' : 'border-border text-text-muted',
        )}
      >
        {error ? 'retry offline save' : 'save tiles for offline'}
      </button>
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

// ─── View mode toggles ────────────────────────────────────────────────

/** Floating top-left control group: 3D terrain + satellite imagery
 *  toggles. Independent toggles — either, both, or neither. Stored in
 *  the persisted view-mode Zustand store so the choice survives reloads. */
function ViewModeControls({
  terrain3d,
  imagery,
  onToggleTerrain,
  onToggleImagery,
}: {
  terrain3d: boolean;
  imagery: boolean;
  onToggleTerrain: () => void;
  onToggleImagery: () => void;
}) {
  return (
    <div className="absolute left-3 top-3 z-10 flex gap-1 rounded-md border border-border bg-bg-surface/90 p-1 font-mono text-[11px] shadow-lg backdrop-blur">
      <ViewModeButton
        active={imagery}
        onClick={onToggleImagery}
        label="Imagery"
        title={imagery ? 'Switch to dark vector basemap' : 'Switch to satellite imagery'}
        testId="toggle-imagery"
      />
      <ViewModeButton
        active={terrain3d}
        onClick={onToggleTerrain}
        label="3D"
        title={terrain3d ? 'Return to flat top-down view' : 'Enable 3D terrain'}
        testId="toggle-terrain3d"
      />
    </div>
  );
}

function ViewModeButton({
  active,
  onClick,
  label,
  title,
  testId,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  title: string;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      data-testid={testId}
      data-active={active}
      className={cn(
        'rounded px-2.5 py-1 transition',
        active
          ? 'bg-accent/20 text-accent shadow-inner ring-1 ring-accent/40'
          : 'text-text-muted hover:bg-bg-panel hover:text-text',
      )}
    >
      {label}
    </button>
  );
}

/** Floating top-left toolbar — Cross-section picker.
 *
 *  - 'off'      → idle button "Cross-section"
 *  - 'pickingA' → highlighted button + banner "Click point A"
 *  - 'pickingB' → highlighted button + banner "Click point B"
 *  - 'open'     → idle button (modal handles its own state)
 *
 *  Sits just below ViewModeControls (which is at top:3). */
function CrossSectionControls({
  mode,
  onStart,
  onCancel,
}: {
  mode: 'off' | 'pickingA' | 'pickingB' | 'open';
  onStart: () => void;
  onCancel: () => void;
}) {
  const picking = mode === 'pickingA' || mode === 'pickingB';
  return (
    <div className="absolute left-3 top-14 z-10 flex items-center gap-2">
      <button
        type="button"
        onClick={picking ? onCancel : onStart}
        data-testid="toggle-cross-section"
        data-mode={mode}
        title={picking ? 'Cancel cross-section picking' : 'Click two points on the map to draw a cross-section'}
        className={cn(
          'rounded-md border bg-bg-surface/90 px-2.5 py-1 font-mono text-[11px] shadow-lg backdrop-blur transition',
          picking
            ? 'border-accent/60 bg-accent/15 text-accent ring-1 ring-accent/40'
            : 'border-border text-text-muted hover:border-accent hover:text-accent',
        )}
      >
        {picking ? 'Cancel section' : 'Cross-section'}
      </button>
      {picking && (
        <span
          data-testid="cs-picker-banner"
          className="rounded-md border border-accent/40 bg-accent/10 px-2 py-1 font-mono text-[11px] text-accent shadow-lg backdrop-blur"
        >
          {mode === 'pickingA' ? 'Click point A' : 'Click point B (ESC to cancel)'}
        </span>
      )}
    </div>
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
  /** Estimated lode claims to cover the AOI (20 ac each). */
  lodeClaims: number;
  /** Year-1 acquisition cost across all claims (low end). */
  year1CostLow: number;
  /** Year-1 acquisition cost across all claims (high end). */
  year1CostHigh: number;
  /** Annual maintenance fee total. */
  annualCost: number;
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

  // Lode-claim sizing: 20 acres per claim. Round up — partial claims
  // still cost the full filing fee.
  const lodeClaims = Math.max(1, Math.ceil(acres / 20));
  // Per-claim ranges from cost-estimate.ts: low ~$225 (40+20+15+50+100),
  // high ~$810 (40+20+50+200+500). Annual maintenance: $165/claim.
  const year1CostLow = lodeClaims * 225;
  const year1CostHigh = lodeClaims * 810;
  const annualCost = lodeClaims * 165;

  return {
    vertices,
    acres,
    mrdsInside,
    mrdsByCategory,
    claimsInside: seenSerials.size,
    claimsByClaimant,
    lodeClaims,
    year1CostLow,
    year1CostHigh,
    annualCost,
  };
}

// ─── Live commodity price ticker ───────────────────────────────────────

/** Compact spot-price strip under the header. Shows the headline metals
 *  with a live/stale indicator. Prices come from the manifest (fetched at
 *  ETL time), so they refresh on each ETL run, not continuously. */
function PriceTicker({ prices }: { prices: CommodityPrices }) {
  // Display order — the commodities prospectors care about most first.
  const order = ['AU', 'AG', 'CU', 'LI', 'NI', 'ZN', 'PB', 'U', 'MO', 'PT', 'PD'];
  const items = order
    .filter((sym) => prices.prices[sym])
    .map((sym) => ({ sym, ...prices.prices[sym]! }));
  if (items.length === 0) return null;

  const fmt = (usd: number, unit: string): string => {
    if (unit === 'oz') return `$${usd.toLocaleString(undefined, { maximumFractionDigits: 0 })}/oz`;
    if (usd >= 1000) return `$${(usd / 1000).toFixed(1)}k/t`;
    return `$${usd.toFixed(0)}/t`;
  };
  const date = prices.fetchedAt.slice(0, 10);

  return (
    <div className="flex items-center gap-1 overflow-x-auto border-t border-border bg-bg/40 px-4 py-1.5">
      <span
        className="shrink-0 font-mono text-[9px] uppercase tracking-wider"
        style={{ color: prices.live ? '#22c55e' : '#f59e0b' }}
        title={
          prices.live
            ? `Live spot prices via ${prices.source}, ${date}`
            : `Static fallback (no live feed reachable), ${date}`
        }
      >
        {prices.live ? '● spot' : '○ est'}
      </span>
      {items.map((it) => (
        <span
          key={it.sym}
          className="shrink-0 rounded border border-border bg-bg-panel px-1.5 py-0.5 font-mono text-[10px]"
          title={`${it.sym} — ${prices.live ? 'live' : 'estimated'} ${date}`}
        >
          <span className="text-text-muted">{it.sym}</span>{' '}
          <span className="text-text">{fmt(it.usd, it.unit)}</span>
        </span>
      ))}
    </div>
  );
}

// ─── Optimal Acre wizard + recommendation drawer ──────────────────────

/** Commodities offered in the wizard dropdown. Hand-picked from the
 *  commodity-base-value list in etl/sources/hotspots.py — these are the
 *  ones for which we ship a meaningful per-cell revenue estimate. */
const WIZARD_COMMODITIES: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'AU', label: 'Gold (Au)' },
  { code: 'AG', label: 'Silver (Ag)' },
  { code: 'CU', label: 'Copper (Cu)' },
  { code: 'LI', label: 'Lithium (Li)' },
  { code: 'REE', label: 'Rare Earths' },
  { code: 'MO', label: 'Molybdenum (Mo)' },
  { code: 'ZN', label: 'Zinc (Zn)' },
  { code: 'PB', label: 'Lead (Pb)' },
  { code: 'U', label: 'Uranium (U)' },
  { code: 'W', label: 'Tungsten (W)' },
];

const BUDGET_PRESETS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 5_000, label: '$5K (single claim · 1 yr)' },
  { value: 15_000, label: '$15K (5 claims · 1 yr)' },
  { value: 50_000, label: '$50K (10 claims · 5 yr)' },
  { value: 200_000, label: '$200K (small-mine workup)' },
  { value: 1_000_000, label: '$1M (full prospect)' },
];

function OptimalAcreWizard({
  hotspots,
  onPick,
  onClose,
}: {
  hotspots: readonly TopHotspot[];
  onPick: (pick: OptimalPick) => void;
  onClose: () => void;
}) {
  const [commodity, setCommodity] = useState<string | null>('AU');
  const [budget, setBudget] = useState<number>(50_000);
  const [state, setState] = useState<string | null>(null);

  const query: OptimalQuery = useMemo(
    () => ({ commodity, maxBudget: budget, state }),
    [commodity, budget, state],
  );
  const picks = useMemo(() => findOptimalPicks(hotspots, query), [hotspots, query]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Find optimal acre"
      className="absolute inset-0 z-30 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        // Close only when clicking the backdrop, not the panel itself.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-2xl rounded-lg border border-fuchsia-400/30 bg-bg-surface shadow-2xl">
        <header className="flex items-start justify-between gap-2 border-b border-border px-5 py-3">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-wider text-fuchsia-300">
              Wizard · prospecting picker
            </div>
            <div className="font-mono text-base text-text">Find Optimal Acre</div>
            <div className="mt-0.5 font-mono text-[10px] text-text-muted">
              Searches {hotspots.length} pre-scored hotspot cells across the western US.
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

        <div className="grid grid-cols-2 gap-4 px-5 py-4">
          {/* Inputs */}
          <div className="space-y-3 font-mono text-[11px]">
            <div>
              <label className="mb-1 block text-[10px] uppercase tracking-wider text-text-muted">
                Target commodity
              </label>
              <select
                value={commodity ?? ''}
                onChange={(e) => setCommodity(e.target.value || null)}
                className="w-full rounded border border-border bg-bg-panel px-2 py-1.5 text-text"
              >
                <option value="">Any commodity</option>
                {WIZARD_COMMODITIES.map((c) => (
                  <option key={c.code} value={c.code}>{c.label}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-1 block text-[10px] uppercase tracking-wider text-text-muted">
                Max budget
              </label>
              <select
                value={budget}
                onChange={(e) => setBudget(Number(e.target.value))}
                className="w-full rounded border border-border bg-bg-panel px-2 py-1.5 text-text"
              >
                {BUDGET_PRESETS.map((b) => (
                  <option key={b.value} value={b.value}>{b.label}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-1 block text-[10px] uppercase tracking-wider text-text-muted">
                State (optional)
              </label>
              <select
                value={state ?? ''}
                onChange={(e) => setState(e.target.value || null)}
                className="w-full rounded border border-border bg-bg-panel px-2 py-1.5 text-text"
              >
                <option value="">Anywhere in the West</option>
                {SUPPORTED_STATES.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>

            <div className="rounded border border-border bg-bg-panel/40 p-2 text-[9px] leading-snug text-text-muted">
              Picker ranks pre-scored hotspot cells by: hotspot score +
              commodity-fit boost + budget-fit bonus − claim-competition
              penalty. Cells above your budget are filtered out entirely.
            </div>
          </div>

          {/* Results */}
          <div className="space-y-2">
            <div className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
              Top 3 picks ({picks.length} match{picks.length === 1 ? '' : 'es'})
            </div>
            {picks.length === 0 && (
              <div className="rounded border border-border bg-bg-panel/40 p-3 font-mono text-[10px] text-text-muted">
                No cells match. Try a wider budget, drop the state filter,
                or pick a different commodity.
              </div>
            )}
            {picks.map((pick) => (
              <button
                key={`${pick.hotspot.lng},${pick.hotspot.lat}`}
                type="button"
                onClick={() => onPick(pick)}
                className="block w-full rounded border border-border bg-bg-panel/40 px-3 py-2 text-left font-mono text-[10px] hover:border-fuchsia-400 hover:bg-bg-panel"
              >
                <div className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-fuchsia-500/30 text-[10px] font-bold text-fuchsia-100"
                  >
                    #{pick.rank}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-text">
                      Score {Math.round(pick.adjustedScore)} · {pick.hotspot.deposits} sites
                    </span>
                    <span className="block text-text-muted">
                      {pick.hotspot.lat.toFixed(2)}°, {pick.hotspot.lng.toFixed(2)}° · {pick.hotspot.topCommodities}
                    </span>
                  </span>
                  <span className="shrink-0 text-fuchsia-300">stake →</span>
                </div>
              </button>
            ))}
          </div>
        </div>

        <footer className="border-t border-border px-5 py-2 font-mono text-[9px] uppercase tracking-wider text-text-muted">
          Heuristic picker · cost/revenue ranges are rough public-data estimates
        </footer>
      </div>
    </div>
  );
}

function RecommendedStakeDrawer({
  pick,
  onClose,
}: {
  pick: OptimalPick;
  onClose: () => void;
}) {
  const h = pick.hotspot;
  const costMid = (h.costLow + h.costHigh) / 2;
  const revMid = (h.revenueLow + h.revenueHigh) / 2;
  const margin = revMid - costMid;
  return (
    <aside
      className="absolute right-3 top-3 bottom-3 z-10 flex w-[360px] flex-col rounded-lg border border-fuchsia-400/40 bg-bg-surface/95 shadow-2xl backdrop-blur"
    >
      <header className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <div className="font-mono text-[10px] uppercase tracking-wider text-fuchsia-300">
            Recommended stake · pick #{pick.rank}
          </div>
          <div className="mt-0.5 font-mono text-sm text-text">
            {pick.recommendedAcres} acres · ~{Math.round(Math.sqrt(pick.recommendedAcres * 4046.86))} m square
          </div>
          <div className="mt-0.5 font-mono text-[10px] text-text-muted">
            {h.lat.toFixed(5)}, {h.lng.toFixed(5)}
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

      <div className="flex-1 overflow-y-auto px-4 py-3 font-mono text-[11px]">
        <section className="mb-4 rounded-md border border-fuchsia-400/30 bg-fuchsia-500/5 p-3">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-fuchsia-300">
            Why this one
          </div>
          <ul className="space-y-1 text-text">
            {pick.reasons.map((r, i) => (
              <li key={i} className="flex gap-2">
                <span aria-hidden className="text-fuchsia-400">•</span>
                <span className="min-w-0 flex-1">{r}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="mb-4">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-text-muted">
            Cost vs revenue (heuristic)
          </div>
          <dl className="grid grid-cols-[120px_minmax(0,1fr)] gap-y-1">
            <dt className="text-text-muted">Stake cost</dt>
            <dd className="text-text">{fmtMoney(h.costLow)} – {fmtMoney(h.costHigh)}</dd>
            <dt className="text-text-muted">Revenue potential</dt>
            <dd className="text-text">{fmtMoney(h.revenueLow)} – {fmtMoney(h.revenueHigh)}</dd>
            <dt className="text-text-muted">Margin (mid)</dt>
            <dd style={{ color: margin >= 0 ? '#22c55e' : '#ef4444' }}>
              {margin >= 0 ? '+' : '−'}{fmtMoney(Math.abs(margin))}
            </dd>
          </dl>
        </section>

        <section className="mb-4">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-text-muted">
            Cell signals
          </div>
          <dl className="grid grid-cols-[120px_minmax(0,1fr)] gap-y-1">
            <dt className="text-text-muted">Hotspot score</dt>
            <dd className="text-text">{Math.round(h.score)}/100</dd>
            <dt className="text-text-muted">Adjusted score</dt>
            <dd className="text-text">{Math.round(pick.adjustedScore)}</dd>
            <dt className="text-text-muted">Mineral occurrences</dt>
            <dd className="text-text">{h.deposits}</dd>
            <dt className="text-text-muted">Existing claims</dt>
            <dd className="text-text">{h.claims}</dd>
            <dt className="text-text-muted">BLM coverage</dt>
            <dd className="text-text">{h.blmPolys} polygons</dd>
            <dt className="text-text-muted">Top commodities</dt>
            <dd className="text-text">{h.topCommodities || '—'}</dd>
          </dl>
        </section>

        <section className="rounded border border-border/60 bg-bg/40 p-2 text-[9px] leading-snug text-text-muted">
          <span className="text-text">Disclaimer.</span> All numbers are
          heuristic ranges from public-data signals. The recommended
          square is a 100-acre stake centered on the cell centroid — real
          staking requires field-verifying open ground, surveying a legal
          claim boundary, and filing BLM Form 3830-1.
        </section>
      </div>

      <footer className="flex items-center justify-between gap-2 border-t border-border px-4 py-2 font-mono text-[10px] text-text-muted">
        <a
          href={`https://www.google.com/maps?q=${h.lat},${h.lng}`}
          target="_blank"
          rel="noreferrer"
          className="text-accent hover:underline"
        >
          Open in Google Maps ↗
        </a>
        <span>magenta square on the map</span>
      </footer>
    </aside>
  );
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

        <Section title="Staking cost to cover this AOI">
          <div className="space-y-1 text-text">
            <div className="flex justify-between">
              <span>Claims needed</span>
              <span>{summary.lodeClaims.toLocaleString()} × 20-acre lode</span>
            </div>
            <div className="flex justify-between">
              <span>Year-1 acquisition</span>
              <span>
                ${summary.year1CostLow.toLocaleString()}–${summary.year1CostHigh.toLocaleString()}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Annual maintenance</span>
              <span>${summary.annualCost.toLocaleString()}/yr</span>
            </div>
            {summary.claimsInside > 0 && (
              <div className="mt-1 text-text-muted">
                {Math.round((100 * summary.claimsInside) / summary.lodeClaims)}% of the AOI is already covered by existing claims — you&apos;d be staking only the gaps (or buying out current claimants).
              </div>
            )}
          </div>
        </Section>

        <div className="mt-2 rounded-md border border-border bg-bg-panel px-3 py-2 text-[10px] leading-relaxed text-text-muted">
          AOI counts only include features rendered at the current zoom level. Zoom in or out and re-draw to refresh. Cost estimates per 43 CFR 3833 + industry standard ranges.
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

type DrawerTab = 'summary' | 'eligibility' | 'geology' | 'economics';

function DetailDrawer({
  feature,
  geology,
  geologyLoading,
  geologyError,
  elevation,
  onClose,
}: {
  feature: SelectedFeature;
  geology: GeologyAtPoint | undefined;
  geologyLoading: boolean;
  geologyError: string | null;
  elevation: ElevationResult | null;
  onClose: () => void;
}) {
  const entries = Object.entries(feature.properties).filter(
    ([, v]) => v !== null && v !== '' && v !== undefined,
  );
  const headline =
    (feature.properties.name as string | undefined) ||
    (feature.properties.serial as string | undefined) ||
    feature.layerLabel;

  // Tabs are only shown when they have meaningful content for the
  // clicked feature. Eligibility hides for federal-lands clicks (the
  // panel would render nothing — see StakeAbility's early-return).
  const showEligibility = feature.layerId !== 'federal-lands';
  const isHotspot = feature.layerId === 'hotspots';
  const availableTabs: DrawerTab[] = ['summary'];
  if (showEligibility) availableTabs.push('eligibility');
  availableTabs.push('geology');
  availableTabs.push('economics');

  // Default tab persists per feature-click via React's natural state
  // reset on key change (no key here, so it persists across clicks of
  // the same point but resets when DetailDrawer mounts fresh).
  const [tab, setTab] = useState<DrawerTab>('summary');
  // If the previously-active tab is no longer available for this feature
  // (e.g. user goes from a claim to a federal-lands click), fall back
  // to summary.
  const activeTab: DrawerTab = availableTabs.includes(tab) ? tab : 'summary';

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

      <nav
        data-testid="drawer-tabs"
        className="flex items-stretch gap-0.5 border-b border-border bg-bg-panel/30 px-1.5 py-1 font-mono text-[11px]"
      >
        {availableTabs.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            aria-pressed={activeTab === t}
            data-testid={`drawer-tab-${t}`}
            data-active={activeTab === t}
            className={cn(
              'flex-1 rounded px-2 py-1 capitalize transition',
              activeTab === t
                ? 'bg-bg-surface text-accent shadow-inner ring-1 ring-accent/30'
                : 'text-text-muted hover:bg-bg-panel hover:text-text',
            )}
          >
            {t}
          </button>
        ))}
      </nav>

      <div data-testid={`drawer-pane-${activeTab}`} className="flex-1 overflow-y-auto px-4 py-3">
        {activeTab === 'summary' && (
          <>
            {entries.length === 0 ? (
              <p className="font-mono text-[11px] text-text-muted">
                Point inspection — no feature attributes at this pixel. Geology + cost
                heuristics still available in the other tabs.
              </p>
            ) : (
              <dl className="grid grid-cols-[120px_minmax(0,1fr)] gap-y-1 font-mono text-[11px]">
                {entries.map(([key, value]) => (
                  <Row key={key} label={PROPERTY_LABELS[key] ?? key} value={value} />
                ))}
              </dl>
            )}
          </>
        )}
        {activeTab === 'eligibility' && <StakeAbility feature={feature} />}
        {activeTab === 'geology' && (
          <SubsurfaceGeology
            geology={geology}
            loading={geologyLoading}
            error={geologyError}
            elevation={elevation}
          />
        )}
        {activeTab === 'economics' && (
          <>
            {isHotspot && <HotspotPanel feature={feature} />}
            <CostPanel feature={feature} />
          </>
        )}
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

function CostPanel({ feature }: { feature: SelectedFeature }) {
  const commodity =
    (feature.properties.commodity as string | undefined) ||
    (feature.properties.commod1 as string | undefined);
  const estimate = useMemo(
    () =>
      estimateCosts({
        overlapCount: feature.overlappingClaims.length,
        isMiningClaim: feature.layerId === 'mining-claims',
        commodity,
        surfaceAgency: feature.surfaceAgency,
      }),
    [feature.layerId, feature.overlappingClaims.length, commodity, feature.surfaceAgency],
  );

  return (
    <section className="mt-5 rounded-md border border-border bg-bg-panel/40 p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
          Acquisition + operating costs (estimate)
        </h3>
      </div>
      <p className="mb-3 font-mono text-[11px] leading-snug text-text">{estimate.headline}</p>

      <CostGroup title="Year-1 acquisition" items={estimate.acquisition} />
      <CostGroup title="Annual (per claim)" items={estimate.annual} suffix="/yr" />
      <CostGroup title="Exploration phase" items={estimate.exploration} collapsedByDefault />
      <CostGroup title="Production phase" items={estimate.production} collapsedByDefault />

      {estimate.notes.length > 0 && (
        <ul className="mt-3 list-disc space-y-1 pl-4 font-mono text-[10px] leading-relaxed text-text-muted">
          {estimate.notes.map((n, i) => <li key={i}>{n}</li>)}
        </ul>
      )}
      <p className="mt-3 font-mono text-[9px] uppercase tracking-wider text-text-muted">
        Estimates only · BLM fees per 43 CFR 3833 · operation ranges are industry standard, not site-specific
      </p>
    </section>
  );
}

function CostGroup({
  title,
  items,
  suffix,
  collapsedByDefault,
}: {
  title: string;
  items: LineItem[];
  suffix?: string;
  collapsedByDefault?: boolean;
}) {
  const [open, setOpen] = useState(!collapsedByDefault);
  if (items.length === 0) return null;
  return (
    <div className="mb-3 last:mb-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="mb-1 flex w-full items-center justify-between font-mono text-[10px] uppercase tracking-wider text-text-muted hover:text-text"
      >
        <span>
          {title} <span className="text-text-subtle normal-case">— {totalRange(items)}{suffix ?? ''}</span>
        </span>
        <span aria-hidden>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <ul className="space-y-1.5 font-mono text-[11px]">
          {items.map((it, i) => (
            <li key={i} className="flex flex-col gap-0.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-text" title={it.label}>{it.label}</span>
                <span className="shrink-0 text-text">
                  {formatAmount(it.amount)}{suffix ?? ''}
                </span>
              </div>
              {it.note && (
                <div className="text-[10px] leading-snug text-text-muted">{it.note}</div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Color ramp matching the hotspots layer paint expression. Used in both
 *  the sidebar Top-Hotspots list and the score chip in the drawer panel
 *  so the visual signal stays consistent across the UI. */
function hotspotScoreColor(score: number): string {
  if (score >= 90) return '#7f1d1d'; // red-900
  if (score >= 70) return '#dc2626'; // red-600
  if (score >= 45) return '#f97316'; // orange-500
  if (score >= 20) return '#facc15'; // yellow-400
  return '#475569'; // slate-600
}

/** Humanize an ISO timestamp as "5m ago" / "2h ago" / "3d ago" — used by
 *  the sidebar freshness badge so the user can tell at a glance whether
 *  they're looking at this week's tileset or last month's. */
function humanizeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 'unknown';
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

/** Format a dollar amount as $1.2M / $850K / $42 etc. */
function fmtMoney(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${Math.round(n)}`;
}

/**
 * Drawer panel that surfaces the hotspot cell's score breakdown,
 * predicted staking cost, and rough revenue potential.
 *
 * Three things to keep honest about:
 * - The score is composed of public-data signals (deposit density,
 *   open-BLM coverage, claim competition), not a real economic model.
 * - Cost is the BLM fee schedule applied to a 5-claim, 5-year prospect.
 *   Real costs balloon with permitting, drilling, assays, etc.
 * - Revenue is a back-of-envelope sum of per-commodity base values ×
 *   deposit count. It says "this cell has the geology for $X of
 *   potential", NOT "$X of guaranteed return."
 *
 * The UI labels all three as heuristic estimates so users don't read
 * them as expert valuations.
 */
function HotspotPanel({ feature }: { feature: SelectedFeature }) {
  const score = Number(feature.properties.score ?? 0);
  const deposits = Number(feature.properties.deposits ?? 0);
  const claims = Number(feature.properties.claims ?? 0);
  const blmPolys = Number(feature.properties.blm_polys ?? 0);
  const geochemAnom = Number(feature.properties.geochem_anom ?? 0);
  const topCommoditiesRaw = String(feature.properties.top_commodities ?? '');
  const costLow = Number(feature.properties.cost_low ?? 0);
  const costHigh = Number(feature.properties.cost_high ?? 0);
  const revLow = Number(feature.properties.revenue_low ?? 0);
  const revHigh = Number(feature.properties.revenue_high ?? 0);
  // Profit margin = midpoint(revenue) − midpoint(cost). Negative means the
  // cell's commodities don't carry enough value to justify the stake at
  // the heuristic level.
  const revMid = (revLow + revHigh) / 2;
  const costMid = (costLow + costHigh) / 2;
  const margin = revMid - costMid;
  const commodityList = topCommoditiesRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return (
    <section className="mt-4 rounded-md border border-border bg-bg-panel/40 p-3">
      <div className="mb-3 flex items-center gap-3">
        <div
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md font-mono text-base font-bold text-white"
          style={{ backgroundColor: hotspotScoreColor(score) }}
          aria-label={`Hotspot score ${score} out of 100`}
        >
          {Math.round(score)}
        </div>
        <div className="min-w-0">
          <div className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
            Hotspot score
          </div>
          <div className="font-mono text-[11px] text-text">
            {score >= 70 ? 'Strong candidate' : score >= 45 ? 'Worth investigating' : score >= 20 ? 'Light signal' : 'Marginal'}
          </div>
          <div className="font-mono text-[10px] text-text-muted">
            heuristic — see disclaimer below
          </div>
        </div>
      </div>

      {/* Signal breakdown */}
      <dl className="mb-3 grid grid-cols-2 gap-2 font-mono text-[10px]">
        <div className="rounded border border-border bg-bg-panel px-2 py-1.5">
          <div className="text-text-muted">Deposits</div>
          <div className="text-text">{deposits}</div>
        </div>
        <div className="rounded border border-border bg-bg-panel px-2 py-1.5">
          <div className="text-text-muted">Geochem anomalies</div>
          <div className="text-text">{geochemAnom}</div>
        </div>
        <div className="rounded border border-border bg-bg-panel px-2 py-1.5">
          <div className="text-text-muted">BLM coverage</div>
          <div className="text-text">{blmPolys} polys</div>
        </div>
        <div className="rounded border border-border bg-bg-panel px-2 py-1.5">
          <div className="text-text-muted">Claims (compete)</div>
          <div className="text-text">{claims}</div>
        </div>
      </dl>

      {/* Top commodities */}
      {commodityList.length > 0 && (
        <div className="mb-3">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-text-muted">
            Top commodities
          </div>
          <div className="flex flex-wrap gap-1">
            {commodityList.map((c) => (
              <span
                key={c}
                className="rounded border border-border bg-bg-panel px-1.5 py-0.5 font-mono text-[10px] text-text"
              >
                {c}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Cost vs revenue projection */}
      <div className="mb-2">
        <div className="mb-1 flex items-baseline justify-between">
          <span className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
            Cost to stake (5 claims · 5 yr)
          </span>
          <span className="font-mono text-[10px] text-text">
            {fmtMoney(costLow)} – {fmtMoney(costHigh)}
          </span>
        </div>
        <div className="mb-1 flex items-baseline justify-between">
          <span className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
            Revenue potential
          </span>
          <span className="font-mono text-[10px] text-text">
            {fmtMoney(revLow)} – {fmtMoney(revHigh)}
          </span>
        </div>
        <div className="mt-2 flex items-baseline justify-between border-t border-border pt-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
            Net margin (midpoint)
          </span>
          <span
            className="font-mono text-[11px] font-bold"
            style={{ color: margin >= 0 ? '#22c55e' : '#ef4444' }}
          >
            {margin >= 0 ? '+' : '−'}{fmtMoney(Math.abs(margin))}
          </span>
        </div>
      </div>

      <div className="mt-2 rounded border border-border/60 bg-bg/40 p-2 font-mono text-[9px] leading-snug text-text-muted">
        <span className="text-text">Heuristic only.</span> Cost = BLM fee schedule
        ($212 location + $165/yr × 5 yr per claim). Revenue = Σ commodity_base_value ×
        deposit_count, where base values are rough small-mine 10-yr ballparks. Not
        an economic study. Use as a relative ranking signal between cells.
      </div>
    </section>
  );
}

function SubsurfaceGeology({
  geology,
  loading,
  error,
  elevation,
}: {
  geology: GeologyAtPoint | undefined;
  loading: boolean;
  error: string | null;
  elevation: ElevationResult | null;
}) {
  return (
    <section className="mt-5">
      <div className="mb-1.5 flex items-center justify-between">
        <h3 className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
          Subsurface geology
        </h3>
        <div className="flex gap-2 font-mono text-[10px]">
          {geology?.ngmdbUrl && (
            <a
              href={geology.ngmdbUrl}
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:underline"
              title="USGS National Geologic Map Database viewer at this point"
            >
              NGMDB ↗
            </a>
          )}
          {geology?.macrostratUrl && (
            <a
              href={geology.macrostratUrl}
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:underline"
              title="Macrostrat interactive geologic map at this point"
            >
              Macrostrat ↗
            </a>
          )}
        </div>
      </div>

      {/* Elevation + topographic context */}
      {elevation && (
        <div className="mb-2 flex items-baseline gap-3 font-mono text-[11px]">
          <span className="text-text-muted">Surface elevation:</span>
          <span className="text-text">
            {Math.round(elevation.meters).toLocaleString()} m
            <span className="text-text-muted"> ({Math.round(elevation.feet).toLocaleString()} ft)</span>
          </span>
        </div>
      )}

      {loading && !geology && (
        <div className="font-mono text-[10px] text-text-muted">looking up bedrock units…</div>
      )}
      {error && !geology && (
        <div className="font-mono text-[10px] text-text-muted">
          (geology lookup unavailable — Macrostrat returned an error)
        </div>
      )}
      {geology && geology.units.length === 0 && (
        <div className="font-mono text-[10px] text-text-muted">
          No mapped bedrock units at this point. Likely offshore or a gap in the geologic map coverage.
        </div>
      )}

      {/* Geologic-map units (what's exposed at the surface) */}
      {geology && geology.units.length > 0 && (
        <div className="flex gap-3">
          {geology.columnId !== undefined && (
            <img
              src={columnImageUrl(geology.columnId)}
              alt="Stratigraphic column"
              width={120}
              loading="lazy"
              className="shrink-0 rounded border border-border bg-bg-panel"
              onError={(e) => {
                (e.target as HTMLElement).style.display = 'none';
              }}
            />
          )}
          <ul className="min-w-0 flex-1 space-y-2 font-mono text-[11px]">
            {geology.units.slice(0, 6).map((u, i) => (
              <li key={i} className="flex gap-2">
                <span
                  aria-hidden
                  className="mt-1 h-3 w-3 shrink-0 rounded-sm border border-border"
                  style={{ backgroundColor: u.color ?? '#444' }}
                />
                <div className="min-w-0">
                  <div className="truncate text-text" title={u.name}>{u.name}</div>
                  <div className="text-text-muted">{u.age}</div>
                  {u.lithology && (
                    <div className="truncate text-text-subtle" title={u.lithology}>
                      {u.lithology}
                    </div>
                  )}
                  {u.sourceUrl && (
                    <a
                      href={u.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[10px] text-accent hover:underline"
                      title={u.sourceCitation}
                    >
                      source ↗
                    </a>
                  )}
                </div>
              </li>
            ))}
            {geology.units.length > 6 && (
              <li className="text-text-muted">
                +{geology.units.length - 6} more units (open Macrostrat for full list)
              </li>
            )}
          </ul>
        </div>
      )}

      {/* Vertical strat column — the "visual log" */}
      {geology && geology.strat.length > 0 && (
        <StratLog strat={geology.strat} />
      )}
    </section>
  );
}

/**
 * Visual stratigraphic log — every formation in the nearest Macrostrat
 * column rendered as a stacked vertical bar, sized proportional to
 * thickness (meters), colored by lithology. This is the closest free
 * analogue to a well log for the prospecting workflow: shows what
 * you'd drill through and how thick each unit is.
 */
function StratLog({ strat }: { strat: StratUnit[] }) {
  const withThickness = strat.filter((u) => u.thicknessM && u.thicknessM > 0);
  if (withThickness.length === 0) return null;
  const totalThickness = withThickness.reduce((s, u) => s + (u.thicknessM ?? 0), 0);
  const totalThicknessFt = totalThickness * 3.28084;

  return (
    <div className="mt-4 rounded-md border border-border bg-bg-panel/40 p-3">
      <div className="mb-2 flex items-baseline justify-between">
        <h4 className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
          Stratigraphic log ({withThickness.length} units)
        </h4>
        <span className="font-mono text-[10px] text-text-muted">
          {Math.round(totalThickness).toLocaleString()} m total
          {' '}({Math.round(totalThicknessFt).toLocaleString()} ft)
        </span>
      </div>
      <div className="flex gap-3">
        {/* Vertical scaled bar */}
        <div
          className="relative flex w-12 shrink-0 flex-col overflow-hidden rounded border border-border bg-bg-panel"
          style={{ height: '320px' }}
        >
          {withThickness.map((u, i) => {
            const heightPct = ((u.thicknessM ?? 0) / totalThickness) * 100;
            return (
              <div
                key={i}
                title={`${u.name}: ${Math.round(u.thicknessM ?? 0)} m`}
                style={{
                  height: `${heightPct}%`,
                  backgroundColor: u.color ?? '#666',
                  borderBottom: '1px solid rgba(0,0,0,0.3)',
                }}
              />
            );
          })}
        </div>
        {/* Unit list */}
        <ul className="min-w-0 flex-1 space-y-1 overflow-y-auto font-mono text-[10px]" style={{ maxHeight: '320px' }}>
          {withThickness.map((u, i) => (
            <li key={i} className="flex items-baseline gap-2">
              <span
                aria-hidden
                className="h-2 w-2 shrink-0 rounded-sm border border-border"
                style={{ backgroundColor: u.color ?? '#666' }}
              />
              <span className="min-w-0 flex-1 truncate text-text" title={u.name}>
                {u.name}
              </span>
              <span className="shrink-0 text-text-muted">
                {Math.round(u.thicknessM ?? 0)} m
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className="mt-2 font-mono text-[9px] uppercase tracking-wider text-text-muted">
        Thickness from Macrostrat units API · proportional rendering
      </div>
    </div>
  );
}

// ─── MapLibre layer factory ────────────────────────────────────────────

/** Suffix appended to the registry id for the paired outline line layer
 *  that accompanies every polygon fill. Stays out of click-detection
 *  (only the fill layer is queried) but participates in visibility sync. */
const OUTLINE_SUFFIX = '__outline';

/** Federal-land agency → outline color. Brighter than the fill so the
 *  border reads even when adjacent polygons of different agencies meet. */
const FEDERAL_OUTLINE_BY_AGENCY: maplibregl.ExpressionSpecification = [
  'match',
  ['get', 'agency'],
  'BLM', '#86efac',   // green-300
  'USFS', '#4ade80',  // green-400
  'NPS', '#fbbf24',   // amber-400 (parks contrast warm-on-cool)
  'BIA', '#d8b4fe',   // purple-300
  '#cbd5e1',          // slate-300 fallback
];

/** Build the MapLibre layer specs for a registry entry. Polygon defs
 *  return TWO layers — a fill plus a paired outline line layer — so the
 *  border stays crisp regardless of fill opacity. Points + lines return
 *  one. The first entry is always the click-interactive one. */
function buildLayer(
  def: LayerDef,
  defaultVisible: boolean,
): maplibregl.LayerSpecification[] {
  const visibility = defaultVisible ? 'visible' : 'none';
  const color = def.color ?? '#94a3b8';
  const common = {
    id: def.id,
    source: 'subterra',
    'source-layer': def.tilesetLayer,
    minzoom: def.minZoom,
    layout: { visibility } as { visibility: 'visible' | 'none' },
    // Optional filter expression. Cast widens readonly tuple to
    // maplibre's broad FilterSpecification union.
    ...(def.filter
      ? { filter: def.filter as unknown as maplibregl.FilterSpecification }
      : {}),
  };

  if (def.geometry === 'point') {
    // MRDS dots are color-coded by commodity category so the most useful
    // signal (what mineral) is visible at a glance. Geochemistry samples
    // are graduated by a pathfinder element (As — classic gold vectoring)
    // so anomalies pop. Other point layers just use their registry color.
    const circleColor: maplibregl.DataDrivenPropertyValueSpecification<string> =
      def.tilesetLayer === 'mrds'
        ? mrdsCommodityColorExpr()
        : def.tilesetLayer === 'geochemistry'
          ? geochemColorExpr()
          : color;
    return [{
      ...common,
      type: 'circle',
      paint: {
        // Bigger radii at LOW zoom so country-scale views still show the
        // points. Previous ramp was 3px at z4 — invisible against the
        // dark federal-lands fill. New ramp keeps points readable from
        // continent zoom (3.5px @ z4) up to street zoom (10px @ z14).
        'circle-radius': [
          'interpolate', ['linear'], ['zoom'],
          4, 3.5,
          6, 4.5,
          9, 6,
          14, 10,
        ],
        'circle-color': circleColor,
        // Light stroke for contrast against any underlay (dark map,
        // green federal fill, red hotspot heatmap). A 0.6px white-ish
        // stroke is enough to halo each dot without making the layer
        // feel fuzzy at high zoom.
        'circle-stroke-color': 'rgba(248, 250, 252, 0.85)',
        'circle-stroke-width': [
          'interpolate', ['linear'], ['zoom'],
          4, 0.6,
          10, 1.0,
          14, 1.4,
        ],
        'circle-opacity': 0.95,
      },
    }];
  }
  if (def.geometry === 'line') {
    // PLSS is a cadastral grid — keep it thin enough not to dominate.
    // Pipelines + well laterals are infrastructure and should be the
    // most prominent linear feature when toggled.
    const isCadastral = def.tilesetLayer === 'plss';
    const widthExpr: maplibregl.DataDrivenPropertyValueSpecification<number> = isCadastral
      ? ['interpolate', ['linear'], ['zoom'], 6, 0.4, 12, 1.2]
      : ['interpolate', ['linear'], ['zoom'], 5, 1.2, 9, 2.0, 14, 3.5];
    return [{
      ...common,
      type: 'line',
      paint: {
        'line-color': color,
        'line-width': widthExpr,
        'line-opacity': isCadastral ? 0.55 : 0.9,
      },
    }];
  }

  // Geophysics survey footprints — low-fill coverage overlay with a
  // prominent dashed-feel outline. The point is to show WHERE modern
  // subsurface data exists, so a light teal wash + crisp border reads as
  // "this ground has been flown" without obscuring what's underneath.
  if (def.id === 'geophysics') {
    const fill: maplibregl.LayerSpecification = {
      ...common,
      type: 'fill',
      paint: { 'fill-color': color, 'fill-opacity': 0.12 },
    };
    const outline: maplibregl.LayerSpecification = {
      ...common,
      id: def.id + OUTLINE_SUFFIX,
      type: 'line',
      paint: {
        'line-color': color,
        'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.8, 9, 1.6, 14, 2.4],
        'line-opacity': 0.9,
      },
    };
    return [fill, outline];
  }

  // polygon — federal_lands paints multi-color by agency; hotspots
  // paints a 0-100 score heatmap; everything else uses the registry color.
  if (def.id === 'hotspots') {
    const fill: maplibregl.LayerSpecification = {
      ...common,
      type: 'fill',
      paint: {
        // Cold → hot ramp: gray → yellow → orange → red. Steps match
        // the same break points used in the sidebar Top Hotspots list.
        'fill-color': [
          'interpolate', ['linear'], ['get', 'score'],
          0, '#64748b',   // slate-500 — slightly brighter floor so low cells still read
          15, '#fde047',  // yellow-300 — kicks in earlier so warm cells are obvious
          40, '#f97316',  // orange-500
          65, '#dc2626',  // red-600
          85, '#7f1d1d',  // red-900 — hottest
        ],
        'fill-opacity': [
          'interpolate', ['linear'], ['get', 'score'],
          0, 0.28,    // bumped floor: heatmap stays visible even on cold cells
          100, 0.75,  // bumped ceiling: hot cells dominate the green underlay
        ],
      },
    };
    // Outline lets the cell grid stay visible even when the fill is at
    // 10% opacity (low-score cells). Uses a dark slate so the heatmap
    // reads as discrete cells, not a smeared cloud.
    const outline: maplibregl.LayerSpecification = {
      ...common,
      id: def.id + OUTLINE_SUFFIX,
      type: 'line',
      paint: {
        'line-color': '#0f172a',
        'line-width': 0.4,
        'line-opacity': 0.5,
      },
    };
    return [fill, outline];
  }

  const fillColor: maplibregl.DataDrivenPropertyValueSpecification<string> =
    def.id === 'federal-lands' ? [
      'match',
      ['get', 'agency'],
      'BLM', '#22c55e',
      'USFS', '#16a34a',
      'NPS', '#b45309',
      'BIA', '#9333ea',
      color,
    ] : color;
  // Open BLM Land gets a stronger fill so the "stakeable candidate"
  // signal is visually unmistakable when toggled on; mining claims also
  // get extra emphasis since they're the most actionable layer.
  const isStakeable = def.id === 'open-blm-land';
  const isClaims = def.id === 'mining-claims';
  const fillOpacity = isStakeable ? 0.35 : isClaims ? 0.28 : 0.18;

  const fill: maplibregl.LayerSpecification = {
    ...common,
    type: 'fill',
    paint: {
      'fill-color': fillColor,
      'fill-opacity': fillOpacity,
    },
  };

  // Paired outline. Crisp 1-1.5px border survives even very low fill
  // opacity, which is critical when stacking 3-4 polygon layers (the
  // old fill-outline-color sub-pixel border vanished into the mud).
  // Outline color: federal-lands uses per-agency expression; everything
  // else uses a brightened-up version of the registry color.
  const outlineColor: maplibregl.DataDrivenPropertyValueSpecification<string> =
    def.id === 'federal-lands' ? FEDERAL_OUTLINE_BY_AGENCY : color;
  const outlineWidth: maplibregl.DataDrivenPropertyValueSpecification<number> = isStakeable || isClaims
    ? ['interpolate', ['linear'], ['zoom'], 5, 0.8, 9, 1.4, 14, 2.0]
    : ['interpolate', ['linear'], ['zoom'], 5, 0.4, 9, 0.9, 14, 1.4];
  const outline: maplibregl.LayerSpecification = {
    ...common,
    id: def.id + OUTLINE_SUFFIX,
    type: 'line',
    paint: {
      'line-color': outlineColor,
      'line-width': outlineWidth,
      'line-opacity': 0.85,
    },
  };
  return [fill, outline];
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

/** Graduated color for a geochemistry sample by its arsenic concentration
 *  (ppm). As is the classic gold pathfinder — high values vector toward
 *  buried mineralization. Cool→hot ramp surfaces anomalies. Samples with
 *  no As reading fall back to the registry violet so they're still
 *  visible as "sampled here, no anomaly". */
function geochemColorExpr(): maplibregl.DataDrivenPropertyValueSpecification<string> {
  return [
    'case',
    ['has', 'as_ppm'],
    [
      'interpolate', ['linear'], ['to-number', ['get', 'as_ppm'], 0],
      0, '#1e3a8a',    // blue-900 background
      10, '#0891b2',   // cyan-600
      30, '#facc15',   // yellow-400
      80, '#f97316',   // orange-500
      200, '#dc2626',  // red-600 — strong anomaly
    ],
    '#a78bfa', // violet fallback (no As reading)
  ] as unknown as maplibregl.DataDrivenPropertyValueSpecification<string>;
}
