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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { fetchElevation } from '@/lib/elevation';
import { fetchGeology, type StratUnit } from '@/lib/macrostrat';
import {
  bearingDeg,
  distanceMeters,
  interpolateLine,
  polylineCrossings,
  projectOntoLine,
  type LngLat,
} from '@/lib/section-math';
import { COMMODITY_CATEGORY_COLORS } from '@subterra/shared';

const ELEV_SAMPLES = 100;
const GEOLOGY_SAMPLES = 24;
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
  a: LngLat;
  b: LngLat;
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
  return [
    `Subterra cross-section A (${fmt(opts.a)}) → B (${fmt(opts.b)}).`,
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
  t: number; // fraction along AB
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

export function CrossSection({
  a,
  b,
  mrds,
  claims = [],
  geochem = [],
  agencies = [],
  faults = [],
  onClose,
}: {
  a: LngLat;
  b: LngLat;
  mrds: CrossSectionMrds[];
  claims?: CrossSectionClaim[];
  geochem?: CrossSectionGeochem[];
  agencies?: CrossSectionAgency[];
  faults?: CrossSectionFault[];
  onClose: () => void;
}) {
  // Reversible endpoints — local state so the modal can swap A/B
  // without bouncing back to the caller. Caller passes the initial
  // pair; we own subsequent ordering.
  const [pair, setPair] = useState<{ a: LngLat; b: LngLat }>({ a, b });
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

  const totalDistM = useMemo(() => distanceMeters(pair.a, pair.b), [pair]);
  const bearing = useMemo(() => bearingDeg(pair.a, pair.b), [pair]);

  const [elev, setElev] = useState<ElevSample[]>([]);
  const [geology, setGeology] = useState<GeoSample[]>([]);
  const [loading, setLoading] = useState<{ elev: boolean; geology: boolean }>({
    elev: true,
    geology: true,
  });
  const cancelRef = useRef(false);
  const svgRef = useRef<SVGSVGElement | null>(null);

  // ─── projections (recompute when AB or buffer changes) ──────────
  const projectedMrds: ProjectedMrds[] = useMemo(() => {
    const out: ProjectedMrds[] = [];
    for (const m of mrds) {
      const proj = projectOntoLine([m.lng, m.lat], pair.a, pair.b);
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
  }, [mrds, pair, bufferM]);

  const projectedClaims: ProjectedClaim[] = useMemo(() => {
    const out: ProjectedClaim[] = [];
    const seen = new Set<string>();
    for (const c of claims) {
      const proj = projectOntoLine([c.lng, c.lat], pair.a, pair.b);
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
  }, [claims, pair, bufferM]);

  const projectedGeochem: ProjectedGeochem[] = useMemo(() => {
    const out: ProjectedGeochem[] = [];
    for (const g of geochem) {
      const proj = projectOntoLine([g.lng, g.lat], pair.a, pair.b);
      if (proj.distanceFrom > bufferM) continue;
      out.push({
        distM: proj.distanceAlong,
        distFromLineM: proj.distanceFrom,
        asPpm: typeof g.asPpm === 'number' ? g.asPpm : null,
        element: g.element ?? 'As',
      });
    }
    return out;
  }, [geochem, pair, bufferM]);

  // Agencies are sampled along the line at 60 evenly-spaced points
  // — they're large polygons so per-sample lookup beats projecting
  // every supplied centroid.
  const agencyStrip = useMemo(() => buildAgencyStrip(pair.a, pair.b, agencies, totalDistM), [
    agencies, pair, totalDistM,
  ]);

  // Fault crossings — exact polyline∩AB intersections (no buffer:
  // a fault either crosses the section plane or it doesn't).
  const faultCrossings: FaultCrossing[] = useMemo(() => {
    const out: FaultCrossing[] = [];
    for (const f of faults) {
      const ts = polylineCrossings(pair.a, pair.b, f.coords);
      for (const t of ts) {
        out.push({
          t,
          name: f.name ?? '(unnamed fault)',
          slipSense: f.slipSense ?? '',
          slipRate: f.slipRate ?? '',
          age: f.age ?? '',
        });
      }
    }
    return out.sort((x, y) => x.t - y.t);
  }, [faults, pair]);

  // ─── data fetching (re-runs only when AB actually changes) ──────
  useEffect(() => {
    cancelRef.current = false;
    setLoading({ elev: true, geology: true });
    const ePts = interpolateLine(pair.a, pair.b, ELEV_SAMPLES);
    const gPts = interpolateLine(pair.a, pair.b, GEOLOGY_SAMPLES);

    void Promise.allSettled(ePts.map((p) => fetchElevation(p[0], p[1]))).then((settled) => {
      if (cancelRef.current) return;
      const out: ElevSample[] = settled.map((s, i) => {
        const t = i / ELEV_SAMPLES;
        const elevM = s.status === 'fulfilled' && s.value ? s.value.meters : null;
        return { t, distM: t * totalDistM, elevM };
      });
      setElev(out);
      setLoading((p) => ({ ...p, elev: false }));
    });

    void Promise.allSettled(gPts.map((p) => fetchGeology(p[0], p[1]))).then((settled) => {
      if (cancelRef.current) return;
      const out: GeoSample[] = settled.map((s, i) => {
        const t = i / GEOLOGY_SAMPLES;
        let color = '#475569';
        let label = 'unknown';
        let age: string | undefined;
        let lithology: string | undefined;
        let columnId: number | undefined;
        let strat: StratUnit[] = [];
        if (s.status === 'fulfilled') {
          const top = s.value.units[0];
          if (top) {
            color = top.color ?? '#475569';
            label = top.name || top.lithology || 'unknown';
            age = top.age;
            lithology = top.lithology;
          }
          columnId = s.value.columnId;
          strat = s.value.strat;
        }
        return { t, distM: t * totalDistM, color, label, age, lithology, columnId, strat };
      });
      setGeology(out);
      setLoading((p) => ({ ...p, geology: false }));
    });

    return () => {
      cancelRef.current = true;
    };
  }, [pair, totalDistM]);

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
    setPair((p) => ({ a: p.b, b: p.a }));
  }, []);

  const downloadPng = useCallback(async () => {
    const svg = svgRef.current;
    if (!svg) return;
    await svgToPngDownload(svg, `cross-section-${Date.now()}.png`);
  }, []);

  // Copy a plain-text citation block to the clipboard. Pairs with the
  // shareable `?cs=...` URL written by the Map route so the citation
  // contains a permalink that reproduces the exact section.
  const [citationCopied, setCitationCopied] = useState(false);
  const copyCitation = useCallback(async () => {
    const url = typeof window !== 'undefined' ? window.location.href : '';
    const text = buildCitation({
      a: pair.a,
      b: pair.b,
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
  }, [pair, ve, bufferM, depthM, trueScale]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4 backdrop-blur"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Cross-section"
    >
      <div
        data-testid="cross-section-modal"
        className="flex max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-lg border border-border bg-bg-surface shadow-2xl"
      >
        <Header
          totalDistM={totalDistM}
          bearing={bearing}
          a={pair.a}
          b={pair.b}
          onClose={onClose}
          onReverse={reverse}
          onDownload={downloadPng}
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
            />
          )}
        </div>

        <Footer
          loading={loading}
          bufferM={bufferM}
          stats={stats}
          mrds={projectedMrds}
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
  a,
  b,
  onClose,
  onReverse,
  onDownload,
  onCopyCitation,
  citationCopied,
}: {
  totalDistM: number;
  bearing: number;
  a: LngLat;
  b: LngLat;
  onClose: () => void;
  onReverse: () => void;
  onDownload: () => void;
  onCopyCitation: () => void;
  citationCopied: boolean;
}) {
  const lengthMi = totalDistM / 1609.34;
  return (
    <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5 font-mono text-[11px]">
      <div className="flex items-center gap-3 text-text">
        <span className="font-semibold text-accent">Cross-section</span>
        <span className="text-text-muted">
          {(totalDistM / 1000).toFixed(2)} km · {lengthMi.toFixed(2)} mi · bearing{' '}
          {bearing.toFixed(0)}° {compassFromDeg(bearing)}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <a
          href={`https://www.google.com/maps?q=${a[1]},${a[0]}`}
          target="_blank"
          rel="noreferrer"
          className="rounded border border-border bg-bg-panel px-2 py-1 text-text-muted hover:border-accent hover:text-accent"
          title={`A: ${a[1].toFixed(5)}, ${a[0].toFixed(5)} — open in Google Maps`}
        >
          A ↗
        </a>
        <a
          href={`https://www.google.com/maps?q=${b[1]},${b[0]}`}
          target="_blank"
          rel="noreferrer"
          className="rounded border border-border bg-bg-panel px-2 py-1 text-text-muted hover:border-accent hover:text-accent"
          title={`B: ${b[1].toFixed(5)}, ${b[0].toFixed(5)} — open in Google Maps`}
        >
          B ↗
        </a>
        <button
          type="button"
          onClick={onReverse}
          data-testid="cs-reverse"
          className="rounded border border-border bg-bg-panel px-2 py-1 text-text-muted hover:border-accent hover:text-accent"
          title="Swap A and B"
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
  const KEY = 'subterra:cs:continuity-disclaimer-dismissed';
  const [dismissed, setDismissed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    return window.sessionStorage.getItem(KEY) === '1';
  });
  if (dismissed) return null;
  return (
    <div className="flex items-start gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-1.5 font-mono text-[10px] text-amber-200">
      <span aria-hidden className="mt-0.5">ⓘ</span>
      <span className="min-w-0 flex-1">
        Hung-column section. Vertical thicknesses from Macrostrat (with
        uncertainty bands shown on hover). Lateral continuity between
        columns and regional dip are NOT modeled — units are drawn flat.
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
}: {
  loading: { elev: boolean; geology: boolean };
  bufferM: number;
  stats: SectionStats;
  mrds: ProjectedMrds[];
}) {
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
}: {
  svgRef: React.MutableRefObject<SVGSVGElement | null>;
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

  // ── topo path (contiguous segments) ───────────────────────────────
  const topoSegments = buildPolySegments(elev, xOf, yOf);
  const topoFillPath = buildFillPath(elev, xOf, yOf, topoBottomY);

  // ── geology bands (contiguous merges) ─────────────────────────────
  const geoBands = mergeGeoBands(geology, xOf);

  // ── hover state ───────────────────────────────────────────────────
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
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
                return (
                  <g key={`u-${bi}-${ui}`}>
                    <rect
                      x={x0}
                      y={yTop}
                      width={w}
                      height={h}
                      fill={u.color ?? '#475569'}
                      opacity={0.82}
                      stroke="#0a0c10"
                      strokeWidth={0.6}
                    >
                      <title>
                        {`${u.name}${u.age ? ` · ${u.age}` : ''}${u.lithology ? ` · ${u.lithology}` : ''}` +
                          `\nthickness ~${Math.round(thick)} m · top ~${Math.round(cum - thick)} m below surface` +
                          `${u.environment ? `\nenvironment: ${u.environment}` : ''}`}
                      </title>
                    </rect>
                    {showLabel && (
                      <text
                        x={x0 + w / 2}
                        y={yTop + h / 2 + 3}
                        textAnchor="middle"
                        fontFamily="ui-monospace, monospace"
                        fontSize={9}
                        fill={contrastTextColor(u.color ?? '#475569')}
                        pointerEvents="none"
                      >
                        {truncate(u.name, Math.max(6, Math.floor(w / 6.5)))}
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
          Quaternary fault traces give the surface crossing point but
          not the dip — drawn vertical-dashed per convention for
          unknown dip, with the name + slip data in the tooltip. */}
      {faultCrossings.map((f, i) => {
        const x = PADDING.l + f.t * innerW;
        const surfY = (() => {
          const e = interpElev(elev, f.t * totalDistM);
          return e != null ? yOf(e) : PADDING.t + 40;
        })();
        return (
          <g key={`fault-${i}`}>
            <line
              x1={x}
              y1={surfY}
              x2={x}
              y2={topoBottomY}
              stroke="#ef4444"
              strokeWidth={2}
              strokeDasharray="8 4"
              opacity={0.9}
            >
              <title>
                {`${f.name}${f.slipSense ? `\nslip sense: ${f.slipSense}` : ''}` +
                  `${f.slipRate ? `\nslip rate: ${f.slipRate}` : ''}` +
                  `${f.age ? `\nage: ${f.age}` : ''}\n(dip unknown — drawn vertical)`}
              </title>
            </line>
            {/* surface tick + label */}
            <polygon
              points={`${x - 5},${surfY - 9} ${x + 5},${surfY - 9} ${x},${surfY - 2}`}
              fill="#ef4444"
            />
            <text
              x={x + 4}
              y={surfY - 14}
              fontFamily="ui-monospace, monospace"
              fontSize={9}
              fill="#ef4444"
            >
              {truncate(f.name, 26)}
            </text>
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
          />
        </g>
      )}
    </svg>
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
}) {
  // Pin the readout to whichever side of the cursor has more space.
  const u = unitAtCursor?.unit;
  const ageRange = u ? formatAgeRange(u) : null;
  const envLabel = u?.environment ? truncate(u.environment, 26) : null;
  // Box grows to accommodate the extra age + environment rows when a
  // subsurface unit is hovered.
  const extraRows = u ? 1 + (ageRange ? 1 : 0) + (envLabel ? 1 : 0) : 0;
  const boxW = 220;
  const boxH = 78 + extraRows * 14;
  const placeRight = hover.x < W - PADDING.r - boxW - 8;
  const x = placeRight ? hover.x + 10 : hover.x - boxW - 10;
  const y = Math.min(hover.y + 10, PADDING.t + 6);
  return (
    <g transform={`translate(${x}, ${y})`} fontFamily="ui-monospace, monospace" fontSize={10}>
      <rect
        width={boxW}
        height={boxH}
        rx={4}
        fill="#0a0c10"
        stroke="#1f2937"
        opacity={0.95}
      />
      <text x={8} y={14} fill="#94a3b8">distance</text>
      <text x={boxW - 8} y={14} textAnchor="end" fill="#fbbf24">
        {(distM / 1000).toFixed(2)} km · {(distM / 1609.34).toFixed(2)} mi
      </text>
      <text x={8} y={28} fill="#94a3b8">elevation</text>
      <text x={boxW - 8} y={28} textAnchor="end" fill="#f8fafc">
        {elevM != null ? `${Math.round(elevM)} m · ${Math.round(elevM * 3.28084)} ft` : '—'}
      </text>
      <text x={8} y={42} fill="#94a3b8">slope</text>
      <text x={boxW - 8} y={42} textAnchor="end" fill="#f8fafc">
        {slopePct != null ? `${slopePct.toFixed(1)}%` : '—'}
      </text>
      <text x={8} y={56} fill="#94a3b8">surface geo</text>
      <text x={boxW - 8} y={56} textAnchor="end" fill="#f8fafc">
        {truncate(geoLabel ?? '—', 22)}{geoAge ? `, ${truncate(geoAge, 8)}` : ''}
      </text>
      <text x={8} y={70} fill="#94a3b8">surface mgmt</text>
      <text x={boxW - 8} y={70} textAnchor="end" fill="#f8fafc">
        {agency ?? '—'}
      </text>
      {u && (
        <>
          <text x={8} y={84} fill="#94a3b8">at cursor</text>
          <text x={boxW - 8} y={84} textAnchor="end" fill="#2dd4bf">
            {truncate(u.name, 20)} ({Math.round(unitAtCursor!.depthM)} m)
          </text>
          {ageRange && (
            <>
              <text x={8} y={98} fill="#94a3b8">age</text>
              <text x={boxW - 8} y={98} textAnchor="end" fill="#f8fafc">
                {truncate(u.age || '—', 20)} · {ageRange}
              </text>
            </>
          )}
          {envLabel && (
            <>
              <text x={8} y={98 + (ageRange ? 14 : 0)} fill="#94a3b8">environ</text>
              <text
                x={boxW - 8}
                y={98 + (ageRange ? 14 : 0)}
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
  a: LngLat,
  b: LngLat,
  agencies: CrossSectionAgency[],
  totalDistM: number,
): AgencySegment[] {
  if (agencies.length === 0 || totalDistM <= 0) return [];
  const N = 60;
  const pts = interpolateLine(a, b, N);
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
