/** Cross-section modal — vertical section between two map clicks.
 *
 *  Layers in the SVG (top → bottom):
 *    1. Statistics callouts (top-left) — length, relief, max slope,
 *       point counts. Visible at a glance for "is this section
 *       interesting" gut-check.
 *    2. Hover crosshair — vertical line at the cursor with a readout
 *       balloon showing distance / elevation / slope / formation /
 *       surface-management agency at that x position.
 *    3. MRDS occurrences — colored dots on the topo line, sized by
 *       commodity-category importance. Labels for the top-5 by
 *       commodity rank so users can read names without hovering.
 *    4. Mining claims — small inverted-triangle markers above the
 *       topo line wherever an active BLM claim's centroid projects
 *       within the buffer. Competition signal at a glance.
 *    5. Geochem anomaly markers (when available) — small purple
 *       diamonds above topo wherever a high-As sample lands in the
 *       buffer. Strong vectoring signal for Au exploration.
 *    6. Topographic profile — amber line, optionally rendered as a
 *       filled mountain shape beneath for visual weight.
 *    7. Geology bands — beneath the topo line, painted by formation,
 *       with inline labels when a band is wide enough to fit text.
 *    8. Surface-management strip — agency-colored band below geology
 *       so users can see what BLM/USFS/NPS jurisdiction each part of
 *       the section sits under (drives stakeability).
 *    9. X-axis with dual units (km + miles) and Y-axis with dual
 *       units (meters + feet).
 *
 *  Controls (toolbar above the SVG):
 *    - Vertical exaggeration slider (1× ↔ 50×) — true scale is rarely
 *      meaningful at section lengths > ~1 km; users need to choose.
 *    - Buffer width slider (0.25 mi ↔ 5 mi) — re-projects MRDS /
 *      claims / geochem live as the buffer changes.
 *    - Reverse button — swaps A and B so the section reads the other
 *      direction. Common after the first pick reveals the wrong end.
 *    - Download PNG — rasterizes the SVG via a canvas + toBlob.
 *    - Open A / Open B — Google Maps links for each endpoint.
 *
 *  Math is in lib/section-math.ts; data fetches use existing
 *  lib/elevation + lib/macrostrat helpers with a small in-component
 *  cache so re-renders during VE/buffer changes don't refetch. */

import { Component, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as React from 'react';

import { fetchElevation } from '@/lib/elevation';
import { columnViewerUrl, fetchGeology, type StratUnit } from '@/lib/macrostrat';
import {
  bearingDeg,
  interpolatePolyline,
  lngLatAtDistance,
  polylineCrossingsAll,
  polylineLength,
  polylineSegments,
  projectOntoPolyline,
  type PolylineSegment,
  type LngLat,
} from '@/lib/section-math';
import { COMMODITY_CATEGORY_COLORS } from '@subterra/shared';

// Sample counts. On narrow viewports we cut these roughly in half so
// the SVG has fewer elements (~480 rects + labels for 24 columns; ~240
// for 12). Heavy SVG renders on mobile compete with MapLibre for GPU
// memory and have been observed to force a WebGL context loss on the
// map canvas underneath — which read to the user as "the whole site
// blacks out" because the modal backdrop was semi-transparent and the
// dead map canvas showed through. The opaque mobile backdrop below
// hides the map regardless; this just reduces the GPU pressure.
const ELEV_SAMPLES_DESKTOP = 100;
const ELEV_SAMPLES_MOBILE = 60;
const GEOLOGY_SAMPLES_DESKTOP = 24;
const GEOLOGY_SAMPLES_MOBILE = 14;
// Default to the desktop values for code paths that run before the
// per-instance `compact` flag is available (the loading-placeholder
// label uses these; values are recomputed at fetch time).
const ELEV_SAMPLES = ELEV_SAMPLES_DESKTOP;
const GEOLOGY_SAMPLES = GEOLOGY_SAMPLES_DESKTOP;
const DEFAULT_BUFFER_M = 1609; // 1 mile
const MIN_BUFFER_M = 400;
const MAX_BUFFER_M = 8000;
const DEFAULT_VE = 4; // vertical exaggeration on first open
const MIN_VE = 1;
/** Field cross-sections routinely use 50-200×; the previous 30 cap was
 *  arbitrary and prevented genuinely useful exaggeration on
 *  long-baseline sections in subdued terrain. */
const MAX_VE = 100;
/** Subsurface depth-window options (meters below lowest surface point).
 *  Macrostrat columns can stack 5-10 km of section; rendering all of it
 *  squashes the interesting near-surface units. Default 1 km. */
const DEPTH_OPTIONS = [500, 1000, 2000, 4000] as const;
const DEFAULT_DEPTH_M = 1000;

/** localStorage key for the sticky slider settings (VE / buffer /
 *  depth / true-scale). Endpoints are NOT persisted — those follow the
 *  AOI the user clicked. Bump the version suffix when the schema
 *  changes; older blobs are silently discarded. */
const PERSIST_KEY = 'subterra:cs:v1';

interface PersistedPrefs {
  ve: number;
  bufferM: number;
  depthM: number;
  trueScale: boolean;
}

function loadPersistedPrefs(): Partial<PersistedPrefs> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(PERSIST_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<PersistedPrefs>;
    return {
      ve: typeof parsed.ve === 'number' ? parsed.ve : undefined,
      bufferM: typeof parsed.bufferM === 'number' ? parsed.bufferM : undefined,
      depthM: typeof parsed.depthM === 'number' ? parsed.depthM : undefined,
      trueScale: typeof parsed.trueScale === 'boolean' ? parsed.trueScale : undefined,
    };
  } catch {
    return {};
  }
}

function savePersistedPrefs(prefs: PersistedPrefs): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PERSIST_KEY, JSON.stringify(prefs));
  } catch {
    // localStorage may be unavailable (private mode, quota) — silently
    // skip persistence rather than crash the modal.
  }
}

/** Build a one-line plain-text citation for this cross-section. Used
 *  by the Copy-citation button + stamped onto downloaded PNGs. Format
 *  is deliberately readable + machine-parseable without ceremony. */
function buildCitation(opts: {
  vertices: LngLat[];
  ve: number;
  bufferM: number;
  depthM: number;
  trueScale: boolean;
  url: string;
}): string {
  const fmt = (p: LngLat) => `${p[0].toFixed(3)}, ${p[1].toFixed(3)}`;
  const scale = opts.trueScale ? '1:1 (true scale)' : `VE ${opts.ve}×`;
  const bufMi = (opts.bufferM / 1609.34).toFixed(2);
  const depthKm = (opts.depthM / 1000).toFixed(1);
  const today = new Date().toISOString().slice(0, 10);
  // Vertex chain — A → B for 2-vertex, A → … → C for 3+.
  let chain: string;
  if (opts.vertices.length === 2) {
    chain = `A (${fmt(opts.vertices[0]!)}) → B (${fmt(opts.vertices[1]!)})`;
  } else {
    const first = fmt(opts.vertices[0]!);
    const last = fmt(opts.vertices[opts.vertices.length - 1]!);
    chain = `A (${first}) → ${opts.vertices.length - 2} bend${
      opts.vertices.length - 2 === 1 ? '' : 's'
    } → ${String.fromCharCode(65 + opts.vertices.length - 1)} (${last})`;
  }
  return [
    `Subterra cross-section ${chain}.`,
    `${scale}, buffer ±${bufMi} mi, depth window ${depthKm} km.`,
    `Data: Macrostrat v2 (geology), USGS EPQS (topo), USGS Quaternary Faults,`,
    `BLM SMA / claims (federal). Generated ${today}. ${opts.url}`,
  ].join('\n');
}

export interface CrossSectionMrds {
  lng: number;
  lat: number;
  name?: string;
  commodity?: string;
}

export interface CrossSectionClaim {
  lng: number;
  lat: number;
  serial?: string;
  claimant?: string;
  acreage?: string;
}

export interface CrossSectionGeochem {
  lng: number;
  lat: number;
  asPpm?: number;
  element?: string;
}

export interface CrossSectionAgency {
  lng: number;
  lat: number;
  agency?: string;
  name?: string;
}

/** A fault trace from the quaternary-faults layer — raw polyline
 *  coordinates plus display attributes. The modal computes exact
 *  crossings with the AB line itself (buffer-independent). */
export interface CrossSectionFault {
  coords: LngLat[];
  name?: string;
  slipSense?: string;
  slipRate?: string;
  age?: string;
}

interface ElevSample {
  t: number;
  distM: number;
  elevM: number | null;
}

interface GeoSample {
  t: number;
  distM: number;
  color: string;
  label: string;
  age?: string;
  lithology?: string;
  /** Macrostrat column id at this sample — used to group adjacent
   *  samples into column blocks for the subsurface section. */
  columnId?: number;
  /** Full stratigraphic column (ordered top → bottom) at this sample. */
  strat: StratUnit[];
}

interface FaultCrossing {
  /** Distance along the polyline in meters from the first vertex.
   *  Multi-segment-aware: a fault that wiggles can produce crossings
   *  in multiple segments; each is recorded by its accumulated distance. */
  distM: number;
  name: string;
  slipSense: string;
  slipRate: string;
  age: string;
}

interface ProjectedPoint {
  distM: number;
  distFromLineM: number;
}

interface ProjectedMrds extends ProjectedPoint {
  color: string;
  rank: number;
  name: string;
  commodity: string;
  category: keyof typeof COMMODITY_CATEGORY_COLORS;
}

interface ProjectedClaim extends ProjectedPoint {
  serial: string;
  claimant: string;
  acreage: string;
}

interface ProjectedGeochem extends ProjectedPoint {
  asPpm: number | null;
  element: string;
}

/** Wraps the real CrossSection component in an error boundary so a
 *  render exception inside it (e.g. a bad data shape from a Macrostrat
 *  response) doesn't blank the surrounding UI — surfaces a useful
 *  fallback with a Close button instead. Mounts as a sibling to the
 *  rest of Map.tsx; without this boundary, an unhandled error inside
 *  the modal renders nothing visible and the user sees a black screen. */
export function CrossSection(props: CrossSectionProps) {
  return (
    <CrossSectionErrorBoundary onClose={props.onClose}>
      <CrossSectionInner {...props} />
    </CrossSectionErrorBoundary>
  );
}

interface CrossSectionProps {
  /** Polyline of 2+ pick vertices (A → B → C → …). A 2-vertex array
   *  behaves identically to the prior single-segment A→B section.
   *  3+ vertices render a bent-line section with each consecutive
   *  pair forming a segment. */
  vertices: LngLat[];
  mrds: CrossSectionMrds[];
  claims: CrossSectionClaim[];
  geochem: CrossSectionGeochem[];
  agencies: CrossSectionAgency[];
  faults: CrossSectionFault[];
  onClose: () => void;
}

class CrossSectionErrorBoundary extends Component<
  { children: React.ReactNode; onClose: () => void },
  { error: Error | null }
> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Logged so a returning user can find this in the JS console.
    console.error('CrossSection render error:', error, info);
  }
  override render() {
    if (this.state.error) {
      return (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center p-4 backdrop-blur"
          style={{ backgroundColor: 'rgba(10, 12, 16, 0.92)' }}
          role="dialog"
          aria-modal="true"
          aria-label="Cross-section error"
        >
          <div
            className="flex max-w-md flex-col gap-3 rounded-lg border border-red-500/40 p-4 font-mono text-[12px] text-text shadow-2xl"
            style={{ backgroundColor: '#161a22' }}
          >
            <div className="text-sm font-semibold text-red-300">Cross-section error</div>
            <div className="text-text-muted">{this.state.error.message || String(this.state.error)}</div>
            <button
              type="button"
              onClick={this.props.onClose}
              className="self-end rounded border border-border bg-bg-panel px-3 py-1 text-text-muted hover:border-accent hover:text-accent"
            >
              Close
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function CrossSectionInner({
  vertices: initialVertices,
  mrds,
  claims = [],
  geochem = [],
  agencies = [],
  faults = [],
  onClose,
}: {
  vertices: LngLat[];
  mrds: CrossSectionMrds[];
  claims?: CrossSectionClaim[];
  geochem?: CrossSectionGeochem[];
  agencies?: CrossSectionAgency[];
  faults?: CrossSectionFault[];
  onClose: () => void;
}) {
  // Local polyline state — own subsequent ordering so the Reverse
  // button can flip the whole chain without bouncing back to the
  // caller. Defaults to the caller-supplied vertices.
  const [polyVertices, setPolyVertices] = useState<LngLat[]>(initialVertices);
  // Restore sticky toolbar settings from localStorage on first mount
  // so a user's preferred VE / buffer / depth carries between sessions.
  // Endpoints come from the caller and are NOT persisted.
  const persistedRef = useRef(loadPersistedPrefs());
  const [bufferM, setBufferM] = useState(persistedRef.current.bufferM ?? DEFAULT_BUFFER_M);
  const [ve, setVe] = useState(persistedRef.current.ve ?? DEFAULT_VE);
  const [depthM, setDepthM] = useState<number>(persistedRef.current.depthM ?? DEFAULT_DEPTH_M);
  // True-scale mode forces the y-axis to render at real meters-per-pixel
  // (squashes the section to ~1:50 aspect). Most real sections look bad
  // in true scale — that's the point. The toggle exists to make the
  // dishonesty of "VE 8×" visceral when an academic asks why something
  // looks dramatic. When on, the VE slider is disabled.
  const [trueScale, setTrueScale] = useState<boolean>(persistedRef.current.trueScale ?? false);

  // Persist the sticky preferences whenever they change.
  useEffect(() => {
    savePersistedPrefs({ ve, bufferM, depthM, trueScale });
  }, [ve, bufferM, depthM, trueScale]);

  const segments = useMemo(() => polylineSegments(polyVertices), [polyVertices]);
  const totalDistM = useMemo(() => polylineLength(polyVertices), [polyVertices]);
  // Header bearing = first segment. For 3+ vertex polylines, each
  // segment has its own bearing; the stats callout shows a per-segment
  // breakdown.
  const bearing = useMemo(
    () => (polyVertices.length >= 2 ? bearingDeg(polyVertices[0]!, polyVertices[1]!) : 0),
    [polyVertices],
  );

  const [elev, setElev] = useState<ElevSample[]>([]);
  const [geology, setGeology] = useState<GeoSample[]>([]);
  const [loading, setLoading] = useState<{ elev: boolean; geology: boolean }>({
    elev: true,
    geology: true,
  });
  // Macrostrat fetch can silently fail (free public API, occasionally
  // rate-limited or temporarily down). Track success/failure counts so
  // the footer can surface "Macrostrat unreachable" instead of just
  // showing an empty section that looks like "no data here".
  const [geoFetchStats, setGeoFetchStats] = useState<{
    ok: number;
    failed: number;
    withColumn: number;
  }>({
    ok: 0,
    failed: 0,
    withColumn: 0,
  });
  // Bumped to re-trigger the data-fetch effect when the user clicks
  // "Retry" — separate from polyline/vertex changes so we can refetch
  // without re-projecting all the MRDS/claims data.
  const [retryToken, setRetryToken] = useState(0);
  const cancelRef = useRef(false);
  const svgRef = useRef<SVGSVGElement | null>(null);

  // ─── projections (recompute when the polyline or buffer changes) ──
  const projectedMrds: ProjectedMrds[] = useMemo(() => {
    const out: ProjectedMrds[] = [];
    for (const m of mrds) {
      const proj = projectOntoPolyline([m.lng, m.lat], polyVertices);
      if (proj.distanceFrom > bufferM) continue;
      const cat = commodityCategory(m.commodity);
      out.push({
        distM: proj.distanceAlong,
        distFromLineM: proj.distanceFrom,
        category: cat,
        color: COMMODITY_CATEGORY_COLORS[cat] ?? '#94a3b8',
        rank: COMMODITY_RANK[cat] ?? 99,
        name: m.name ?? '(unnamed)',
        commodity: m.commodity ?? '',
      });
    }
    return out.sort((x, y) => x.distM - y.distM);
  }, [mrds, polyVertices, bufferM]);

  const projectedClaims: ProjectedClaim[] = useMemo(() => {
    const out: ProjectedClaim[] = [];
    const seen = new Set<string>();
    for (const c of claims) {
      const proj = projectOntoPolyline([c.lng, c.lat], polyVertices);
      if (proj.distanceFrom > bufferM) continue;
      const key = c.serial ?? `${c.lng.toFixed(5)},${c.lat.toFixed(5)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        distM: proj.distanceAlong,
        distFromLineM: proj.distanceFrom,
        serial: c.serial ?? '',
        claimant: c.claimant ?? '',
        acreage: c.acreage ?? '',
      });
    }
    return out.sort((x, y) => x.distM - y.distM);
  }, [claims, polyVertices, bufferM]);

  const projectedGeochem: ProjectedGeochem[] = useMemo(() => {
    const out: ProjectedGeochem[] = [];
    for (const g of geochem) {
      const proj = projectOntoPolyline([g.lng, g.lat], polyVertices);
      if (proj.distanceFrom > bufferM) continue;
      out.push({
        distM: proj.distanceAlong,
        distFromLineM: proj.distanceFrom,
        asPpm: typeof g.asPpm === 'number' ? g.asPpm : null,
        element: g.element ?? 'As',
      });
    }
    return out;
  }, [geochem, polyVertices, bufferM]);

  // Agencies are sampled along the line at 60 evenly-spaced points
  // (distributed across polyline segments by length) — they're large
  // polygons so per-sample lookup beats projecting every supplied
  // centroid.
  const agencyStrip = useMemo(() => buildAgencyStrip(polyVertices, agencies, totalDistM), [
    agencies, polyVertices, totalDistM,
  ]);

  // Fault crossings — exact polyline∩section intersections (no buffer:
  // a fault either crosses the section plane or it doesn't). Returns
  // distance along the polyline in meters; downstream renders convert
  // to a fraction of totalDistM for x-axis positioning.
  const faultCrossings: FaultCrossing[] = useMemo(() => {
    const out: FaultCrossing[] = [];
    for (const f of faults) {
      const dists = polylineCrossingsAll(polyVertices, f.coords);
      for (const distM of dists) {
        out.push({
          distM,
          name: f.name ?? '(unnamed fault)',
          slipSense: f.slipSense ?? '',
          slipRate: f.slipRate ?? '',
          age: f.age ?? '',
        });
      }
    }
    return out.sort((x, y) => x.distM - y.distM);
  }, [faults, polyVertices]);

  // ─── data fetching (re-runs only when AB actually changes) ──────
  useEffect(() => {
    cancelRef.current = false;
    setLoading({ elev: true, geology: true });
    // Sample counts pegged to viewport width — fewer SVG elements on
    // narrow viewports to avoid the WebGL-context-loss issue we saw
    // when MapLibre and a heavy SVG fought for GPU memory.
    const narrow = typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(max-width: 640px)').matches;
    const elevSamples = narrow ? ELEV_SAMPLES_MOBILE : ELEV_SAMPLES_DESKTOP;
    const geoSamples = narrow ? GEOLOGY_SAMPLES_MOBILE : GEOLOGY_SAMPLES_DESKTOP;
    const ePts = interpolatePolyline(polyVertices, elevSamples);
    const gPts = interpolatePolyline(polyVertices, geoSamples);

    void Promise.allSettled(ePts.map((p) => fetchElevation(p[0], p[1]))).then((settled) => {
      if (cancelRef.current) return;
      const out: ElevSample[] = settled.map((s, i) => {
        const t = i / elevSamples;
        const elevM = s.status === 'fulfilled' && s.value ? s.value.meters : null;
        return { t, distM: t * totalDistM, elevM };
      });
      setElev(out);
      setLoading((p) => ({ ...p, elev: false }));
    });

    void Promise.allSettled(gPts.map((p) => fetchGeology(p[0], p[1]))).then((settled) => {
      if (cancelRef.current) return;
      let okCount = 0;
      let failCount = 0;
      let withColumnCount = 0;
      // String hash → negative integer, used as a synthetic columnId
      // when Macrostrat has no real column for a sample (so consecutive
      // same-surface-unit samples still group into a single column
      // block in buildColumnBlocks instead of getting silently dropped).
      const synthId = (s: string): number => {
        let h = 0;
        for (let j = 0; j < s.length; j++) h = ((h << 5) - h + s.charCodeAt(j)) | 0;
        return -(Math.abs(h) || 1);
      };
      const out: GeoSample[] = settled.map((s, i) => {
        const t = i / geoSamples;
        let color = '#475569';
        let label = 'unknown';
        let age: string | undefined;
        let lithology: string | undefined;
        let columnId: number | undefined;
        let strat: StratUnit[] = [];
        if (s.status === 'fulfilled') {
          okCount++;
          const top = s.value.units[0];
          if (top) {
            color = top.color ?? '#475569';
            label = top.name || top.lithology || 'unknown';
            age = top.age;
            lithology = top.lithology;
          }
          columnId = s.value.columnId;
          strat = s.value.strat;
          if (strat.length > 0) {
            withColumnCount++;
          } else if (top) {
            // Synthesize a "shallow stratigraphy" placeholder from the
            // SURFACE map unit when no real Macrostrat column exists
            // for this point (true for most of the western US — columns
            // are regional transects, not nationwide). The fake unit
            // gets a 200 m default thickness and a stable synthetic
            // columnId so consecutive same-unit samples coalesce into
            // a visible block instead of disappearing. Disclaimer
            // banner + footer pill flag this for the user.
            const fakeName = strField(top.name) || strField(top.lithology) || 'unknown';
            columnId = synthId(fakeName);
            strat = [{
              name: fakeName,
              age: top.age ?? '',
              thicknessM: 200,
              color: top.color,
              lithology: top.lithology,
            }];
          }
        } else {
          failCount++;
        }
        return { t, distM: t * totalDistM, color, label, age, lithology, columnId, strat };
      });
      setGeology(out);
      setGeoFetchStats({ ok: okCount, failed: failCount, withColumn: withColumnCount });
      setLoading((p) => ({ ...p, geology: false }));
    });

    return () => {
      cancelRef.current = true;
    };
  }, [polyVertices, totalDistM, retryToken]);

  // ESC closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const stats = useMemo(() => computeStats(elev), [elev]);

  const reverse = useCallback(() => {
    setPolyVertices((v) => [...v].reverse());
  }, []);

  const downloadPng = useCallback(async () => {
    const svg = svgRef.current;
    if (!svg) return;
    await svgToPngDownload(svg, `cross-section-${Date.now()}.png`);
  }, []);

  // Download the section as a GeoJSON FeatureCollection — useful for
  // re-opening in QGIS / ArcGIS Pro. Includes the polyline itself
  // (LineString), every sampled elevation point, every sampled
  // geology point, every projected MRDS / claim / geochem, and every
  // fault crossing. Each feature has a `kind` property so the QGIS
  // user can split by symbology.
  const downloadGeoJson = useCallback(() => {
    const features: Array<Record<string, unknown>> = [];
    // 1. Polyline itself
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: polyVertices },
      properties: {
        kind: 'section_polyline',
        totalDistM,
        vertexCount: polyVertices.length,
      },
    });
    // 2. Vertex markers (A, B, C, …)
    polyVertices.forEach((v, i) => {
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: v },
        properties: { kind: 'section_vertex', letter: String.fromCharCode(65 + i) },
      });
    });
    // 3. Sampled elevation points (with distance + elev)
    elev.forEach((e, i) => {
      const { lngLat } = lngLatAtDistance(polyVertices, e.distM);
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: lngLat },
        properties: {
          kind: 'elev_sample',
          index: i,
          distM: e.distM,
          elevM: e.elevM,
        },
      });
    });
    // 4. Sampled geology points (with column id + top unit name)
    geology.forEach((g, i) => {
      const { lngLat } = lngLatAtDistance(polyVertices, g.distM);
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: lngLat },
        properties: {
          kind: 'geo_sample',
          index: i,
          distM: g.distM,
          columnId: g.columnId,
          unitName: strField(g.label),
          age: g.age,
          lithology: g.lithology,
          unitsCount: g.strat.length,
        },
      });
    });
    // 5. Projected MRDS / claims / geochem (in section-coordinate space)
    projectedMrds.forEach((m) => {
      const { lngLat } = lngLatAtDistance(polyVertices, m.distM);
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: lngLat },
        properties: {
          kind: 'mrds_projection',
          distM: m.distM,
          distFromLineM: m.distFromLineM,
          name: m.name,
          commodity: m.commodity,
          category: m.category,
        },
      });
    });
    projectedClaims.forEach((c) => {
      const { lngLat } = lngLatAtDistance(polyVertices, c.distM);
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: lngLat },
        properties: {
          kind: 'claim_projection',
          distM: c.distM,
          distFromLineM: c.distFromLineM,
          serial: c.serial,
          claimant: c.claimant,
          acreage: c.acreage,
        },
      });
    });
    projectedGeochem.forEach((g) => {
      const { lngLat } = lngLatAtDistance(polyVertices, g.distM);
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: lngLat },
        properties: {
          kind: 'geochem_projection',
          distM: g.distM,
          distFromLineM: g.distFromLineM,
          asPpm: g.asPpm,
          element: g.element,
        },
      });
    });
    // 6. Fault crossings (with USGS deep-link URL embedded)
    faultCrossings.forEach((f) => {
      const { lngLat } = lngLatAtDistance(polyVertices, f.distM);
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: lngLat },
        properties: {
          kind: 'fault_crossing',
          distM: f.distM,
          name: f.name,
          slipSense: f.slipSense,
          slipRate: f.slipRate,
          age: f.age,
          usgsViewerUrl: `https://usgs.maps.arcgis.com/apps/webappviewer/index.html?id=5a6038b3a1684561a9b0aadf88412fcf&center=${lngLat[0].toFixed(5)},${lngLat[1].toFixed(5)}&level=13`,
        },
      });
    });

    const fc = {
      type: 'FeatureCollection',
      metadata: {
        generator: 'Subterra cross-section',
        generatedAt: new Date().toISOString(),
        verticalExaggeration: trueScale ? 1 : ve,
        bufferM,
        depthM,
        sourceUrl: typeof window !== 'undefined' ? window.location.href : '',
      },
      features,
    };
    const blob = new Blob([JSON.stringify(fc, null, 2)], { type: 'application/geo+json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cross-section-${Date.now()}.geojson`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [polyVertices, totalDistM, elev, geology, projectedMrds, projectedClaims, projectedGeochem, faultCrossings, trueScale, ve, bufferM, depthM]);

  // Copy a plain-text citation block to the clipboard. Pairs with the
  // shareable `?cs=...` URL written by the Map route so the citation
  // contains a permalink that reproduces the exact section.
  const [citationCopied, setCitationCopied] = useState(false);
  const copyCitation = useCallback(async () => {
    const url = typeof window !== 'undefined' ? window.location.href : '';
    const text = buildCitation({
      vertices: polyVertices,
      ve,
      bufferM,
      depthM,
      trueScale,
      url,
    });
    try {
      await navigator.clipboard.writeText(text);
      setCitationCopied(true);
      window.setTimeout(() => setCitationCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable (insecure context, denied
      // permission). Fall back to a prompt the user can copy manually.
      window.prompt('Copy this citation:', text);
    }
  }, [polyVertices, ve, bufferM, depthM, trueScale]);

  return (
    <div
      // Mobile blackout fix v2: use an inline-style backdrop guaranteed
      // to render (the previous `bg-bg` class doesn't generate from the
      // codebase's @theme tokens — every other use is `bg-bg-surface`
      // etc.). 85% opaque so the MapLibre canvas underneath, even if
      // its WebGL context dies and renders pure black, is masked by a
      // dark-but-distinguishable backdrop, not a transparent one.
      className="fixed inset-0 z-40 flex items-center justify-center p-2 sm:p-4 backdrop-blur"
      style={{ backgroundColor: 'rgba(10, 12, 16, 0.92)' }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Cross-section"
    >
      <div
        data-testid="cross-section-modal"
        // Inline background style for the same reason as the backdrop —
        // guaranteed to render even if the Tailwind theme tokens don't
        // produce a class. Mobile: full-bleed; desktop: max-w-6xl card.
        className="flex h-full max-h-[96vh] w-full flex-col overflow-hidden border-border shadow-2xl sm:h-auto sm:max-h-[92vh] sm:max-w-6xl sm:rounded-lg sm:border"
        style={{ backgroundColor: '#161a22' }}
      >
        <Header
          totalDistM={totalDistM}
          bearing={bearing}
          vertices={polyVertices}
          onClose={onClose}
          onReverse={reverse}
          onDownload={downloadPng}
          onDownloadGeoJson={downloadGeoJson}
          onCopyCitation={copyCitation}
          citationCopied={citationCopied}
        />

        <Toolbar
          ve={ve}
          onVeChange={setVe}
          bufferM={bufferM}
          onBufferChange={setBufferM}
          depthM={depthM}
          onDepthChange={setDepthM}
          trueScale={trueScale}
          onTrueScaleChange={setTrueScale}
          counts={{
            mrds: projectedMrds.length,
            claims: projectedClaims.length,
            geochem: projectedGeochem.length,
            faults: faultCrossings.length,
          }}
        />

        <ContinuityDisclaimer />

        <div className="overflow-auto p-4">
          {loading.elev && loading.geology ? (
            <div className="flex h-72 items-center justify-center font-mono text-[11px] text-text-muted">
              Sampling {ELEV_SAMPLES + 1} elevation points + {GEOLOGY_SAMPLES + 1} geology points…
            </div>
          ) : (
            <SectionSvg
              svgRef={svgRef}
              vertices={polyVertices}
              segments={segments}
              totalDistM={totalDistM}
              bearing={bearing}
              elev={elev}
              geology={geology}
              mrds={projectedMrds}
              claims={projectedClaims}
              geochem={projectedGeochem}
              agencyStrip={agencyStrip}
              faultCrossings={faultCrossings}
              stats={stats}
              ve={ve}
              bufferM={bufferM}
              depthM={depthM}
              trueScale={trueScale}
              citationText={buildCitation({
                vertices: polyVertices,
                ve,
                bufferM,
                depthM,
                trueScale,
                url: typeof window !== 'undefined' ? window.location.href : '',
              })}
            />
          )}
        </div>

        <Footer
          loading={loading}
          bufferM={bufferM}
          stats={stats}
          mrds={projectedMrds}
          geoFetchStats={geoFetchStats}
          onRetryGeology={() => setRetryToken((n) => n + 1)}
        />
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Header / toolbar / footer
// ────────────────────────────────────────────────────────────────────

function Header({
  totalDistM,
  bearing,
  vertices,
  onClose,
  onReverse,
  onDownload,
  onDownloadGeoJson,
  onCopyCitation,
  citationCopied,
}: {
  totalDistM: number;
  bearing: number;
  vertices: LngLat[];
  onClose: () => void;
  onReverse: () => void;
  onDownload: () => void;
  onDownloadGeoJson: () => void;
  onCopyCitation: () => void;
  citationCopied: boolean;
}) {
  const lengthMi = totalDistM / 1609.34;
  // Vertex letters: A, B, C, ... — first + last get linked buttons;
  // intermediate bends are summarized as "+ N bends" to keep the
  // header compact.
  const first = vertices[0];
  const last = vertices[vertices.length - 1];
  const intermediateCount = Math.max(0, vertices.length - 2);
  const firstLetter = 'A';
  const lastLetter = String.fromCharCode(65 + vertices.length - 1);
  return (
    <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5 font-mono text-[11px]">
      <div className="flex items-center gap-3 text-text">
        <span className="font-semibold text-accent">Cross-section</span>
        <span className="text-text-muted">
          {(totalDistM / 1000).toFixed(2)} km · {lengthMi.toFixed(2)} mi · bearing{' '}
          {bearing.toFixed(0)}° {compassFromDeg(bearing)}
          {intermediateCount > 0 && ` · +${intermediateCount} bend${intermediateCount === 1 ? '' : 's'}`}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        {first && (
          <a
            href={`https://www.google.com/maps?q=${first[1]},${first[0]}`}
            target="_blank"
            rel="noreferrer"
            className="rounded border border-border bg-bg-panel px-2 py-1 text-text-muted hover:border-accent hover:text-accent"
            title={`${firstLetter}: ${first[1].toFixed(5)}, ${first[0].toFixed(5)} — open in Google Maps`}
          >
            {firstLetter} ↗
          </a>
        )}
        {last && vertices.length > 1 && (
          <a
            href={`https://www.google.com/maps?q=${last[1]},${last[0]}`}
            target="_blank"
            rel="noreferrer"
            className="rounded border border-border bg-bg-panel px-2 py-1 text-text-muted hover:border-accent hover:text-accent"
            title={`${lastLetter}: ${last[1].toFixed(5)}, ${last[0].toFixed(5)} — open in Google Maps`}
          >
            {lastLetter} ↗
          </a>
        )}
        <button
          type="button"
          onClick={onReverse}
          data-testid="cs-reverse"
          className="rounded border border-border bg-bg-panel px-2 py-1 text-text-muted hover:border-accent hover:text-accent"
          title="Reverse polyline (flip endpoint order)"
        >
          ⇄ reverse
        </button>
        <button
          type="button"
          onClick={onDownload}
          data-testid="cs-download"
          className="rounded border border-border bg-bg-panel px-2 py-1 text-text-muted hover:border-accent hover:text-accent"
          title="Download the cross-section as a PNG"
        >
          ⬇ png
        </button>
        <button
          type="button"
          onClick={onDownloadGeoJson}
          data-testid="cs-download-geojson"
          className="rounded border border-border bg-bg-panel px-2 py-1 text-text-muted hover:border-accent hover:text-accent"
          title="Download the section as GeoJSON — opens cleanly in QGIS / ArcGIS Pro for downstream analysis"
        >
          ⬇ geojson
        </button>
        <button
          type="button"
          onClick={onCopyCitation}
          data-testid="cs-citation"
          className="rounded border border-border bg-bg-panel px-2 py-1 text-text-muted hover:border-accent hover:text-accent"
          title="Copy a plain-text citation (data sources + endpoints + permalink) to the clipboard"
        >
          {citationCopied ? '✓ copied' : '⎘ cite'}
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded p-1 text-text-muted hover:bg-bg-panel hover:text-text"
        >
          ✕
        </button>
      </div>
    </header>
  );
}

function Toolbar({
  ve,
  onVeChange,
  bufferM,
  onBufferChange,
  depthM,
  onDepthChange,
  trueScale,
  onTrueScaleChange,
  counts,
}: {
  ve: number;
  onVeChange: (v: number) => void;
  bufferM: number;
  onBufferChange: (m: number) => void;
  depthM: number;
  onDepthChange: (m: number) => void;
  trueScale: boolean;
  onTrueScaleChange: (v: boolean) => void;
  counts: { mrds: number; claims: number; geochem: number; faults: number };
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-bg-panel/30 px-4 py-2 font-mono text-[10px]">
      <label className="flex items-center gap-2 text-text-muted">
        <span>Vertical stretch</span>
        <input
          type="range"
          min={MIN_VE}
          max={MAX_VE}
          step={1}
          value={ve}
          onChange={(e) => onVeChange(Number(e.target.value))}
          disabled={trueScale}
          data-testid="cs-ve-slider"
          className="h-1 w-28 accent-accent disabled:opacity-40"
        />
        <span className={`w-10 ${trueScale ? 'text-text-muted line-through' : 'text-accent'}`}>
          {ve}×
        </span>
      </label>
      <label
        className="flex items-center gap-1.5 text-text-muted"
        title="Render the section at real meters-per-pixel. Most sections look squashed in true scale — that's why exaggeration exists. Toggle to see the honest aspect ratio."
      >
        <input
          type="checkbox"
          checked={trueScale}
          onChange={(e) => onTrueScaleChange(e.target.checked)}
          data-testid="cs-truescale-toggle"
          className="h-3 w-3 accent-accent"
        />
        <span>1:1 (true scale)</span>
      </label>
      <label className="flex items-center gap-2 text-text-muted">
        <span>Buffer ±</span>
        <input
          type="range"
          min={MIN_BUFFER_M}
          max={MAX_BUFFER_M}
          step={100}
          value={bufferM}
          onChange={(e) => onBufferChange(Number(e.target.value))}
          data-testid="cs-buffer-slider"
          className="h-1 w-28 accent-accent"
        />
        <span className="w-14 text-accent">
          {(bufferM / 1609.34).toFixed(2)} mi
        </span>
      </label>
      <label className="flex items-center gap-2 text-text-muted">
        <span>Depth</span>
        <select
          value={depthM}
          onChange={(e) => onDepthChange(Number(e.target.value))}
          data-testid="cs-depth-select"
          className="rounded border border-border bg-bg-panel px-1.5 py-0.5 text-accent focus:border-accent focus:outline-none"
        >
          {DEPTH_OPTIONS.map((d) => (
            <option key={d} value={d}>
              {d >= 1000 ? `${d / 1000} km` : `${d} m`}
            </option>
          ))}
        </select>
      </label>
      <div className="ml-auto flex items-center gap-3 text-text-muted">
        <CountBadge label="MRDS" value={counts.mrds} color="#fbbf24" />
        <CountBadge label="Claims" value={counts.claims} color="#f59e0b" />
        <CountBadge label="Geochem" value={counts.geochem} color="#a78bfa" />
        <CountBadge label="Faults" value={counts.faults} color="#ef4444" />
      </div>
    </div>
  );
}

/** One-line geological-honesty disclaimer shown above the section
 *  the first time the user opens it in a session. The default rendering
 *  is a hung-column section: vertical thicknesses are real, lateral
 *  continuity between columns is implied, and regional dip is not
 *  modeled. Spelling that out up front prevents the academic-reviewer
 *  question "but how do you know unit X extends 8 km east?" — answer:
 *  we don't, and we're not claiming to. */
function ContinuityDisclaimer() {
  // Bumped suffix when the disclaimer wording changed (surface-unit
  // fallback for sections outside Macrostrat column coverage).
  const KEY = 'subterra:cs:continuity-disclaimer-dismissed-v4';
  const [dismissed, setDismissed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    return window.sessionStorage.getItem(KEY) === '1';
  });
  if (dismissed) return null;
  return (
    <div className="flex items-start gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-1.5 font-mono text-[10px] text-amber-200">
      <span aria-hidden className="mt-0.5">ⓘ</span>
      <span className="min-w-0 flex-1">
        Hung-column section. Apparent dip computed from inter-column
        elevation differences (along-section component only). Fault dip
        inferred from slip-sense. Dashed-stripe overlay = Macrostrat
        min-to-max thickness uncertainty. Where no Macrostrat column
        covers the section, a 200 m surface-unit fallback is shown;
        the footer column-coverage badge tells you which spans are
        real columns vs fallback.
      </span>
      <button
        type="button"
        onClick={() => {
          if (typeof window !== 'undefined') {
            window.sessionStorage.setItem(KEY, '1');
          }
          setDismissed(true);
        }}
        aria-label="Dismiss"
        className="rounded px-1 text-amber-300 hover:bg-amber-500/20"
      >
        ✕
      </button>
    </div>
  );
}

function CountBadge({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
      <span>{label}</span>
      <span className="text-text">{value}</span>
    </span>
  );
}

function Footer({
  loading,
  bufferM,
  stats,
  mrds,
  geoFetchStats,
  onRetryGeology,
}: {
  loading: { elev: boolean; geology: boolean };
  bufferM: number;
  stats: SectionStats;
  mrds: ProjectedMrds[];
  geoFetchStats: { ok: number; failed: number; withColumn: number };
  onRetryGeology: () => void;
}) {
  // Macrostrat fetch status: distinct from generic loading because
  // failures are silent (Promise.allSettled hides them). Visible
  // outcomes:
  //  - loading.geology=true            → "loading geology" amber pill
  //  - !loading + 0 failed + 0 cols    → "surface-fallback (no Macrostrat
  //                                       columns cover this section)"
  //  - !loading + 0 failed + N cols    → "Macrostrat: N/M with column"
  //                                       (silent when all OK to avoid noise)
  //  - !loading + failed > 0 + ok > 0  → "Macrostrat partial (N/M)"
  //  - !loading + failed > 0 + ok == 0 → "Macrostrat unreachable" + retry
  const total = geoFetchStats.ok + geoFetchStats.failed;
  const allFailed = !loading.geology && total > 0 && geoFetchStats.ok === 0;
  const partial = !loading.geology && geoFetchStats.failed > 0 && geoFetchStats.ok > 0;
  const noColumns = !loading.geology && total > 0 && geoFetchStats.failed === 0 && geoFetchStats.withColumn === 0;
  const partialColumns = !loading.geology
    && geoFetchStats.failed === 0
    && geoFetchStats.withColumn > 0
    && geoFetchStats.withColumn < total;
  const commodityCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const m of mrds) out[m.category] = (out[m.category] ?? 0) + 1;
    return out;
  }, [mrds]);

  return (
    <footer className="border-t border-border bg-bg-panel/40 px-4 py-2 font-mono text-[10px] text-text-muted">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          Topo: <span className="text-text">USGS EPQS</span> ·
          Geology: <span className="text-text">Macrostrat</span> ·
          Buffer: <span className="text-text">±{(bufferM / 1609.34).toFixed(2)} mi</span>
          {(loading.elev || loading.geology) && (
            <span className="text-amber-300">
              {loading.elev ? '· loading elevation' : ''}
              {loading.geology ? '· loading geology' : ''}
            </span>
          )}
          {allFailed && (
            <span className="flex items-center gap-1.5 text-red-300">
              · Macrostrat unreachable ({geoFetchStats.failed} fail)
              <button
                type="button"
                onClick={onRetryGeology}
                className="rounded border border-red-400/50 bg-red-500/10 px-1.5 py-0.5 text-[10px] text-red-200 hover:border-red-300 hover:text-red-100"
              >
                Retry
              </button>
            </span>
          )}
          {partial && (
            <span className="flex items-center gap-1.5 text-amber-300">
              · Macrostrat partial ({geoFetchStats.ok}/{total})
              <button
                type="button"
                onClick={onRetryGeology}
                className="rounded border border-amber-400/50 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-200 hover:border-amber-300 hover:text-amber-100"
              >
                Retry
              </button>
            </span>
          )}
          {noColumns && (
            <span
              className="text-amber-300"
              title="Macrostrat columns are regional study transects, not nationwide. Pick a section near a Macrostrat-covered area (e.g. the Wasatch Front, the Front Range, the Grand Canyon) to see real subsurface columns. Surface-unit fallback shown."
            >
              · surface-unit fallback (0/{total} Macrostrat columns cover this section)
            </span>
          )}
          {partialColumns && (
            <span
              className="text-text-muted"
              title="Macrostrat column coverage is sparse here; surface-unit fallback fills the gaps."
            >
              · columns: {geoFetchStats.withColumn}/{total} · rest = surface-unit fallback
            </span>
          )}
        </div>
        {Object.keys(commodityCounts).length > 0 && (
          <div className="flex items-center gap-2">
            {Object.entries(commodityCounts).map(([cat, n]) => (
              <span key={cat} className="flex items-center gap-1">
                <span
                  aria-hidden
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: COMMODITY_CATEGORY_COLORS[cat] ?? '#94a3b8' }}
                />
                <span className="text-text-muted">{cat}</span>
                <span className="text-text">{n}</span>
              </span>
            ))}
          </div>
        )}
      </div>
      {stats.maxSlopePct != null && (
        <div className="mt-1 flex flex-wrap gap-x-4 text-text-muted">
          Relief <span className="text-text">{Math.round(stats.reliefM)} m / {Math.round(stats.reliefM * 3.28084)} ft</span>
          · Max slope <span className="text-text">{stats.maxSlopePct.toFixed(1)}%</span>
          · Avg elevation <span className="text-text">{Math.round(stats.meanElevM)} m</span>
          · Samples <span className="text-text">{stats.validSamples}/{stats.totalSamples}</span>
        </div>
      )}
    </footer>
  );
}

// ────────────────────────────────────────────────────────────────────
// SVG render
// ────────────────────────────────────────────────────────────────────

function SectionSvg({
  svgRef,
  vertices,
  segments,
  totalDistM,
  bearing,
  elev,
  geology,
  mrds,
  claims,
  geochem,
  agencyStrip,
  faultCrossings,
  stats,
  ve,
  bufferM,
  depthM,
  trueScale,
  citationText,
}: {
  svgRef: React.MutableRefObject<SVGSVGElement | null>;
  vertices: LngLat[];
  segments: PolylineSegment[];
  totalDistM: number;
  bearing: number;
  elev: ElevSample[];
  geology: GeoSample[];
  mrds: ProjectedMrds[];
  claims: ProjectedClaim[];
  geochem: ProjectedGeochem[];
  agencyStrip: AgencySegment[];
  faultCrossings: FaultCrossing[];
  stats: SectionStats;
  ve: number;
  bufferM: number;
  depthM: number;
  trueScale: boolean;
  /** Citation block stamped at the bottom of the SVG so PNG exports
   *  carry the same provenance + permalink as the Copy-citation
   *  clipboard payload. */
  citationText: string;
}) {
  const W = 1200;
  const H = 640;
  const PADDING = { l: 70, r: 24, t: 28, b: 92 };
  const innerW = W - PADDING.l - PADDING.r;
  const innerH = H - PADDING.t - PADDING.b;
  const GEO_BAND_H = 22;
  const AGENCY_BAND_H = 12;
  const STRIP_GAP = 4;

  // ── elevation domain (continuous through the subsurface) ─────────
  // Industry "hung section" convention: one elevation axis spans the
  // highest surface point down to (lowest surface − depth window).
  // The VE slider stretches the axis around the data midpoint —
  // effective vertical exaggeration relative to the horizontal scale
  // is computed below for honest labeling.
  const elevValid = elev.filter((e): e is ElevSample & { elevM: number } => e.elevM != null);
  const dataMin = elevValid.length ? Math.min(...elevValid.map((e) => e.elevM)) : 0;
  const dataMax = elevValid.length ? Math.max(...elevValid.map((e) => e.elevM)) : 100;
  const subsurfaceFloor = dataMin - depthM;
  const fullRange = Math.max(50, dataMax - subsurfaceFloor);
  const elevMid = (dataMax + subsurfaceFloor) / 2;
  // In true-scale mode, the y-axis renders at the same meters-per-pixel
  // as the x-axis — VE collapses to 1.0. The section gets brutally
  // squashed; that's the point. Otherwise apply the user's VE around
  // the data midpoint (ve=4 default → the full data window fills the
  // canvas).
  const trueScaleSpan = totalDistM * (innerH / innerW);
  const visibleRange = trueScale
    ? Math.max(trueScaleSpan, fullRange)
    : fullRange / Math.max(1, ve / 4);
  const yDomainMin = elevMid - visibleRange / 2 - fullRange * 0.02;
  const yDomainMax = elevMid + visibleRange / 2 + fullRange * 0.02;
  const yDomainSpan = Math.max(1, yDomainMax - yDomainMin);
  // Effective VE = horizontal meters-per-px ÷ vertical meters-per-px.
  const effectiveVe = (totalDistM / innerW) / (yDomainSpan / innerH);

  const xOf = (distM: number): number => PADDING.l + (distM / totalDistM) * innerW;
  const yOf = (elevM: number): number =>
    PADDING.t + innerH - ((elevM - yDomainMin) / yDomainSpan) * innerH;

  const topoBottomY = PADDING.t + innerH;
  const geoTopY = topoBottomY + STRIP_GAP;
  const agencyTopY = geoTopY + GEO_BAND_H + STRIP_GAP;

  // ── subsurface column blocks ──────────────────────────────────────
  // Group adjacent geology samples sharing a Macrostrat column id into
  // one block; each block renders its strat units hung from the topo
  // surface at the block midpoint. Column boundaries get a dashed
  // divider — that's where the data resolution changes, and drawing a
  // fake smooth transition would imply structure we don't know.
  const columnBlocks = useMemo(
    () => buildColumnBlocks(geology, totalDistM),
    [geology, totalDistM],
  );

  // Apparent dip per (block, unit) — computed from inter-column
  // elevation differences of same-named formations across adjacent
  // columns. Positive degrees = unit dips toward +x (toward B);
  // negative = dips toward A. This is the regional-dip-along-section
  // component of true dip (apparent dip ≤ true dip, with equality when
  // the section runs perpendicular to strike). Honest improvement
  // over the prior "all units flat" rendering, but only along-section
  // — true 3D dip needs adjacent parallel sections we don't have.
  const dipsByBlock = useMemo<Array<Array<number | null>>>(() => {
    if (columnBlocks.length === 0) return [];
    // First pass: for each block, build a map of unit-name → top
    // elevation. Top elev derives from each block's midpoint surface
    // elevation minus the cumulative thickness above the unit.
    const topsByBlock: Array<Map<string, number>> = [];
    const midByBlock: number[] = [];
    for (const block of columnBlocks) {
      const midDist = (block.startM + block.endM) / 2;
      midByBlock.push(midDist);
      const surfElev = interpElev(elev, midDist) ?? 0;
      const tops = new Map<string, number>();
      let cum = 0;
      for (const u of block.units) {
        // strField() — u.name can be a {name, ...} object; coerce
        // before using as a Map key so the cross-block lookup matches.
        tops.set(strField(u.name), surfElev - cum);
        const thick = u.thicknessM && u.thicknessM > 0 ? u.thicknessM : 50;
        cum += thick;
      }
      topsByBlock.push(tops);
    }
    // Second pass: per-unit apparent dip relative to the same unit's
    // top elevation in the previous block.
    const out: Array<Array<number | null>> = [];
    for (let bi = 0; bi < columnBlocks.length; bi++) {
      const blockDips: Array<number | null> = [];
      const units = columnBlocks[bi]?.units ?? [];
      for (let ui = 0; ui < units.length; ui++) {
        if (bi === 0) { blockDips.push(null); continue; }
        const u = units[ui]!;
        const uKey = strField(u.name);
        const thisTop = topsByBlock[bi]!.get(uKey);
        const prevTop = topsByBlock[bi - 1]!.get(uKey);
        const runM = midByBlock[bi]! - midByBlock[bi - 1]!;
        if (thisTop == null || prevTop == null || runM <= 0) {
          blockDips.push(null);
          continue;
        }
        const dipDeg = Math.atan2(prevTop - thisTop, runM) * 180 / Math.PI;
        blockDips.push(dipDeg);
      }
      out.push(blockDips);
    }
    return out;
  }, [columnBlocks, elev]);

  // ── topo path (contiguous segments) ───────────────────────────────
  const topoSegments = buildPolySegments(elev, xOf, yOf);
  const topoFillPath = buildFillPath(elev, xOf, yOf, topoBottomY);

  // ── geology bands (contiguous merges) ─────────────────────────────
  const geoBands = mergeGeoBands(geology, xOf);

  // ── hover state ───────────────────────────────────────────────────
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  // Viewport-aware readout sizing. The SVG renders at a fixed 1200×640
  // viewBox that auto-scales to container width; on a phone (~380px
  // wide), 10px viewBox text becomes ~3px on screen — unreadable.
  // `compact` switches the readout to a larger font + wider box; the
  // readout stays inside the SVG (no state lift) but gets readable.
  const [compact, setCompact] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    return window.matchMedia('(max-width: 640px)').matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(max-width: 640px)');
    const onChange = (e: { matches: boolean }) => setCompact(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  // Pointer events instead of mouse events so the crosshair tracks
  // touch on phones too. A tap shows the crosshair at the touched
  // point; subsequent drags update it; lifting the finger leaves it
  // visible until the next interaction (better mobile UX than instant
  // dismiss).
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * W;
    const y = ((e.clientY - rect.top) / rect.height) * H;
    if (x < PADDING.l || x > W - PADDING.r) {
      setHover(null);
      return;
    }
    setHover({ x, y });
  };
  const onLeave = (e: React.PointerEvent<SVGSVGElement>) => {
    // Don't dismiss on touch-end — readout stays put so the user can
    // actually read it after lifting their finger. Only mouse-leave
    // (non-touch) clears the hover.
    if (e.pointerType !== 'mouse') return;
    setHover(null);
  };

  // ── crosshair readouts at hovered x ───────────────────────────────
  const hoverDist = hover ? ((hover.x - PADDING.l) / innerW) * totalDistM : null;
  const hoverElev = hoverDist != null ? interpElev(elev, hoverDist) : null;
  const hoverGeo = hoverDist != null ? geoAt(geology, hoverDist) : null;
  const hoverAgency = hoverDist != null ? agencyAt(agencyStrip, hoverDist) : null;
  const hoverSlope = hoverDist != null ? slopeAt(elev, hoverDist) : null;
  // Unit at the hovered DEPTH — convert cursor y back to elevation,
  // then walk the column block's stack. Null when above the surface.
  const hoverCursorElev = hover
    ? yDomainMin + ((PADDING.t + innerH - hover.y) / innerH) * yDomainSpan
    : null;
  const hoverUnit =
    hoverDist != null && hoverCursorElev != null && hoverElev != null && hoverCursorElev < hoverElev
      ? unitAtDepth(columnBlocks, elev, hoverDist, hoverElev - hoverCursorElev)
      : null;

  // ── y-axis ticks (span surface + subsurface window) ───────────────
  const yTickCount = 8;
  const yTickStep = niceStep((dataMax - subsurfaceFloor) / yTickCount);
  const yTicks: number[] = [];
  if (yTickStep > 0) {
    const start = Math.ceil(subsurfaceFloor / yTickStep) * yTickStep;
    for (let v = start; v <= dataMax + 0.5; v += yTickStep) yTicks.push(v);
  }

  // ── x-axis ticks (km + mi) ────────────────────────────────────────
  const xTickStep = niceStep(totalDistM / 8);
  const xTicks: number[] = [];
  for (let d = 0; d <= totalDistM + 0.5; d += xTickStep) xTicks.push(d);
  if (xTicks[xTicks.length - 1] !== totalDistM) xTicks.push(totalDistM);

  // ── MRDS label-collision avoidance ────────────────────────────────
  // Sort by rank, lay out top-N labels with simple right-shove to
  // avoid overlap. Remaining MRDS render dots only (hover for name).
  const labeledMrds = pickLabeledMrds(mrds, xOf, innerW);

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      className="block w-full touch-none"
      style={{ background: '#0a0c10' }}
      role="img"
      aria-label="Topographic and geologic cross-section"
      onPointerMove={onMove}
      onPointerLeave={onLeave}
      data-testid="cs-svg"
    >
      <defs>
        <linearGradient id="cs-topo-fill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#f59e0b" stopOpacity={0.18} />
          <stop offset="100%" stopColor="#f59e0b" stopOpacity={0} />
        </linearGradient>
        <pattern id="cs-buffer-hatch" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" stroke="#475569" strokeWidth={0.8} />
        </pattern>
      </defs>

      {/* ── horizontal grid lines ── */}
      {yTicks.map((v) => (
        <line
          key={`grid-${v}`}
          x1={PADDING.l}
          x2={W - PADDING.r}
          y1={yOf(v)}
          y2={yOf(v)}
          stroke="#1f2937"
          strokeWidth={1}
          strokeDasharray="2 3"
        />
      ))}

      {/* ── subsurface stratigraphy (hung section) ──
          Units hang from the topo surface, stacked downward by
          Macrostrat thickness. Clipped to below-the-surface so unit
          rects never poke above the terrain. */}
      <defs>
        <clipPath id="cs-subsurface-clip">
          <path d={buildBelowSurfaceClip(elev, xOf, yOf, PADDING.l, W - PADDING.r, topoBottomY)} />
        </clipPath>
      </defs>
      <g clipPath="url(#cs-subsurface-clip)">
        {columnBlocks.map((block, bi) => {
          const x0 = xOf(block.startM);
          const x1 = xOf(block.endM);
          const w = Math.max(1, x1 - x0);
          // Hang from the surface elevation at the block midpoint.
          const midDist = (block.startM + block.endM) / 2;
          const surfElev = interpElev(elev, midDist) ?? dataMax;
          let cum = 0;
          return (
            <g key={`col-${bi}`}>
              {block.units.map((u, ui) => {
                const thick = u.thicknessM && u.thicknessM > 0 ? u.thicknessM : 50;
                const topElev = surfElev - cum;
                const botElev = topElev - thick;
                cum += thick;
                if (topElev < subsurfaceFloor) return null; // below depth window
                const yTop = yOf(topElev);
                const yBot = Math.min(yOf(Math.max(botElev, subsurfaceFloor)), topoBottomY);
                const h = Math.max(0.5, yBot - yTop);
                const showLabel = h > 13 && w > 90;
                // Thickness uncertainty band: if Macrostrat publishes both
                // min_thick and max_thick AND they differ meaningfully,
                // render a lighter-fill rectangle from the min-thick
                // bottom down to the max-thick bottom. This is the
                // "we don't know exactly where the unit ends" zone.
                const minThick = typeof u.thicknessMinM === 'number' && u.thicknessMinM > 0
                  ? u.thicknessMinM
                  : null;
                const hasUncertainty = minThick != null && minThick < thick - 1;
                const yMinBot = hasUncertainty
                  ? Math.min(yOf(Math.max(topElev - minThick, subsurfaceFloor)), topoBottomY)
                  : yTop;
                const uncertaintyTop = yMinBot;
                const uncertaintyHeight = hasUncertainty ? Math.max(0, yBot - yMinBot) : 0;
                // Lithology-derived color overrides Macrostrat's
                // age-based color when we recognize the lithology —
                // standard USGS palette is more informative for
                // economic-geology readers.
                const fillColor = lithologyColor(u.lithology) ?? u.color ?? '#475569';
                const dipDeg = dipsByBlock[bi]?.[ui] ?? null;
                const showDipBadge = dipDeg != null && Math.abs(dipDeg) >= 0.5 && h > 18 && w > 60;
                return (
                  <g key={`u-${bi}-${ui}`}>
                    <rect
                      x={x0}
                      y={yTop}
                      width={w}
                      height={h}
                      fill={fillColor}
                      opacity={0.82}
                      stroke="#0a0c10"
                      strokeWidth={0.6}
                    >
                      <title>
                        {(() => {
                          const uName = strField(u.name) || '(unnamed)';
                          const uAge = strField(u.age);
                          const uLith = strField(u.lithology);
                          const uEnv = strField(u.environment);
                          return (
                            `${uName}${uAge ? ` · ${uAge}` : ''}${uLith ? ` · ${uLith}` : ''}` +
                            `\nthickness ~${Math.round(thick)} m · top ~${Math.round(cum - thick)} m below surface` +
                            `${uEnv ? `\nenvironment: ${uEnv}` : ''}` +
                            `${hasUncertainty ? `\nthickness uncertainty: ${Math.round(minThick!)}–${Math.round(thick)} m` : ''}` +
                            `${dipDeg != null ? `\napparent dip: ${Math.abs(dipDeg).toFixed(1)}° toward ${dipDeg > 0 ? 'B' : 'A'} (along-section component)` : ''}`
                          );
                        })()}
                      </title>
                    </rect>
                    {hasUncertainty && uncertaintyHeight > 0.5 && (
                      // Lighter overlay showing the "between min-thick
                      // and max-thick" zone — the unit is reported up to
                      // this depth, but might end higher. Diagonal-line
                      // pattern would be nicer; for now use a striped
                      // opacity contrast which renders cleanly on mobile.
                      <rect
                        x={x0}
                        y={uncertaintyTop}
                        width={w}
                        height={uncertaintyHeight}
                        fill={fillColor}
                        opacity={0.35}
                        stroke="#0a0c10"
                        strokeWidth={0.4}
                        strokeDasharray="2 2"
                        pointerEvents="none"
                      />
                    )}
                    {showLabel && (
                      <text
                        x={x0 + w / 2}
                        y={yTop + h / 2 + 3}
                        textAnchor="middle"
                        fontFamily="ui-monospace, monospace"
                        fontSize={9}
                        fill={contrastTextColor(fillColor)}
                        pointerEvents="none"
                      >
                        {truncate(strField(u.name) || '(unnamed)', Math.max(6, Math.floor(w / 6.5)))}
                      </text>
                    )}
                    {showDipBadge && (
                      <text
                        x={x0 + w - 4}
                        y={yTop + 11}
                        textAnchor="end"
                        fontFamily="ui-monospace, monospace"
                        fontSize={9}
                        fill={contrastTextColor(fillColor)}
                        opacity={0.85}
                        pointerEvents="none"
                      >
                        {dipDeg! > 0 ? '↘' : '↗'} {Math.abs(dipDeg!).toFixed(1)}°
                      </text>
                    )}
                  </g>
                );
              })}
              {/* column boundary divider (skip leading edge of first block) */}
              {bi > 0 && (
                <line
                  x1={x0}
                  y1={PADDING.t}
                  x2={x0}
                  y2={topoBottomY}
                  stroke="#0a0c10"
                  strokeWidth={2}
                  strokeDasharray="6 4"
                  opacity={0.9}
                />
              )}
              {/* Macrostrat column deep-link badge — only on real
                  columns (positive id), not synthesized fallback
                  blocks (negative id from the surface-unit fallback).
                  Gated on width so it doesn't overflow narrow blocks. */}
              {block.columnId != null && block.columnId > 0 && w > 56 && (
                <a
                  href={columnViewerUrl(block.columnId)}
                  target="_blank"
                  rel="noreferrer"
                >
                  <text
                    x={x0 + w - 4}
                    y={topoBottomY - 4}
                    textAnchor="end"
                    fontFamily="ui-monospace, monospace"
                    fontSize={8}
                    fill="#94a3b8"
                    style={{ cursor: 'pointer', textDecoration: 'underline' }}
                  >
                    #{block.columnId} ↗
                  </text>
                </a>
              )}
            </g>
          );
        })}
      </g>
      {columnBlocks.length === 0 && (
        <text
          x={PADDING.l + innerW / 2}
          y={topoBottomY - 30}
          textAnchor="middle"
          fontFamily="ui-monospace, monospace"
          fontSize={10}
          fill="#64748b"
        >
          no stratigraphic column coverage along this line (Macrostrat)
        </text>
      )}

      {/* ── fault traces crossing the section ──
          Quaternary faults dataset gives the surface crossing point +
          slip-sense. We pick a typical dip per sense (normal=60°,
          reverse=30°, strike-slip=vertical) and slant the fault trace
          accordingly. Color by sense — red=normal, orange=reverse/
          thrust, purple=strike-slip, gray=unknown. The dip angle is
          INFERRED (not measured) when sense is known; this is
          documented in the hover tooltip. */}
      {faultCrossings.map((f, i) => {
        const tFrac = totalDistM > 0 ? f.distM / totalDistM : 0;
        const x = PADDING.l + tFrac * innerW;
        const surfY = (() => {
          const e = interpElev(elev, f.distM);
          return e != null ? yOf(e) : PADDING.t + 40;
        })();
        const style = faultStyle(f.slipSense);
        // Convert "dip from vertical" to a horizontal pixel offset at
        // the bottom of the section. The fault dips toward +x (toward
        // B). Real direction would need hanging-wall context the
        // dataset doesn't carry — flagged in the tooltip as inferred.
        const dipHeight = topoBottomY - surfY;
        const dipOffsetPx = Math.tan((style.dipFromVerticalDeg * Math.PI) / 180) * dipHeight;
        const xBot = x + dipOffsetPx;
        return (
          <g key={`fault-${i}`}>
            <line
              x1={x}
              y1={surfY}
              x2={xBot}
              y2={topoBottomY}
              stroke={style.color}
              strokeWidth={2}
              strokeDasharray="8 4"
              opacity={0.9}
            >
              <title>
                {`${f.name}` +
                  `${f.slipSense ? `\nslip sense: ${f.slipSense} (${style.label})` : '\nslip sense: unknown'}` +
                  `${f.slipRate ? `\nslip rate: ${f.slipRate}` : ''}` +
                  `${f.age ? `\nage: ${f.age}` : ''}` +
                  `\ndip: ${style.dipFromVerticalDeg === 0 ? 'vertical' : `~${90 - style.dipFromVerticalDeg}° toward B`}` +
                  `${style.inferred ? ' (inferred from slip sense — true dip not in dataset)' : ''}`}
              </title>
            </line>
            {/* surface tick + label (label is clickable → USGS Q-Faults
                viewer centered on the fault's interpolated midpoint.
                The USGS dataset doesn't carry a stable fault ID we can
                deep-link to, so we point at the canonical web app at
                the fault's coords and let the user identify it on the
                interactive map). */}
            <polygon
              points={`${x - 5},${surfY - 9} ${x + 5},${surfY - 9} ${x},${surfY - 2}`}
              fill={style.color}
            />
            <a
              href={(() => {
                const { lngLat } = lngLatAtDistance(vertices, f.distM);
                return `https://usgs.maps.arcgis.com/apps/webappviewer/index.html?id=5a6038b3a1684561a9b0aadf88412fcf&center=${lngLat[0].toFixed(5)},${lngLat[1].toFixed(5)}&level=13`;
              })()}
              target="_blank"
              rel="noreferrer"
            >
              <text
                x={x + 4}
                y={surfY - 14}
                fontFamily="ui-monospace, monospace"
                fontSize={9}
                fill={style.color}
                style={{ cursor: 'pointer', textDecoration: 'underline' }}
              >
                {truncate(strField(f.name) || '(unnamed fault)', 26)} ↗
              </text>
            </a>
          </g>
        );
      })}

      {/* ── topo fill (gradient) + line ── */}
      {topoFillPath && (
        <path d={topoFillPath} fill="url(#cs-topo-fill)" stroke="none" />
      )}
      {topoSegments.map((pts, i) => (
        <polyline
          key={`topo-${i}`}
          points={pts}
          fill="none"
          stroke="#f59e0b"
          strokeWidth={1.8}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      ))}

      {/* ── geology bands ── */}
      {geoBands.map((g, i) => {
        const x0 = xOf(g.start);
        const x1 = xOf(g.end);
        const w = Math.max(0.5, x1 - x0);
        const showLabel = w > 80;
        return (
          <g key={`geo-${i}`}>
            <rect
              x={x0}
              y={geoTopY}
              width={w}
              height={GEO_BAND_H}
              fill={g.color}
              opacity={0.9}
              stroke="#0a0c10"
              strokeWidth={0.5}
            >
              <title>{`${g.label}${g.age ? ` · ${g.age}` : ''}${g.lithology ? ` · ${g.lithology}` : ''}`}</title>
            </rect>
            {showLabel && (
              <text
                x={x0 + w / 2}
                y={geoTopY + GEO_BAND_H / 2 + 3}
                textAnchor="middle"
                fontFamily="ui-monospace, monospace"
                fontSize={9}
                fill={contrastTextColor(g.color)}
                pointerEvents="none"
              >
                {truncate(g.label, Math.max(6, Math.floor(w / 6)))}
              </text>
            )}
          </g>
        );
      })}

      {/* ── surface-management agency strip ── */}
      {agencyStrip.map((seg, i) => {
        const x0 = xOf(seg.start);
        const x1 = xOf(seg.end);
        return (
          <rect
            key={`agency-${i}`}
            x={x0}
            y={agencyTopY}
            width={Math.max(0.5, x1 - x0)}
            height={AGENCY_BAND_H}
            fill={AGENCY_COLORS[seg.agency] ?? '#475569'}
            opacity={0.85}
          >
            <title>{`${seg.agency}${seg.name ? ` — ${seg.name}` : ''}`}</title>
          </rect>
        );
      })}

      {/* ── geochem anomalies (above topo) ── */}
      {geochem.map((g, i) => {
        const cx = xOf(g.distM);
        const cy = PADDING.t + 14 + ((i % 3) * 6);
        const intense = (g.asPpm ?? 0) >= 30;
        return (
          <g key={`gc-${i}`}>
            <rect
              x={cx - 3.2}
              y={cy - 3.2}
              width={6.4}
              height={6.4}
              transform={`rotate(45 ${cx} ${cy})`}
              fill={intense ? '#dc2626' : '#a78bfa'}
              stroke="#0a0c10"
              strokeWidth={0.6}
            >
              <title>
                {`Geochem ${g.element}: ${g.asPpm == null ? '—' : `${g.asPpm} ppm`} (${(g.distFromLineM / 1609.34).toFixed(2)} mi off-line)`}
              </title>
            </rect>
          </g>
        );
      })}

      {/* ── mining claims (above topo, as small inverted triangles) ── */}
      {claims.map((c, i) => {
        const cx = xOf(c.distM);
        const baseY = PADDING.t + 4;
        return (
          <polygon
            key={`claim-${i}`}
            points={`${cx - 4},${baseY} ${cx + 4},${baseY} ${cx},${baseY + 7}`}
            fill="#f59e0b"
            stroke="#0a0c10"
            strokeWidth={0.6}
            opacity={0.95}
          >
            <title>
              {`Claim ${c.serial}${c.claimant ? ` — ${c.claimant}` : ''}${c.acreage ? ` — ${c.acreage} ac` : ''}`}
            </title>
          </polygon>
        );
      })}

      {/* ── MRDS dots (on topo, sized by category rank) ── */}
      {mrds.map((m, i) => {
        const cx = xOf(m.distM);
        const nearest = nearestSample(elev, m.distM);
        const cy = nearest?.elevM != null ? yOf(nearest.elevM) - 5 : PADDING.t + 28;
        const r = mrdsRadius(m.category);
        return (
          <g key={`mrds-${i}`}>
            <circle
              cx={cx}
              cy={cy}
              r={r}
              fill={m.color}
              stroke="#f8fafc"
              strokeWidth={0.7}
              opacity={0.95}
            >
              <title>{`${m.name} — ${m.commodity || 'commodity unknown'} (${(m.distFromLineM / 1609.34).toFixed(2)} mi off-line)`}</title>
            </circle>
          </g>
        );
      })}

      {/* ── MRDS labels (top-N, with right-shove) ── */}
      {labeledMrds.map((m) => (
        <g key={`lab-${m.distM}-${m.name}`}>
          <line
            x1={xOf(m.distM)}
            y1={m.labelAnchorY}
            x2={m.labelX}
            y2={m.labelY + 1}
            stroke={m.color}
            strokeWidth={0.6}
            opacity={0.5}
          />
          <text
            x={m.labelX}
            y={m.labelY}
            fontFamily="ui-monospace, monospace"
            fontSize={10}
            fill={m.color}
            textAnchor={m.anchor}
          >
            {truncate(m.name, 24)}
          </text>
        </g>
      ))}

      {/* ── stats callout (top-left) ── */}
      {stats.validSamples > 0 && (
        <g
          fontFamily="ui-monospace, monospace"
          fontSize={10}
          fill="#cbd5e1"
          transform={`translate(${PADDING.l + 8}, ${PADDING.t + 12})`}
        >
          <rect
            x={-6}
            y={-12}
            width={200}
            height={52}
            fill="#0a0c10"
            stroke="#1f2937"
            strokeWidth={1}
            opacity={0.85}
            rx={3}
          />
          <text x={0} y={0} fill="#94a3b8">VE</text>
          <text x={50} y={0} fill={trueScale ? '#94a3b8' : '#fbbf24'}>
            {trueScale ? '1:1 true' : `${effectiveVe.toFixed(1)}×`}
          </text>
          <text x={90} y={0} fill="#94a3b8">Relief</text>
          <text x={150} y={0}>{Math.round(stats.reliefM)} m</text>
          <text x={0} y={14} fill="#94a3b8">Slope</text>
          <text x={50} y={14}>{stats.maxSlopePct?.toFixed(1)}%</text>
          <text x={90} y={14} fill="#94a3b8">Bearing</text>
          <text x={150} y={14}>{Math.round(bearing)}°</text>
          <text x={0} y={28} fill="#94a3b8">Length</text>
          <text x={50} y={28}>{(totalDistM / 1000).toFixed(2)} km</text>
          <text x={90} y={28} fill="#94a3b8">Buffer</text>
          <text x={150} y={28}>±{(bufferM / 1609.34).toFixed(2)} mi</text>
        </g>
      )}

      {/* ── y-axis ticks (m + ft) ── */}
      {yTicks.map((v) => {
        const y = yOf(v);
        return (
          <g key={`yt-${v}`} fontFamily="ui-monospace, monospace" fontSize={10} fill="#94a3b8">
            <line x1={PADDING.l - 4} y1={y} x2={PADDING.l} y2={y} stroke="#475569" />
            <text x={PADDING.l - 6} y={y + 3} textAnchor="end">
              {Math.round(v)}
            </text>
            <text x={PADDING.l - 6} y={y + 13} textAnchor="end" fill="#64748b" fontSize={8}>
              {Math.round(v * 3.28084)} ft
            </text>
          </g>
        );
      })}
      <text
        x={PADDING.l - 50}
        y={PADDING.t + innerH / 2}
        textAnchor="middle"
        transform={`rotate(-90 ${PADDING.l - 50} ${PADDING.t + innerH / 2})`}
        fontFamily="ui-monospace, monospace"
        fontSize={10}
        fill="#94a3b8"
      >
        Elevation (m / ft)
      </text>

      {/* ── polyline-vertex markers (bent-line sections only) ──
          Each interior vertex (A=start and last=end excluded) gets a
          subtle full-height dashed line plus a small letter label at
          the top — gives the operator a clear visual cue of where the
          section direction changes. */}
      {segments.length > 1 && segments.slice(1).map((seg, i) => {
        // seg.startOffsetM = distance along polyline at this vertex.
        const x = xOf(seg.startOffsetM);
        // i+1 → vertex letter B, C, D, ... (i=0 corresponds to vertex 1).
        const letter = String.fromCharCode(65 + i + 1);
        return (
          <g key={`vert-${i}`} pointerEvents="none">
            <line
              x1={x}
              y1={PADDING.t}
              x2={x}
              y2={topoBottomY}
              stroke="#94a3b8"
              strokeWidth={1}
              strokeDasharray="2 4"
              opacity={0.55}
            />
            <text
              x={x}
              y={PADDING.t - 4}
              textAnchor="middle"
              fontFamily="ui-monospace, monospace"
              fontSize={9}
              fill="#94a3b8"
            >
              {`${letter} · bearing ${Math.round(seg.bearingDeg)}°`}
            </text>
          </g>
        );
      })}

      {/* ── x-axis ticks (km + mi) ── */}
      {xTicks.map((d) => {
        const x = xOf(d);
        const yBase = agencyTopY + AGENCY_BAND_H + 4;
        return (
          <g key={`xt-${d.toFixed(0)}`} fontFamily="ui-monospace, monospace" fontSize={10} fill="#94a3b8">
            <line x1={x} y1={yBase} x2={x} y2={yBase + 4} stroke="#475569" />
            <text x={x} y={yBase + 15} textAnchor="middle">
              {(d / 1000).toFixed(d > 5000 ? 1 : 2)} km
            </text>
            <text x={x} y={yBase + 26} textAnchor="middle" fill="#64748b" fontSize={8}>
              {(d / 1609.34).toFixed(d > 5000 ? 1 : 2)} mi
            </text>
          </g>
        );
      })}
      <text x={PADDING.l} y={H - 6} fontFamily="ui-monospace, monospace" fontSize={11} fill="#fbbf24">
        A
      </text>
      <text
        x={W - PADDING.r}
        y={H - 6}
        textAnchor="end"
        fontFamily="ui-monospace, monospace"
        fontSize={11}
        fill="#fbbf24"
      >
        B
      </text>

      {/* ── strip labels (right edge) ── */}
      <text
        x={W - PADDING.r + 6}
        y={geoTopY + GEO_BAND_H / 2 + 3}
        fontFamily="ui-monospace, monospace"
        fontSize={9}
        fill="#94a3b8"
      >
        geology
      </text>
      <text
        x={W - PADDING.r + 6}
        y={agencyTopY + AGENCY_BAND_H / 2 + 3}
        fontFamily="ui-monospace, monospace"
        fontSize={9}
        fill="#94a3b8"
      >
        surface
      </text>

      {/* ── hover crosshair + readout ── */}
      {hover && hoverDist != null && (
        <g pointerEvents="none">
          <line
            x1={hover.x}
            y1={PADDING.t}
            x2={hover.x}
            y2={agencyTopY + AGENCY_BAND_H}
            stroke="#cbd5e1"
            strokeWidth={1}
            strokeDasharray="3 3"
            opacity={0.55}
          />
          {hoverElev != null && (
            <circle
              cx={hover.x}
              cy={yOf(hoverElev)}
              r={3}
              fill="#cbd5e1"
              stroke="#0a0c10"
              strokeWidth={1}
            />
          )}
          <HoverReadout
            hover={hover}
            distM={hoverDist}
            totalDistM={totalDistM}
            elevM={hoverElev}
            slopePct={hoverSlope}
            geoLabel={hoverGeo?.label ?? null}
            geoAge={hoverGeo?.age ?? null}
            agency={hoverAgency?.agency ?? null}
            unitAtCursor={hoverUnit}
            W={W}
            PADDING={PADDING}
            compact={compact}
          />
        </g>
      )}

      {/* ── side-panel: raw Macrostrat column at cursor ──
          Desktop-only floating overlay on the right edge. Shows the
          FULL stratigraphic column for the nearest geology sample to
          the hover position (or to the section midpoint when no hover
          is active). The cross-section's column blocks INTERPOLATE
          between samples; this panel is the raw data feed so a reader
          can see what we're working from. */}
      {!compact && geology.length > 0 && (
        <StratColumnPanel
          geology={geology}
          hoverDistM={hoverDist}
          totalDistM={totalDistM}
          W={W}
          PADDING={PADDING}
          innerH={innerH}
        />
      )}

      {/* ── citation stamp (bottom-right) ──
          Rendered as SVG text so it's captured by the PNG export.
          One short line per ~80 chars; the buildCitation() output is
          a multi-line block, so split + render each line. */}
      <g
        fontFamily="ui-monospace, monospace"
        fontSize={7}
        fill="#475569"
        pointerEvents="none"
      >
        {citationText.split('\n').map((line, i) => (
          <text key={`cite-${i}`} x={W - PADDING.r} y={H - 4 - (citationText.split('\n').length - 1 - i) * 9} textAnchor="end">
            {line}
          </text>
        ))}
      </g>
    </svg>
  );
}

/** Floating side panel showing the FULL Macrostrat stratigraphic
 *  column for the geology sample nearest the cursor. Rendered as an
 *  SVG group anchored to the right edge of the chart so PNG exports
 *  capture it. Desktop only — mobile is too narrow for a side rail. */
function StratColumnPanel({
  geology,
  hoverDistM,
  totalDistM,
  W,
  PADDING,
  innerH,
}: {
  geology: GeoSample[];
  hoverDistM: number | null;
  totalDistM: number;
  W: number;
  PADDING: { l: number; r: number; t: number; b: number };
  innerH: number;
}) {
  // Pick the sample nearest to the cursor distance. When no hover, use
  // the section midpoint — guarantees the panel is always populated and
  // the PNG export captures something useful.
  const targetDistM = hoverDistM ?? totalDistM / 2;
  let nearest: GeoSample | null = null;
  let bestGap = Infinity;
  for (const g of geology) {
    const gap = Math.abs(g.distM - targetDistM);
    if (gap < bestGap) {
      bestGap = gap;
      nearest = g;
    }
  }
  if (!nearest || nearest.strat.length === 0) return null;

  // Panel geometry — anchored to the right edge inside PADDING.r,
  // floating in the upper-right of the chart.
  const panelW = 170;
  const panelX = W - PADDING.r - panelW - 6;
  const panelY = PADDING.t + 56; // below the stats callout
  const headerH = 22;
  const maxBodyH = Math.min(420, innerH - 80);
  // Equal-area bars by default; weight by thickness when available so
  // the column visualizes proportionally.
  const totalThick = nearest.strat.reduce((acc, u) => {
    const t = typeof u.thicknessM === 'number' && u.thicknessM > 0 ? u.thicknessM : 50;
    return acc + t;
  }, 0);
  const bodyH = maxBodyH;
  let cum = 0;
  const distKm = (nearest.distM / 1000).toFixed(2);

  return (
    <g
      transform={`translate(${panelX}, ${panelY})`}
      fontFamily="ui-monospace, monospace"
      pointerEvents="none"
    >
      <rect
        x={0}
        y={0}
        width={panelW}
        height={headerH + bodyH}
        rx={3}
        fill="#0a0c10"
        stroke="#1f2937"
        strokeWidth={1}
        opacity={0.94}
      />
      {/* Header */}
      <text x={6} y={14} fontSize={9} fill="#94a3b8">
        {strField('Column @ ') + distKm + ' km'}
      </text>
      {nearest.columnId != null && (
        <text x={panelW - 6} y={14} textAnchor="end" fontSize={9} fill="#94a3b8">
          {`#${nearest.columnId}`}
        </text>
      )}
      <line x1={4} y1={headerH - 2} x2={panelW - 4} y2={headerH - 2} stroke="#1f2937" strokeWidth={0.6} />
      {/* Units stack top → bottom */}
      <g transform={`translate(0, ${headerH})`}>
        {nearest.strat.map((u, i) => {
          const thick = typeof u.thicknessM === 'number' && u.thicknessM > 0 ? u.thicknessM : 50;
          const h = Math.max(2, (thick / totalThick) * bodyH);
          const y = cum;
          cum += h;
          const fill = lithologyColor(u.lithology) ?? u.color ?? '#475569';
          const showLabel = h > 9;
          const name = strField(u.name) || '(unnamed)';
          return (
            <g key={`strat-${i}`}>
              <rect
                x={0}
                y={y}
                width={panelW}
                height={h}
                fill={fill}
                opacity={0.85}
                stroke="#0a0c10"
                strokeWidth={0.4}
              />
              {showLabel && (
                <text
                  x={6}
                  y={y + h / 2 + 3}
                  fontSize={Math.min(9, Math.max(7, h - 2))}
                  fill={contrastTextColor(fill)}
                >
                  {truncate(name, 22)}
                </text>
              )}
            </g>
          );
        })}
      </g>
    </g>
  );
}

function HoverReadout({
  hover,
  distM,
  totalDistM,
  elevM,
  slopePct,
  geoLabel,
  geoAge,
  agency,
  unitAtCursor,
  W,
  PADDING,
  compact,
}: {
  hover: { x: number; y: number };
  distM: number;
  totalDistM: number;
  elevM: number | null;
  slopePct: number | null;
  geoLabel: string | null;
  geoAge: string | null;
  agency: string | null;
  unitAtCursor: { unit: StratUnit; depthM: number } | null;
  W: number;
  PADDING: { l: number; r: number; t: number; b: number };
  compact: boolean;
}) {
  // Pin the readout to whichever side of the cursor has more space.
  // `compact` (mobile) scales up the box ~1.8× so text remains readable
  // after the 1200-wide viewBox is auto-scaled down to ~380px on phones.
  const u = unitAtCursor?.unit;
  // Coerce all Macrostrat string-ish fields via strField — they're
  // typed-as-string but reality includes objects/arrays. Direct
  // rendering crashes with React error #31.
  const uName = u ? (strField(u.name) || '(unnamed)') : '';
  const uAge = u ? strField(u.age) : '';
  const ageRange = u ? formatAgeRange(u) : null;
  const envStr = u ? strField(u.environment) : '';
  const envLabel = envStr ? truncate(envStr, 26) : null;
  const extraRows = u ? 1 + (ageRange ? 1 : 0) + (envLabel ? 1 : 0) : 0;
  const fontPx = compact ? 18 : 10;
  const rowH = compact ? 22 : 14;
  const boxW = compact ? 380 : 220;
  const boxH = (compact ? 96 : 78) + extraRows * rowH;
  const placeRight = hover.x < W - PADDING.r - boxW - 8;
  const x = placeRight ? hover.x + 10 : hover.x - boxW - 10;
  const y = Math.min(hover.y + 10, PADDING.t + 6);
  // Row y-positions derived from rowH so the layout scales consistently
  // across compact / desktop.
  const row = (n: number) => (compact ? 22 : 14) + n * rowH;
  return (
    <g transform={`translate(${x}, ${y})`} fontFamily="ui-monospace, monospace" fontSize={fontPx}>
      <rect
        width={boxW}
        height={boxH}
        rx={4}
        fill="#0a0c10"
        stroke="#1f2937"
        opacity={0.95}
      />
      <text x={8} y={row(0)} fill="#94a3b8">distance</text>
      <text x={boxW - 8} y={row(0)} textAnchor="end" fill="#fbbf24">
        {(distM / 1000).toFixed(2)} km · {(distM / 1609.34).toFixed(2)} mi
      </text>
      <text x={8} y={row(1)} fill="#94a3b8">elevation</text>
      <text x={boxW - 8} y={row(1)} textAnchor="end" fill="#f8fafc">
        {elevM != null ? `${Math.round(elevM)} m · ${Math.round(elevM * 3.28084)} ft` : '—'}
      </text>
      <text x={8} y={row(2)} fill="#94a3b8">slope</text>
      <text x={boxW - 8} y={row(2)} textAnchor="end" fill="#f8fafc">
        {slopePct != null ? `${slopePct.toFixed(1)}%` : '—'}
      </text>
      <text x={8} y={row(3)} fill="#94a3b8">surface geo</text>
      <text x={boxW - 8} y={row(3)} textAnchor="end" fill="#f8fafc">
        {truncate(strField(geoLabel) || '—', 22)}{geoAge ? `, ${truncate(strField(geoAge), 8)}` : ''}
      </text>
      <text x={8} y={row(4)} fill="#94a3b8">surface mgmt</text>
      <text x={boxW - 8} y={row(4)} textAnchor="end" fill="#f8fafc">
        {strField(agency) || '—'}
      </text>
      {u && (
        <>
          <text x={8} y={row(5)} fill="#94a3b8">at cursor</text>
          <text x={boxW - 8} y={row(5)} textAnchor="end" fill="#2dd4bf">
            {truncate(uName, 20)} ({Math.round(unitAtCursor!.depthM)} m)
          </text>
          {ageRange && (
            <>
              <text x={8} y={row(6)} fill="#94a3b8">age</text>
              <text x={boxW - 8} y={row(6)} textAnchor="end" fill="#f8fafc">
                {truncate(uAge || '—', 20)} · {ageRange}
              </text>
            </>
          )}
          {envLabel && (
            <>
              <text x={8} y={row(6 + (ageRange ? 1 : 0))} fill="#94a3b8">environ</text>
              <text
                x={boxW - 8}
                y={row(6 + (ageRange ? 1 : 0))}
                textAnchor="end"
                fill="#f8fafc"
              >
                {envLabel}
              </text>
            </>
          )}
        </>
      )}
      {/* invariant: keeps positional info accessible if the cursor is
          past the section's full span (clamped to totalDistM). */}
      {distM > totalDistM && <title>past end of section</title>}
    </g>
  );
}

// ────────────────────────────────────────────────────────────────────
// Helpers — math + projection + render utilities
// ────────────────────────────────────────────────────────────────────

interface SectionStats {
  reliefM: number;
  meanElevM: number;
  maxSlopePct: number | null;
  validSamples: number;
  totalSamples: number;
}

function computeStats(elev: ElevSample[]): SectionStats {
  const valid = elev.filter((e): e is ElevSample & { elevM: number } => e.elevM != null);
  if (valid.length < 2) {
    return {
      reliefM: 0,
      meanElevM: 0,
      maxSlopePct: null,
      validSamples: valid.length,
      totalSamples: elev.length,
    };
  }
  const min = Math.min(...valid.map((e) => e.elevM));
  const max = Math.max(...valid.map((e) => e.elevM));
  const mean = valid.reduce((s, e) => s + e.elevM, 0) / valid.length;
  let maxSlope = 0;
  for (let i = 1; i < valid.length; i++) {
    const dh = valid[i]!.elevM - valid[i - 1]!.elevM;
    const dd = valid[i]!.distM - valid[i - 1]!.distM;
    if (dd <= 0) continue;
    const slope = Math.abs(dh / dd) * 100;
    if (slope > maxSlope) maxSlope = slope;
  }
  return {
    reliefM: max - min,
    meanElevM: mean,
    maxSlopePct: maxSlope,
    validSamples: valid.length,
    totalSamples: elev.length,
  };
}

function buildPolySegments(
  elev: ElevSample[],
  xOf: (m: number) => number,
  yOf: (e: number) => number,
): string[] {
  const segments: string[] = [];
  let current: string[] = [];
  for (const e of elev) {
    if (e.elevM == null) {
      if (current.length) {
        segments.push(current.join(' '));
        current = [];
      }
      continue;
    }
    current.push(`${xOf(e.distM).toFixed(1)},${yOf(e.elevM).toFixed(1)}`);
  }
  if (current.length) segments.push(current.join(' '));
  return segments;
}

/** Build a single fill path that closes each contiguous topo run down
 *  to the baseline. Used to paint a subtle gradient under the terrain. */
function buildFillPath(
  elev: ElevSample[],
  xOf: (m: number) => number,
  yOf: (e: number) => number,
  baselineY: number,
): string {
  const runs: Array<Array<ElevSample & { elevM: number }>> = [];
  let cur: Array<ElevSample & { elevM: number }> = [];
  for (const e of elev) {
    if (e.elevM == null) {
      if (cur.length > 1) runs.push(cur);
      cur = [];
    } else {
      cur.push(e as ElevSample & { elevM: number });
    }
  }
  if (cur.length > 1) runs.push(cur);
  if (runs.length === 0) return '';
  const parts: string[] = [];
  for (const run of runs) {
    const first = run[0]!;
    const last = run[run.length - 1]!;
    let d = `M ${xOf(first.distM).toFixed(1)} ${baselineY.toFixed(1)} `;
    d += `L ${xOf(first.distM).toFixed(1)} ${yOf(first.elevM).toFixed(1)} `;
    for (const e of run.slice(1)) {
      d += `L ${xOf(e.distM).toFixed(1)} ${yOf(e.elevM).toFixed(1)} `;
    }
    d += `L ${xOf(last.distM).toFixed(1)} ${baselineY.toFixed(1)} Z`;
    parts.push(d);
  }
  return parts.join(' ');
}

interface MergedGeoBand {
  start: number;
  end: number;
  color: string;
  label: string;
  age?: string;
  lithology?: string;
}

/** Coalesce consecutive geology samples with the same `label` into one
 *  band so the rendering doesn't draw 18 tiny boxes for a single
 *  formation that spans the whole section. */
function mergeGeoBands(geology: GeoSample[], _xOf: (m: number) => number): MergedGeoBand[] {
  const out: MergedGeoBand[] = [];
  for (let i = 0; i < geology.length; i++) {
    const g = geology[i]!;
    const next = geology[i + 1];
    const segEnd = next?.distM ?? g.distM + 1; // leave a tiny tail on last sample
    const last = out[out.length - 1];
    if (last && last.label === g.label && last.color === g.color) {
      last.end = segEnd;
    } else {
      out.push({
        start: g.distM,
        end: segEnd,
        color: g.color,
        label: g.label,
        age: g.age,
        lithology: g.lithology,
      });
    }
  }
  return out;
}

interface ColumnBlock {
  startM: number;
  endM: number;
  columnId: number | undefined;
  /** Ordered top → bottom stratigraphic units for this column. */
  units: StratUnit[];
}

/** Group adjacent geology samples sharing a Macrostrat column id into
 *  contiguous blocks. Each block renders one hung column. Samples with
 *  no column coverage produce no block (gap in the section — honest
 *  about missing data rather than smearing a neighbor sideways). */
function buildColumnBlocks(geology: GeoSample[], totalDistM: number): ColumnBlock[] {
  const out: ColumnBlock[] = [];
  for (let i = 0; i < geology.length; i++) {
    const g = geology[i]!;
    if (g.columnId == null || g.strat.length === 0) continue;
    const next = geology[i + 1];
    const segEnd = next?.distM ?? totalDistM;
    const last = out[out.length - 1];
    if (last && last.columnId === g.columnId && Math.abs(last.endM - g.distM) < 1) {
      last.endM = segEnd;
    } else {
      out.push({ startM: g.distM, endM: segEnd, columnId: g.columnId, units: g.strat });
    }
  }
  return out;
}

/** Clip path covering the region BELOW the topo surface (down to the
 *  chart bottom). Subsurface unit rects are clipped to this so they
 *  never paint above the terrain line. Where elevation data is missing
 *  the clip follows the chart top (no masking) — units in those spans
 *  simply won't render, which matches the missing-topo gap. */
function buildBelowSurfaceClip(
  elev: ElevSample[],
  xOf: (m: number) => number,
  yOf: (e: number) => number,
  leftX: number,
  rightX: number,
  bottomY: number,
): string {
  const valid = elev.filter((e): e is ElevSample & { elevM: number } => e.elevM != null);
  if (valid.length < 2) {
    return `M ${leftX} ${bottomY} L ${rightX} ${bottomY} L ${rightX} ${bottomY} Z`;
  }
  let d = `M ${xOf(valid[0]!.distM).toFixed(1)} ${yOf(valid[0]!.elevM).toFixed(1)} `;
  for (const e of valid.slice(1)) {
    d += `L ${xOf(e.distM).toFixed(1)} ${yOf(e.elevM).toFixed(1)} `;
  }
  d += `L ${xOf(valid[valid.length - 1]!.distM).toFixed(1)} ${bottomY} `;
  d += `L ${xOf(valid[0]!.distM).toFixed(1)} ${bottomY} Z`;
  return d;
}

/** Find the stratigraphic unit at `depthM` below the surface at
 *  `distM` along the section. Walks the column block covering that
 *  distance, accumulating unit thicknesses. */
function unitAtDepth(
  blocks: ColumnBlock[],
  _elev: ElevSample[],
  distM: number,
  depthM: number,
): { unit: StratUnit; depthM: number } | null {
  const block = blocks.find((bl) => distM >= bl.startM && distM <= bl.endM);
  if (!block) return null;
  let cum = 0;
  for (const u of block.units) {
    const thick = u.thicknessM && u.thicknessM > 0 ? u.thicknessM : 50;
    if (depthM >= cum && depthM < cum + thick) {
      return { unit: u, depthM };
    }
    cum += thick;
  }
  return null;
}

/** Pretty-print a numerical age range from Macrostrat's `bAge` (older
 *  bound) and `tAge` (younger bound) fields. Returns null when both
 *  are missing so callers can omit the line cleanly. */
function formatAgeRange(unit: StratUnit): string | null {
  if (typeof unit.bAge === 'number' && typeof unit.tAge === 'number') {
    return `${unit.bAge.toFixed(0)}–${unit.tAge.toFixed(0)} Ma`;
  }
  if (typeof unit.bAge === 'number') return `${unit.bAge.toFixed(0)} Ma`;
  return null;
}

interface AgencySegment {
  start: number;
  end: number;
  agency: string;
  name: string;
}

const AGENCY_COLORS: Record<string, string> = {
  BLM: '#a3a04d',
  USFS: '#16a34a',
  NPS: '#7c3aed',
  BIA: '#a855f7',
  FWS: '#f97316',
  DOD: '#64748b',
  BOR: '#0e7490',
  STATE: '#0ea5e9',
  PRIVATE: '#334155',
  OTHER: '#475569',
};

/** Sample agencies along the section by nearest-centroid lookup.
 *  Caller passes federal-land polygon centroids; we pick the nearest
 *  one to each sample point on the line. Coarse but sufficient at
 *  the SVG scale we're rendering. */
function buildAgencyStrip(
  vertices: LngLat[],
  agencies: CrossSectionAgency[],
  totalDistM: number,
): AgencySegment[] {
  if (agencies.length === 0 || totalDistM <= 0 || vertices.length < 2) return [];
  const N = 60;
  const pts = interpolatePolyline(vertices, N);
  const samples: Array<{ distM: number; agency: string; name: string }> = [];
  for (let i = 0; i <= N; i++) {
    const p = pts[i]!;
    let bestDist = Infinity;
    let bestAgency = '';
    let bestName = '';
    for (const ag of agencies) {
      const d = (ag.lng - p[0]) ** 2 + (ag.lat - p[1]) ** 2;
      if (d < bestDist) {
        bestDist = d;
        bestAgency = ag.agency ?? '';
        bestName = ag.name ?? '';
      }
    }
    samples.push({ distM: (i / N) * totalDistM, agency: bestAgency, name: bestName });
  }
  const out: AgencySegment[] = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    const next = samples[i + 1];
    const segEnd = next?.distM ?? s.distM + 1;
    const last = out[out.length - 1];
    if (last && last.agency === s.agency) {
      last.end = segEnd;
    } else {
      out.push({ start: s.distM, end: segEnd, agency: s.agency || 'OTHER', name: s.name });
    }
  }
  return out;
}

