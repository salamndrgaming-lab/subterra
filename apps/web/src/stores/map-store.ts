'use client';

import { create } from 'zustand';
import { LAYER_DEFINITIONS } from '@subterra/shared';

export interface ViewState {
  longitude: number;
  latitude: number;
  zoom: number;
  bearing: number;
  pitch: number;
}

export type LayerVisibility = Record<string, boolean>;

export interface LayerFilters {
  state?: string;
  county?: string;
  commodity?: string;
  status?: string;
}

export type SelectedFeature =
  | { kind: 'well'; id: string }
  | { kind: 'claim'; id: string }
  | { kind: 'parcel'; id: string }
  | { kind: 'occurrence'; id: string }
  | null;

interface MapStoreState {
  view: ViewState;
  setView: (v: Partial<ViewState>) => void;

  layerVisibility: LayerVisibility;
  toggleLayer: (id: string) => void;
  setLayerVisible: (id: string, visible: boolean) => void;

  filters: LayerFilters;
  setFilters: (f: Partial<LayerFilters>) => void;
  clearFilters: () => void;

  selected: SelectedFeature;
  selectFeature: (f: SelectedFeature) => void;

  drawingAoi: boolean;
  setDrawingAoi: (b: boolean) => void;

  /** Most recently drawn polygon in GeoJSON form (set by MapboxDraw events). */
  drawnPolygon: { type: 'Polygon'; coordinates: number[][][] } | null;
  setDrawnPolygon: (p: { type: 'Polygon'; coordinates: number[][][] } | null) => void;

  /** Live Mapbox instance; set by MapView once the map mounts. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mapInstance: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setMapInstance: (m: any) => void;

  bottomPanelOpen: boolean;
  setBottomPanelOpen: (b: boolean) => void;

  sidebarOpen: boolean;
  setSidebarOpen: (b: boolean) => void;
}

const defaultLayerVisibility: LayerVisibility = Object.fromEntries(
  LAYER_DEFINITIONS.map((l) => [l.id, l.defaultVisible]),
);

// Default view: central Nevada mining belt — Tonopah / Round Mountain.
// At zoom 7 the OSM mining + oil/gas Overpass queries return real features
// within a few hundred ms, so the first paint shows live data, not an
// empty basemap.
const DEFAULT_VIEW: ViewState = {
  longitude: -117.06,
  latitude: 38.66,
  zoom: 7.5,
  bearing: 0,
  pitch: 0,
};

export const useMapStore = create<MapStoreState>((set) => ({
  view: DEFAULT_VIEW,
  setView: (v) => set((state) => ({ view: { ...state.view, ...v } })),

  layerVisibility: defaultLayerVisibility,
  toggleLayer: (id) =>
    set((state) => ({ layerVisibility: { ...state.layerVisibility, [id]: !state.layerVisibility[id] } })),
  setLayerVisible: (id, visible) =>
    set((state) => ({ layerVisibility: { ...state.layerVisibility, [id]: visible } })),

  filters: {},
  setFilters: (f) => set((state) => ({ filters: { ...state.filters, ...f } })),
  clearFilters: () => set({ filters: {} }),

  selected: null,
  selectFeature: (f) => set({ selected: f }),

  drawingAoi: false,
  setDrawingAoi: (b) => set({ drawingAoi: b }),

  drawnPolygon: null,
  setDrawnPolygon: (p) => set({ drawnPolygon: p }),

  mapInstance: null,
  setMapInstance: (m) => set({ mapInstance: m }),

  bottomPanelOpen: true,
  setBottomPanelOpen: (b) => set({ bottomPanelOpen: b }),

  sidebarOpen: true,
  setSidebarOpen: (b) => set({ sidebarOpen: b }),
}));
