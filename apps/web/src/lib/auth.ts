/** Client-side authentication helpers — talk to the Worker's /auth/* routes.
 *
 *  All requests go to VITE_API_URL with credentials:'include' so the
 *  session cookie rides cross-origin. The Worker's CORS config already
 *  allows credentials from the Pages origins + localhost dev. */

import type { User } from '@subterra/shared';

const API_URL = (import.meta.env.VITE_API_URL ?? 'http://localhost:8787').replace(/\/$/, '');

export interface MeResponse {
  user: User | null;
}

/** Fetch the current user (or null if not signed in). */
export async function fetchMe(): Promise<User | null> {
  const res = await fetch(`${API_URL}/auth/me`, { credentials: 'include' });
  if (!res.ok) return null;
  const body = (await res.json()) as MeResponse;
  return body.user;
}

/** POST a magic-link request. The Worker emails the link; this returns
 *  ok=true even if the email address isn't registered (we don't leak
 *  user-existence signals to unauthenticated callers). */
export async function requestMagicLink(email: string): Promise<{ ok: boolean; error?: string }> {
  const ret = `${window.location.origin}/map`;
  const res = await fetch(`${API_URL}/auth/request?return=${encodeURIComponent(ret)}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (res.ok) return { ok: true };
  let error = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { error?: string; message?: string };
    error = body.message ?? body.error ?? error;
  } catch {
    // Non-JSON body — keep the status-code error.
  }
  return { ok: false, error };
}

/** Clear the session cookie + tell the Worker to invalidate it. */
export async function signOut(): Promise<void> {
  await fetch(`${API_URL}/auth/logout`, { method: 'POST', credentials: 'include' });
}