function nearestSample<T extends { distM: number; elevM: number | null }>(
  samples: T[],
  distM: number,
): T | null {
  let best: T | null = null;
  let bestDelta = Infinity;
  for (const s of samples) {
    if (s.elevM == null) continue;
    const d = Math.abs(s.distM - distM);
    if (d < bestDelta) {
      best = s;
      bestDelta = d;
    }
  }
  return best;
}

/** Linear interpolation between the two nearest valid elevation samples
 *  bracketing distM. Returns null if there isn't a bracketing pair. */
function interpElev(elev: ElevSample[], distM: number): number | null {
  let prev: (ElevSample & { elevM: number }) | null = null;
  for (const e of elev) {
    if (e.elevM == null) continue;
    if (e.distM >= distM) {
      if (!prev) return e.elevM;
      const span = e.distM - prev.distM;
      if (span <= 0) return e.elevM;
      const t = (distM - prev.distM) / span;
      return prev.elevM + (e.elevM - prev.elevM) * t;
    }
    prev = e as ElevSample & { elevM: number };
  }
  return prev?.elevM ?? null;
}

/** Slope as percent at distM — first derivative of the elevation profile,
 *  computed from the two nearest valid samples bracketing distM. */
function slopeAt(elev: ElevSample[], distM: number): number | null {
  let prev: (ElevSample & { elevM: number }) | null = null;
  for (const e of elev) {
    if (e.elevM == null) continue;
    if (e.distM >= distM && prev) {
      const dh = e.elevM - prev.elevM;
      const dd = e.distM - prev.distM;
      if (dd <= 0) return null;
      return Math.abs(dh / dd) * 100;
    }
    prev = e as ElevSample & { elevM: number };
  }
  return null;
}

