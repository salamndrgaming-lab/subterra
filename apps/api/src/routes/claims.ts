import { Router } from 'express';
import { fetchBlmClaimById, fetchBlmClaims } from '../sources/blm-claims.js';
import { fetchMrds } from '../sources/usgs-mrds.js';
import { HttpError } from '../middleware/error.js';
import { haversineKm } from '../lib/geo.js';
import { query } from '../db.js';

export const claimsRouter = Router();

/**
 * Mining claim detail. Looks in PostGIS first (cached + supplemented by ETL),
 * then falls back to the live BLM National Mining Claims FeatureServer.
 * Nearby occurrences come from the live USGS MRDS WFS within ~50 km.
 */
claimsRouter.get('/:id', async (req, res, next) => {
  try {
    const id = req.params.id;

    const dbRow = await query<{
      id: string; serial_number: string; claim_name: string | null;
      claim_type: string | null; status: string | null; owner_name: string | null;
      owner_address: string | null; commodity: string | null;
      state: string; county: string | null; meridian: string | null;
      plss_township: string | null; plss_range: string | null; plss_section: number | null;
      location_date: Date | null; recordation_date: Date | null;
      last_assessment_year: number | null; acreage: string | null;
      geom: unknown; centroid: unknown; lng: number; lat: number;
    }>(
      `SELECT id, serial_number, claim_name, claim_type::text, status::text,
              owner_name, owner_address, commodity, state, county, meridian,
              plss_township, plss_range, plss_section,
              location_date, recordation_date, last_assessment_year, acreage,
              ST_AsGeoJSON(geom)::jsonb AS geom,
              ST_AsGeoJSON(centroid)::jsonb AS centroid,
              ST_X(centroid) AS lng, ST_Y(centroid) AS lat
         FROM mining_claims
        WHERE id::text = $1 OR serial_number = $1
        LIMIT 1`,
      [id],
    );

    let claim: Record<string, unknown> | null = null;
    let lng: number | null = null;
    let lat: number | null = null;

    if (dbRow.rows.length > 0) {
      const r = dbRow.rows[0]!;
      lng = r.lng; lat = r.lat;
      claim = {
        id: r.id,
        serialNumber: r.serial_number,
        claimName: r.claim_name,
        claimType: r.claim_type,
        status: r.status,
        ownerName: r.owner_name,
        ownerAddress: r.owner_address,
        commodity: r.commodity,
        state: r.state,
        county: r.county,
        meridian: r.meridian,
        plssTownship: r.plss_township,
        plssRange: r.plss_range,
        plssSection: r.plss_section,
        locationDate: r.location_date?.toISOString().slice(0, 10) ?? null,
        recordationDate: r.recordation_date?.toISOString().slice(0, 10) ?? null,
        lastAssessmentYear: r.last_assessment_year,
        acreage: r.acreage == null ? null : Number(r.acreage),
        geom: r.geom,
        centroid: r.centroid,
      };
    } else {
      const live = await fetchBlmClaimById(id);
      if (live) {
        const ring = live.geom.coordinates[0]?.[0];
        if (ring && ring.length) {
          let sx = 0, sy = 0;
          for (const pt of ring) { sx += pt[0]!; sy += pt[1]!; }
          lng = sx / ring.length; lat = sy / ring.length;
        }
        claim = { ...live };
      }
    }

    if (!claim) {
      throw new HttpError(404, 'not_found', 'Claim not found in PostGIS or BLM National Mining Claims FeatureServer');
    }

    let nearbyOccurrences: Array<Record<string, unknown> & { distanceKm: number }> = [];
    if (lng != null && lat != null) {
      const occ = await fetchMrds({
        bbox: [lng - 0.5, lat - 0.5, lng + 0.5, lat + 0.5],
        limit: 50,
      });
      nearbyOccurrences = occ.features
        .map((f) => ({
          ...(f.properties as unknown as Record<string, unknown>),
          distanceKm: haversineKm([lng!, lat!], (f.geometry as { coordinates: [number, number] }).coordinates),
        }))
        .filter((m) => m.distanceKm < 50)
        .sort((a, b) => a.distanceKm - b.distanceKm)
        .slice(0, 10);
    }

    const filingHistory = [
      claim['locationDate'] ? { event: 'Notice of Location filed', date: claim['locationDate'] as string, agency: 'BLM' } : null,
      claim['recordationDate'] ? { event: 'Recorded with county', date: claim['recordationDate'] as string, agency: claim['county'] as string } : null,
      claim['lastAssessmentYear']
        ? { event: `Annual maintenance fee paid (FY${claim['lastAssessmentYear']})`, date: `${claim['lastAssessmentYear']}-08-31`, agency: 'BLM' }
        : null,
    ].filter(Boolean);

    res.json({ claim, nearbyOccurrences, filingHistory });
  } catch (err) {
    next(err);
  }
});

/**
 * List claims for a serial-number prefix; used by the search box. Live BLM.
 */
claimsRouter.get('/', async (req, res, next) => {
  try {
    const prefix = String(req.query['prefix'] ?? '').slice(0, 32);
    if (!prefix) {
      res.json({ type: 'FeatureCollection', features: [] });
      return;
    }
    const fc = await fetchBlmClaims({ status: 'active', limit: 50 });
    const matches = fc.features.filter((f) => f.properties.serialNumber?.startsWith(prefix));
    res.json({ type: 'FeatureCollection', features: matches });
  } catch (err) {
    next(err);
  }
});
