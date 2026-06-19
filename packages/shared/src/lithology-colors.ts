/** Standard USGS-palette lithology → color mapping.
 *
 * Used by:
 *   - apps/web/src/components/CrossSection.tsx — color subsurface unit
 *     rects in the hung-column section.
 *   - packages/shared/src/layers.ts — color the SGMC bedrock-geology
 *     map layer's polygons via a MapLibre match expression (built from
 *     LITHOLOGY_COLOR_STOPS below).
 *
 * Substring match because both Macrostrat and SGMC return loose
 * strings ("sandstone", "ss", "Sandstone - fine grained, lithic"). The
 * `lithologyColor` helper returns null when no match, so callers can
 * fall back to dataset-provided per-unit colors.
 *
 * Palette tuned for the dark basemap — desaturated, distinct hues per
 * lithology class so a quick visual scan separates sedimentary from
 * igneous from metamorphic at any zoom level.
 */

/** Ordered (regex, color) tuples. Order matters: earlier entries win.
 *  Exported in this shape so the SGMC layer's MapLibre match expression
 *  can build a controlled-vocabulary lookup at runtime (where only
 *  exact-string matching is available; substring matching happens at
 *  ETL time when populating the normalized `lithology` property). */
export const LITHOLOGY_PALETTE = [
  // Sedimentary — most common in the western US prospecting target
  { match: /(limestone|dolomite|carbonate)/, color: '#7dd3fc' },
  { match: /(sandstone|\bss\b|arenite)/, color: '#fde68a' },
  { match: /(shale|mudstone|claystone|siltstone)/, color: '#94a3b8' },
  { match: /conglomerate/, color: '#fcd34d' },
  { match: /(evaporite|gypsum|halite|anhydrite)/, color: '#fce7f3' },
  { match: /coal/, color: '#1f2937' },
  { match: /(chert|jasperoid)/, color: '#fb923c' },
  // Igneous
  { match: /(granite|granodiorite|tonalite|diorite|monzonite)/, color: '#fda4af' },
  { match: /(basalt|gabbro|diabase|dolerite)/, color: '#7c3aed' },
  { match: /(rhyolite|tuff|ignimbrite|dacite|andesite|volcanic)/, color: '#f43f5e' },
  // Metamorphic
  { match: /(schist|gneiss|amphibolite)/, color: '#86efac' },
  { match: /quartzite/, color: '#fef3c7' },
  { match: /marble/, color: '#e0f2fe' },
  { match: /(slate|phyllite)/, color: '#64748b' },
] as const;

/** Canonical lithology buckets the SGMC ETL emits in the normalized
 *  `lithology` property. The map's MapLibre match expression keys off
 *  these exact strings — keep in sync with
 *  etl/sources/sgmc.py:ROCKTYPE_TO_LITHOLOGY. */
export const SGMC_LITHOLOGY_COLORS: Record<string, string> = {
  sandstone: '#fde68a',
  limestone: '#7dd3fc',
  dolomite: '#7dd3fc',
  shale: '#94a3b8',
  mudstone: '#94a3b8',
  siltstone: '#94a3b8',
  claystone: '#94a3b8',
  conglomerate: '#fcd34d',
  evaporite: '#fce7f3',
  gypsum: '#fce7f3',
  halite: '#fce7f3',
  chert: '#fb923c',
  coal: '#1f2937',
  granite: '#fda4af',
  granodiorite: '#fda4af',
  diorite: '#fda4af',
  gabbro: '#7c3aed',
  basalt: '#7c3aed',
  rhyolite: '#f43f5e',
  andesite: '#f43f5e',
  dacite: '#f43f5e',
  tuff: '#f43f5e',
  ignimbrite: '#f43f5e',
  schist: '#86efac',
  gneiss: '#86efac',
  amphibolite: '#86efac',
  quartzite: '#fef3c7',
  marble: '#e0f2fe',
  slate: '#64748b',
  phyllite: '#64748b',
};

/** Default fill for SGMC polygons that don't match a known lithology. */
export const SGMC_DEFAULT_COLOR = '#475569';

/** Map a free-form lithology string to a USGS-palette color via regex.
 *  Loose-typed input — accepts Macrostrat's nested `{name, lith_class}`
 *  objects + arrays + plain strings. Returns null when no rule matches
 *  so callers can fall back to a dataset-provided color. */
export function lithologyColor(lithology: unknown): string | null {
  if (lithology == null) return null;
  let str: string;
  if (typeof lithology === 'string') {
    str = lithology;
  } else if (Array.isArray(lithology)) {
    str = lithology
      .map((x) => (typeof x === 'string'
        ? x
        : (x && typeof x === 'object' && 'name' in x ? String((x as { name: unknown }).name) : '')))
      .filter(Boolean)
      .join(' ');
  } else if (typeof lithology === 'object' && lithology !== null && 'name' in lithology) {
    str = String((lithology as { name: unknown }).name);
  } else {
    str = String(lithology);
  }
  if (!str) return null;
  const l = str.toLowerCase();
  for (const entry of LITHOLOGY_PALETTE) {
    if (entry.match.test(l)) return entry.color;
  }
  return null;
}

/** Build a MapLibre `match` expression that paints a feature by its
 *  controlled-vocabulary `lithology` property (as emitted by the SGMC
 *  ETL). Falls back to SGMC_DEFAULT_COLOR for unmatched lithologies. */
export function buildSgmcFillExpression(): readonly unknown[] {
  const stops: unknown[] = ['match', ['get', 'lithology']];
  for (const [lith, color] of Object.entries(SGMC_LITHOLOGY_COLORS)) {
    stops.push(lith, color);
  }
  stops.push(SGMC_DEFAULT_COLOR);
  return stops;
}