function geoAt(geology: GeoSample[], distM: number): GeoSample | null {
  let best: GeoSample | null = null;
  let bestDelta = Infinity;
  for (const g of geology) {
    const d = Math.abs(g.distM - distM);
    if (d < bestDelta) {
      best = g;
      bestDelta = d;
    }
  }
  return best;
}

function agencyAt(strip: AgencySegment[], distM: number): AgencySegment | null {
  for (const s of strip) {
    if (distM >= s.start && distM <= s.end) return s;
  }
  return strip[strip.length - 1] ?? null;
}

const COMMODITY_RANK: Partial<Record<keyof typeof COMMODITY_CATEGORY_COLORS, number>> = {
  precious: 1,
  critical: 2,
  base: 3,
  energy: 4,
  industrial: 5,
  unknown: 6,
};

function mrdsRadius(category: keyof typeof COMMODITY_CATEGORY_COLORS): number {
  // Bigger dots for the categories users care most about.
  switch (category) {
    case 'precious': return 6;
    case 'critical': return 5.5;
    case 'base': return 5;
    case 'energy': return 4.5;
    case 'industrial': return 4;
    default: return 4;
  }
}

interface LabeledMrds {
  distM: number;
  name: string;
  color: string;
  labelAnchorY: number;
  labelX: number;
  labelY: number;
  anchor: 'start' | 'end' | 'middle';
}

