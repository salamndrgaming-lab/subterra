/** Layer registry. Single source of truth for both the web app's sidebar
 * and the ETL pipeline — the ETL emits one tippecanoe layer per entry
 * with the matching `tilesetLayer` id, and the web app's MapLibre style
 * references the same id. */

export interface LayerDef {
  id: string;
  label: string;
  group: 'federal' | 'cadastral' | 'oilgas' | 'mining' | 'infrastructure';
  defaultVisible: boolean;
  /** Tippecanoe layer id inside the PMTiles file. */
  tilesetLayer: string;
  /** GeoJSON geometry kind painted by this layer. */
  geometry: 'point' | 'line' | 'polygon';
  /** Minimum zoom at which the layer renders. */
  minZoom: number;
}

export const LAYERS: readonly LayerDef[] = [
  // federal lands
  {
    id: 'federal-lands',
    label: 'Federal Lands (BLM · USFS · NPS · BIA)',
    group: 'federal',
    defaultVisible: true,
    tilesetLayer: 'federal_lands',
    geometry: 'polygon',
    minZoom: 4,
  },

  // cadastral
  {
    id: 'plss',
    label: 'PLSS Township/Range/Section',
    group: 'cadastral',
    defaultVisible: true,
    tilesetLayer: 'plss',
    geometry: 'line',
    minZoom: 8,
  },

  // mining
  {
    id: 'mining-claims',
    label: 'BLM Mining Claims (active)',
    group: 'mining',
    defaultVisible: true,
    tilesetLayer: 'mining_claims',
    geometry: 'polygon',
    minZoom: 5,
  },
  {
    id: 'mrds',
    label: 'USGS Mineral Occurrences',
    group: 'mining',
    defaultVisible: true,
    tilesetLayer: 'mrds',
    geometry: 'point',
    minZoom: 4,
  },
  {
    id: 'open-blm-land',
    label: 'Open BLM Land (stake-able)',
    group: 'mining',
    defaultVisible: false,
    tilesetLayer: 'open_blm_land',
    geometry: 'polygon',
    minZoom: 6,
  },

  // oilgas
  {
    id: 'wells',
    label: 'Oil & Gas Wells',
    group: 'oilgas',
    defaultVisible: true,
    tilesetLayer: 'wells',
    geometry: 'point',
    minZoom: 6,
  },
  {
    id: 'well-laterals',
    label: 'Wellbore Laterals',
    group: 'oilgas',
    defaultVisible: false,
    tilesetLayer: 'well_laterals',
    geometry: 'line',
    minZoom: 9,
  },
  {
    id: 'leases',
    label: 'BLM Federal O&G Leases',
    group: 'oilgas',
    defaultVisible: false,
    tilesetLayer: 'leases',
    geometry: 'polygon',
    minZoom: 6,
  },

  // infrastructure
  {
    id: 'pipelines-natgas',
    label: 'Natural Gas Pipelines',
    group: 'infrastructure',
    defaultVisible: false,
    tilesetLayer: 'pipelines_natgas',
    geometry: 'line',
    minZoom: 5,
  },
  {
    id: 'pipelines-crude',
    label: 'Crude Oil Pipelines',
    group: 'infrastructure',
    defaultVisible: false,
    tilesetLayer: 'pipelines_crude',
    geometry: 'line',
    minZoom: 5,
  },
] as const;

export const LAYER_GROUPS: Record<LayerDef['group'], string> = {
  federal: 'Federal Lands',
  cadastral: 'Cadastral',
  oilgas: 'Oil & Gas',
  mining: 'Mining',
  infrastructure: 'Infrastructure',
};
