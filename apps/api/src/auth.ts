/**
 * Authentication helpers — token generation, session lookup, cookie
 * utilities, and a `requireUser` middleware.
 *
 * Magic-link flow:
 *   1. POST /auth/request {email}  → issueMagicLink + sendMagicLinkEmail
 *   2. GET  /auth/verify?token=… → consumeMagicLink → upsertUser →
 *      createSession + setSessionCookie → redirect to ?return=
 *   3. GET  /auth/me              → readSessionCookie + loadSessionUser
 *   4. POST /auth/logout          → invalidateSession + clearSessionCookie
 *
 * Tokens (magic + session) are 32 random bytes base64url-encoded. The
 * raw token is sent to the client (email body / cookie); D1 only ever
 * holds the SHA-256 hex digest. Single-use magic links, 30-day sessions.
 */

import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

import type { Env } from './index';

// Cookie helpers accept any Hono context — the route handlers add a
// Variables slot for the authed user, and the typed App context that
// wraps them is incompatible with the narrower `Context<{Bindings:Env}>`
// shape. We don't read Variables here anyway; only the request/response.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyContext = Context<any, any, any>;

export const SESSION_COOKIE = 'subterra_session';
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
export const MAGIC_LINK_TTL_SECONDS = 60 * 15; // 15 minutes

export interface AuthedUser {
  id: string;
  email: string;
  displayName: string | null;
  tier: 'free' | 'prospector' | 'operator' | 'enterprise';
  createdAt: string;
}

// ─── token generation ──────────────────────────────────────────────────

/** 32 random bytes → base64url string. Used for both magic links and
 *  session tokens. The cookie / email link carries this raw value;
 *  D1 stores only the SHA-256 hex digest. */
export function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64urlEncode(bytes);
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function base64urlEncode(bytes: Uint8Array): string {
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ─── magic links ───────────────────────────────────────────────────────

/** Issue a magic-link token for `email`. Returns the raw token (only
 *  ever leaves the server inside the email body). Stores the SHA-256
 *  digest in D1 with a 15-min expiry. */
export async function issueMagicLink(env: Env, email: string): Promise<string> {
  const token = generateToken();
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_SECONDS * 1000).toISOString();
  await env.DB.prepare(
    'INSERT INTO magic_links (token_hash, email, expires_at) VALUES (?, ?, ?)',
  )
    .bind(tokenHash, email.toLowerCase(), expiresAt)
    .run();
  return token;
}

/** Verify and consume a magic-link token. Returns the email it was
 *  issued for, or null if the token is invalid / expired / already used. */
export async function consumeMagicLink(env: Env, token: string): Promise<string | null> {
  const tokenHash = await sha256Hex(token);
  const now = new Date().toISOString();
  const row = await env.DB.prepare(
    'SELECT email, expires_at, consumed_at FROM magic_links WHERE token_hash = ?',
  )
    .bind(tokenHash)
    .first<{ email: string; expires_at: string; consumed_at: string | null }>();
  if (!row) return null;
  if (row.consumed_at) return null;
  if (row.expires_at < now) return null;
  await env.DB.prepare('UPDATE magic_links SET consumed_at = ? WHERE token_hash = ?')
    .bind(now, tokenHash)
    .run();
  return row.email;
}

// ─── users + sessions ──────────────────────────────────────────────────

/** Create a user if no row matches `email`; otherwise return the
 *  existing user. Email is stored lower-cased. */
export async function upsertUser(env: Env, email: string): Promise<AuthedUser> {
  const lower = email.toLowerCase();
  const existing = await env.DB.prepare(
    'SELECT id, email, display_name, tier, created_at FROM users WHERE email = ?',
  )
    .bind(lower)
    .first<{
      id: string;
      email: string;
      display_name: string | null;
      tier: AuthedUser['tier'];
      created_at: string;
    }>();
  if (existing) {
    return {
      id: existing.id,
      email: existing.email,
      displayName: existing.display_name,
      tier: existing.tier,
      createdAt: existing.created_at,
    };
  }
  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO users (id, email) VALUES (?, ?)',
  )
    .bind(id, lower)
    .run();
  return {
    id,
    email: lower,
    displayName: null,
    tier: 'free',
    createdAt: new Date().toISOString(),
  };
}

/** Create a session for `userId` and return the raw cookie token. The
 *  hashed token is what's stored in sessions.id. */
export async function createSession(env: Env, userId: string): Promise<string> {
  const token = generateToken();
  const sessionId = await sha256Hex(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  await env.DB.prepare(
    'INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)',
  )
    .bind(sessionId, userId, expiresAt)
    .run();
  return token;
}

/** Look up the user for a raw session token. Returns null if the
 *  session doesn't exist or has expired. */
export async function loadSessionUser(
  env: Env,
  rawToken: string,
): Promise<AuthedUser | null> {
  const sessionId = await sha256Hex(rawToken);
  const now = new Date().toISOString();
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.display_name, u.tier, u.created_at, s.expires_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = ?`,
  )
    .bind(sessionId)
    .first<{
      id: string;
      email: string;
      display_name: string | null;
      tier: AuthedUser['tier'];
      created_at: string;
      expires_at: string;
    }>();
  if (!row) return null;
  if (row.expires_at < now) return null;
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    tier: row.tier,
    createdAt: row.created_at,
  };
}

export async function invalidateSession(env: Env, rawToken: string): Promise<void> {
  const sessionId = await sha256Hex(rawToken);
  await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
}

// ─── cookie helpers ────────────────────────────────────────────────────

/** Set the session cookie. SameSite=None because the web app and API
 *  live on different origins (pages.dev ↔ workers.dev) and the cookie
 *  needs to ride cross-origin fetch credentials. Secure is required
 *  for SameSite=None and is fine in localhost dev (browsers treat
 *  localhost as secure). */
export function setSessionCookie(c: AnyContext, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'None',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
}

export function clearSessionCookie(c: AnyContext): void {
  deleteCookie(c, SESSION_COOKIE, {
    path: '/',
    secure: true,
    sameSite: 'None',
  });
}

export function readSessionCookie(c: AnyContext): string | undefined {
  return getCookie(c, SESSION_COOKIE);
}

// ─── middleware ────────────────────────────────────────────────────────

/** Hono middleware: load the user from the session cookie and attach
 *  it to the context. Returns 401 if no valid session. Use for
 *  protected routes (AOIs, alerts, billing, /me). */
export async function requireUser(
  c: Context<{ Bindings: Env; Variables: { user: AuthedUser } }>,
  next: () => Promise<void>,
): Promise<Response | void> {
  const token = readSessionCookie(c);
  if (!token) {
    return c.json({ error: 'unauthenticated' }, 401);
  }
  const user = await loadSessionUser(c.env, token);
  if (!user) {
    return c.json({ error: 'unauthenticated' }, 401);
  }
  c.set('user', user);
  await next();
}

/** Basic email validation. Worker has no `email-validator` dep; this
 *  RFC-5322-ish check rejects whitespace, bare hostnames, and empty
 *  fields, which is enough to gatekeep magic-link issuance. */
export function looksLikeEmail(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const trimmed = s.trim();
  if (trimmed.length < 5 || trimmed.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
}
