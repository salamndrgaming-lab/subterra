/**
 * OpenStreetMap Nominatim geocoder client. Free, no key, but the public
 * endpoint requires a descriptive User-Agent and asks for ≤1 request per
 * second. We respect both — every call goes through Redis-cached results
 * (1h) and a short in-memory queue.
 *
 * Docs: https://operations.osmfoundation.org/policies/nominatim/
 */
import { cached } from './cache.js';

const ENDPOINT = process.env.NOMINATIM_URL ?? 'https://nominatim.openstreetmap.org/search';
const USER_AGENT =
  process.env.NOMINATIM_USER_AGENT ??
  'Subterra/0.1 (+https://github.com/salamndrgaming-lab/subterra)';

let lastCallAt = 0;
const MIN_INTERVAL_MS = 1100;

async function throttle() {
  const wait = MIN_INTERVAL_MS - (Date.now() - lastCallAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

export interface GeocodeHit {
  label: string;          // human-readable (e.g. "Midland, Midland County, TX, US")
  lat: number;
  lng: number;
  bbox: [number, number, number, number] | null;  // [w, s, e, n]
  type: string;           // OSM class (place, boundary, building, ...)
  importance: number;
}

export async function geocode(q: string, limit = 8): Promise<GeocodeHit[]> {
  const trimmed = q.trim();
  if (!trimmed) return [];
  const key = `geo:nominatim:${trimmed.toLowerCase()}:${limit}`;

  return cached(key, 3600, async () => {
    await throttle();
    const url = new URL(ENDPOINT);
    url.searchParams.set('q', trimmed);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('addressdetails', '0');
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('countrycodes', 'us,ca');     // bias to North America

    const res = await fetch(url.toString(), {
      headers: { 'User-Agent': USER_AGENT, accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`Nominatim ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const body = (await res.json()) as Array<{
      display_name: string;
      lat: string;
      lon: string;
      boundingbox?: [string, string, string, string];   // [s, n, w, e]
      class: string;
      importance?: number;
    }>;

    return body.map((r) => {
      const lat = Number(r.lat);
      const lng = Number(r.lon);
      let bbox: [number, number, number, number] | null = null;
      if (r.boundingbox && r.boundingbox.length === 4) {
        const [s, n, w, e] = r.boundingbox.map(Number) as [number, number, number, number];
        if ([w, s, e, n].every(Number.isFinite)) bbox = [w, s, e, n];
      }
      return {
        label: r.display_name,
        lat,
        lng,
        bbox,
        type: r.class,
        importance: r.importance ?? 0,
      };
    });
  });
}
