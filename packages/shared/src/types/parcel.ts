import type { GeoJSONMultiPolygon, GeoJSONPoint, USStateCode } from './geo.js';

export interface Parcel {
  id: string;
  parcelNumber: string | null;
  state: USStateCode;
  county: string;
  ownerName: string | null;
  ownerAddress: string | null;
  legalDescription: string | null;
  acreage: number | null;
  estimatedValue: number | null;
  landUse: string | null;
  surfaceRights: boolean | null;
  mineralRights: boolean | null;
  lastSaleDate: string | null;
  lastSalePrice: number | null;
  geom: GeoJSONMultiPolygon;
  centroid: GeoJSONPoint;
  source: string;
  sourceUpdatedAt: string | null;
}
