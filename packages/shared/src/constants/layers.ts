export interface LayerDefinition {
  id: string;
  label: string;
  group: 'federal' | 'cadastral' | 'oilgas' | 'mining' | 'geology' | 'infrastructure';
  defaultVisible: boolean;
  minZoom?: number;
  maxZoom?: number;
}

export const LAYER_DEFINITIONS: LayerDefinition[] = [
  // federal
  { id: 'blm-surface-mgmt', label: 'BLM Surface Management', group: 'federal', defaultVisible: true, minZoom: 5 },
  { id: 'usfs', label: 'US Forest Service', group: 'federal', defaultVisible: false, minZoom: 5 },
  { id: 'wilderness', label: 'Wilderness Areas', group: 'federal', defaultVisible: false, minZoom: 5 },
  { id: 'tribal', label: 'Tribal Lands', group: 'federal', defaultVisible: false, minZoom: 5 },

  // cadastral
  { id: 'plss-grid', label: 'PLSS Township/Range/Section', group: 'cadastral', defaultVisible: true, minZoom: 8 },
  { id: 'parcels', label: 'County Parcels', group: 'cadastral', defaultVisible: false, minZoom: 11 },

  // oilgas
  { id: 'wells-active', label: 'Wells — Active', group: 'oilgas', defaultVisible: true, minZoom: 7 },
  { id: 'wells-plugged', label: 'Wells — Plugged', group: 'oilgas', defaultVisible: false, minZoom: 8 },
  { id: 'wells-permitted', label: 'Wells — Permitted', group: 'oilgas', defaultVisible: false, minZoom: 8 },
  { id: 'lease-boundaries', label: 'Lease Boundaries', group: 'oilgas', defaultVisible: false, minZoom: 8 },
  { id: 'pipelines', label: 'Pipelines', group: 'infrastructure', defaultVisible: false, minZoom: 6 },

  // mining
  { id: 'claims-active', label: 'Mining Claims — Active', group: 'mining', defaultVisible: true, minZoom: 7 },
  { id: 'claims-closed', label: 'Mining Claims — Closed', group: 'mining', defaultVisible: false, minZoom: 8 },
  { id: 'mineral-occurrences', label: 'USGS Mineral Occurrences', group: 'mining', defaultVisible: true, minZoom: 5 },
  { id: 'historical-mines', label: 'Historical Mines', group: 'mining', defaultVisible: false, minZoom: 6 },

  // geology
  { id: 'geology-state', label: 'State Geology', group: 'geology', defaultVisible: false, minZoom: 5 },
  { id: 'topo', label: 'USGS Topo Overlay', group: 'geology', defaultVisible: false, minZoom: 8 },
];

export const LAYER_GROUPS: Record<LayerDefinition['group'], string> = {
  federal: 'Federal Lands',
  cadastral: 'Cadastral',
  oilgas: 'Oil & Gas',
  mining: 'Mining',
  geology: 'Geology',
  infrastructure: 'Infrastructure',
};
