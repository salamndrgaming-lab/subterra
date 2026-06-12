/** Client for the /my-claims Worker routes — list, add, delete. */

import { API_BASE } from './api-base';

const API_URL = API_BASE;

export interface TrackedClaim {
  id: string;
  serial: string;
  name: string | null;
  notes: string | null;
  created_at: string;
}

export async function fetchTrackedClaims(): Promise<TrackedClaim[]> {
  const res = await fetch(`${API_URL}/my-claims`, { credentials: 'include' });
  if (res.status === 401) throw new Error('UNAUTHENTICATED');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { claims: TrackedClaim[] };
  return body.claims;
}

export async function addTrackedClaims(
  serials: string[],
): Promise<{ added: number; skipped: number; total: number }> {
  const res = await fetch(`${API_URL}/my-claims`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ serials }),
  });
  if (res.status === 401) throw new Error('UNAUTHENTICATED');
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      msg = body.message ?? body.error ?? msg;
    } catch {
      // keep status code
    }
    throw new Error(msg);
  }
  return (await res.json()) as { added: number; skipped: number; total: number };
}

export async function deleteTrackedClaim(id: string): Promise<void> {
  const res = await fetch(`${API_URL}/my-claims/${id}`, {
    method: 'DELETE',
    credentials: 'include',
  });
  if (res.status === 401) throw new Error('UNAUTHENTICATED');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

/** Next BLM annual maintenance-fee deadline. Sept 1 of the current
 *  year if today is before it; otherwise Sept 1 of next year.
 *  Returns the date in UTC (the deadline is a calendar date, not a
 *  point-in-time, so the user's TZ doesn't matter for the countdown). */
export function nextMaintenanceFeeDate(today: Date = new Date()): Date {
  const year = today.getUTCFullYear();
  const thisYear = new Date(Date.UTC(year, 8, 1)); // Sept 1
  // Compare calendar dates, not instants — Sept 1 at any time of day
  // still meets that year's deadline; Sept 2 rolls to next year.
  const todayUtcMidnight = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
  );
  if (todayUtcMidnight.getTime() <= thisYear.getTime()) return thisYear;
  return new Date(Date.UTC(year + 1, 8, 1));
}

/** Days until next Sept 1, rounded down. Negative if past — which
 *  never happens with nextMaintenanceFeeDate but kept defensive. */
export function daysUntil(target: Date, today: Date = new Date()): number {
  const ms = target.getTime() - today.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}
