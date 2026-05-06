/**
 * Real-data raster + feature endpoints for U.S. federal land categories
 * beyond BLM. All URLs point at public ArcGIS REST services published by
 * the relevant federal agency.
 */

export interface RasterSource {
  id: string;
  label: string;
  /** ArcGIS MapServer base URL (no /export). */
  mapServer: string;
  /** Default raster opacity 0..1. */
  opacity: number;
  /** Min zoom at which the raster is requested. */
  minZoom: number;
  /** Optional sublayer index list (`?layers=show:0,1,2`). */
  showLayers?: number[];
  /** Attribution. */
  attribution: string;
}

export const FEDERAL_LAND_RASTERS: RasterSource[] = [
  {
    id: 'usfs-admin-forest',
    label: 'US Forest Service — Administrative Forest Boundaries',
    mapServer:
      'https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_ForestSystemBoundaries_01/MapServer',
    opacity: 0.40,
    minZoom: 4,
    attribution: 'USDA Forest Service',
  },
  {
    id: 'nps-boundaries',
    label: 'National Park Service — Park Boundaries',
    mapServer:
      'https://mapservices.nps.gov/arcgis/rest/services/LandResourcesDivisionTractAndBoundaryService/MapServer',
    opacity: 0.45,
    minZoom: 4,
    attribution: 'National Park Service',
  },
  {
    id: 'usfws-refuges',
    label: 'US Fish & Wildlife — National Wildlife Refuges',
    mapServer:
      'https://gis.fws.gov/arcgis/rest/services/FWS_Refuge_Boundaries/MapServer',
    opacity: 0.40,
    minZoom: 4,
    attribution: 'US Fish & Wildlife Service',
  },
  {
    id: 'wilderness',
    label: 'Designated Wilderness Areas',
    mapServer:
      'https://gisservices.cfc.umt.edu/arcgis/rest/services/ProtectedAreas/Wilderness/MapServer',
    opacity: 0.45,
    minZoom: 5,
    attribution: 'Wilderness.net (UMT/CFC)',
  },
  {
    id: 'tribal-lands',
    label: 'BIA Indian Lands',
    mapServer:
      'https://services.arcgis.com/F4WjK0gUSjKKJfBT/arcgis/rest/services/Indian_Lands/FeatureServer',
    opacity: 0.40,
    minZoom: 4,
    attribution: 'Bureau of Indian Affairs',
  },
];

export const PIPELINE_RASTERS: RasterSource[] = [
  {
    id: 'pipelines-natgas',
    label: 'HIFLD — Natural Gas Pipelines',
    mapServer:
      'https://services1.arcgis.com/Hp6G80Pky0om7QvQ/arcgis/rest/services/Natural_Gas_Pipelines/FeatureServer',
    opacity: 0.85,
    minZoom: 5,
    attribution: 'HIFLD Open / EIA',
  },
  {
    id: 'pipelines-petroleum',
    label: 'HIFLD — Petroleum Product Pipelines',
    mapServer:
      'https://services1.arcgis.com/Hp6G80Pky0om7QvQ/arcgis/rest/services/Petroleum_Product_Pipelines/FeatureServer',
    opacity: 0.85,
    minZoom: 5,
    attribution: 'HIFLD Open / EIA',
  },
  {
    id: 'pipelines-crude',
    label: 'HIFLD — Crude Oil Pipelines',
    mapServer:
      'https://services1.arcgis.com/Hp6G80Pky0om7QvQ/arcgis/rest/services/Crude_Oil_Pipelines/FeatureServer',
    opacity: 0.85,
    minZoom: 5,
    attribution: 'HIFLD Open / EIA',
  },
];
