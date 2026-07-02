/** Client for the /alerts + /aois Worker routes — save an AOI and watch it
 *  for new claims / permits. All requests carry the session cookie. */

import { API_BASE } from './api-base';
import type { LngLat } from './geo';

const API_URL = API_BASE;

export type AlertEventKind = 'new_claim_filed' | 'permit_filed';

export interface AlertRecord {
  id: string;
  name: string;
  eventKind: string;
  aoiId: string | null;
  filters: { state?: string; operator?: string };
  isEnabled: boolean;
  lastNotifiedVersion: number;
  createdAt: string;
}

/** Persist a drawn polygon as an AOI. Returns its id. */
export async function saveAoi(input: {
  name: string;
  vertices: LngLat[];
  acres: number;
}): Promise<string> {
  // Close the ring: GeoJSON polygons repeat the first point last.
  // LngLat is a [lng, lat] tuple.
  const ring: [number, number][] = input.vertices.map((v) => [v[0], v[1]]);
  if (ring.length > 0) ring.push(ring[0]!);
  const geometry = { type: 'Polygon' as const, coordinates: [ring] };
  const res = await fetch(`${API_URL}/aois`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: input.name, geometry, areaAcres: input.acres }),
  });
  if (res.status === 401) throw new Error('UNAUTHENTICATED');
  if (!res.ok) throw new Error(`AOI save failed: HTTP ${res.status}`);
  const body = (await res.json()) as { id: string };
  return body.id;
}

export async function createAlert(input: {
  aoiId: string;
  name: string;
  eventKind: AlertEventKind;
  filters?: { state?: string; operator?: string };
}): Promise<string> {
  const res = await fetch(`${API_URL}/alerts`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (res.status === 401) throw new Error('UNAUTHENTICATED');
  if (!res.ok) throw new Error(`Alert create failed: HTTP ${res.status}`);
  const body = (await res.json()) as { id: string };
  return body.id;
}

/** Save the AOI and create an alert on it in one call — the "Watch this
 *  area" action. */
export async function watchArea(input: {
  name: string;
  vertices: LngLat[];
  acres: number;
  eventKind: AlertEventKind;
}): Promise<{ aoiId: string; alertId: string }> {
  const aoiId = await saveAoi({ name: input.name, vertices: input.vertices, acres: input.acres });
  const alertId = await createAlert({ aoiId, name: input.name, eventKind: input.eventKind });
  return { aoiId, alertId };
}

export async function fetchAlerts(): Promise<AlertRecord[]> {
  const res = await fetch(`${API_URL}/alerts`, { credentials: 'include' });
  if (res.status === 401) throw new Error('UNAUTHENTICATED');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { alerts: AlertRecord[] };
  return body.alerts;
}

export async function setAlertEnabled(id: string, isEnabled: boolean): Promise<void> {
  const res = await fetch(`${API_URL}/alerts/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ isEnabled }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function deleteAlert(id: string): Promise<void> {
  const res = await fetch(`${API_URL}/alerts/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}
