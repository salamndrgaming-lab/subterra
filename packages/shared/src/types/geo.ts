/**
 * Common geospatial types — GeoJSON conformant.
 */

export type Position2D = [number, number];
export type Position3D = [number, number, number];
export type Position = Position2D | Position3D;

export interface BBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export type BBoxArray = [number, number, number, number];

export type GeoJSONGeometryType =
  | 'Point'
  | 'LineString'
  | 'Polygon'
  | 'MultiPoint'
  | 'MultiLineString'
  | 'MultiPolygon'
  | 'GeometryCollection';

export interface GeoJSONPoint {
  type: 'Point';
  coordinates: Position;
}

export interface GeoJSONLineString {
  type: 'LineString';
  coordinates: Position[];
}

export interface GeoJSONPolygon {
  type: 'Polygon';
  coordinates: Position[][];
}

export interface GeoJSONMultiPolygon {
  type: 'MultiPolygon';
  coordinates: Position[][][];
}

export type GeoJSONGeometry =
  | GeoJSONPoint
  | GeoJSONLineString
  | GeoJSONPolygon
  | GeoJSONMultiPolygon;

export interface GeoJSONFeature<P = Record<string, unknown>, G extends GeoJSONGeometry = GeoJSONGeometry> {
  type: 'Feature';
  id?: string | number;
  geometry: G;
  properties: P;
  bbox?: BBoxArray;
}

export interface GeoJSONFeatureCollection<P = Record<string, unknown>> {
  type: 'FeatureCollection';
  features: GeoJSONFeature<P>[];
  bbox?: BBoxArray;
}

export type USStateCode =
  | 'AL' | 'AK' | 'AZ' | 'AR' | 'CA' | 'CO' | 'CT' | 'DE' | 'FL' | 'GA'
  | 'HI' | 'ID' | 'IL' | 'IN' | 'IA' | 'KS' | 'KY' | 'LA' | 'ME' | 'MD'
  | 'MA' | 'MI' | 'MN' | 'MS' | 'MO' | 'MT' | 'NE' | 'NV' | 'NH' | 'NJ'
  | 'NM' | 'NY' | 'NC' | 'ND' | 'OH' | 'OK' | 'OR' | 'PA' | 'RI' | 'SC'
  | 'SD' | 'TN' | 'TX' | 'UT' | 'VT' | 'VA' | 'WA' | 'WV' | 'WI' | 'WY';

export interface PLSSLocation {
  meridian: string;
  township: string;
  range: string;
  section: number;
  quarter?: string;
}
