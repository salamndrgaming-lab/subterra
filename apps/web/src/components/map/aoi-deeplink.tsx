'use client';

import { useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import mapboxgl, { type Map as MapboxMap, type GeoJSONSource } from 'mapbox-gl';
import { api, type SavedAoi } from '@/lib/api';

/**
 * If the URL contains `?aoi=<id>`, fetch the AOI from the API, render its
 * outline on the map, and fly to its bounding box. The component renders
 * nothing — it is a side-effect anchor.
 */
export function AoiDeeplink({ map }: { map: MapboxMap | null }) {
  const params = useSearchParams();
  const aoiId = params.get('aoi');

  const aoiQuery = useQuery({
    queryKey: ['aoi', aoiId],
    queryFn: () => api.aois.list().then((r) => r.aois.find((a) => a.id === aoiId) ?? null),
    enabled: !!aoiId,
  });

  useEffect(() => {
    if (!map || !aoiQuery.data) return;
    const aoi = aoiQuery.data;
    const apply = () => renderAoi(map, aoi);
    if (map.isStyleLoaded()) apply();
    else map.once('load', apply);
  }, [map, aoiQuery.data]);

  return null;
}

function renderAoi(map: MapboxMap, aoi: SavedAoi) {
  const sourceId = 'saved-aoi';
  const fillId = 'saved-aoi-fill';
  const lineId = 'saved-aoi-line';

  const data: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: aoi.geom, properties: { name: aoi.name, id: aoi.id } }],
  };

  const existing = map.getSource(sourceId) as GeoJSONSource | undefined;
  if (existing) {
    existing.setData(data);
  } else {
    map.addSource(sourceId, { type: 'geojson', data });
    map.addLayer({
      id: fillId,
      type: 'fill',
      source: sourceId,
      paint: { 'fill-color': '#f59e0b', 'fill-opacity': 0.12 },
    });
    map.addLayer({
      id: lineId,
      type: 'line',
      source: sourceId,
      paint: { 'line-color': '#f59e0b', 'line-width': 2, 'line-dasharray': [3, 2] },
    });
  }

  const bounds = computeBounds(aoi.geom.coordinates);
  if (bounds) {
    map.fitBounds(bounds, { padding: 80, duration: 800 });
  }
}

function computeBounds(coords: number[][][][]): mapboxgl.LngLatBoundsLike | null {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const polygon of coords) {
    for (const ring of polygon) {
      for (const pt of ring) {
        if (pt.length < 2) continue;
        const [x, y] = pt;
        if (x! < w) w = x!;
        if (x! > e) e = x!;
        if (y! < s) s = y!;
        if (y! > n) n = y!;
      }
    }
  }
  if (!Number.isFinite(w) || !Number.isFinite(e) || !Number.isFinite(s) || !Number.isFinite(n)) return null;
  return [[w, s], [e, n]];
}
