/**
 * OSM Overpass API client — gives Subterra a reliable, key-less feed of
 * features tagged in OpenStreetMap that overlap our domain:
 *
 *   - active and historical mines (`industrial=mine`, `man_made=mineshaft`,
 *     `landuse=quarry`)
 *   - oil/gas wells (`man_made=petroleum_well`, `man_made=oil_well`,
 *     `industrial=oil`, `industrial=oil_field`)
 *
 * The Overpass API is free, public, and well-documented. Every Subterra
 * install gets it out of the box — no agency-specific URLs to verify.
 *
 * Endpoint: https://overpass-api.de/api/interpreter
 * Docs:    https://wiki.openstreetmap.org/wiki/Overpass_API
 */

import type { BBoxArray, GeoJSONFeatureCollection, GeoJSONPoint, GeoJSONPolygon } from '@subterra/shared';
import { cached } from './cache.js';

const PRIMARY = process.env.OVERPASS_URL ?? 'https://overpass-api.de/api/interpreter';
// Mirrors used when the primary returns 4xx or times out. All are public
// and free; published by the Overpass community.
const MIRRORS = (process.env.OVERPASS_MIRRORS ?? [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
  'https://overpass.openstreetmap.fr/api/interpreter',
].join(',')).split(',').map((s) => s.trim()).filter(Boolean);

// Overpass servers 406 anonymous Node/undici user-agents. A browser-like UA
// + descriptive contact string passes their content-negotiation gate.
const USER_AGENT = process.env.OVERPASS_USER_AGENT ??
  'Mozilla/5.0 Subterra/0.1 (+https://github.com/salamndrgaming-lab/subterra; geospatial-platform)';

export type OsmFeatureKind = 'mining' | 'oilgas';

export interface OsmFeatureProps {
  osmId: string;
  osmType: 'node' | 'way' | 'relation';
  kind: OsmFeatureKind;
  name: string | null;
  resource: string | null;        // e.g. "gold", "coal", "oil"
  operator: string | null;
  startDate: string | null;
  endDate: string | null;
  surface: string | null;
  tags: Record<string, string>;
}

const QUERIES: Record<OsmFeatureKind, (bbox: BBoxArray) => string> = {
  // Mines + quarries + mineshafts
  mining: ([w, s, e, n]) => `[out:json][timeout:25];
(
  node["industrial"="mine"](${s},${w},${n},${e});
  way["industrial"="mine"](${s},${w},${n},${e});
  node["man_made"="mineshaft"](${s},${w},${n},${e});
  node["man_made"="adit"](${s},${w},${n},${e});
  node["historic"="mine"](${s},${w},${n},${e});
  node["landuse"="quarry"](${s},${w},${n},${e});
  way["landuse"="quarry"](${s},${w},${n},${e});
);
out geom 1500;`,

  // Oil & gas surface infrastructure
  oilgas: ([w, s, e, n]) => `[out:json][timeout:25];
(
  node["man_made"="petroleum_well"](${s},${w},${n},${e});
  node["man_made"="oil_well"](${s},${w},${n},${e});
  node["man_made"="gas_well"](${s},${w},${n},${e});
  node["man_made"="pumpjack"](${s},${w},${n},${e});
  way["industrial"="oil"](${s},${w},${n},${e});
  way["industrial"="oil_field"](${s},${w},${n},${e});
  way["industrial"="oil_terminal"](${s},${w},${n},${e});
);
out geom 1500;`,
};

interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  geometry?: Array<{ lat: number; lon: number }>;
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements: OverpassElement[];
}

export async function fetchOsmFeatures(
  kind: OsmFeatureKind,
  bbox: BBoxArray,
): Promise<GeoJSONFeatureCollection<OsmFeatureProps> & { meta?: { unavailable?: string; endpoint?: string } }> {
  const q = QUERIES[kind](bbox);
  const key = `osm:${kind}:${bbox.join(',')}`;
  try {
    return await cached(key, 600, async () => {
      const body = await postOverpass(q);
      return {
        type: 'FeatureCollection' as const,
        features: body.elements.flatMap((el) => convert(el, kind)).filter(Boolean) as GeoJSONFeatureCollection<OsmFeatureProps>['features'],
      };
    });
  } catch (err) {
    console.warn(`[osm:${kind}] upstream failed: ${(err as Error).message.slice(0, 200)}`);
    return {
      type: 'FeatureCollection',
      features: [],
      meta: { unavailable: `overpass:${kind}`, endpoint: PRIMARY },
    };
  }
}

/**
 * POSTs an Overpass QL query, trying the primary endpoint first and falling
 * back to community mirrors on 4xx/5xx/timeout. Sets Accept + User-Agent
 * explicitly so well-behaved Overpass instances don't 406 us.
 */
async function postOverpass(q: string): Promise<OverpassResponse> {
  const endpoints = [PRIMARY, ...MIRRORS];
  let lastError: unknown;
  for (const url of endpoints) {
    // Try POST first, then GET — some Overpass mirrors only accept GET
    // for short queries; some 406 the POST content-type from Node.
    for (const method of ['POST', 'GET'] as const) {
      try {
        const reqUrl = method === 'GET' ? `${url}?data=${encodeURIComponent(q)}` : url;
        const res = await fetch(reqUrl, {
          method,
          body: method === 'POST' ? new URLSearchParams({ data: q }) : undefined,
          headers: {
            ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
            accept: 'application/json',
            'user-agent': USER_AGENT,
          },
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) {
          const text = (await res.text()).slice(0, 200);
          lastError = new Error(`${url} [${method}] → HTTP ${res.status}: ${text}`);
          continue;
        }
        return (await res.json()) as OverpassResponse;
      } catch (err) {
        lastError = err;
      }
    }
  }
  throw lastError ?? new Error('All Overpass endpoints unreachable');
}

function convert(el: OverpassElement, kind: OsmFeatureKind): GeoJSONFeatureCollection<OsmFeatureProps>['features'][number] | null {
  const tags = el.tags ?? {};
  const props: OsmFeatureProps = {
    osmId: `${el.type}/${el.id}`,
    osmType: el.type,
    kind,
    name: tags['name'] ?? null,
    resource: tags['resource'] ?? tags['mineral'] ?? null,
    operator: tags['operator'] ?? null,
    startDate: tags['start_date'] ?? null,
    endDate: tags['end_date'] ?? tags['abandoned:date'] ?? null,
    surface: tags['surface'] ?? null,
    tags,
  };

  if (el.type === 'node' && typeof el.lon === 'number' && typeof el.lat === 'number') {
    const geom: GeoJSONPoint = { type: 'Point', coordinates: [el.lon, el.lat] };
    return { type: 'Feature', geometry: geom, properties: props };
  }

  if ((el.type === 'way' || el.type === 'relation') && el.geometry && el.geometry.length >= 3) {
    // Treat closed ways as polygons; ignore degenerate ones.
    const ring = el.geometry.map((p) => [p.lon, p.lat] as [number, number]);
    const first = ring[0]; const last = ring[ring.length - 1];
    if (!first || !last) return null;
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
    const geom: GeoJSONPolygon = { type: 'Polygon', coordinates: [ring] };
    return { type: 'Feature', geometry: geom, properties: props };
  }

  return null;
}
