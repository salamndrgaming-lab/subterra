export interface ScoringInputs {
  lat: number;
  lng: number;
  radiusKm: number;
  commodity?: string;
}

export interface OpportunityBreakdown {
  proximityToProduction: number;
  geologySimilarity: number;
  infrastructureScore: number;
  claimAvailability: number;
  commodityPriceIndex: number;
  permittingComplexity: number;
}

export type OpportunityTag =
  | 'proven_trend'
  | 'near_infrastructure'
  | 'low_cost_entry'
  | 'high_density_claims'
  | 'historic_producer'
  | 'open_federal_land'
  | 'permitting_friendly'
  | 'permitting_complex'
  | 'price_tailwind'
  | 'price_headwind'
  | 'analog_to_producer';

export interface OpportunityScore {
  score: number;
  tags: OpportunityTag[];
  breakdown: OpportunityBreakdown;
  commodity?: string;
  computedAt: string;
}
