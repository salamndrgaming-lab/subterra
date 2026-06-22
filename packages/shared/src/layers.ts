/** Layer registry. Single source of truth for both the web app's sidebar
 * and the ETL pipeline — the ETL emits one tippecanoe layer per entry
 * with the matching `tilesetLayer` id, and the web app's MapLibre style
 * references the same id.
 *
 * Groups are task-based, not data-taxonomy: each group asks a question
 * the user is trying to answer, rather than describing what kind of
 * dataset the layer is. That keeps the sidebar discoverable as the
 * layer count grows — a prospector wants to know "what's already
 * here?" more often than "what is this dataset's federal source?"
 */

export interface LayerDef {
  id: string;
  label: string;
  /** Task-based grouping. See LAYER_GROUPS below for the question each
   *  group answers. 'risk' is reserved for future hazard layers (fire
   *  perimeters, seismic, Superfund) and is intentionally absent until
   *  any layer needs it — sidebar empty groups stay hidden. */
  group: 'stake' | 'present' | 'economic' | 'subsurface' | 'reference';
  defaultVisible: boolean;
  /** Tippecanoe layer id inside the PMTiles file. Unused for raster
   *  layers (which have their own external tile source) but kept
   *  required so the registry shape stays uniform; raster entries
   *  set it to the layer id by convention. */
  tilesetLayer: string;
  /** GeoJSON geometry kind for vector layers, or 'raster' for external
   *  raster-tile overlays (XYZ / TMS endpoints — not WMS, MapLibre
   *  doesn't speak WMS natively). Raster layers ignore tilesetLayer
   *  and read their data from rasterTiles instead. */
  geometry: 'point' | 'line' | 'polygon' | 'raster';
  /** Minimum zoom at which the layer renders. */
  minZoom: number;
  /** Layer-specific paint color (overrides the group default). Hex like #f59e0b.
   *  Ignored for raster layers. */
  color?: string;
  /** Optional MapLibre filter expression. Lets multiple layers share one
   *  tilesetLayer with different filters (e.g. open-blm-land is just
   *  federal_lands filtered to agency=BLM). Type is `unknown[]` because
   *  the maplibre Filter type isn't available in @subterra/shared. */
  filter?: readonly unknown[];
  /** Raster-only: XYZ tile URL templates (e.g. {z}/{x}/{y}). Plural
   *  to allow tile-server load balancing across mirrors. MapLibre will
   *  pick from the list. Required when geometry === 'raster'. */
  rasterTiles?: readonly string[];
  /** Raster-only: tile size in pixels (256 for legacy XYZ, 512 for
   *  retina-style). Defaults to 256 when omitted. */
  rasterTileSize?: number;
  /** Raster-only: max zoom at which the upstream serves tiles. MapLibre
   *  over-zooms (resamples) above this. */
  rasterMaxZoom?: number;
  /** Raster-only: attribution string surfaced in the map's
   *  attribution control. Required by upstream licenses. */
  rasterAttribution?: string;
  /** Raster-only: paint opacity (0..1). Defaults to 0.7 so the overlay
   *  blends with the vector basemap. */
  rasterOpacity?: number;
}

