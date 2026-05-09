'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';

/**
 * Slim banner shown above every page when the API reports demo mode (no
 * PostgreSQL reachable). Every public-data layer still works; the banner
 * just tells the user which features need a database.
 */
export function DemoModeBanner() {
  const [dismissed, setDismissed] = useState(false);
  const q = useQuery({
    queryKey: ['mode'],
    queryFn: () => api.sources.mode(),
    refetchInterval: 30_000,
  });

  if (dismissed || !q.data?.demoMode) return null;

  return (
    <div className={cn(
      'flex items-center justify-between gap-3 border-b border-accent/30 bg-accent/10 px-4 py-1.5 font-mono text-[11px] text-accent',
    )}>
      <div className="flex items-center gap-2">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent animate-pulse-glow" />
        <span>
          <strong className="font-semibold">Demo mode</strong> · all live BLM/USGS/state layers + OSM search are working ·
          sign-in, saved AOIs, and projects are disabled until PostgreSQL is reachable.
          Run <code className="rounded bg-bg/40 px-1">npm run infra:up</code> to enable them.
        </span>
      </div>
      <button
        onClick={() => setDismissed(true)}
        className="rounded border border-accent/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider hover:bg-accent/15"
        aria-label="Dismiss"
      >
        Dismiss
      </button>
    </div>
  );
}
