import type { GeoJSONPolygon } from './geo.js';

export type AlertEventKind =
  | 'new_claim_filed'
  | 'claim_dropped'
  | 'permit_filed'
  | 'permit_approved'
  | 'well_spudded'
  | 'production_change'
  | 'lease_filed'
  | 'price_threshold';

export type AlertDelivery = 'email' | 'sms' | 'webhook' | 'in_app';

export interface Alert {
  id: string;
  userId: string;
  projectId: string | null;
  name: string;
  eventKind: AlertEventKind;
  aoiId: string | null;
  bbox: GeoJSONPolygon | null;
  filters: Record<string, unknown>;
  delivery: AlertDelivery[];
  webhookUrl: string | null;
  isEnabled: boolean;
  lastFiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AlertEvent {
  id: string;
  alertId: string;
  eventKind: AlertEventKind;
  entityType: string | null;
  entityId: string | null;
  payload: Record<string, unknown>;
  firedAt: string;
  deliveredAt: string | null;
  isRead: boolean;
}
