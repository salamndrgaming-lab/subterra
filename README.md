# Subterra

Geospatial intelligence platform that turns weekly public-data downloads
(BLM mining claims, USGS MRDS, state oil & gas commission extracts, EPA
FRS, HIFLD pipelines, OSM) into a map-first app for finding stake-able
federal land and producing oil/gas opportunities.

> **Architecture rule:** never depend on a third-party service being up at
> request time. Data is downloaded in bulk, baked into static vector
> tiles + a queryable SQLite database, served from a CDN.

## Stack at a glance

- **Frontend:** Vite + React 19 + TypeScript + Tailwind + MapLibre GL JS
- **Tiles:** Protomaps `.pmtiles` (single file, range-requested over HTTPS)
- **Edge API:** Cloudflare Workers + Hono + D1 SQLite
- **Storage:** Cloudflare R2 (tiles + feature database)
- **ETL:** Python 3.12 + GeoPandas + tippecanoe, runs weekly via GitHub Actions
- **CI:** GitHub Actions — typecheck + lint + vitest + Playwright must pass before merge
- **Hosting:** Cloudflare Pages (web) + Workers (API). All free tier.

Total fixed infra cost: **$0**.

## Quickstart (local dev)

Prerequisites: Node 20+. (Python + tippecanoe are only needed to run
the ETL yourself — local dev pulls live tiles without them.)

```bash
git clone https://github.com/salamndrgaming-lab/subterra.git
cd subterra
npm install
npm run dev
```

Two dev servers boot:

- `http://localhost:5173` — Vite serving the web app
- `http://localhost:8787` — wrangler serving the Worker

That's the whole setup — no `.env.local`, no ETL run, no R2 seeding:

- **Tiles/data:** when the local Worker has no tileset (it won't,
  unless you've run the ETL), the web app falls back to the production
  API read-only and the map shows the full live dataset.
- **Database:** `npm run dev` applies pending D1 migrations to the
  local SQLite simulator before the Worker starts.
- **Sign-in emails:** without `RESEND_API_KEY` configured, the Worker
  logs the magic-link URL to the wrangler terminal instead of emailing
  it — copy that URL into your browser to finish sign-in.

Optional: create `apps/web/.env.local` with
`VITE_API_URL=<any Worker URL>` to pin the API target and bypass the
automatic resolution in `apps/web/src/lib/api-base.ts`.

## Production deploy

CI handles it. Push to `main`, `.github/workflows/deploy.yml` runs:

```
wrangler pages deploy apps/web/dist     # static SPA → Cloudflare Pages
wrangler deploy --config apps/api/wrangler.toml   # API → Cloudflare Workers
wrangler d1 migrations apply             # only if migrations/*.sql changed
```

## Weekly ETL refresh

GitHub Actions cron job at `Sun 02:00 UTC` (`.github/workflows/etl.yml`)
downloads every bulk dataset, builds a single `subterra.pmtiles` + a
SQLite `subterra-features.db`, and uploads both to R2 with a bumped
version number. The web app reads `manifest.json` to discover the
latest version on next load.

## Project layout

```
apps/web/        Vite SPA — React + MapLibre + Tailwind
apps/api/        Cloudflare Worker — Hono, D1, JWT auth
packages/shared/ TypeScript types + commodity/state constants
etl/             Python: bulk download → GeoJSON → PMTiles + SQLite
infra/           wrangler.toml, d1-schema.sql, stripe-products.json
tests/unit/      Vitest unit tests
tests/e2e/       Playwright end-to-end tests
docs/            Architecture + filing-a-mining-claim guide
.github/workflows/ CI, deploy, ETL cron
```

## Manual setup you need to do once

See `docs/setup.md` for the ~30-minute one-time Cloudflare + Stripe +
Resend account walkthrough. After that, everything is automated by CI.

## Filing a real mining claim

If Subterra surfaces an open BLM cell you want to stake, see
`docs/filing-a-claim.md` for the step-by-step BLM Notice-of-Location
process. The app generates the filing packet PDF for you.

## License

Proprietary.
