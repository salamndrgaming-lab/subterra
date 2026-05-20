# Architecture

This is the current production blueprint. Keep it short; reference the
plan file at `/root/.claude/plans/dawg-none-of-these-silly-island.md`
for the long-form rationale.

## Core rule

**Never depend on a third-party service being up at request time.**

Every dataset is downloaded in bulk on a weekly schedule, transformed
into a single PMTiles file + a SQLite features database, and served
from a CDN. The map can't go blank because the data lives in the same
bucket the app does.

## Components

- **Web** (`apps/web`) — Vite + React 19 + MapLibre + Tailwind. Static SPA. Hosted on Cloudflare Pages.
- **API** (`apps/api`) — Cloudflare Worker + Hono + D1 SQLite. Auth, AOIs, alerts, scoring, billing.
- **Shared** (`packages/shared`) — TypeScript types, commodity / state / layer registries.
- **ETL** (`etl/`) — Python 3.12 + GeoPandas + tippecanoe. Weekly GitHub Actions cron.
- **Infra** (`infra/`) — `wrangler.toml`, `d1-schema.sql`, `stripe-products.json`.

## Data flow

```
weekly cron → ETL → tippecanoe → subterra.pmtiles + manifest.json → R2 → CDN → MapLibre
                                          ↓
                                   features.db → R2 → sql.js (in-browser) for detail panels
```

The Worker is only on the path for write paths (auth, AOI save, alert
create, Stripe webhook). Read paths skip the Worker entirely — the SPA
fetches `manifest.json` once, then reads tiles + features straight from
R2.

## Phases

- **Phase 0** (this commit) — scaffold + basemap + CI gate.
- **Phase 1** — first real ETL source (BLM Mining Claims) + tippecanoe + R2 upload + the web app paints them.
- **Phase 2** — every remaining dataset.
- **Phase 3** — features.db + click-to-detail panels.
- **Phase 4** — WebAuthn auth + AOI persistence.
- **Phase 5** — opportunity score + Notice-of-Location export.
- **Phase 6** — alerts via email.
- **Phase 7** — Stripe billing + tier gates.
- **Phase 8** — marketing site + waitlist.

Each phase is one PR. CI must be green before merge.
