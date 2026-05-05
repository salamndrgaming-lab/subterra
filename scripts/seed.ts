/**
 * Seeds the database with realistic mock data so the dev environment renders
 * without running the full ETL pipeline.
 *
 * Inserts: a handful of wells (Permian, Bakken, Niobrara, Eagle Ford, Powder River),
 * a handful of mining claims, a few USGS MRDS occurrences, and a couple parcels.
 */
import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgresql://subterra:subterra@localhost:5432/subterra',
});

async function main() {
  console.log('[seed] inserting mock wells...');
  await pool.query(`
    INSERT INTO wells (api_number, well_name, operator, state, county, basin, formation, well_type, status,
                       spud_date, total_depth_ft, true_vertical_depth_ft, lateral_length_ft,
                       surface_lat, surface_lng, geom, source)
    VALUES
      ('42-329-12345', 'Lonestar Federal 1H', 'Pioneer Natural Resources', 'TX', 'Midland',
       'Permian', 'Wolfcamp A', 'oil_gas', 'active',
       '2022-03-14', 19850, 9200, 10650,
       31.9973, -102.0779, ST_SetSRID(ST_MakePoint(-102.0779, 31.9973), 4326), 'tx_rrc'),
      ('33-053-09876', 'Mountrail 24-13H', 'Continental Resources', 'ND', 'Mountrail',
       'Bakken', 'Middle Bakken', 'oil', 'active',
       '2021-09-02', 20120, 10350, 9700,
       48.1413, -102.5601, ST_SetSRID(ST_MakePoint(-102.5601, 48.1413), 4326), 'ndic'),
      ('05-123-44210', 'Watkins 33-7-12HN', 'Civitas Resources', 'CO', 'Weld',
       'Niobrara', 'Niobrara B', 'oil_gas', 'active',
       '2023-01-10', 16400, 7100, 9300,
       40.0911, -104.5103, ST_SetSRID(ST_MakePoint(-104.5103, 40.0911), 4326), 'cogcc')
    ON CONFLICT (api_number) DO NOTHING;
  `);

  console.log('[seed] inserting mock mining claims...');
  await pool.query(`
    INSERT INTO mining_claims (serial_number, claim_name, claim_type, status, owner_name,
                               commodity, state, county, location_date, acreage, geom, source)
    VALUES
      ('NMC-1192345', 'Hartford Lode #4', 'lode', 'active', 'Silver Strike Mining LLC',
       'silver', 'NV', 'Nye', '2019-06-12', 20.66,
       ST_Multi(ST_GeomFromText('POLYGON((-117.2305 38.0501, -117.2280 38.0501, -117.2280 38.0521, -117.2305 38.0521, -117.2305 38.0501))', 4326)),
       'blm_mlrs'),
      ('NMC-1144558', 'Lithia Flats 7', 'placer', 'active', 'Great Basin Lithium Corp',
       'lithium', 'NV', 'Esmeralda', '2022-11-02', 160.0,
       ST_Multi(ST_GeomFromText('POLYGON((-117.4912 37.7610, -117.4810 37.7610, -117.4810 37.7690, -117.4912 37.7690, -117.4912 37.7610))', 4326)),
       'blm_mlrs')
    ON CONFLICT (serial_number) DO NOTHING;
  `);

  console.log('[seed] inserting mock mineral occurrences...');
  await pool.query(`
    INSERT INTO mineral_occurrences (mrds_id, site_name, state, county, primary_commodity,
                                     development_status, discovery_year, geom)
    VALUES
      ('10046789', 'Round Mountain District', 'NV', 'Nye', 'gold', 'producer', 1906,
       ST_SetSRID(ST_MakePoint(-117.0673, 38.7158), 4326)),
      ('10001234', 'Bingham Canyon', 'UT', 'Salt Lake', 'copper', 'producer', 1848,
       ST_SetSRID(ST_MakePoint(-112.1497, 40.5239), 4326)),
      ('10042210', 'Clayton Valley (Silver Peak)', 'NV', 'Esmeralda', 'lithium', 'producer', 1966,
       ST_SetSRID(ST_MakePoint(-117.6390, 37.7872), 4326))
    ON CONFLICT (mrds_id) DO NOTHING;
  `);

  console.log('[seed] done.');
  await pool.end();
}

main().catch((err) => {
  console.error('[seed] failed', err);
  process.exit(1);
});
