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
  mapbox: {
    darkStyle: 'mapbox://styles/mapbox/dark-v11',
    satelliteStyle: 'mapbox://styles/mapbox/satellite-streets-v12',
  },
} as const;
