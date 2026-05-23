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
  /** Layer-specific paint color (overrides the group default). Hex like #f59e0b. */
  color?: string;
}

export const LAYERS: readonly LayerDef[] = [
  // federal lands — painted multi-color by agency (special case in Map.tsx),
  // the `color` field here is ignored.
  {
    id: 'federal-lands',
    label: 'Federal Lands (BLM · USFS · NPS · BIA)',
    group: 'federal',
    defaultVisible: true,
    tilesetLayer: 'federal_lands',
    geometry: 'polygon',
    minZoom: 4,
    color: '#22c55e',
  },

  // cadastral
  {
    id: 'plss',
    label: 'PLSS Townships',
    group: 'cadastral',
    defaultVisible: false,
    tilesetLayer: 'plss',
    geometry: 'line',
    minZoom: 6,
    color: '#64748b', // slate
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
    color: '#f59e0b', // amber — keep miner's mark for claim activity
  },
  {
    id: 'mrds',
    label: 'USGS Mineral Occurrences',
    group: 'mining',
    defaultVisible: true,
    tilesetLayer: 'mrds',
    geometry: 'point',
    minZoom: 4,
    // MRDS dots are color-coded by commodity category (Map.tsx special-cases);
    // this fallback is used when the commodity is unknown.
    color: '#94a3b8',
  },
  {
    id: 'open-blm-land',
    label: 'Open BLM Land (stake-able)',
    group: 'mining',
    defaultVisible: false,
    tilesetLayer: 'open_blm_land',
    geometry: 'polygon',
    minZoom: 6,
    color: '#a3e635', // lime — the staking target
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
    color: '#10b981', // emerald
  },
  {
    id: 'well-laterals',
    label: 'Wellbore Laterals',
    group: 'oilgas',
    defaultVisible: false,
    tilesetLayer: 'well_laterals',
    geometry: 'line',
    minZoom: 9,
    color: '#14b8a6', // teal
  },
  {
    id: 'leases',
    label: 'BLM Federal O&G Leases',
    group: 'oilgas',
    defaultVisible: false,
    tilesetLayer: 'leases',
    geometry: 'polygon',
    minZoom: 6,
    color: '#06b6d4', // cyan
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
    color: '#60a5fa', // sky-blue
  },
  {
    id: 'pipelines-crude',
    label: 'Crude Oil Pipelines',
    group: 'infrastructure',
    defaultVisible: false,
    tilesetLayer: 'pipelines_crude',
    geometry: 'line',
    minZoom: 5,
    color: '#dc2626', // red
  },
] as const;

export const LAYER_GROUPS: Record<LayerDef['group'], string> = {
  federal: 'Federal Lands',
  cadastral: 'Cadastral',
  oilgas: 'Oil & Gas',
  mining: 'Mining',
  infrastructure: 'Infrastructure',
};

/** Commodity-category colors used by MRDS (matched at render time). */
export const COMMODITY_CATEGORY_COLORS: Record<string, string> = {
  precious: '#fbbf24',    // amber-yellow (gold, silver, Pt, Pd)
  base: '#b45309',         // copper-brown (Cu, Pb, Zn, Mo)
  critical: '#06b6d4',     // cyan (Li, Co, Ni, REE)
  energy: '#ef4444',       // red (oil, gas, coal, U, He)
  industrial: '#a3a3a3',   // neutral (potash, phosphate, sand+gravel)
  unknown: '#94a3b8',      // slate fallback
};

