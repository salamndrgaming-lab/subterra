/**
 * Place geocoder using OSM Nominatim.
 *
 * Nominatim has multiple free community mirrors with a strict 1-req/sec
 * policy. We use a Subterra-identifying User-Agent string and only fire
 * on explicit user submit, so we stay well within the policy.
 */

export interface GeocodeHit {
  display: string;
  lng: number;
  lat: number;
  bbox?: [number, number, number, number]; // west, south, east, north
}

const ENDPOINT = 'https://nominatim.openstreetmap.org/search';
const UA = 'Subterra/0.1 (https://subterra.pages.dev)';

export async function geocode(query: string): Promise<GeocodeHit[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const url = new URL(ENDPOINT);
  url.searchParams.set('q', q);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '5');
  url.searchParams.set('addressdetails', '0');
  url.searchParams.set('countrycodes', 'us');
  const res = await fetch(url.toString(), {
    headers: { accept: 'application/json', 'user-agent': UA },
  });
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  const body = (await res.json()) as Array<{
    display_name: string;
    lon: string;
    lat: string;
    boundingbox?: [string, string, string, string];
  }>;
  return body.map((r) => ({
    display: r.display_name,
    lng: Number(r.lon),
    lat: Number(r.lat),
    bbox: r.boundingbox
      ? [Number(r.boundingbox[2]), Number(r.boundingbox[0]), Number(r.boundingbox[3]), Number(r.boundingbox[1])]
      : undefined,
  }));
}
