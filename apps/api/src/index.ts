/**
 * Subterra API — Cloudflare Worker.
 *
 * Phase 0 ships the Hono router skeleton with every route returning 501
 * + a clear body explaining which phase implements it. Real routes
 * arrive incrementally — see /root/.claude/plans for the phase plan.
 */

import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

import {
  clearSessionCookie,
  consumeMagicLink,
  createSession,
  invalidateSession,
  issueMagicLink,
  loadSessionUser,
  looksLikeEmail,
  readSessionCookie,
  requireUser,
  setSessionCookie,
  upsertUser,
  type AuthedUser,
} from './auth';
import { sendMagicLinkEmail } from './email';

export interface Env {
  DB: D1Database;
  TILES: R2Bucket;
  ENVIRONMENT: string;
  AUTH_JWT_SECRET?: string;
  AUTH_RP_ID?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  SENTRY_DSN_API?: string;
}

type AppEnv = { Bindings: Env; Variables: { user: AuthedUser } };

const app = new Hono<AppEnv>();

app.use('*', logger());
// Read-only data routes (manifest + tiles + features.db) get a permissive
// wildcard CORS so PMTiles + sql.js Range requests work from every Pages
// alias and from localhost dev without origin gymnastics. Mutating /auth,
// /aois, /alerts, /billing routes get the strict origin-restricted CORS
// below (those need credentials, which requires an explicit origin).
app.use('/manifest', cors({
  origin: '*',
  allowHeaders: ['Range', 'Content-Type', 'Accept'],
  exposeHeaders: ['Content-Range', 'Content-Length', 'Accept-Ranges', 'ETag'],
  maxAge: 86400,
}));
app.use('/diff', cors({
  origin: '*',
  allowHeaders: ['Range', 'Content-Type', 'Accept'],
  exposeHeaders: ['Content-Range', 'Content-Length', 'Accept-Ranges', 'ETag'],
  maxAge: 86400,
}));
app.use('/diff/*', cors({
  origin: '*',
  allowHeaders: ['Range', 'Content-Type', 'Accept'],
  exposeHeaders: ['Content-Range', 'Content-Length', 'Accept-Ranges', 'ETag'],
  maxAge: 86400,
}));
app.use('/tiles/*', cors({
  origin: '*',
  allowHeaders: ['Range', 'Content-Type', 'Accept'],
  exposeHeaders: ['Content-Range', 'Content-Length', 'Accept-Ranges', 'ETag'],
  maxAge: 86400,
}));
app.use('/features/*', cors({
  origin: '*',
  allowHeaders: ['Range', 'Content-Type', 'Accept'],
  exposeHeaders: ['Content-Range', 'Content-Length', 'Accept-Ranges', 'ETag'],
  maxAge: 86400,
}));

// Allow localhost dev + every Pages alias subterra.pages.dev publishes
// (per-deploy hashes like 95c718a4.subterra.pages.dev, branch aliases
// like main.subterra.pages.dev, and the production root).
const PAGES_ORIGIN = /^https:\/\/([a-z0-9-]+\.)?subterra\.pages\.dev$/;
app.use('*', cors({
  origin: (origin) => {
    if (!origin) return null;
    if (origin === 'http://localhost:5173') return origin;
    return PAGES_ORIGIN.test(origin) ? origin : null;
  },
  credentials: true,
  allowHeaders: ['Range', 'Content-Type', 'Accept', 'Authorization'],
  exposeHeaders: ['Content-Range', 'Content-Length', 'Accept-Ranges', 'ETag'],
  maxAge: 86400,
}));

// ─── liveness / manifest ────────────────────────────────────────────────

app.get('/', (c) =>
  c.json({
    service: 'subterra-api',
    environment: c.env.ENVIRONMENT,
    docs: 'https://github.com/salamndrgaming-lab/subterra',
  }),
);

