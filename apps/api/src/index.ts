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
 * Tile manifest pass-through. The web app calls /manifest to discover
 * the current pmtiles + features.db version. This proxies the canonical
 * manifest.json file from R2 so the URL the web app uses is stable even
 * when we rotate R2 buckets or move to a different storage backend.
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
  const body = await obj.text();
  return new Response(body, {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=60',
    },
  });
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
  // eslint-disable-next-line no-console
  console.error('[api] unhandled error', err);
  return c.json({ error: 'internal_error', message: err.message }, 500);
});

export default app;
