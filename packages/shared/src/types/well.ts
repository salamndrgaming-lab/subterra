import type { GeoJSONLineString, GeoJSONPoint, USStateCode } from './geo.js';

export type WellStatus =
  | 'active' | 'inactive' | 'plugged' | 'permitted'
  | 'drilling' | 'completed' | 'abandoned' | 'shut_in';

export type WellType =
  | 'oil' | 'gas' | 'oil_gas' | 'injection' | 'disposal'
  | 'water' | 'dry_hole' | 'service' | 'observation';

export interface Well {
  id: string;
  apiNumber: string | null;
  wellName: string | null;
  operator: string | null;
  operatorId: string | null;
  state: USStateCode;
  county: string | null;
  fieldName: string | null;
  basin: string | null;
  formation: string | null;
  wellType: WellType | null;
  status: WellStatus | null;
  spudDate: string | null;
  completionDate: string | null;
  plugDate: string | null;
  totalDepthFt: number | null;
  trueVerticalDepthFt: number | null;
  lateralLengthFt: number | null;
  surfaceLat: number;
  surfaceLng: number;
  bottomHoleLat: number | null;
  bottomHoleLng: number | null;
  geom: GeoJSONPoint;
  lateralGeom: GeoJSONLineString | null;
  plssTownship: string | null;
  plssRange: string | null;
  plssSection: number | null;
  source: string;
  sourceUpdatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WellProductionMonth {
  reportMonth: string; // YYYY-MM-01
  oilBbl: number | null;
  gasMcf: number | null;
  waterBbl: number | null;
  daysProduced: number | null;
}

export interface WellProductionSeries {
  wellId: string;
  monthly: WellProductionMonth[];
  cumulative: {
    oilBbl: number;
    gasMcf: number;
    waterBbl: number;
  };
}

export interface WellLog {
  id: string;
  wellId: string;
  logType: string;
  fileUrl: string | null;
  startDepthFt: number | null;
  endDepthFt: number | null;
  curves: Record<string, number[]> | null;
  metadata: Record<string, unknown> | null;
}