app.get('/health', async (c) => {
  // Try a no-op against D1 + R2 so the response reflects real binding health.
  let db: 'ok' | 'unavailable' = 'unavailable';
  let tiles: 'ok' | 'unavailable' = 'unavailable';
  try { await c.env.DB.prepare('SELECT 1').first(); db = 'ok'; } catch { /* surfaced below */ }
  try { await c.env.TILES.head('manifest.json'); tiles = 'ok'; } catch { /* surfaced below */ }
  return c.json({
    status: db === 'ok' && tiles === 'ok' ? 'ok' : 'degraded',
    components: { db, tiles },
    ts: new Date().toISOString(),
  });
});

/**
 * Tile manifest. Reads the canonical manifest.json from R2 and rewrites
 * pmtilesUrl / featuresDbUrl to point at this Worker's own /tiles + /features
 * routes, regardless of what the ETL wrote. Keeps the web app free of any
 * external-bucket DNS dependency — every URL it sees is same-origin.
 */
app.get('/manifest', async (c) => {
  const obj = await c.env.TILES.get('manifest.json');
  if (!obj) {
    return c.json(
      {
        error: 'no_manifest',
        message:
          'No tile manifest in R2 yet. Run `npm run etl:refresh` locally or wait for the next weekly ETL run.',
      },
      404,
    );
  }
  const raw = await obj.text();
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(raw);
  } catch {
    return c.json({ error: 'manifest_invalid_json' }, 502);
  }
  const origin = new URL(c.req.url).origin;
  // Defense-in-depth: only ever emit known keys. The manifest is written
  // by our own ETL, but R2 is a mutable store — if its contents were ever
  // tampered with, this whitelist guarantees /manifest can't serve
  // unexpected fields (e.g. attacker-injected strings) to the client.
  const ALLOWED_KEYS = new Set([
    'version',
    'publishedAt',
    'pmtilesUrl',
    'featuresDbUrl',
    'checksums',
    'counts',
    'topHotspots',
    'commodityPrices',
    'sources',
  ]);
  manifest = Object.fromEntries(
    Object.entries(manifest).filter(([k]) => ALLOWED_KEYS.has(k)),
  );
  // Cache-bust the pmtiles + features.db URLs with the manifest's
  // version (a unix timestamp set at ETL time). Otherwise protomaps +
  // sql.js + browsers + Cloudflare's edge can all serve the previous
  // pmtiles header from cache even after R2 has new content, leaving
  // the map showing stale data indefinitely.
  const ver = manifest.version ?? Date.now();
  manifest.pmtilesUrl = `${origin}/tiles/subterra.pmtiles?v=${ver}`;
  manifest.featuresDbUrl = `${origin}/features/subterra-features.db?v=${ver}`;
  return new Response(JSON.stringify(manifest), {
    headers: {
      'content-type': 'application/json',
      // Browsers always re-validate the manifest; we never want a stale
      // manifest pinning the map to old data after an ETL refresh.
      'cache-control': 'no-cache, must-revalidate',
    },
  });
});

/**
 * Diff payload — what changed between the prior ETL run and the current
 * one. Produced by etl/diff.py after the ETL pipeline's upload step;
 * the web app's sidebar pill polls this on load with the user's
 * last-seen version. Empty-shape response when no diff exists yet
 * (first run after this feature lands) or when the caller is already
 * caught up. Always 200 so the client doesn't need an error branch
 * to distinguish "no news" from "no diff produced yet."
 */
app.get('/diff', async (c) => {
  return serveDiff(c, 'diffs/latest.json');
});

/**
 * Permits diff — same shape as `/diff` (claims) but tracks O&G
 * drilling-permit additions/drops. Leading-indicator data: operators
 * file weeks-to-months before spud, so this surfaces movement before
 * it shows in the wells layer. Served from diffs/permits.json,
 * produced by etl/diff.py's permits SOURCES entry.
 */
app.get('/diff/permits', async (c) => {
  return serveDiff(c, 'diffs/permits.json');
});

