'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { useMapStore } from '@/stores/map-store';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { AuthStatus } from '../auth/auth-status';

export function MapTopBar() {
  const { sidebarOpen, setSidebarOpen, view, drawingAoi, setDrawingAoi } = useMapStore();
  const health = useQuery({
    queryKey: ['sources-health'],
    queryFn: () => api.sources.health(),
    refetchInterval: 60_000,
  });

  return (
    <header className="z-30 flex h-12 items-center justify-between gap-2 border-b border-border bg-bg-surface px-3">
      <div className="flex items-center gap-2">
        <button
          aria-label="Toggle sidebar"
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className="flex h-8 w-8 items-center justify-center rounded-md border border-border bg-bg-panel text-text-subtle transition hover:border-border-strong hover:text-text"
        >
          <SidebarIcon collapsed={!sidebarOpen} />
        </button>

        <Link href="/" className="flex items-center gap-2 px-1.5">
          <Logo />
          <span className="hidden font-display text-sm tracking-tight text-text md:inline">Subterra</span>
        </Link>
      </div>

      <div className="hidden flex-1 items-center justify-center md:flex">
        <SearchInput />
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={() => setDrawingAoi(!drawingAoi)}
          className={cn(
            'flex h-8 items-center gap-1.5 rounded-md border px-3 font-mono text-xs transition',
            drawingAoi
              ? 'border-accent bg-accent/15 text-accent'
              : 'border-border bg-bg-panel text-text-subtle hover:text-text',
          )}
        >
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden>
            <path d="M2 9 L5.5 2 L9 9 Z" stroke="currentColor" strokeWidth="1.2" />
          </svg>
          {drawingAoi ? 'Drawing AOI' : 'Draw AOI'}
        </button>
        <SourcesIndicator data={health.data} />
        <Telemetry view={view} />
        <AuthStatus />
        <Link
          href="/settings"
          className="flex h-8 items-center rounded-md border border-border bg-bg-panel px-3 font-mono text-xs text-text-subtle hover:text-text"
        >
          Settings
        </Link>
      </div>
    </header>
  );
}

function SearchInput() {
  return (
    <div className="relative w-full max-w-xl">
      <input
        type="search"
        placeholder="Search wells, claims, owners, APN, township..."
        className="h-8 w-full rounded-md border border-border bg-bg-panel pl-9 pr-3 font-mono text-xs text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
      />
      <svg
        aria-hidden
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted"
        width="14"
        height="14"
        viewBox="0 0 14 14"
        fill="none"
      >
        <circle cx="6" cy="6" r="4.25" stroke="currentColor" strokeWidth="1.2" />
        <path d="M9.5 9.5L12 12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    </div>
  );
}

function SourcesIndicator({ data }: { data: { overall: 'ok' | 'degraded'; sources: Array<{ id: string; name: string; status: 'ok' | 'degraded' | 'down'; latencyMs: number | null }> } | undefined }) {
  if (!data) return null;
  const down = data.sources.filter((s) => s.status === 'down').length;
  const degraded = data.sources.filter((s) => s.status === 'degraded').length;
  const dotColor = down > 0 ? 'bg-danger' : degraded > 0 ? 'bg-accent' : 'bg-success';
  const label = down > 0 ? `${down} down` : degraded > 0 ? `${degraded} slow` : 'all live';
  return (
    <div
      className="hidden h-8 items-center gap-2 rounded-md border border-border bg-bg-panel px-3 font-mono text-[10px] text-text-subtle md:flex"
      title={data.sources.map((s) => `${s.name}: ${s.status}${s.latencyMs ? ` (${s.latencyMs}ms)` : ''}`).join('\n')}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', dotColor)} />
      <span>sources · {label}</span>
    </div>
  );
}

function Telemetry({ view }: { view: { longitude: number; latitude: number; zoom: number } }) {
  return (
    <div className="hidden items-center gap-3 rounded-md border border-border bg-bg-panel px-3 py-1 font-mono text-[10px] text-text-muted lg:flex">
      <span className="data-value text-text-subtle">{view.latitude.toFixed(4)}</span>
      <span className="text-border-strong">·</span>
      <span className="data-value text-text-subtle">{view.longitude.toFixed(4)}</span>
      <span className="text-border-strong">·</span>
      <span className="data-value text-accent">z{view.zoom.toFixed(2)}</span>
    </div>
  );
}

function SidebarIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <rect x="1.5" y="2" width="11" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <line
        x1="5.5"
        y1="2"
        x2="5.5"
        y2="12"
        stroke="currentColor"
        strokeWidth="1.2"
        className={cn(collapsed && 'opacity-30')}
      />
    </svg>
  );
}

function Logo() {
  return (
    <svg width="18" height="18" viewBox="0 0 22 22" fill="none" aria-hidden>
      <path d="M11 2 L20 18 L2 18 Z" stroke="#f59e0b" strokeWidth="1.5" />
      <circle cx="11" cy="11" r="1.2" fill="#f59e0b" />
    </svg>
  );
}
