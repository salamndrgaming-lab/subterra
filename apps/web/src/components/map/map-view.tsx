'use client';

import { useEffect, useRef } from 'react';
import mapboxgl, { type Map as MapboxMap, type GeoJSONSource } from 'mapbox-gl';
import MapboxDraw from '@mapbox/mapbox-gl-draw';
import 'mapbox-gl/dist/mapbox-gl.css';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';
import { useQuery } from '@tanstack/react-query';
import { DATA_SOURCES } from '@subterra/shared';
import { useMapStore } from '@/stores/map-store';
import { api } from '@/lib/api';

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? '';
const MAPBOX_STYLE = process.env.NEXT_PUBLIC_MAPBOX_STYLE ?? DATA_SOURCES.mapbox.darkStyle;

export function MapView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapboxMap | null>(null);
  const drawRef = useRef<MapboxDraw | null>(null);

  const view = useMapStore((s) => s.view);
  const setView = useMapStore((s) => s.setView);
  const layerVisibility = useMapStore((s) => s.layerVisibility);
  const filters = useMapStore((s) => s.filters);
  const selectFeature = useMapStore((s) => s.selectFeature);
  const drawingAoi = useMapStore((s) => s.drawingAoi);
  const setDrawnPolygon = useMapStore((s) => s.setDrawnPolygon);

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

  // Init map
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    if (!MAPBOX_TOKEN) {
      // Render a placeholder if no token; the rest of the dashboard still works.
      console.warn('[map] NEXT_PUBLIC_MAPBOX_TOKEN not set — map will not render.');
      return;
    }

    mapboxgl.accessToken = MAPBOX_TOKEN;

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: MAPBOX_STYLE,
      center: [view.longitude, view.latitude],
      zoom: view.zoom,
      bearing: view.bearing,
      pitch: view.pitch,
      attributionControl: false,
    });

    map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), 'top-right');
    map.addControl(new mapboxgl.ScaleControl({ unit: 'imperial' }), 'bottom-left');
    map.addControl(new mapboxgl.AttributionControl({ compact: true }), 'bottom-right');

    map.on('load', () => {
      // BLM SMA — surface management areas via ArcGIS REST tile export
      map.addSource('blm-sma', {
        type: 'raster',
        tiles: [
          `${DATA_SOURCES.blm.surfaceManagement}/export?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=512,512&dpi=96&format=png32&transparent=true&f=image`,
        ],
        tileSize: 512,
      });
      map.addLayer({
        id: 'blm-surface-mgmt',
        type: 'raster',
        source: 'blm-sma',
        paint: { 'raster-opacity': 0.55 },
        layout: { visibility: 'visible' },
      });

      // PLSS grid
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
        layout: { visibility: 'visible' },
      });

      // USGS topo overlay
      map.addSource('usgs-topo', {
        type: 'raster',
        tiles: [
          `${DATA_SOURCES.usgs.topo}/export?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=512,512&dpi=96&format=png32&transparent=true&f=image`,
        ],
        tileSize: 512,
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
      const interactiveLayers = ['wells-active', 'wells-plugged', 'wells-permitted', 'claims-active', 'claims-closed', 'mineral-occurrences'];
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
    return () => {
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
      const all = [...rasterCatalog.data!.federalLands, ...rasterCatalog.data!.pipelines];
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
    };
    if (map.isStyleLoaded()) update();
    else map.once('load', update);
  }, [wellsQuery.data, claimsQuery.data, occQuery.data]);

  if (!MAPBOX_TOKEN) {
    return <MapPlaceholder />;
  }

  return <div ref={containerRef} className="absolute inset-0 h-full w-full" />;
}

function MapPlaceholder() {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-bg-surface">
      <div className="max-w-md rounded-lg border border-border bg-bg-panel p-6 text-center font-mono text-xs text-text-subtle">
        <div className="mb-2 font-display text-base text-text">Mapbox token missing</div>
        Set <code className="text-accent">NEXT_PUBLIC_MAPBOX_TOKEN</code> in <code>.env.local</code> and reload.
      </div>
    </div>
  );
}

/**
 * Dark-theme overrides for MapboxDraw. Default styles use light/blue colors
 * that wash out against our base-dark cartography.
 */
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