async function serveDiff(c: Context<AppEnv>, r2Key: string): Promise<Response> {
  const sinceRaw = c.req.query('since') ?? '0';
  const since = Number.isFinite(Number(sinceRaw)) ? Number(sinceRaw) : 0;
  const obj = await c.env.TILES.get(r2Key);
  if (!obj) {
    return c.json({
      fromVersion: since,
      toVersion: since,
      added: [],
      dropped: [],
    });
  }
  let diff: { toVersion?: number; fromVersion?: number; added?: unknown; dropped?: unknown };
  try {
    diff = await obj.json();
  } catch {
    return c.json({ error: 'diff_invalid_json' }, 502);
  }
  const toVersion = Number(diff.toVersion ?? 0);
  if (since >= toVersion) {
    return c.json({
      fromVersion: since,
      toVersion,
      added: [],
      dropped: [],
    });
  }
  return new Response(JSON.stringify(diff), {
    headers: {
      'content-type': 'application/json',
      // Cache for 5 min — the diff only refreshes on a new ETL run
      // (weekly), so the edge can hold it confidently between visits.
      'cache-control': 'public, max-age=300',
    },
  });
}

/**
 * Range-aware streaming proxy for tile + feature files in R2. The PMTiles
 * library issues HTTP Range requests against the pmtiles URL; we honor
 * them by passing the Range header through to R2.get(..., { range }).
 */
type OffsetRange = { offset: number; length?: number };

async function serveR2(c: { env: Env; req: { url: string; header: (n: string) => string | undefined } }, key: string, contentType: string): Promise<Response> {
  const rangeHeader = c.req.header('range');
  let range: OffsetRange | undefined;
  if (rangeHeader) {
    const m = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
    if (m) {
      const offset = Number(m[1]);
      const end = m[2] ? Number(m[2]) : undefined;
      range = end !== undefined ? { offset, length: end - offset + 1 } : { offset };
    }
  }
  const obj = await c.env.TILES.get(key, range ? { range } : undefined);
  if (!obj) return new Response('not found', { status: 404 });
  const total = obj.size;
  const headers: Record<string, string> = {
    'content-type': contentType,
    'cache-control': 'public, max-age=300',
    'accept-ranges': 'bytes',
    etag: obj.httpEtag,
  };
  if (range) {
    const start = range.offset;
    const length = range.length ?? total - start;
    const end = start + length - 1;
    headers['content-range'] = `bytes ${start}-${end}/${total}`;
    headers['content-length'] = String(length);
    return new Response(obj.body, { status: 206, headers });
  }
  headers['content-length'] = String(total);
  return new Response(obj.body, { status: 200, headers });
}

app.get('/tiles/subterra.pmtiles', (c) =>
  serveR2(c, 'tiles/subterra.pmtiles', 'application/octet-stream'),
);
app.get('/features/subterra-features.db', (c) =>
  serveR2(c, 'features/subterra-features.db', 'application/vnd.sqlite3'),
);

// Raster tile proxy for the geophysics overlays (Bouguer gravity,
// aeromag, future radiometric). Pre-tiled by .github/workflows/rasters.yml
// (manual dispatch only) and stored in R2 under rasters/<dataset>/<z>/<x>/<y>.png.
// LayerDef.rasterTiles in the registry uses the {base}/rasters/<dataset>/{z}/{x}/{y}.png
// template; the web app substitutes {base} with this Worker's origin at
// install time, so a request lands here.
//
// Dataset + coordinate components are validated: dataset matches a
// short-name whitelist, z/x/y must be integers. Otherwise an attacker
// could probe arbitrary R2 keys via path traversal.
const RASTER_DATASETS = new Set(['gravity', 'aeromag', 'radiometric']);
app.get('/rasters/:dataset/:z/:x/:y{.+\\.png}', async (c) => {
  const dataset = c.req.param('dataset');
  const z = c.req.param('z');
  const x = c.req.param('x');
  // The :y param includes the .png suffix (regex `.+\.png`); strip it.
  const yWithExt = c.req.param('y');
  const y = yWithExt.replace(/\.png$/, '');
  if (!RASTER_DATASETS.has(dataset)) return new Response('unknown dataset', { status: 404 });
  if (!/^\d+$/.test(z) || !/^\d+$/.test(x) || !/^\d+$/.test(y)) {
    return new Response('bad tile coords', { status: 400 });
  }
  return serveR2(c, `rasters/${dataset}/${z}/${x}/${y}.png`, 'image/png');
});

