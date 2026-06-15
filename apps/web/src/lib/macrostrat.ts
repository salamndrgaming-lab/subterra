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
const UNITS_ENDPOINT = 'https://macrostrat.org/api/v2/units';

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

/** A single stratigraphic unit at the column — full vertical detail.
 *  Used to render the visual log (thickness bars). */
export interface StratUnit {
  name: string;
  age: string;
  /** Maximum reported thickness in meters. Null if unknown. */
  thicknessM?: number;
  /** Numerical age range start/end (Ma — millions of years ago).
   *  bAge = older bound, tAge = younger bound. */
  bAge?: number;
  tAge?: number;
  color?: string;
  lithology?: string;
  environment?: string;
}

export interface GeologyAtPoint {
  units: GeologyUnit[];
  /** Macrostrat column id at this point, if one is nearby. Used to build
   *  the burwell stratigraphic-column image URL. */
  columnId?: number;
  /** Full vertical stratigraphic units at the column. Rendered as a
   *  thickness-bar visual log in the drawer. */
  strat: StratUnit[];
  /** External link to the same point on Macrostrat's interactive map. */
  macrostratUrl: string;
  /** Link to the USGS National Geologic Map Database viewer at this
   *  point — shows the published geologic map sheets covering it. */
  ngmdbUrl: string;
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

/** Column-units cache — Macrostrat columns are ~50 km wide, so a
 *  cross-section's 25 sample points usually share one or two columns.
 *  Caching the units promise per col_id collapses 25 unit fetches into
 *  1-2 and also speeds up repeated drawer clicks in the same area. */
const columnUnitsCache = new Map<number, Promise<StratUnit[]>>();

function fetchColumnUnitsCached(columnId: number): Promise<StratUnit[]> {
  let p = columnUnitsCache.get(columnId);
  if (!p) {
    p = fetchColumnUnits(columnId).catch((err) => {
      // Don't cache failures — next call retries.
      columnUnitsCache.delete(columnId);
      throw err;
    });
    columnUnitsCache.set(columnId, p);
  }
  return p;
}

export async function fetchGeology(lng: number, lat: number): Promise<GeologyAtPoint> {
  const [mapUnits, columnId] = await Promise.all([
    fetchMapUnits(lng, lat),
    fetchNearestColumn(lng, lat).catch(() => undefined),
  ]);
  // Fetch full unit detail only if we have a column to query against.
  const strat = columnId !== undefined
    ? await fetchColumnUnitsCached(columnId).catch(() => [])
    : [];
  const macrostratUrl = `https://macrostrat.org/map/dev#x=${lng.toFixed(4)}&y=${lat.toFixed(4)}&z=10`;
  const ngmdbUrl = `https://ngmdb.usgs.gov/mapview/?center=${lng.toFixed(4)},${lat.toFixed(4)}&zoom=11`;
  return { units: mapUnits, columnId, strat, macrostratUrl, ngmdbUrl };
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

/** Detailed stratigraphic units at one Macrostrat column.
 *  This is the "visual log" data: every formation with thickness,
 *  age range, lithology, and depositional environment. */
async function fetchColumnUnits(columnId: number): Promise<StratUnit[]> {
  const url = new URL(UNITS_ENDPOINT);
  url.searchParams.set('col_id', String(columnId));
  url.searchParams.set('response', 'long');
  const res = await fetch(url.toString(), {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Macrostrat units ${res.status}`);
  const body = (await res.json()) as {
    success?: {
      data?: Array<{
        strat_name?: string;
        unit_name?: string;
        name?: string;
        age?: string;
        b_age?: number;
        t_age?: number;
        b_int_name?: string;
        t_int_name?: string;
        max_thick?: number;
        min_thick?: number;
        color?: string;
        lith?: string;
        environ?: string;
      }>;
    };
  };
  const data = body.success?.data ?? [];
  return data.map<StratUnit>((d) => ({
    name: d.strat_name || d.unit_name || d.name || '(unnamed)',
    age:
      d.age ??
      (d.b_int_name && d.t_int_name && d.b_int_name !== d.t_int_name
        ? `${d.t_int_name}–${d.b_int_name}`
        : (d.t_int_name ?? d.b_int_name ?? '')),
    thicknessM: d.max_thick ?? d.min_thick,
    bAge: d.b_age,
    tAge: d.t_age,
    color: d.color,
    lithology: d.lith,
    environment: d.environ,
  }));
}

/** URL for the burwell stratigraphic-column image at this column id.
 *  Renders a vertical column showing every formation stacked by age,
 *  shaded by lithology. */
export function columnImageUrl(columnId: number): string {
  return `https://macrostrat.org/api/v2/columns/${columnId}/image?width=180`;
}
