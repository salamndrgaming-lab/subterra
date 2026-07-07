/** Client for the /shares Worker routes — create a public prospect
 *  report from an AOI summary, and read one back (public, no auth). */

import { API_BASE } from './api-base';

const API_URL = API_BASE;

/** The snapshot rendered on the public report page. Kept small + flat. */
export interface SharePayload {
  acres: number;
  centroid: [number, number];
  mrdsInside: number;
  mrdsByCategory: Record<string, number>;
  claimsInside: number;
  lodeClaims: number;
  year1CostLow: number;
  year1CostHigh: number;
  annualCost: number;
}

export interface ShareRecord {
  title: string;
  payload: SharePayload | null;
  createdAt: string;
}

/** Create a share; returns the public path (/r/<token>). Authed. */
export async function createShare(title: string, payload: SharePayload): Promise<string> {
  const res = await fetch(`${API_URL}/shares`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, payload }),
  });
  if (res.status === 401) throw new Error('UNAUTHENTICATED');
  if (!res.ok) throw new Error(`share failed: HTTP ${res.status}`);
  const body = (await res.json()) as { token: string };
  return `/r/${body.token}`;
}

/** Fetch a public report by token. No auth. */
export async function fetchShare(token: string): Promise<ShareRecord> {
  const res = await fetch(`${API_URL}/shares/${encodeURIComponent(token)}`);
  if (res.status === 404) throw new Error('NOT_FOUND');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as ShareRecord;
}
