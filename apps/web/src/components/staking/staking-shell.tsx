'use client';

import { useState } from 'react';

interface Conflict {
  id: string;
  serialNumber: string;
  claimName: string | null;
  owner: string | null;
  commodity: string | null;
  acreage: number | null;
}

interface CheckResult {
  acreage: number;
  conflictCount: number;
  conflicts: Conflict[];
}

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export function StakingShell() {
  const [polygon, setPolygon] = useState<string>(
    JSON.stringify(
      {
        type: 'Polygon',
        coordinates: [[
          [-117.30, 38.04],
          [-117.20, 38.04],
          [-117.20, 38.09],
          [-117.30, 38.09],
          [-117.30, 38.04],
        ]],
      },
      null,
      2,
    ),
  );
  const [result, setResult] = useState<CheckResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [exportResult, setExportResult] = useState<unknown>(null);

  const checkConflict = async () => {
    setLoading(true);
    try {
      const geometry = JSON.parse(polygon);
      const res = await fetch(`${API}/api/staking/check-conflict`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ geometry }),
      });
      setResult((await res.json()) as CheckResult);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const buildExport = async () => {
    try {
      const geometry = JSON.parse(polygon);
      const res = await fetch(`${API}/api/staking/export`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          geometry,
          claimName: 'NEW LOCATION 1',
          claimType: 'lode',
          locator: { name: 'Jane Prospector', address: '123 Mining Rd, Tonopah NV 89049' },
          discoveryDate: new Date().toISOString().slice(0, 10),
        }),
      });
      setExportResult(await res.json());
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <main className="flex-1 overflow-hidden">
      <div className="mx-auto grid h-full max-w-7xl grid-cols-[1fr_360px] gap-4 px-6 py-6">
        <section className="flex flex-col gap-3 overflow-y-auto rounded-lg border border-border bg-bg-surface p-4">
          <h1 className="font-display text-2xl text-text">Staking toolkit</h1>
          <p className="text-sm text-text-subtle">
            Draw or paste a polygon, run a conflict check against active BLM MLRS claims, and export a Notice of
            Location packet — corner pins, GPS CSV, monument checklist, filing-deadline tracker.
          </p>

          <label className="block">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-text-muted">Polygon (GeoJSON)</span>
            <textarea
              value={polygon}
              onChange={(e) => setPolygon(e.target.value)}
              rows={14}
              spellCheck={false}
              className="w-full rounded-md border border-border bg-bg-panel p-3 font-mono text-xs text-text focus:border-accent focus:outline-none"
            />
          </label>

          <div className="flex gap-2">
            <button
              onClick={checkConflict}
              disabled={loading}
              className="rounded-md bg-accent px-4 py-2 font-mono text-xs text-bg disabled:opacity-50"
            >
              {loading ? 'Checking…' : 'Check conflicts'}
            </button>
            <button
              onClick={buildExport}
              className="rounded-md border border-border bg-bg-panel px-4 py-2 font-mono text-xs text-text"
            >
              Build Notice of Location
            </button>
          </div>
        </section>

        <aside className="flex flex-col gap-3 overflow-y-auto rounded-lg border border-border bg-bg-surface p-4">
          <Card title="Conflict check">
            {!result ? (
              <Empty>Run a check to see conflicting claims.</Empty>
            ) : (
              <div className="space-y-2 font-mono text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-text-muted">Acreage</span>
                  <span className="data-value text-text">{result.acreage}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-text-muted">Conflicts</span>
                  <span className={`data-value ${result.conflictCount === 0 ? 'text-success' : 'text-danger'}`}>
                    {result.conflictCount}
                  </span>
                </div>
                {result.conflicts.length > 0 && (
                  <ul className="mt-1 space-y-1">
                    {result.conflicts.map((c) => (
                      <li key={c.id} className="rounded border border-danger/30 bg-danger/10 px-2 py-1.5">
                        <div className="text-text">{c.claimName ?? c.serialNumber}</div>
                        <div className="text-text-muted">{c.serialNumber} · {c.owner ?? '—'}</div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </Card>

          <Card title="Export">
            {!exportResult ? (
              <Empty>Build the Notice to see corners, deadline, and checklist.</Empty>
            ) : (
              <pre className="max-h-[320px] overflow-auto rounded border border-border bg-bg p-2 font-mono text-[10px] text-text">
                {JSON.stringify(exportResult, null, 2)}
              </pre>
            )}
          </Card>

          <Card title="Filing deadlines">
            <ul className="space-y-1 font-mono text-xs">
              <li className="flex justify-between"><span className="text-text-muted">Notice of Location</span><span className="text-accent">90 days</span></li>
              <li className="flex justify-between"><span className="text-text-muted">County recordation</span><span className="text-accent">90 days</span></li>
              <li className="flex justify-between"><span className="text-text-muted">BLM filing</span><span className="text-accent">90 days</span></li>
              <li className="flex justify-between"><span className="text-text-muted">Annual maintenance</span><span className="text-text">Sept 1 yr.</span></li>
            </ul>
          </Card>
        </aside>
      </div>
    </main>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-bg-panel p-3">
      <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-text-muted">{title}</div>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="font-mono text-xs text-text-muted">{children}</div>;
}
