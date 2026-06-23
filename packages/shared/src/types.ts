/** Tile manifest published by the ETL job. The web app fetches this on
 * boot to discover the current dataset version and load the right
 * PMTiles + features.db pair from R2. */
export interface TileManifest {
  /** Monotonic version number bumped every successful ETL run. */
  version: number;
  /** ISO timestamp when this version was published. */
  publishedAt: string;
  /** Public URL to the PMTiles file for this version. */
  pmtilesUrl: string;
  /** Public URL to the SQLite features database for this version. */
  featuresDbUrl: string;
  /** SHA-256 checksums for client-side integrity verification. */
  checksums: {
    pmtiles: string;
    featuresDb: string;
  };
  /** Per-layer feature counts so the UI can show "47 active claims in view". */
  counts: Record<string, number>;
  /** Top-N pre-ranked resource hotspots emitted by the hotspots ETL
   * source. Embedded in the manifest so the sidebar's "Top Hotspots"
   * panel can render without a separate fetch — PMTiles can't be
   * queried globally (only per-tile), so the ranked list has to
   * travel with the version manifest. Absent in old manifests. */
  topHotspots?: TopHotspot[];
  /** Live commodity spot prices fetched at ETL time. Advisory — the
   * client shows them as "spot as of <date>". Absent in old manifests. */
  commodityPrices?: CommodityPrices;
  /** Per-source outcome from the ETL run that produced this manifest.
   *  Lets the UI surface "this layer failed because X" instead of
   *  silently rendering an empty layer. Absent in old manifests. */
  sources?: SourceStatus[];
}

/** Outcome of one ETL source module in the run that produced the
 *  current manifest. `status` is 'ok' when the source wrote at least
 *  one feature, 'empty' when it completed cleanly with zero, and
 *  'failed' when it raised — in which case `error` carries the
 *  (truncated) exception type + message. */
export interface SourceStatus {
  name: string;
  status: 'ok' | 'empty' | 'failed';
  featureCount: number;
  elapsedS: number;
  error?: string;
}

/** Live (or static-fallback) commodity spot prices carried in the
 *  manifest. Drives the market-tracking dollar figures in the UI. */
export interface CommodityPrices {
  /** Provider name, e.g. "metals.dev" or "static_fallback". */
  source: string;
  /** ISO timestamp the prices were fetched. */
  fetchedAt: string;
  /** False when every live feed was unreachable and the static table
   *  was used — the UI surfaces this so users know it's not live. */
  live: boolean;
  /** Symbol → price. Precious metals priced per troy-oz, base/battery
   *  metals per tonne (see `unit`). */
  prices: Record<string, { usd: number; unit: string }>;
}

/** One pre-scored resource hotspot. Coordinates are the cell centroid
 *  so the sidebar's "Fly to" button can recenter the map on it. */
export interface TopHotspot {
  /** Composite prospecting score, 0–100. Same as the hotspots layer
   *  paint expression key. */
  score: number;
  /** USGS MRDS mineral occurrences inside this cell. */
  deposits: number;
  /** Active BLM mining claims inside this cell — competition signal. */
  claims: number;
  /** Count of BLM-admin federal polygons overlapping this cell. */
  blmPolys: number;
  /** Geochemically anomalous NGDB samples in this cell — a strong
   *  leading target signal. Absent in manifests from before geochem
   *  was added to the pipeline. */
  geochemAnom?: number;
  /** Comma-joined "COMMODITY:count" string of the top-3 commodities
   *  by deposit count, e.g. "AU:12,AG:7,CU:3". */
  topCommodities: string;
  /** Rough staking-cost heuristic over the chosen claim horizon. */
  costLow: number;
  costHigh: number;
  /** Rough revenue-potential heuristic — sum of commodity-base values
   *  × deposit count. Disclaimed in the UI. */
  revenueLow: number;
  revenueHigh: number;
  /** Cell centroid coordinates for the "Fly to" action. */
  lng: number;
  lat: number;
}

export interface User {
  id: string;
  email: string;
  displayName: string | null;
  tier: 'free' | 'prospector' | 'operator' | 'enterprise';
  createdAt: string;
}

export interface AreaOfInterest {
  id: string;
  userId: string;
  name: string;
  notes: string | null;
  /** GeoJSON Polygon stored as TEXT in D1. */
  geometry: { type: 'Polygon'; coordinates: number[][][] };
  /** Acres, computed at save time via the shoelace + cosine-latitude formula. */
  areaAcres: number;
  createdAt: string;
  updatedAt: string;
}

export interface Alert {
  id: string;
  userId: string;
  name: string;
  /** What kind of change triggers the alert. */
  eventKind:
    | 'new_claim_filed'
    | 'claim_dropped'
    | 'permit_filed'
    | 'well_spudded'
    | 'production_change'
    | 'price_threshold';
  /** Optional AOI to scope the alert to. */
  aoiId: string | null;
  /** JSON filters (commodity, operator, etc). */
  filters: Record<string, unknown>;
  isEnabled: boolean;
  createdAt: string;
}

export interface OpportunityScore {
  /** 0–100. Higher = more attractive. */
  score: number;
  breakdown: {
    proximityToProduction: number;
    geologySimilarity: number;
    infrastructureScore: number;
    claimAvailability: number;
    commodityPriceIndex: number;
    permittingComplexity: number;
  };
  /** Short human tags like "near_producer", "open_federal_land". */
  tags: string[];
  /** Optional explanation copy for the UI. */
  rationale: string;
  computedAt: string;
}

/** Diff payload served by `/diff?since=<version>`. Produced by the ETL
 *  after each successful BLM mining-claims build by comparing the
 *  current run's serial-number set against the previous run's snapshot.
 *  The web app surfaces a sidebar pill ("N new claims") so a returning
 *  user immediately sees what changed since their last visit; the
 *  email side of Phase 6 alerts consumes the same payload later. */
export interface DiffPayload {
  /** Manifest version the diff was computed against (the prior run). */
  fromVersion: number;
  /** Manifest version the diff was computed *for* (the latest run). */
  toVersion: number;
  /** Claims that appeared this run and weren't in the prior snapshot. */
  added: DiffClaim[];
  /** Claims that disappeared this run vs the prior snapshot. */
  dropped: DiffClaim[];
  /** Per-state added/dropped counts so the sidebar pill's tooltip can
   *  surface a quick breakdown without paging through the full lists. */
  byState?: {
    added: Record<string, number>;
    dropped: Record<string, number>;
  };
}

export interface DiffClaim {
  /** BLM serial (e.g. "NMC123456") — the canonical claim identifier. */
  serial: string;
  /** Centroid longitude — lets the web app filter the diff by AOI bbox
   *  client-side without needing a separate spatial query. */
  lng: number;
  /** Centroid latitude. */
  lat: number;
  /** USPS state code (e.g. "NV") — drives the per-state breakdown
   *  rollup and lets the email producer scope alerts by state. */
  state: string;
}
