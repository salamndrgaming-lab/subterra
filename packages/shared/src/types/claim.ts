import type { GeoJSONMultiPolygon, GeoJSONPoint, USStateCode } from './geo.js';

export type ClaimStatus =
  | 'active' | 'closed' | 'void' | 'pending' | 'relinquished' | 'forfeited';

export type ClaimType = 'lode' | 'placer' | 'mill_site' | 'tunnel_site' | 'sand_gravel';

export interface MiningClaim {
  id: string;
  serialNumber: string;
  claimName: string | null;
  claimType: ClaimType | null;
  status: ClaimStatus | null;
  ownerName: string | null;
  ownerAddress: string | null;
  coOwners: Array<{ name: string; share: number }> | null;
  commodity: string | null;
  state: USStateCode;
  county: string | null;
  meridian: string | null;
  plssTownship: string | null;
  plssRange: string | null;
  plssSection: number | null;
  locationDate: string | null;
  recordationDate: string | null;
  lastAssessmentYear: number | null;
  acreage: number | null;
  geom: GeoJSONMultiPolygon;
  centroid: GeoJSONPoint;
  source: string;
  sourceUpdatedAt: string | null;
}

export interface MineralOccurrence {
  id: string;
  mrdsId: string | null;
  siteName: string | null;
  state: USStateCode | null;
  county: string | null;
  primaryCommodity: string | null;
  secondaryCommodities: string[];
  depositType: string | null;
  developmentStatus: 'producer' | 'past_producer' | 'prospect' | 'occurrence' | null;
  discoveryYear: number | null;
  lastProductionYear: number | null;
  geom: GeoJSONPoint;
  metadata: Record<string, unknown> | null;
}
