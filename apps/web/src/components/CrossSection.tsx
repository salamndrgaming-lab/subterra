/** Cross-section modal — given two points A and B on the map, fetch a
 *  topographic profile (USGS EPQS) along the line, sample surface
 *  bedrock geology from Macrostrat at coarser intervals, project the
 *  caller-supplied MRDS occurrences onto the line within a buffer,
 *  and render the lot as a vertical SVG section.
 *
 *  Math lives in lib/section-math.ts; data fetches are local async
 *  helpers in this file. No new shared state — the component owns
 *  its sampling lifecycle and cancels in-flight work on unmount. */

import { useEffect, useMemo, useRef, useState } from 'react';

import { fetchElevation } from '@/lib/elevation';
import { fetchGeology } from '@/lib/macrostrat';
import {
  bearingDeg,
  distanceMeters,
  interpolateLine,
  projectOntoLine,
  type LngLat,
} from '@/lib/section-math';
import { COMMODITY_CATEGORY_COLORS } from '@subterra/shared';

const ELEV_SAMPLES = 60;
const GEOLOGY_SAMPLES = 18;
const DEFAULT_BUFFER_M = 1609; // 1 mile

export interface CrossSectionMrds {
  lng: number;
  lat: number;
  name?: string;
  commodity?: string;
}

interface ElevSample {
  t: number; // fraction 0..1 along AB
  distM: number; // meters from A along AB
  elevM: number | null;
}

interface GeoSample {
  t: number;
  distM: number;
  color: string;
  label: string;
}

interface ProjectedMrds {
  distM: number;
  distFromLineM: number;
  color: string;
  name: string;
  commodity: string;
  lng: number;
  lat: number;
}