/** Pick up to 8 MRDS occurrences to label inline. Top-rank categories
 *  win; collisions resolved by stacking the y position. */
function pickLabeledMrds(
  mrds: ProjectedMrds[],
  xOf: (m: number) => number,
  innerW: number,
): LabeledMrds[] {
  const top = [...mrds].sort((x, y) => x.rank - y.rank || y.distM - x.distM).slice(0, 8);
  const out: LabeledMrds[] = [];
  const rows: number[] = []; // y positions already occupied (per row)
  const ROW_H = 12;
  const ROW_BASE = 56;
  for (const m of top) {
    const x = xOf(m.distM);
    // Choose label side based on which half of the section the dot is on.
    const rightSide = x < (innerW / 2) + 70;
    const anchor: 'start' | 'end' = rightSide ? 'start' : 'end';
    const labelX = rightSide ? x + 8 : x - 8;
    let row = 0;
    while (rows[row] != null && Math.abs(rows[row]! - x) < 90) row++;
    rows[row] = x;
    out.push({
      distM: m.distM,
      name: m.name,
      color: m.color,
      labelAnchorY: ROW_BASE + row * ROW_H,
      labelX,
      labelY: ROW_BASE + row * ROW_H,
      anchor,
    });
  }
  return out;
}

function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const exp = Math.floor(Math.log10(raw));
  const mag = 10 ** exp;
  const m = raw / mag;
  if (m < 1.5) return 1 * mag;
  if (m < 3) return 2 * mag;
  if (m < 7) return 5 * mag;
  return 10 * mag;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, Math.max(1, n - 1)) + '…';
}

