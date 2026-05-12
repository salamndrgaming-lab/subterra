import { Router } from 'express';
import { HttpError } from '../middleware/error.js';
import { query } from '../db.js';

export const parcelsRouter = Router();

/**
 * Parcel detail. Parcels live exclusively in PostGIS (loaded via the parcel
 * ETL from county assessor extracts or Regrid). Surrounding activity is
 * computed against ingested wells + claims using PostGIS spatial joins.
 */
parcelsRouter.get('/:id', async (req, res, next) => {
  try {
    const id = req.params.id;

    const parcelResult = await query<{
      id: string; parcel_number: string | null; state: string; county: string;
      owner_name: string | null; owner_address: string | null; legal_description: string | null;
      acreage: string | null; estimated_value: string | null; land_use: string | null;
      surface_rights: boolean | null; mineral_rights: boolean | null;
      last_sale_date: Date | null; last_sale_price: string | null;
      geom: unknown; centroid: unknown; lng: number; lat: number;
    }>(
      `SELECT id, parcel_number, state, county, owner_name, owner_address,
              legal_description, acreage, estimated_value, land_use,
              surface_rights, mineral_rights, last_sale_date, last_sale_price,
              ST_AsGeoJSON(geom)::jsonb AS geom,
              ST_AsGeoJSON(centroid)::jsonb AS centroid,
              ST_X(centroid) AS lng, ST_Y(centroid) AS lat
         FROM parcels
        WHERE id::text = $1 OR parcel_number = $1
        LIMIT 1`,
      [id],
    );

    if (!parcelResult.rows.length) {
      throw new HttpError(404, 'not_found', 'Parcel not in PostGIS — load county assessor extract via scripts/etl/ingest-parcels.ts');
    }
    const r = parcelResult.rows[0]!;

    const wells = await query<{ id: string; well_name: string | null; operator: string | null; status: string | null; distance_m: number }>(
      `SELECT id, well_name, operator, status::text,
              ST_Distance(geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) AS distance_m
         FROM wells
        WHERE ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, 10000)
        ORDER BY distance_m
        LIMIT 10`,
      [r.lng, r.lat],
    );

    const claims = await query<{ id: string; serial_number: string; claim_name: string | null; status: string | null; commodity: string | null; distance_m: number }>(
      `SELECT id, serial_number, claim_name, status::text, commodity,
              ST_Distance(centroid::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) AS distance_m
         FROM mining_claims
        WHERE ST_DWithin(centroid::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, 10000)
        ORDER BY distance_m
        LIMIT 10`,
      [r.lng, r.lat],
    );

    res.json({
      parcel: {
        id: r.id,
        parcelNumber: r.parcel_number,
        state: r.state,
        county: r.county,
        ownerName: r.owner_name,
        ownerAddress: r.owner_address,
        legalDescription: r.legal_description,
        acreage: r.acreage == null ? null : Number(r.acreage),
        estimatedValue: r.estimated_value == null ? null : Number(r.estimated_value),
        landUse: r.land_use,
        surfaceRights: r.surface_rights,
        mineralRights: r.mineral_rights,
        lastSaleDate: r.last_sale_date?.toISOString().slice(0, 10) ?? null,
        lastSalePrice: r.last_sale_price == null ? null : Number(r.last_sale_price),
        geom: r.geom,
        centroid: r.centroid,
      },
      activity: {
        nearbyWells: wells.rows.map((w) => ({
          id: w.id,
          wellName: w.well_name,
          operator: w.operator,
          status: w.status,
          distanceKm: Number((Number(w.distance_m) / 1000).toFixed(2)),
        })),
        nearbyClaims: claims.rows.map((c) => ({
          id: c.id,
          serialNumber: c.serial_number,
          claimName: c.claim_name,
          status: c.status,
          commodity: c.commodity,
          distanceKm: Number((Number(c.distance_m) / 1000).toFixed(2)),
        })),
      },
    });
  } catch (err) {
    next(err);
  }
});