export function CrossSection({
  a,
  b,
  mrds,
  bufferMeters = DEFAULT_BUFFER_M,
  onClose,
}: {
  a: LngLat;
  b: LngLat;
  mrds: CrossSectionMrds[];
  bufferMeters?: number;
  onClose: () => void;
}) {
  const totalDistM = useMemo(() => distanceMeters(a, b), [a, b]);
  const bearing = useMemo(() => bearingDeg(a, b), [a, b]);

  const [elev, setElev] = useState<ElevSample[]>([]);
  const [geology, setGeology] = useState<GeoSample[]>([]);
  const [loading, setLoading] = useState<{ elev: boolean; geology: boolean }>({
    elev: true,
    geology: true,
  });
  const cancelledRef = useRef(false);

  // Project MRDS onto the AB line — pure computation, runs synchronously.
  const projectedMrds: ProjectedMrds[] = useMemo(() => {
    const out: ProjectedMrds[] = [];
    for (const m of mrds) {
      const proj = projectOntoLine([m.lng, m.lat], a, b);
      if (proj.distanceFrom > bufferMeters) continue;
      const cat = commodityCategory(m.commodity);
      out.push({
        distM: proj.distanceAlong,
        distFromLineM: proj.distanceFrom,
        color: COMMODITY_CATEGORY_COLORS[cat] ?? '#94a3b8',
        name: m.name ?? '(unnamed)',
        commodity: m.commodity ?? '',
        lng: m.lng,
        lat: m.lat,
      });
    }
    return out;
  }, [a, b, mrds, bufferMeters]);

  // Sample elevation + geology in parallel on mount.
  useEffect(() => {
    cancelledRef.current = false;
    const pts = interpolateLine(a, b, ELEV_SAMPLES);
    const gPts = interpolateLine(a, b, GEOLOGY_SAMPLES);

    void Promise.allSettled(pts.map((p) => fetchElevation(p[0], p[1]))).then((settled) => {
      if (cancelledRef.current) return;
      const out: ElevSample[] = settled.map((s, i) => {
        const t = i / ELEV_SAMPLES;
        const elevM = s.status === 'fulfilled' && s.value ? s.value.meters : null;
        return { t, distM: t * totalDistM, elevM };
      });
      setElev(out);
      setLoading((prev) => ({ ...prev, elev: false }));
    });

    void Promise.allSettled(gPts.map((p) => fetchGeology(p[0], p[1]))).then((settled) => {
      if (cancelledRef.current) return;
      const out: GeoSample[] = settled.map((s, i) => {
        const t = i / GEOLOGY_SAMPLES;
        let color = '#475569';
        let label = 'unknown';
        if (s.status === 'fulfilled') {
          const top = s.value.units[0];
          if (top) {
            color = top.color ?? '#475569';
            label = top.name || top.lithology || 'unknown';
          }
        }
        return { t, distM: t * totalDistM, color, label };
      });
      setGeology(out);
      setLoading((prev) => ({ ...prev, geology: false }));
    });

    return () => {
      cancelledRef.current = true;
    };
  }, [a, b, totalDistM]);

  // ESC closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

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
        className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-border bg-bg-surface shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-border px-4 py-2.5 font-mono text-[11px]">
          <div className="flex items-center gap-3 text-text">
            <span className="font-semibold text-accent">Cross-section</span>
            <span className="text-text-muted">
              {(totalDistM / 1000).toFixed(2)} km · bearing {bearing.toFixed(0)}° · ±
              {(bufferMeters / 1000).toFixed(2)} km buffer · {projectedMrds.length} MRDS
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-text-muted hover:bg-bg-panel hover:text-text"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <div className="overflow-auto p-4">
          {loading.elev && loading.geology ? (
            <div className="flex h-64 items-center justify-center font-mono text-[11px] text-text-muted">
              Sampling {ELEV_SAMPLES + 1} elevation points + {GEOLOGY_SAMPLES + 1} geology points…
            </div>
          ) : (
            <SectionSvg
              totalDistM={totalDistM}
              elev={elev}
              geology={geology}
              mrds={projectedMrds}
            />
          )}
        </div>

        <footer className="border-t border-border bg-bg-panel/40 px-4 py-2 font-mono text-[10px] text-text-muted">
          Topography: <span className="text-text">USGS EPQS</span>
          {' · '}
          Geology: <span className="text-text">Macrostrat</span>
          {' · '}
          Occurrences projected within ±{(bufferMeters / 1000).toFixed(2)} km of section line.
          {(loading.elev || loading.geology) && (
            <span className="ml-2 text-amber-300">
              {loading.elev ? 'elev…' : ''} {loading.geology ? 'geol…' : ''}
            </span>
          )}
        </footer>
      </div>
    </div>
  );
}

