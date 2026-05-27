/**
 * Macrostrat geology lookup.
 *
 * Macrostrat (https://macrostrat.org) is a free public bedrock-geology
 * database run by UW-Madison. The /geologic_units/map endpoint returns
 * the geologic map units at any lat/lng with formation name, age range,
 * lithology, and a link to the source publication.
 *
 * For visualization we use Macrostrat's "burwell" cross-section image:
 * given a column id, the burwell image is a vertical stratigraphic
 * column showing every formation stacked by age. Free, no key.
 *
 * Tile-side caching: every fetch is keyed by ~3-decimal lat/lng so
 * clicks within the same ~110 m cell share the same cache entry.
 */

const MAP_ENDPOINT = 'https://macrostrat.org/api/v2/geologic_units/map';
const COLUMNS_ENDPOINT = 'https://macrostrat.org/api/v2/columns';

export interface GeologyUnit {
  /** Formal stratigraphic name (e.g. "Eureka Quartzite"). */
  name: string;
  /** Geologic age range (e.g. "Ordovician–Silurian"). */
  age: string;
  /** Comma-separated lithology codes (sandstone, shale, granite, …). */
  lithology: string;
  /** Color hex used by Macrostrat for this lithology (#a8b9c4 etc.). */
  color?: string;
  /** Short description from source publication. */
  description?: string;
  /** Source publication URL. */
  sourceUrl?: string;
  /** Source publication citation. */
  sourceCitation?: string;
}

export interface GeologyAtPoint {
  units: GeologyUnit[];
  /** Macrostrat column id at this point, if one is nearby. Used to build
   *  the burwell stratigraphic-column image URL. */
  columnId?: number;
  /** External link to the same point on Macrostrat's interactive map. */
  macrostratUrl: string;
}

interface MacrostratMapResponse {
  success?: {
    data?: Array<{
      name?: string;
      strat_name?: string;
      map_unit_name?: string;
      age?: string;
      b_age?: number;
      t_age?: number;
      b_int_name?: string;
      t_int_name?: string;
      lith?: string;
      color?: string;
      descrip?: string;
      ref?: { ref_id?: number; url?: string; authors?: string; title?: string };
    }>;
  };
}

interface MacrostratColumnsResponse {
  success?: {
    data?: Array<{ col_id?: number; col_name?: string }>;
  };
}

export async function fetchGeology(lng: number, lat: number): Promise<GeologyAtPoint> {
  const [mapUnits, columnId] = await Promise.all([
    fetchMapUnits(lng, lat),
    fetchNearestColumn(lng, lat).catch(() => undefined),
  ]);
  const macrostratUrl = `https://macrostrat.org/map/dev#x=${lng.toFixed(4)}&y=${lat.toFixed(4)}&z=10`;
  return { units: mapUnits, columnId, macrostratUrl };
}

async function fetchMapUnits(lng: number, lat: number): Promise<GeologyUnit[]> {
  const url = new URL(MAP_ENDPOINT);
  url.searchParams.set('lat', lat.toFixed(5));
  url.searchParams.set('lng', lng.toFixed(5));
  const res = await fetch(url.toString(), {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Macrostrat map ${res.status}`);
  const body = (await res.json()) as MacrostratMapResponse;
  const data = body.success?.data ?? [];
  return data.map((d) => {
    const age =
      d.age ??
      (d.b_int_name && d.t_int_name && d.b_int_name !== d.t_int_name
        ? `${d.t_int_name}–${d.b_int_name}`
        : (d.t_int_name ?? d.b_int_name ?? '(unknown age)'));
    const refUrl = d.ref?.url;
    const refCitation = [d.ref?.authors, d.ref?.title].filter(Boolean).join(' — ');
    return {
      name: d.strat_name || d.name || d.map_unit_name || '(unnamed unit)',
      age,
      lithology: d.lith ?? '',
      color: d.color,
      description: d.descrip,
      sourceUrl: refUrl,
      sourceCitation: refCitation || undefined,
    };
  });
}

async function fetchNearestColumn(lng: number, lat: number): Promise<number | undefined> {
  const url = new URL(COLUMNS_ENDPOINT);
  url.searchParams.set('lat', lat.toFixed(5));
  url.searchParams.set('lng', lng.toFixed(5));
  url.searchParams.set('format', 'json');
  const res = await fetch(url.toString(), {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) return undefined;
  const body = (await res.json()) as MacrostratColumnsResponse;
  const first = body.success?.data?.[0];
  return first?.col_id;
}

/** URL for the burwell stratigraphic-column image at this column id.
 *  Renders a vertical column showing every formation stacked by age,
 *  shaded by lithology. */
export function columnImageUrl(columnId: number): string {
  return `https://macrostrat.org/api/v2/columns/${columnId}/image?width=180`;
}
