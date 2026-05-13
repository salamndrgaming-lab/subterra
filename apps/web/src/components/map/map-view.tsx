'use client';

import { useEffect, useRef } from 'react';
import maplibregl, { type Map as MapLibreMap, type GeoJSONSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';
import { useQuery } from '@tanstack/react-query';
import { DATA_SOURCES } from '@subterra/shared';
import { useMapStore } from '@/stores/map-store';
import { api } from '@/lib/api';

// mapbox-gl-draw expects a global `mapboxgl`; satisfy with maplibre-gl so
// we can reuse the polished Mapbox draw control without paying for Mapbox.
if (typeof window !== 'undefined' && !(window as unknown as { mapboxgl?: unknown }).mapboxgl) {
  (window as unknown as { mapboxgl: unknown }).mapboxgl = maplibregl;
}
// eslint-disable-next-line import/order
import MapboxDraw from '@mapbox/mapbox-gl-draw';

const MAP_STYLE = process.env.NEXT_PUBLIC_MAP_STYLE_URL ?? DATA_SOURCES.basemap.darkStyle;

export function MapView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const drawRef = useRef<MapboxDraw | null>(null);

  const view = useMapStore((s) => s.view);
  const setView = useMapStore((s) => s.setView);
  const layerVisibility = useMapStore((s) => s.layerVisibility);
  const filters = useMapStore((s) => s.filters);
  const selectFeature = useMapStore((s) => s.selectFeature);
  const drawingAoi = useMapStore((s) => s.drawingAoi);
  const setDrawnPolygon = useMapStore((s) => s.setDrawnPolygon);
  const setMapInstance = useMapStore((s) => s.setMapInstance);

  const rasterCatalog = useQuery({
    queryKey: ['rasters'],
    queryFn: () => api.sources.rasters(),
    staleTime: 24 * 60 * 60 * 1000,
  });

  // Data
  const wellsQuery = useQuery({
    queryKey: ['layers', 'wells', filters],
    queryFn: () => api.layers.wells({ state: filters.state, county: filters.county, status: filters.status }),
  });
  const claimsQuery = useQuery({
    queryKey: ['layers', 'claims', filters],
    queryFn: () => api.layers.claims({ state: filters.state, county: filters.county, status: filters.status, commodity: filters.commodity }),
  });
  const occQuery = useQuery({
    queryKey: ['layers', 'mineral-occurrences', filters],
    queryFn: () => api.layers.mineralOccurrences({ state: filters.state, commodity: filters.commodity }),
  });
  const lateralsQuery = useQuery({
    queryKey: ['layers', 'well-laterals', filters],
    queryFn: () => api.layers.wellLaterals({ state: filters.state, limit: 800 }),
    enabled: !!layerVisibility['well-laterals'],
  });

  // OSM features are queried with a bbox derived from the current view.
  // We compute a half-degree window that scales with zoom but is clamped to
  // a maximum 8° span (Overpass times out on country-sized bboxes).
  const osmBbox: [number, number, number, number] = (() => {
    const rawHalf = 180 / Math.pow(2, view.zoom);
    const halfDeg = Math.min(rawHalf, 4);
    return [
      Math.floor(view.longitude - halfDeg),
      Math.floor(view.latitude - halfDeg),
      Math.ceil(view.longitude + halfDeg),
      Math.ceil(view.latitude + halfDeg),
    ];
  })();
  const osmMiningQuery = useQuery({
    queryKey: ['layers', 'osm-mines', osmBbox],
    queryFn: () => api.layers.osmFeatures('mining', osmBbox),
    enabled: !!layerVisibility['osm-mines'] && view.zoom >= 5,
    staleTime: 10 * 60 * 1000,
  });
  const osmOilGasQuery = useQuery({
    queryKey: ['layers', 'osm-oilgas', osmBbox],
    queryFn: () => api.layers.osmFeatures('oilgas', osmBbox),
    enabled: !!layerVisibility['osm-oilgas'] && view.zoom >= 5,
    staleTime: 10 * 60 * 1000,
  });

  // Init map
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAP_STYLE,
      center: [view.longitude, view.latitude],
      zoom: view.zoom,
      bearing: view.bearing,
      pitch: view.pitch,
      attributionControl: false,
    });

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-left');
    map.addControl(
      new maplibregl.AttributionControl({
        compact: true,
        customAttribution:
          '<a href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a> · <a href="https://openmaptiles.org" target="_blank" rel="noreferrer">OpenMapTiles</a> · © OpenStreetMap',
      }),
      'bottom-right',
    );

    map.on('load', () => {
      // USGS PAD-US (Protected Areas Database) — covers federal lands
      // including BLM, USFS, NPS, etc. Cached XYZ tiles via ArcGIS REST.
      // This replaces the dynamic /export?bbox=... pattern which didn't
      // render reliably through MapLibre's bbox template.
      map.addSource('blm-sma', {
        type: 'raster',
        tiles: [
          'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
        ],
        tileSize: 256,
      });
      map.addLayer({
        id: 'blm-surface-mgmt',
        type: 'raster',
        source: 'blm-sma',
        paint: { 'raster-opacity': 0.40 },
        layout: { visibility: 'none' },
      });

      // PLSS — switch to the cached BLM PLSS tiles. The /tile endpoint is
      // not available for the dynamic PLSS service, so this remains
      // /export with WebMercator bbox template. MapLibre 5.x handles it
      // when the source is configured with `tileSize: 512` and bbox is
      // requested in EPSG:3857.
      map.addSource('plss', {
        type: 'raster',
        tiles: [
          `${DATA_SOURCES.blm.plssCadnsdi}/export?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=512,512&dpi=96&format=png32&transparent=true&f=image`,
        ],
        tileSize: 512,
      });
      map.addLayer({
        id: 'plss-grid',
        type: 'raster',
        source: 'plss',
        minzoom: 8,
        paint: { 'raster-opacity': 0.6 },
        layout: { visibility: 'none' },
      });

      // USGS topo overlay — cached XYZ tiles (definitely works).
      map.addSource('usgs-topo', {
        type: 'raster',
        tiles: [
          'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}',
        ],
        tileSize: 256,
      });
      map.addLayer({
        id: 'topo',
        type: 'raster',
        source: 'usgs-topo',
        paint: { 'raster-opacity': 0.5 },
        layout: { visibility: 'none' },
      });

      // empty geojson sources for app data — populated by the effect below
      map.addSource('wells', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addSource('claims', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addSource('mineral-occurrences', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addSource('well-laterals', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addSource('osm-mines', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addSource('osm-oilgas', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

      // OSM mining/quarry features — orange-amber points + polygon outlines
      map.addLayer({
        id: 'osm-mines',
        type: 'circle',
        source: 'osm-mines',
        filter: ['==', ['geometry-type'], 'Point'],
        minzoom: 5,
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 3, 13, 7],
          'circle-color': '#f59e0b',
          'circle-stroke-color': '#0a0c10',
          'circle-stroke-width': 1,
          'circle-opacity': 0.9,
        },
        layout: { visibility: 'visible' },
      });
      map.addLayer({
        id: 'osm-mines-polys',
        type: 'fill',
        source: 'osm-mines',
        filter: ['==', ['geometry-type'], 'Polygon'],
        minzoom: 5,
        paint: { 'fill-color': '#f59e0b', 'fill-opacity': 0.18, 'fill-outline-color': '#f59e0b' },
        layout: { visibility: 'visible' },
      });

      // OSM oil/gas surface infrastructure — emerald points + polygons
      map.addLayer({
        id: 'osm-oilgas',
        type: 'circle',
        source: 'osm-oilgas',
        filter: ['==', ['geometry-type'], 'Point'],
        minzoom: 5,
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 3, 13, 7],
          'circle-color': '#10b981',
          'circle-stroke-color': '#0a0c10',
          'circle-stroke-width': 1,
          'circle-opacity': 0.9,
        },
        layout: { visibility: 'visible' },
      });
      map.addLayer({
        id: 'osm-oilgas-polys',
        type: 'fill',
        source: 'osm-oilgas',
        filter: ['==', ['geometry-type'], 'Polygon'],
        minzoom: 5,
        paint: { 'fill-color': '#10b981', 'fill-opacity': 0.15, 'fill-outline-color': '#10b981' },
        layout: { visibility: 'visible' },
      });

      map.addLayer({
        id: 'well-laterals',
        type: 'line',
        source: 'well-laterals',
        minzoom: 9,
        paint: {
          'line-color': '#10b981',
          'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.6, 13, 1.6],
          'line-opacity': 0.85,
        },
        layout: { visibility: 'none' },
      });

      // wells — split into active/plugged/permitted by data-driven styling
      map.addLayer({
        id: 'wells-active',
        type: 'circle',
        source: 'wells',
        filter: ['==', ['get', 'status'], 'active'],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 2, 12, 6],
          'circle-color': '#10b981',
          'circle-stroke-color': '#0a0c10',
          'circle-stroke-width': 1,
        },
      });
      map.addLayer({
        id: 'wells-plugged',
        type: 'circle',
        source: 'wells',
        filter: ['==', ['get', 'status'], 'plugged'],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 2, 12, 5],
          'circle-color': '#64748b',
          'circle-stroke-color': '#0a0c10',
          'circle-stroke-width': 1,
        },
      });
      map.addLayer({
        id: 'wells-permitted',
        type: 'circle',
        source: 'wells',
        filter: ['==', ['get', 'status'], 'permitted'],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 2, 12, 6],
          'circle-color': '#f59e0b',
          'circle-stroke-color': '#0a0c10',
          'circle-stroke-width': 1,
        },
      });

      // mining claims — fill polygons split by status
      map.addLayer({
        id: 'claims-active',
        type: 'fill',
        source: 'claims',
        filter: ['==', ['get', 'status'], 'active'],
        paint: {
          'fill-color': '#f59e0b',
          'fill-opacity': 0.18,
          'fill-outline-color': '#f59e0b',
        },
      });
      map.addLayer({
        id: 'claims-active-outline',
        type: 'line',
        source: 'claims',
        filter: ['==', ['get', 'status'], 'active'],
        paint: { 'line-color': '#f59e0b', 'line-width': 1.2 },
      });
      map.addLayer({
        id: 'claims-closed',
        type: 'fill',
        source: 'claims',
        filter: ['==', ['get', 'status'], 'closed'],
        paint: { 'fill-color': '#64748b', 'fill-opacity': 0.12, 'fill-outline-color': '#64748b' },
      });

      // USGS MRDS occurrences
      map.addLayer({
        id: 'mineral-occurrences',
        type: 'circle',
        source: 'mineral-occurrences',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 3, 10, 7],
          'circle-color': '#3b82f6',
          'circle-stroke-color': '#0a0c10',
          'circle-stroke-width': 1,
          'circle-opacity': 0.85,
        },
      });

      // hover cursor
      const interactiveLayers = ['wells-active', 'wells-plugged', 'wells-permitted', 'claims-active', 'claims-closed', 'mineral-occurrences', 'osm-mines', 'osm-mines-polys', 'osm-oilgas', 'osm-oilgas-polys'];
      for (const id of interactiveLayers) {
        map.on('mouseenter', id, () => (map.getCanvas().style.cursor = 'pointer'));
        map.on('mouseleave', id, () => (map.getCanvas().style.cursor = ''));
      }

      // click handlers — extract the natural identifier per layer (API number,
      // BLM serial, MRDS dep_id) so detail routes can query upstream sources.
      map.on('click', (e) => {
        const features = map.queryRenderedFeatures(e.point, { layers: interactiveLayers });
        const feature = features[0];
        if (!feature) {
          selectFeature(null);
          return;
        }
        const props = feature.properties ?? {};
        if (feature.layer.id.startsWith('wells')) {
          const id = String(props['apiNumber'] ?? props['api_number'] ?? '');
          if (id) selectFeature({ kind: 'well', id });
        } else if (feature.layer.id.startsWith('claims')) {
          const id = String(props['serialNumber'] ?? props['serial_number'] ?? '');
          if (id) selectFeature({ kind: 'claim', id });
        } else if (feature.layer.id === 'mineral-occurrences') {
          const id = String(props['mrdsId'] ?? props['mrds_id'] ?? '');
          if (id) selectFeature({ kind: 'occurrence', id });
        } else if (feature.layer.id.startsWith('osm-')) {
          // OSM features don't have a server-side detail route; pop a
          // MapLibre popup with the on-feature tags + a link to OSM.
          const osmId = String(props['osmId'] ?? '');
          const name = String(props['name'] ?? 'Unnamed');
          const resource = props['resource'] ? String(props['resource']) : null;
          const operator = props['operator'] ? String(props['operator']) : null;
          const lngLat = (feature.geometry as { type: string; coordinates: [number, number] }).type === 'Point'
            ? (feature.geometry as { coordinates: [number, number] }).coordinates
            : [e.lngLat.lng, e.lngLat.lat];
          const html = `
            <div style="font-family:ui-monospace,monospace;font-size:11px;line-height:1.4">
              <div style="color:#f59e0b;font-weight:600;margin-bottom:4px;text-transform:uppercase;letter-spacing:.05em;font-size:10px">${feature.layer.id.includes('mines') ? 'OSM mine' : 'OSM oil/gas'}</div>
              <div style="color:#e2e8f0;font-size:13px;margin-bottom:6px">${escapeHtml(name)}</div>
              ${resource ? `<div style="color:#94a3b8">resource: <span style="color:#e2e8f0">${escapeHtml(resource)}</span></div>` : ''}
              ${operator ? `<div style="color:#94a3b8">operator: <span style="color:#e2e8f0">${escapeHtml(operator)}</span></div>` : ''}
              <div style="margin-top:6px">
                <a href="https://www.openstreetmap.org/${osmId}" target="_blank" rel="noreferrer" style="color:#f59e0b;text-decoration:underline">view on OSM →</a>
              </div>
            </div>`;
          new maplibregl.Popup({ closeOnClick: true, maxWidth: '280px' })
            .setLngLat(lngLat as [number, number])
            .setHTML(html)
            .addTo(map);
        }
      });
    });

    map.on('moveend', () => {
      const c = map.getCenter();
      setView({ longitude: c.lng, latitude: c.lat, zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() });
    });

    // MapboxDraw — installed lazily once the style is loaded.
    map.once('load', () => {
      const draw = new MapboxDraw({
        displayControlsDefault: false,
        controls: { polygon: true, trash: true },
        defaultMode: 'simple_select',
        styles: drawStyles,
      });
      map.addControl(draw, 'top-right');
      drawRef.current = draw;

      const emit = () => {
        const fc = draw.getAll();
        const polygon = fc.features.find((f) => f.geometry.type === 'Polygon');
        if (polygon) {
          setDrawnPolygon(polygon.geometry as { type: 'Polygon'; coordinates: number[][][] });
        } else {
          setDrawnPolygon(null);
        }
      };
      map.on('draw.create', emit);
      map.on('draw.update', emit);
      map.on('draw.delete', emit);
    });

    mapRef.current = map;
    setMapInstance(map);
    return () => {
      setMapInstance(null);
      map.remove();
      mapRef.current = null;
      drawRef.current = null;
    };
    // we intentionally only run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Toggle draw mode based on store state.
  useEffect(() => {
    const draw = drawRef.current;
    if (!draw) return;
    if (drawingAoi) draw.changeMode('draw_polygon');
    else draw.changeMode('simple_select');
  }, [drawingAoi]);

  // Register dynamic raster overlays (federal lands + pipelines) once the
  // catalog has loaded. Each entry is added as an ArcGIS export-image raster
  // tile source so visibility can be toggled from the sidebar.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !rasterCatalog.data) return;
    const install = () => {
      const all = [
        ...rasterCatalog.data!.federalLands,
        ...rasterCatalog.data!.leases,
        ...rasterCatalog.data!.pipelines,
      ];
      for (const r of all) {
        if (map.getSource(r.id)) continue;
        map.addSource(r.id, {
          type: 'raster',
          tiles: [
            `${r.mapServer}/export?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=512,512&dpi=96&format=png32&transparent=true&f=image`,
          ],
          tileSize: 512,
          attribution: r.attribution,
        });
        map.addLayer({
          id: r.id,
          type: 'raster',
          source: r.id,
          minzoom: r.minZoom,
          paint: { 'raster-opacity': r.opacity },
          layout: { visibility: 'none' },
        });
      }
    };
    if (map.isStyleLoaded()) install();
    else map.once('load', install);
  }, [rasterCatalog.data]);

  // sync layer visibility
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const apply = () => {
      for (const [id, visible] of Object.entries(layerVisibility)) {
        if (map.getLayer(id)) {
          map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
        }
        if (id === 'claims-active' && map.getLayer('claims-active-outline')) {
          map.setLayoutProperty('claims-active-outline', 'visibility', visible ? 'visible' : 'none');
        }
        // OSM layers each have a point + polygon companion that toggles together.
        if (id === 'osm-mines' && map.getLayer('osm-mines-polys')) {
          map.setLayoutProperty('osm-mines-polys', 'visibility', visible ? 'visible' : 'none');
        }
        if (id === 'osm-oilgas' && map.getLayer('osm-oilgas-polys')) {
          map.setLayoutProperty('osm-oilgas-polys', 'visibility', visible ? 'visible' : 'none');
        }
      }
    };
    apply();
  }, [layerVisibility]);

  // sync data sources
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const update = () => {
      const wellsSrc = map.getSource('wells') as GeoJSONSource | undefined;
      if (wellsSrc && wellsQuery.data) wellsSrc.setData(wellsQuery.data as GeoJSON.FeatureCollection);
      const claimsSrc = map.getSource('claims') as GeoJSONSource | undefined;
      if (claimsSrc && claimsQuery.data) claimsSrc.setData(claimsQuery.data as GeoJSON.FeatureCollection);
      const occSrc = map.getSource('mineral-occurrences') as GeoJSONSource | undefined;
      if (occSrc && occQuery.data) occSrc.setData(occQuery.data as GeoJSON.FeatureCollection);
      const latSrc = map.getSource('well-laterals') as GeoJSONSource | undefined;
      if (latSrc && lateralsQuery.data) latSrc.setData(lateralsQuery.data as GeoJSON.FeatureCollection);
      const osmMinesSrc = map.getSource('osm-mines') as GeoJSONSource | undefined;
      if (osmMinesSrc && osmMiningQuery.data) osmMinesSrc.setData(osmMiningQuery.data as GeoJSON.FeatureCollection);
      const osmOilSrc = map.getSource('osm-oilgas') as GeoJSONSource | undefined;
      if (osmOilSrc && osmOilGasQuery.data) osmOilSrc.setData(osmOilGasQuery.data as GeoJSON.FeatureCollection);
    };
    if (map.isStyleLoaded()) update();
    else map.once('load', update);
  }, [wellsQuery.data, claimsQuery.data, occQuery.data, lateralsQuery.data, osmMiningQuery.data, osmOilGasQuery.data]);

  return <div ref={containerRef} className="absolute inset-0 h-full w-full" />;
}

