/**
 * USGS National Map EPQS elevation lookup.
 *
 * EPQS = Elevation Point Query Service. Free, no key, returns the DEM
 * elevation at a lat/lng. Useful prospecting context: surface elevation
 * gives a frame of reference for drill-depth + topographic targeting.
 *
 * Source: https://epqs.nationalmap.gov/v1/json
 */

export interface ElevationResult {
  meters: number;
  feet: number;
}

const ENDPOINT = 'https://epqs.nationalmap.gov/v1/json';

export async function fetchElevation(lng: number, lat: number): Promise<ElevationResult | null> {
  const url = new URL(ENDPOINT);
  url.searchParams.set('x', lng.toFixed(6));
  url.searchParams.set('y', lat.toFixed(6));
  url.searchParams.set('units', 'Meters');
  url.searchParams.set('wkid', '4326');
  url.searchParams.set('includeDate', 'false');
  const res = await fetch(url.toString(), {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) return null;
  const body = (await res.json()) as {
    value?: number | string;
    elevation?: number | string;
  };
  const v = Number(body.value ?? body.elevation);
  if (!Number.isFinite(v) || v < -500) return null; // -1e+38 sentinel = no data
  return { meters: v, feet: v * 3.28084 };
}
