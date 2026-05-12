/**
 * Seeds PostGIS with a small bounded extract from real public sources so
 * developers can use the app without running every full-dataset ETL job.
 *
 * Pulls live from:
 *   - BLM National Mining Claims FeatureServer (active claims, NV/AZ/CO bbox)
 *   - USGS MRDS WFS (occurrences in the same bbox)
 *
 * Wells require state-specific ETL (see scripts/etl/ingest-wells.ts) and are
 * not seeded here. Production volumes likewise require state-flat-file ETL.
 *
 * Run:  npx tsx scripts/seed.ts
 */
import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

const BLM_CLAIMS = 'https://gis.blm.gov/arcgis/rest/services/mining/BLM_Natl_Mining_Claims/MapServer/0/query';
const MRDS_WFS = 'https://mrdata.usgs.gov/wfs/mrds';

// Western US prospecting belt — NV/AZ/CO mineral districts.
const SEED_BBOX: [number, number, number, number] = [-118.0, 37.5, -104.5, 41.5];

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgresql://subterra:subterra@localhost:5432/subterra',
});

async function fetchBlm() {
  const params = new URLSearchParams({
    where: `UPPER(CASE_DISP) = 'ACTIVE'`,
    outFields: '*',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson',
    resultRecordCount: '1500',
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    geometry: JSON.stringify({
      xmin: SEED_BBOX[0], ymin: SEED_BBOX[1], xmax: SEED_BBOX[2], ymax: SEED_BBOX[3],
      spatialReference: { wkid: 4326 },
    }),
    spatialRel: 'esriSpatialRelIntersects',
  });
  const url = `${BLM_CLAIMS}?${params.toString()}`;
  console.log('[seed] GET', url.slice(0, 110), '…');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`BLM fetch ${res.status}`);
  return (await res.json()) as { features: Array<{ geometry: { type: string; coordinates: number[][][][] }; properties: Record<string, unknown> }> };
}

async function fetchMrds() {
  const params = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeNames: 'mrds:mrds',
    outputFormat: 'application/json',
    srsName: 'EPSG:4326',
    count: '1000',
    bbox: `${SEED_BBOX[1]},${SEED_BBOX[0]},${SEED_BBOX[3]},${SEED_BBOX[2]},EPSG:4326`,
  });
  const url = `${MRDS_WFS}?${params.toString()}`;
  console.log('[seed] GET', url.slice(0, 110), '…');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MRDS fetch ${res.status}`);
  return (await res.json()) as { features: Array<{ geometry: { type: string; coordinates: [number, number] }; properties: Record<string, unknown> }> };
}

async function seedClaims() {
  const data = await fetchBlm();
  console.log('[seed] BLM active claims:', data.features.length);
  for (const f of data.features) {
    const a = f.properties as Record<string, unknown>;
    const serial = (a['CASE_RECORD_SERIAL_NR'] ?? a['SERIAL_NR']) as string | undefined;
    if (!serial || !f.geometry || f.geometry.type !== 'MultiPolygon') continue;

    await pool.query(
      `INSERT INTO mining_claims
         (serial_number, claim_name, claim_type, status, owner_name,
          commodity, state, county, location_date, recordation_date,
          last_assessment_year, acreage, geom, source, source_updated_at)
       VALUES ($1,$2,$3::claim_type,$4::claim_status,$5,$6,$7,$8,$9,$10,$11,$12,
               ST_Multi(ST_GeomFromGeoJSON($13)), 'blm_mlrs', now())
       ON CONFLICT (serial_number) DO UPDATE SET
         status = EXCLUDED.status,
         owner_name = EXCLUDED.owner_name,
         last_assessment_year = EXCLUDED.last_assessment_year,
         acreage = EXCLUDED.acreage,
         geom = EXCLUDED.geom,
         source_updated_at = now()`,
      [
        serial,
        a['CLAIM_NAME'] ?? null,
        normalizeClaimType(a['CLAIM_TYPE']),
        normalizeClaimStatus(a['CASE_DISP']),
        a['CLAIMANT_NAME'] ?? a['CASE_NAME'] ?? null,
        a['COMMODITY'] ?? null,
        a['STATE'] ?? null,
        a['COUNTY'] ?? null,
        epochToDate(a['LOCATION_DT']),
        epochToDate(a['RECORDATION_DT']),
        a['LAST_ASSESS_YR'] ?? null,
        a['ACREAGE'] ?? null,
        JSON.stringify(f.geometry),
      ],
    );
  }
}

async function seedOccurrences() {
  const data = await fetchMrds();
  console.log('[seed] USGS MRDS occurrences:', data.features.length);
  for (const f of data.features) {
    const p = f.properties;
    const id = String(p['dep_id'] ?? p['mrds_id'] ?? '');
    if (!id || !f.geometry || f.geometry.type !== 'Point') continue;

    await pool.query(
      `INSERT INTO mineral_occurrences
         (mrds_id, site_name, state, county, primary_commodity,
          development_status, discovery_year, geom, source, source_updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,
               ST_SetSRID(ST_MakePoint($9, $8), 4326),
               'usgs_mrds', now())
       ON CONFLICT (mrds_id) DO UPDATE SET
         primary_commodity = EXCLUDED.primary_commodity,
         development_status = EXCLUDED.development_status,
         geom = EXCLUDED.geom,
         source_updated_at = now()`,
      [
        id,
        p['site_name'] ?? null,
        p['state'] ?? null,
        p['county'] ?? null,
        ((p['commod1'] as string) ?? '').toLowerCase() || null,
        ((p['dev_stat'] as string) ?? '').toLowerCase() || null,
        Number.isFinite(Number(p['disc_yr'])) ? Number(p['disc_yr']) : null,
        f.geometry.coordinates[1],
        f.geometry.coordinates[0],
      ],
    );
  }
}

function normalizeClaimType(v: unknown): string | null {
  if (!v) return null;
  const s = String(v).trim().toLowerCase();
  if (s.startsWith('lode')) return 'lode';
  if (s.startsWith('plac')) return 'placer';
  if (s.startsWith('mill')) return 'mill_site';
  if (s.startsWith('tunn')) return 'tunnel_site';
  if (s.startsWith('sand')) return 'sand_gravel';
  return null;
}

function normalizeClaimStatus(v: unknown): string | null {
  if (!v) return null;
  const s = String(v).trim().toLowerCase();
  if (s === 'active' || s === 'closed' || s === 'void' || s === 'pending' || s === 'relinquished' || s === 'forfeited') return s;
  return null;
}

function epochToDate(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v).toISOString().slice(0, 10);
  if (typeof v === 'string' && v) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return null;
}

async function main() {
  console.log('[seed] bounding box:', SEED_BBOX.join(','));
  await seedClaims();
  await seedOccurrences();
  console.log('[seed] done.');
  await pool.end();
}

main().catch((err) => {
  console.error('[seed] failed', err);
  process.exit(1);
});