/**
 * Dark-theme overrides for MapboxDraw. Default styles use light/blue colors
 * that wash out against our base-dark cartography.
 */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
}

const drawStyles = [
  {
    id: 'gl-draw-polygon-fill-active',
    type: 'fill',
    filter: ['all', ['==', '$type', 'Polygon'], ['==', 'active', 'true']],
    paint: { 'fill-color': '#f59e0b', 'fill-opacity': 0.15 },
  },
  {
    id: 'gl-draw-polygon-stroke-active',
    type: 'line',
    filter: ['all', ['==', '$type', 'Polygon'], ['==', 'active', 'true']],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#f59e0b', 'line-dasharray': [0.4, 2], 'line-width': 2 },
  },
  {
    id: 'gl-draw-polygon-fill-inactive',
    type: 'fill',
    filter: ['all', ['==', 'active', 'false'], ['==', '$type', 'Polygon']],
    paint: { 'fill-color': '#f59e0b', 'fill-opacity': 0.1 },
  },
  {
    id: 'gl-draw-polygon-stroke-inactive',
    type: 'line',
    filter: ['all', ['==', 'active', 'false'], ['==', '$type', 'Polygon']],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#f59e0b', 'line-width': 1.5 },
  },
  {
    id: 'gl-draw-polygon-and-line-vertex',
    type: 'circle',
    filter: ['all', ['==', 'meta', 'vertex'], ['==', '$type', 'Point']],
    paint: { 'circle-radius': 5, 'circle-color': '#0a0c10', 'circle-stroke-color': '#f59e0b', 'circle-stroke-width': 2 },
  },
];
