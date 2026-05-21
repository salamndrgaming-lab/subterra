/**
 * Subterra API — Cloudflare Worker.
 *
 * Phase 0 ships the Hono router skeleton with every route returning 501
 * + a clear body explaining which phase implements it. Real routes
 * arrive incrementally — see /root/.claude/plans for the phase plan.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

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

const app = new Hono<{ Bindings: Env }>();

app.use('*', logger());
app.use('*', cors({
  origin: ['http://localhost:5173', 'https://subterra.pages.dev'],
  credentials: true,
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
  manifest.pmtilesUrl = `${origin}/tiles/subterra.pmtiles`;
  manifest.featuresDbUrl = `${origin}/features/subterra-features.db`;
  return new Response(JSON.stringify(manifest), {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=60',
    },
  });
});

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

// ─── routes filled in by later phases ───────────────────────────────────

const NOT_YET = (phase: string) => (c: { json: (b: unknown, s?: number) => Response }) =>
  c.json(
    {
      error: 'not_implemented',
      message: `Implemented in Phase ${phase}. See /docs/architecture.md.`,
    },
    501,
  );

// Phase 4 — auth via WebAuthn passkeys
app.post('/auth/passkey/options', NOT_YET('4'));
app.post('/auth/passkey/verify', NOT_YET('4'));
app.post('/auth/logout', NOT_YET('4'));
app.get('/auth/me', NOT_YET('4'));

// Phase 4 — areas of interest
app.get('/aois', NOT_YET('4'));
app.post('/aois', NOT_YET('4'));
app.patch('/aois/:id', NOT_YET('4'));
app.delete('/aois/:id', NOT_YET('4'));

// Phase 5 — opportunity scoring + NoL export
app.get('/score', NOT_YET('5'));
app.post('/aois/:id/nol-packet', NOT_YET('5'));

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
