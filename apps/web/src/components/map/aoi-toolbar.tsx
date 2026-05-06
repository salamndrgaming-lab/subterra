'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMapStore } from '@/stores/map-store';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';

/**
 * Floating bottom-center toolbar that appears when the user is in AOI-draw
 * mode. Shows live acreage and lets them name + save the polygon to
 * /api/aois (which stores it in PostGIS).
 */
export function AoiToolbar() {
  const drawingAoi = useMapStore((s) => s.drawingAoi);
  const setDrawingAoi = useMapStore((s) => s.setDrawingAoi);
  const drawnPolygon = useMapStore((s) => s.drawnPolygon);
  const setDrawnPolygon = useMapStore((s) => s.setDrawnPolygon);
  const queryClient = useQueryClient();

  const [name, setName] = useState('');

  const save = useMutation({
    mutationFn: async () => {
      if (!drawnPolygon) throw new Error('Draw a polygon first');
      return api.aois.create({ name: name || `AOI ${new Date().toISOString().slice(0, 10)}`, geometry: drawnPolygon });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['aois'] });
      setName('');
      setDrawnPolygon(null);
      setDrawingAoi(false);
    },
  });

  const conflict = useMutation({
    mutationFn: async () => {
      if (!drawnPolygon) throw new Error('Draw a polygon first');
      return api.staking.checkConflict(drawnPolygon);
    },
  });

  const acres = drawnPolygon ? polygonAcres(drawnPolygon.coordinates[0] ?? []) : 0;

  if (!drawingAoi && !drawnPolygon) return null;

  return (
    <div className="pointer-events-auto absolute bottom-6 left-1/2 z-30 -translate-x-1/2 animate-fade-in rounded-lg border border-border bg-bg-surface/95 p-3 shadow-panel backdrop-blur">
      <div className="flex items-center gap-3 font-mono text-xs">
        <span className={cn('h-1.5 w-1.5 rounded-full', drawnPolygon ? 'bg-accent' : 'bg-info animate-pulse-glow')} />
        <span className="text-text-subtle">
          {drawnPolygon ? `Polygon · ${acres.toFixed(2)} acres` : 'Draw a polygon to define an AOI'}
        </span>
        {drawnPolygon && (
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="AOI name"
            className="rounded border border-border bg-bg-panel px-2 py-1 text-xs text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
          />
        )}
        {drawnPolygon && (
          <button
            onClick={() => conflict.mutate()}
            disabled={conflict.isPending}
            className="rounded border border-border bg-bg-panel px-2 py-1 text-xs text-text hover:border-accent disabled:opacity-50"
          >
            {conflict.isPending ? 'Checking…' : 'Check claim conflicts'}
          </button>
        )}
        {drawnPolygon && (
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending}
            className="rounded bg-accent px-3 py-1 text-xs text-bg hover:brightness-110 disabled:opacity-50"
          >
            {save.isPending ? 'Saving…' : 'Save AOI'}
          </button>
        )}
        <button
          onClick={() => { setDrawingAoi(false); setDrawnPolygon(null); }}
          className="rounded border border-border bg-bg-panel px-2 py-1 text-xs text-text-subtle hover:text-text"
        >
          Cancel
        </button>
      </div>

      {conflict.data && (
        <div className="mt-2 rounded border border-border bg-bg p-2 text-[11px] text-text-subtle">
          <span className={conflict.data.conflictCount === 0 ? 'text-success' : 'text-danger'}>
            {conflict.data.conflictCount === 0 ? '✓ No active BLM claim conflicts' : `${conflict.data.conflictCount} conflicting active BLM claims`}
          </span>
          <span className="ml-2 text-text-muted">source: {conflict.data.source}</span>
        </div>
      )}

      {save.error && <div className="mt-2 text-[11px] text-danger">{(save.error as Error).message}</div>}
    </div>
  );
}

function polygonAcres(ring: number[][]): number {
  if (ring.length < 4) return 0;
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]; const b = ring[j];
    if (!a || !b) continue;
    area += (b[0]! + a[0]!) * (b[1]! - a[1]!);
  }
  area = Math.abs(area / 2);
  let sumLat = 0;
  for (const pt of ring) sumLat += pt[1] ?? 0;
  const meanLat = sumLat / ring.length;
  const sqKm = area * 111 * 111 * Math.cos((meanLat * Math.PI) / 180);
  return sqKm * 247.105;
}
