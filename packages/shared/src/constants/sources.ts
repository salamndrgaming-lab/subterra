/**
 * Public data source endpoints.
 * These are real, public ArcGIS REST / WMS / data portal URLs.
 */
export const DATA_SOURCES = {
  blm: {
    surfaceManagement:
      'https://gis.blm.gov/arcgis/rest/services/lands/BLM_Natl_SMA_LimitedScale/MapServer',
    plssCadnsdi:
      'https://gis.blm.gov/arcgis/rest/services/Cadastral/BLM_Natl_PLSS_CadNSDI/MapServer',
    miningClaims:
      'https://gis.blm.gov/arcgis/rest/services/mining/BLM_Natl_Mining_Claims/MapServer',
    mlrsReports: 'https://reports.blm.gov/reports/MLRS',
  },
  usgs: {
    topo: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer',
    imagery: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer',
    mrds: 'https://mrdata.usgs.gov/mrds/',
    geology: 'https://mrdata.usgs.gov/geology/state/',
  },
  states: {
    tx_rrc: 'https://www.rrc.texas.gov/',
    nd_dmr: 'https://www.dmr.nd.gov/oilgas/',
    co_ecmc: 'https://ecmc.state.co.us/',
    nm_emnrd: 'https://www.emnrd.nm.gov/ocd/',
    ok_occ: 'https://oklahoma.gov/occ/divisions/oil-gas.html',
    wy_wogcc: 'https://wogcc.wyo.gov/',
  },
  /**
   * Free, no-key vector + raster basemap styles. All require zero auth and
   * have no usage caps for normal app traffic. Self-hosting via Protomaps
   * is the fully-offline option; OpenFreeMap is the easiest hosted choice.
   */
  basemap: {
    /** OpenFreeMap dark — free hosted MapLibre vector tiles, no key. */
    darkStyle: 'https://tiles.openfreemap.org/styles/dark',
    /** OpenFreeMap "liberty" street style. */
    streetsStyle: 'https://tiles.openfreemap.org/styles/liberty',
    /** USGS imagery raster (XYZ). */
    usgsImagery:
      'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}',
    /** Esri World Dark Gray Canvas (free, no key). */
    esriDarkGray:
      'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
  },
} as const;
