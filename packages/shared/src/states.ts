/** Lower-48 U.S. state codes covered by the CONUS ETL run. */

export const CONUS_STATES = [
  'AL','AZ','AR','CA','CO','CT','DE','FL','GA','ID','IL','IN','IA','KS','KY',
  'LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY',
  'NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA',
  'WV','WI','WY',
] as const;

export type ConusState = (typeof CONUS_STATES)[number];

/** Subset of states with stake-able federal mining claims (BLM-managed
 * surface). Used by the staking UI to default the "open land" filter. */
export const MINING_CLAIM_STATES = [
  'AK','AZ','CA','CO','ID','MT','NM','NV','OR','UT','WA','WY',
] as const;
