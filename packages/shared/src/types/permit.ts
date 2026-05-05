import type { GeoJSONGeometry, USStateCode } from './geo.js';

export type PermitStatus =
  | 'pending' | 'approved' | 'denied' | 'expired' | 'withdrawn' | 'active';

export type PermitType =
  | 'drilling' | 'mining_pod' | 'NEPA_EA' | 'NEPA_EIS'
  | 'air_quality' | 'water_discharge' | 'reclamation';

export interface Permit {
  id: string;
  permitNumber: string | null;
  permitType: PermitType | string;
  agency: string | null;
  operator: string | null;
  title: string | null;
  description: string | null;
  status: PermitStatus | null;
  applicationDate: string | null;
  decisionDate: string | null;
  expirationDate: string | null;
  state: USStateCode | null;
  county: string | null;
  wellId: string | null;
  claimId: string | null;
  geom: GeoJSONGeometry | null;
  metadata: Record<string, unknown> | null;
  source: string | null;
}