// ─── routes filled in by later phases ───────────────────────────────────

const NOT_YET = (phase: string) => (c: { json: (b: unknown, s?: number) => Response }) =>
  c.json(
    {
      error: 'not_implemented',
      message: `Implemented in Phase ${phase}. See /docs/architecture.md.`,
    },
    501,
  );

// Phase 4 — email magic-link authentication.
// (Original Phase 4 design used passkeys; magic links shipped first as
// the MVP — see infra/migrations/0003_magic_links.sql for rationale.
// The passkeys table stays in 0001 so passkey routes can land later
// without a schema change.)

app.post('/auth/request', async (c) => {
  let body: { email?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'bad_request', message: 'JSON body required' }, 400);
  }
  const email = body.email;
  if (!looksLikeEmail(email)) {
    return c.json({ error: 'invalid_email' }, 400);
  }
  const token = await issueMagicLink(c.env, email);
  // Build the verify URL on the API origin. The client passes its
  // origin via the `return` query so we know where to redirect on
  // successful verify; default to the API root if absent.
  const apiOrigin = new URL(c.req.url).origin;
  const reqUrl = new URL(c.req.url);
  const returnTo = reqUrl.searchParams.get('return') ?? c.req.header('referer') ?? '';
  const verifyUrl = new URL(`${apiOrigin}/auth/verify`);
  verifyUrl.searchParams.set('token', token);
  if (returnTo) verifyUrl.searchParams.set('return', returnTo);
  try {
    await sendMagicLinkEmail(c.env, email, verifyUrl.toString());
  } catch (err) {
    console.error('[auth] magic-link send failed', err);
    return c.json({ error: 'email_send_failed' }, 502);
  }
  // Return 200 with no token-leak; the email is the only carrier of
  // the raw token. The client just shows "check your email" on 200.
  return c.json({ ok: true });
});

app.get('/auth/verify', async (c) => {
  const token = c.req.query('token');
  if (!token) {
    return c.json({ error: 'missing_token' }, 400);
  }
  const email = await consumeMagicLink(c.env, token);
  if (!email) {
    return c.json({ error: 'invalid_or_expired_token' }, 400);
  }
  const user = await upsertUser(c.env, email);
  const sessionToken = await createSession(c.env, user.id);
  setSessionCookie(c, sessionToken);
  // Redirect back to wherever the sign-in was initiated. If the
  // `return` URL isn't an allowed origin, redirect to the API root
  // (the client polls /auth/me on focus so it'll pick the user up
  // either way).
  const returnTo = c.req.query('return');
  const target = returnTo && isAllowedReturnUrl(returnTo) ? returnTo : '/';
  return c.redirect(target, 302);
});

app.post('/auth/logout', async (c) => {
  const token = readSessionCookie(c);
  if (token) {
    await invalidateSession(c.env, token);
  }
  clearSessionCookie(c);
  return c.json({ ok: true });
});

app.get('/auth/me', async (c) => {
  const token = readSessionCookie(c);
  if (!token) {
    return c.json({ user: null });
  }
  const user = await loadSessionUser(c.env, token);
  return c.json({ user });
});

/** Only allow redirects to localhost dev or any subterra.pages.dev
 *  Pages alias. Prevents open-redirect abuse via the `return` param. */
function isAllowedReturnUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.origin === 'http://localhost:5173') return true;
    return /^https:\/\/([a-z0-9-]+\.)?subterra\.pages\.dev$/.test(u.origin);
  } catch {
    return false;
  }
}

// Phase 4 — areas of interest. CRUD over the user's saved AOIs. All
// routes are gated by requireUser so the session-cookie check happens
// before any D1 query.

