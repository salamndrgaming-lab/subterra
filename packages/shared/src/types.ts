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