function SectionSvg({
  totalDistM,
  elev,
  geology,
  mrds,
}: {
  totalDistM: number;
  elev: ElevSample[];
  geology: GeoSample[];
  mrds: ProjectedMrds[];
}) {
  const W = 1000;
  const H = 360;
  const PADDING = { l: 56, r: 16, t: 16, b: 36 };
  const innerW = W - PADDING.l - PADDING.r;
  const innerH = H - PADDING.t - PADDING.b;

  // Establish elev domain — fall back to a small synthetic range if every
  // sample failed so the SVG isn't degenerate.
  const elevValid = elev.filter((e) => e.elevM != null) as Array<ElevSample & { elevM: number }>;
  const minElev = elevValid.length > 0 ? Math.min(...elevValid.map((e) => e.elevM)) : 0;
  const maxElev = elevValid.length > 0 ? Math.max(...elevValid.map((e) => e.elevM)) : 100;
  const elevRange = Math.max(50, maxElev - minElev);
  const elevPadTop = elevRange * 0.1;

  const xOf = (distM: number): number => PADDING.l + (distM / totalDistM) * innerW;
  const yOf = (elevM: number): number =>
    PADDING.t + innerH - ((elevM - minElev) / (elevRange + elevPadTop)) * innerH;

  // Topo path — only segments where consecutive samples both have data.
  const topoSegments: string[] = [];
  let current: string[] = [];
  for (const e of elev) {
    if (e.elevM == null) {
      if (current.length) {
        topoSegments.push(current.join(' '));
        current = [];
      }
      continue;
    }
    current.push(`${xOf(e.distM).toFixed(1)},${yOf(e.elevM).toFixed(1)}`);
  }
  if (current.length) topoSegments.push(current.join(' '));

  // Geology bands — paint each interval [g[i].distM, g[i+1].distM] with g[i].color.
  const geoBands = geology.slice(0, -1).map((g, i) => {
    const next = geology[i + 1]!;
    const x0 = xOf(g.distM);
    const x1 = xOf(next.distM);
    return { x: x0, width: Math.max(0.5, x1 - x0), color: g.color, label: g.label };
  });

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="block w-full"
      style={{ background: '#0a0c10' }}
      role="img"
      aria-label="Topographic and geologic cross-section"
    >
      {/* Geology bands: thin strip beneath the topo line so users see the
          formation pattern even where topo dips out. */}
      {geoBands.map((g, i) => (
        <rect
          key={`geo-${i}`}
          x={g.x}
          y={H - PADDING.b - 14}
          width={g.width}
          height={14}
          fill={g.color}
          opacity={0.85}
        >
          <title>{g.label}</title>
        </rect>
      ))}

      {/* Topo polylines — one segment per contiguous valid run. */}
      {topoSegments.map((pts, i) => (
        <polyline
          key={`topo-${i}`}
          points={pts}
          fill="none"
          stroke="#f59e0b"
          strokeWidth={1.6}
        />
      ))}

      {/* MRDS dots — placed on the topo line at their projected x. */}
      {mrds.map((m, i) => {
        const cx = xOf(m.distM);
        // Find nearest topo sample for y; fall back to mid-height if none.
        const nearestElev = elev.reduce<ElevSample | null>((best, e) => {
          if (e.elevM == null) return best;
          if (!best || Math.abs(e.distM - m.distM) < Math.abs(best.distM - m.distM)) return e;
          return best;
        }, null);
        const cy = nearestElev?.elevM != null ? yOf(nearestElev.elevM) - 4 : PADDING.t + 20;
        return (
          <g key={`mrds-${i}`}>
            <circle cx={cx} cy={cy} r={4.5} fill={m.color} stroke="#f8fafc" strokeWidth={0.7}>
              <title>{`${m.name} — ${m.commodity || 'commodity unknown'}`}</title>
            </circle>
          </g>
        );
      })}

      {/* X-axis tick marks: 0 / quarter / mid / three-quarter / end. */}
      {[0, 0.25, 0.5, 0.75, 1].map((t) => {
        const x = PADDING.l + t * innerW;
        const km = ((t * totalDistM) / 1000).toFixed(2);
        return (
          <g key={`xt-${t}`} fontFamily="ui-monospace, monospace" fontSize={10} fill="#94a3b8">
            <line x1={x} y1={H - PADDING.b} x2={x} y2={H - PADDING.b + 4} stroke="#475569" />
            <text x={x} y={H - PADDING.b + 16} textAnchor="middle">
              {km} km
            </text>
          </g>
        );
      })}
      <text
        x={PADDING.l}
        y={H - 4}
        fontFamily="ui-monospace, monospace"
        fontSize={10}
        fill="#64748b"
      >
        A
      </text>
      <text
        x={W - PADDING.r}
        y={H - 4}
        textAnchor="end"
        fontFamily="ui-monospace, monospace"
        fontSize={10}
        fill="#64748b"
      >
        B
      </text>

      {/* Y-axis tick marks: min / mid / max elevation. */}
      {[minElev, (minElev + maxElev) / 2, maxElev].map((e, i) => {
        const y = yOf(e);
        return (
          <g key={`yt-${i}`} fontFamily="ui-monospace, monospace" fontSize={10} fill="#94a3b8">
            <line x1={PADDING.l - 4} y1={y} x2={PADDING.l} y2={y} stroke="#475569" />
            <text x={PADDING.l - 6} y={y + 3} textAnchor="end">
              {Math.round(e)} m
            </text>
          </g>
        );
      })}
    </svg>
  );
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