app.get('/aois', requireUser, async (c) => {
  const user = c.get('user');
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, notes, geometry_json, bbox_west, bbox_south,
            bbox_east, bbox_north, area_acres, created_at, updated_at
       FROM aois
      WHERE user_id = ?
      ORDER BY updated_at DESC`,
  )
    .bind(user.id)
    .all<{
      id: string;
      name: string;
      notes: string | null;
      geometry_json: string;
      bbox_west: number;
      bbox_south: number;
      bbox_east: number;
      bbox_north: number;
      area_acres: number;
      created_at: string;
      updated_at: string;
    }>();
  return c.json({
    aois: results.map((r) => ({
      id: r.id,
      name: r.name,
      notes: r.notes,
      geometry: JSON.parse(r.geometry_json),
      bbox: [r.bbox_west, r.bbox_south, r.bbox_east, r.bbox_north],
      areaAcres: r.area_acres,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
  });
});

app.post('/aois', requireUser, async (c) => {
  const user = c.get('user');
  let body: {
    name?: unknown;
    notes?: unknown;
    geometry?: unknown;
    areaAcres?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'bad_request', message: 'JSON body required' }, 400);
  }
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'Untitled AOI';
  const notes = typeof body.notes === 'string' ? body.notes : null;
  const geometry = body.geometry;
  const areaAcres = typeof body.areaAcres === 'number' && body.areaAcres > 0 ? body.areaAcres : 0;
  const bbox = computeBboxFromPolygon(geometry);
  if (!bbox) {
    return c.json({ error: 'invalid_geometry', message: 'Expected GeoJSON Polygon' }, 400);
  }
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO aois
       (id, user_id, name, notes, geometry_json,
        bbox_west, bbox_south, bbox_east, bbox_north, area_acres)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id, user.id, name, notes, JSON.stringify(geometry),
      bbox[0], bbox[1], bbox[2], bbox[3], areaAcres,
    )
    .run();
  return c.json({ id }, 201);
});

app.patch('/aois/:id', requireUser, async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  let body: { name?: unknown; notes?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'bad_request' }, 400);
  }
  const updates: string[] = [];
  const values: unknown[] = [];
  if (typeof body.name === 'string' && body.name.trim()) {
    updates.push('name = ?');
    values.push(body.name.trim());
  }
  if (typeof body.notes === 'string' || body.notes === null) {
    updates.push('notes = ?');
    values.push(body.notes);
  }
  if (updates.length === 0) {
    return c.json({ error: 'no_updates' }, 400);
  }
  updates.push("updated_at = datetime('now')");
  values.push(id, user.id);
  const result = await c.env.DB.prepare(
    `UPDATE aois SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`,
  )
    .bind(...values)
    .run();
  if (result.meta.changes === 0) {
    return c.json({ error: 'not_found' }, 404);
  }
  return c.json({ ok: true });
});

app.delete('/aois/:id', requireUser, async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const result = await c.env.DB.prepare('DELETE FROM aois WHERE id = ? AND user_id = ?')
    .bind(id, user.id)
    .run();
  if (result.meta.changes === 0) {
    return c.json({ error: 'not_found' }, 404);
  }
  return c.json({ ok: true });
});

/** Extract bbox [west, south, east, north] from a GeoJSON Polygon. */
function computeBboxFromPolygon(geom: unknown): [number, number, number, number] | null {
  if (
    !geom ||
    typeof geom !== 'object' ||
    (geom as { type?: unknown }).type !== 'Polygon'
  ) {
    return null;
  }
  const coords = (geom as { coordinates?: unknown }).coordinates;
  if (!Array.isArray(coords) || !Array.isArray(coords[0])) return null;
  const ring = coords[0];
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const pt of ring) {
    if (!Array.isArray(pt) || typeof pt[0] !== 'number' || typeof pt[1] !== 'number') {
      return null;
    }
    const lng = pt[0];
    const lat = pt[1];
    if (lng < west) west = lng;
    if (lng > east) east = lng;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  if (!Number.isFinite(west)) return null;
  return [west, south, east, north];
}

// Phase 4 — user-tracked claims (BLM maintenance-fee tracker). The
// table stores claim serials a user has marked as theirs; the client
// computes the countdown to Sept 1 (the BLM annual maintenance-fee
// deadline) from the current date.

app.get('/my-claims', requireUser, async (c) => {
  const user = c.get('user');
  const { results } = await c.env.DB.prepare(
    'SELECT id, serial, name, notes, created_at FROM tracked_claims WHERE user_id = ? ORDER BY created_at DESC',
  )
    .bind(user.id)
    .all<{ id: string; serial: string; name: string | null; notes: string | null; created_at: string }>();
  return c.json({ claims: results });
});

app.post('/my-claims', requireUser, async (c) => {
  const user = c.get('user');
  let body: { serials?: unknown; name?: unknown; notes?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'bad_request' }, 400);
  }
  // Accept either { serial } (single) or { serials: [] } (bulk paste).
  const rawSerials: string[] = [];
  if (Array.isArray(body.serials)) {
    for (const s of body.serials) if (typeof s === 'string') rawSerials.push(s);
  } else if (typeof (body as { serial?: unknown }).serial === 'string') {
    rawSerials.push((body as { serial: string }).serial);
  }
  const cleaned = Array.from(
    new Set(
      rawSerials
        .map((s) => s.trim().toUpperCase())
        .filter((s) => /^[A-Z0-9-]{4,32}$/.test(s)),
    ),
  );
  if (cleaned.length === 0) {
    return c.json({ error: 'no_valid_serials' }, 400);
  }
  const name = typeof body.name === 'string' ? body.name : null;
  const notes = typeof body.notes === 'string' ? body.notes : null;
  let added = 0;
  let skipped = 0;
  for (const serial of cleaned) {
    const id = crypto.randomUUID();
    try {
      await c.env.DB.prepare(
        'INSERT INTO tracked_claims (id, user_id, serial, name, notes) VALUES (?, ?, ?, ?, ?)',
      )
        .bind(id, user.id, serial, name, notes)
        .run();
      added += 1;
    } catch (err) {
      // UNIQUE(user_id, serial) — duplicate is the expected non-error
      // path. Anything else surfaces.
      if (String(err).includes('UNIQUE')) {
        skipped += 1;
      } else {
        console.error('[my-claims] insert failed', err);
        throw err;
      }
    }
  }
  return c.json({ added, skipped, total: cleaned.length }, 201);
});

app.delete('/my-claims/:id', requireUser, async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const result = await c.env.DB.prepare(
    'DELETE FROM tracked_claims WHERE id = ? AND user_id = ?',
  )
    .bind(id, user.id)
    .run();
  if (result.meta.changes === 0) {
    return c.json({ error: 'not_found' }, 404);
  }
  return c.json({ ok: true });
});

// Phase 5 — opportunity scoring + NoL export
app.get('/score', NOT_YET('5'));
app.post('/aois/:id/nol-packet', NOT_YET('5'));

// Phase 9 — stake-ability eligibility lookup. Full point-in-polygon
// implementation arrives with the features.db build (Phase 3+). For now
// this returns a deterministic 501 with the contract clients can code
// against, so the web Eligibility card can render a placeholder state.
app.get('/eligibility', NOT_YET('9'));

// Phase 6 — alerts
app.get('/alerts', NOT_YET('6'));
app.post('/alerts', NOT_YET('6'));
app.patch('/alerts/:id', NOT_YET('6'));
app.delete('/alerts/:id', NOT_YET('6'));

// Phase 7 — Stripe billing
app.post('/billing/checkout', NOT_YET('7'));
app.post('/billing/webhook', NOT_YET('7'));

app.notFound((c) =>
  c.json({ error: 'not_found', path: new URL(c.req.url).pathname }, 404),
);

app.onError((err, c) => {
  console.error('[api] unhandled error', err);
  return c.json({ error: 'internal_error', message: err.message }, 500);
});

export default app;