function compassFromDeg(deg: number): string {
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return dirs[Math.round(deg / 22.5) % 16]!;
}

/** Pick a high-contrast text color for a band background — geology
 *  colors range from pale yellows to deep maroons, so a simple
 *  luminance check beats a hardcoded choice. */
function contrastTextColor(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#0a0c10';
  const n = parseInt(m[1]!, 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 160 ? '#0a0c10' : '#f8fafc';
}

/** Map a Macrostrat lithology string to a standard USGS-palette
 *  color. Substring match because Macrostrat strings vary widely
 *  ("sandstone", "ss", "Sandstone - fine grained, lithic"). Returns
 *  null when no match, so the caller falls back to Macrostrat's
 *  per-unit color (which is age-based, not lithology-based). */
/** Coerce a Macrostrat string-ish field to a plain display string.
 *  Macrostrat's typed-as-string fields (`name`, `age`, `lithology`,
 *  `environment`) regularly arrive as nested objects or arrays:
 *    environment → { environ_id, name, type, class }
 *    lithology   → [{ name, lith_class, ... }, ...]
 *    age         → either a string like 'Devonian' or { name, ... }
 *  Rendering any of these as a React child crashes with React error
 *  #31 ("Objects are not valid as a React child"). Coerce defensively
 *  by pulling out a `.name` when present; otherwise stringify. */
function strField(x: unknown): string {
  if (x == null) return '';
  if (typeof x === 'string') return x;
  if (typeof x === 'number' || typeof x === 'boolean') return String(x);
  if (Array.isArray(x)) {
    return x.map((item) => strField(item)).filter(Boolean).join(', ');
  }
  if (typeof x === 'object') {
    // Prefer .name; fall back to .label or stringify.
    const obj = x as Record<string, unknown>;
    if (typeof obj.name === 'string') return obj.name;
    if (typeof obj.label === 'string') return obj.label;
    return '';
  }
  return String(x);
}

function lithologyColor(lithology: unknown): string | null {
  // Macrostrat's `lithology` field is loosely typed — some unit
  // records return an array of lith objects ({name, lith_class, ...})
  // or a comma-joined string, others return null. Coerce to a single
  // searchable string defensively; the type annotation can't be trusted.
  if (lithology == null) return null;
  let str: string;
  if (typeof lithology === 'string') {
    str = lithology;
  } else if (Array.isArray(lithology)) {
    str = lithology
      .map((x) => (typeof x === 'string' ? x : (x && typeof x === 'object' && 'name' in x ? String((x as { name: unknown }).name) : '')))
      .filter(Boolean)
      .join(' ');
  } else if (typeof lithology === 'object' && 'name' in lithology) {
    str = String((lithology as { name: unknown }).name);
  } else {
    str = String(lithology);
  }
  if (!str) return null;
  const l = str.toLowerCase();
  // Sedimentary — most common in the western US prospecting target
  if (/(limestone|dolomite|carbonate)/.test(l)) return '#7dd3fc';
  if (/(sandstone|\bss\b|arenite)/.test(l)) return '#fde68a';
  if (/(shale|mudstone|claystone|siltstone)/.test(l)) return '#94a3b8';
  if (/conglomerate/.test(l)) return '#fcd34d';
  if (/(evaporite|gypsum|halite|anhydrite)/.test(l)) return '#fce7f3';
  if (/coal/.test(l)) return '#1f2937';
  if (/(chert|jasperoid)/.test(l)) return '#fb923c';
  // Igneous
  if (/(granite|granodiorite|tonalite|diorite|monzonite)/.test(l)) return '#fda4af';
  if (/(basalt|gabbro|diabase|dolerite)/.test(l)) return '#7c3aed';
  if (/(rhyolite|tuff|ignimbrite|dacite|andesite|volcanic)/.test(l)) return '#f43f5e';
  // Metamorphic
  if (/(schist|gneiss|amphibolite)/.test(l)) return '#86efac';
  if (/quartzite/.test(l)) return '#fef3c7';
  if (/marble/.test(l)) return '#e0f2fe';
  if (/(slate|phyllite)/.test(l)) return '#64748b';
  return null;
}

/** Render style for a fault crossing, inferred from `slipSense`.
 *  When the USGS Quaternary Faults dataset carries slip-sense, we
 *  draw the fault at a typical dip:
 *    normal:        60° (extensional — typical Basin-and-Range range)
 *    reverse/thrust: 30° (compressional — typical fold-thrust belt)
 *    strike-slip:    0° (vertical — dip-slip negligible)
 *  Direction defaults to dipping toward +x (toward B). True dip
 *  direction needs hanging-wall/footwall context that the Q-faults
 *  dataset doesn't always provide — honest improvement over the
 *  prior "always vertical" rendering, but documented as inferred. */
function faultStyle(slipSense: unknown): {
  dipFromVerticalDeg: number;
  color: string;
  label: string;
  inferred: boolean;
} {
  // Defensive coercion — slipSense source data (USGS Q-Faults attrs)
  // is loosely typed; some records ship arrays or nulls instead of
  // plain strings, and `(thing || '').toLowerCase()` crashes when
  // `thing` is a truthy non-string like `[]`.
  const s = (typeof slipSense === 'string' ? slipSense : '').toLowerCase();
  if (/normal/.test(s)) return { dipFromVerticalDeg: 60, color: '#ef4444', label: 'normal', inferred: true };
  if (/(thrust|reverse)/.test(s)) {
    return {
      dipFromVerticalDeg: 30,
      color: '#f97316',
      label: /thrust/.test(s) ? 'thrust' : 'reverse',
      inferred: true,
    };
  }
  if (/strike|lateral|wrench/.test(s)) return { dipFromVerticalDeg: 0, color: '#a855f7', label: 'strike-slip', inferred: false };
  return { dipFromVerticalDeg: 0, color: '#94a3b8', label: 'sense unknown', inferred: false };
}

function commodityCategory(commodity: string | undefined): keyof typeof COMMODITY_CATEGORY_COLORS {
  const s = String(commodity ?? '').toLowerCase();
  const has = (...needles: string[]): boolean => needles.some((n) => s.includes(n));
  if (has('gold', 'silver', 'platinum', 'palladium')) return 'precious';
  if (has('lithium', 'cobalt', 'nickel', 'rare earth', 'tungsten', 'tin', 'antimony')) {
    return 'critical';
  }
  if (has('copper', 'zinc', 'lead', 'molybdenum', 'iron')) return 'base';
  if (has('coal', 'uranium', 'oil', 'gas', 'helium')) return 'energy';
  if (has('potash', 'phosphate', 'sand', 'gravel', 'gypsum', 'sulfur')) return 'industrial';
  return 'unknown';
}

// ────────────────────────────────────────────────────────────────────
// PNG export — serialize the SVG to a Blob, draw onto a canvas at 2×
// for retina, hand back a download.
// ────────────────────────────────────────────────────────────────────

async function svgToPngDownload(svg: SVGSVGElement, filename: string): Promise<void> {
  const cloned = svg.cloneNode(true) as SVGSVGElement;
  // Inline width/height so the rasterized canvas has a real pixel size
  // (viewBox alone doesn't tell the canvas how big to draw).
  const vb = svg.viewBox.baseVal;
  const scale = 2;
  const targetW = Math.round(vb.width * scale);
  const targetH = Math.round(vb.height * scale);
  cloned.setAttribute('width', String(targetW));
  cloned.setAttribute('height', String(targetH));
  const serial = new XMLSerializer().serializeToString(cloned);
  const svgBlob = new Blob([serial], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('svg→png failed: image decode'));
    img.src = url;
  });
  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    URL.revokeObjectURL(url);
    throw new Error('svg→png failed: no 2d context');
  }
  ctx.fillStyle = '#0a0c10';
  ctx.fillRect(0, 0, targetW, targetH);
  ctx.drawImage(img, 0, 0, targetW, targetH);
  URL.revokeObjectURL(url);
  const pngUrl = canvas.toDataURL('image/png');
  const link = document.createElement('a');
  link.href = pngUrl;
  link.download = filename;
  link.click();
}