export const LAYERS: readonly LayerDef[] = [
  // federal lands — painted multi-color by agency (special case in Map.tsx),
  // the `color` field here is ignored. Surface-management ownership is
  // the first stake-ability question — who owns the dirt above the deposit.
  {
    id: 'federal-lands',
    label: 'Federal Lands (BLM · USFS · NPS · BIA)',
    group: 'stake',
    defaultVisible: true,
    tilesetLayer: 'federal_lands',
    geometry: 'polygon',
    minZoom: 4,
    color: '#22c55e',
  },

  // cadastral — surveyor's reference grid, useful for locating
  // section corners but not a constraint or signal.
  {
    id: 'plss',
    label: 'PLSS Townships',
    group: 'reference',
    defaultVisible: false,
    tilesetLayer: 'plss',
    geometry: 'line',
    minZoom: 6,
    color: '#64748b', // slate
  },

  // existing rights / sites — what's already been staked, drilled, or
  // documented as mineral-bearing here.
  {
    id: 'mining-claims',
    label: 'BLM Mining Claims (active)',
    group: 'present',
    defaultVisible: true,
    tilesetLayer: 'mining_claims',
    geometry: 'polygon',
    minZoom: 5,
    color: '#f59e0b', // amber — keep miner's mark for claim activity
  },
  {
    id: 'mrds',
    label: 'USGS Mineral Occurrences (MRDS legacy)',
    group: 'present',
    defaultVisible: true,
    tilesetLayer: 'mrds',
    geometry: 'point',
    minZoom: 4,
    // MRDS dots are color-coded by commodity category (Map.tsx special-cases);
    // this fallback is used when the commodity is unknown.
    color: '#94a3b8',
  },
  {
    // USGS USMIN — 2020+ successor to MRDS. Smaller (~80k vs 310k)
    // but every record is peer-reviewed against modern commodity codes
    // and deposit-type classifications. Ship side-by-side with MRDS;
    // drop MRDS from default-visible once coverage parity is verified.
    id: 'usmin',
    label: 'USGS USMIN (vetted occurrences)',
    group: 'present',
    defaultVisible: false,
    tilesetLayer: 'usmin',
    geometry: 'point',
    minZoom: 4,
    // Match expression reuses MRDS commodity-category coloring (Map.tsx
    // special-case checks layerId === 'usmin' too).
    color: '#cbd5e1', // slate-300 fallback for unknown commodity
  },
  {
    // USGS Critical Minerals Mapping Initiative — dedicated layer for
    // REE / Li / Co / Ni / Ga / Ge / In / Sc / Ta / V / W / Te occurrences.
    // Magenta-violet palette so critical-mineral hits visually pop
    // against the gray/amber MRDS + USMIN dot field.
    id: 'cmmi',
    label: 'USGS Critical Minerals (CMMI)',
    group: 'present',
    defaultVisible: false,
    tilesetLayer: 'cmmi',
    geometry: 'point',
    minZoom: 4,
    color: '#d946ef', // magenta — critical-mineral discriminator
  },
  {
    id: 'open-blm-land',
    label: 'Open BLM Land (stake-able)',
    group: 'stake',
    defaultVisible: false,
    // Shares the federal_lands source-layer + filters to BLM-only. Real
    // "open" stakeability (subtracting active claims) is checked at click
    // time via map.queryRenderedFeatures + the stake-ability indicator
    // in the detail drawer — spatial subtraction over 550k+ claim polygons
    // is too expensive to precompute as a polygon layer.
    tilesetLayer: 'federal_lands',
    filter: ['==', ['get', 'agency'], 'BLM'] as const,
    geometry: 'polygon',
    minZoom: 6,
    color: '#a3e635', // lime — the staking target
  },
  {
    id: 'quaternary-faults',
    label: 'Quaternary Faults (USGS)',
    group: 'subsurface',
    defaultVisible: false,
    tilesetLayer: 'quaternary_faults',
    geometry: 'line',
    minZoom: 5,
    color: '#ef4444', // red — seismic-hazard signal + cross-section feed
  },
  {
    id: 'parcels',
    label: 'County Parcels (NV: Washoe·Clark·Elko·Lyon)',
    group: 'present',
    // Off by default — parcel layers are dense at city zooms; the
    // user enables them when zoomed into a target area.
    defaultVisible: false,
    tilesetLayer: 'parcels',
    geometry: 'polygon',
    minZoom: 11,
    color: '#fde68a', // pale yellow — surveyed-private signal
  },
  {
    id: 'water-rights',
    label: 'Water Rights (NV, UT, AZ)',
    group: 'economic',
    // Off by default — the layer is dense (tens of thousands of points
    // per state) and answers a specific "can I get water?" question
    // rather than a baseline-map need.
    defaultVisible: false,
    tilesetLayer: 'water_rights',
    geometry: 'point',
    // Only meaningful at basin / sub-basin zoom; at continental zoom
    // the points coalesce into noise.
    minZoom: 6,
    color: '#0ea5e9', // sky blue — water
  },

  // oil & gas — wells and leases are also "what's already here" for
  // an O&G evaluator. Pipelines further down are about access /
  // economics for an O&G or mining play.
  {
    id: 'wells',
    label: 'Oil & Gas Wells',
    group: 'present',
    defaultVisible: true,
    tilesetLayer: 'wells',
    geometry: 'point',
    minZoom: 6,
    // orange — eliminates the wells-on-green-federal-land collision the
    // old emerald color caused. Pairs visually with well-laterals amber.
    color: '#fb923c',
  },
  {
    id: 'well-laterals',
    label: 'Wellbore Laterals',
    group: 'present',
    defaultVisible: false,
    tilesetLayer: 'well_laterals',
    geometry: 'line',
    minZoom: 9,
    color: '#fbbf24', // amber — pairs with the orange wells
  },
  {
    // USGS NURE drill holes — historical (1973-1984) uranium-targeted
    // drilling with co-collected pathfinder assays. Best-bulk-published
    // national drillhole archive. Renders as collar dots on the map at
    // zoom 7+; cross-section projects each within the buffer as a
    // vertical drill stick sized by depth_ft.
    id: 'drill-holes',
    label: 'Drill Holes (USGS NURE)',
    group: 'subsurface',
    defaultVisible: false,
    tilesetLayer: 'drill_holes',
    geometry: 'point',
    minZoom: 7,
    color: '#2dd4bf', // teal — distinct from MRDS/USMIN/CMMI mineral colors
  },
  {
    id: 'leases',
    label: 'BLM Federal O&G Leases',
    group: 'present',
    defaultVisible: false,
    tilesetLayer: 'leases',
    geometry: 'polygon',
    minZoom: 6,
    color: '#0e7490', // cyan-700 — deeper than the old cyan so the lease
                     // fill stands apart from the sky-blue gas pipelines
  },

  // infrastructure — proximity to pipelines drives haul economics
  // for both O&G output and mining concentrate.
  {
    id: 'pipelines-natgas',
    label: 'Natural Gas Pipelines',
    group: 'economic',
    defaultVisible: false,
    tilesetLayer: 'pipelines_natgas',
    geometry: 'line',
    minZoom: 5,
    color: '#60a5fa', // sky-blue
  },
  {
    id: 'pipelines-crude',
    label: 'Crude Oil Pipelines',
    group: 'economic',
    defaultVisible: false,
    tilesetLayer: 'pipelines_crude',
    geometry: 'line',
    minZoom: 5,
    color: '#dc2626', // red
  },

  // subsurface signal — raw science datasets the pros vector targets from.
  // Geochemistry is painted graduated-by-element in Map.tsx; geophysics
  // is a coverage footprint overlay.
  {
    id: 'geochemistry',
    label: 'Geochemistry (NGDB samples)',
    group: 'subsurface',
    defaultVisible: false,
    tilesetLayer: 'geochemistry',
    geometry: 'point',
    minZoom: 6,
    color: '#a78bfa', // violet — Map.tsx overrides with element-graduated ramp
  },
  {
    id: 'geophysics',
    label: 'Geophysical Survey Coverage',
    group: 'subsurface',
    defaultVisible: false,
    tilesetLayer: 'geophysics',
    geometry: 'polygon',
    minZoom: 4,
    color: '#2dd4bf', // teal — airborne survey footprints
  },
  {
    // USGS State Geologic Map Compilation v2 — surface bedrock polygons
    // covering the western US. First on-map bedrock layer; complements
    // (does not replace) the cross-section's Macrostrat stratigraphic
    // column lookup. Per-polygon fill comes from a MapLibre `match`
    // expression on the normalized `lithology` property — see Map.tsx
    // `buildLayer` SGMC branch.
    id: 'bedrock-geology',
    label: 'Bedrock Geology (USGS SGMC)',
    group: 'subsurface',
    defaultVisible: false,
    tilesetLayer: 'sgmc',
    geometry: 'polygon',
    minZoom: 6,
    // `color` is ignored for this layer; Map.tsx's buildLayer pulls the
    // multi-color match expression from buildSgmcFillExpression().
    color: '#7dd3fc',
  },

  // USGS National Map shaded relief — first raster overlay on the
  // app. The main map is otherwise a flat vector basemap, which hides
  // the structural information terrain carries (range-and-basin
  // fabric, fault scarps, alluvial fans). Toggling this overlay
  // restores visible topography without needing the full 3D-terrain
  // mode (which requires DEM + GPU pitch). XYZ tiles served from
  // the USGS National Map basemap service — production-stable,
  // public, no auth, no rate limit at our use volume.
  //
  // First raster-geometry layer in the registry; unlocks the
  // architectural path for future Earth MRI aeromag + Bouguer
  // gravity overlays (PR 4b) that need the same source-and-paint
  // shape.
  {
    id: 'hillshade',
    label: 'Shaded Relief (USGS)',
    group: 'subsurface',
    defaultVisible: false,
    tilesetLayer: 'hillshade',
    geometry: 'raster',
    minZoom: 0,
    rasterTiles: [
      'https://basemap.nationalmap.gov/arcgis/rest/services/USGSShadedReliefOnly/MapServer/tile/{z}/{y}/{x}',
    ],
    rasterTileSize: 256,
    rasterMaxZoom: 15,
    rasterAttribution: 'USGS The National Map: 3DEP',
    rasterOpacity: 0.55,
  },

  // Stake-ability constraints — eligibility blockers a clicked point can hit.
  {
    id: 'withdrawals',
    label: 'Mineral Withdrawals (BLM)',
    group: 'stake',
    defaultVisible: false,
    tilesetLayer: 'withdrawals',
    geometry: 'polygon',
    minZoom: 5,
    color: '#ef4444', // red — "do not stake here" signal
  },
  {
    id: 'critical-habitat',
    label: 'USFWS Critical Habitat',
    group: 'stake',
    defaultVisible: false,
    tilesetLayer: 'critical_habitat',
    geometry: 'polygon',
    minZoom: 5,
    color: '#f97316', // orange — strong caution, not hard-block
  },
  {
    id: 'indian-lands',
    label: 'Tribal Lands (AIANNH)',
    group: 'stake',
    defaultVisible: false,
    tilesetLayer: 'indian_lands',
    geometry: 'polygon',
    minZoom: 4,
    color: '#a855f7', // purple — distinct from BLM/USFS/NPS agency colors
  },

  // analysis — precomputed prospecting overlays. Score-driven, click for
  // cost/revenue heuristics. Painted in Map.tsx with a graduated fill
  // expression keyed off the `score` property. Lands in 'economic'
  // because the score is a feasibility/opportunity signal, not a
  // primary data layer.
  {
    id: 'hotspots',
    label: 'Resource Hotspots (heatmap)',
    group: 'economic',
    defaultVisible: false,
    tilesetLayer: 'hotspots',
    geometry: 'polygon',
    minZoom: 4,
    color: '#ef4444', // fallback only — Map.tsx paints score-graduated
  },
] as const;

/** Task-based group registry. Order = display order in the sidebar.
 *  Each group is "what question does this answer?" — chosen for
 *  discoverability over data taxonomy. */
export const LAYER_GROUPS: Record<LayerDef['group'], string> = {
  stake: 'Where can I stake?',
  present: "What's already here?",
  economic: 'Is it economical?',
  subsurface: "What's underground?",
  reference: 'Reference',
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

