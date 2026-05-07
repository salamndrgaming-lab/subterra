# Subterra

A map-first geospatial intelligence portal that aggregates fragmented public and commercial land, mineral, oil/gas, and mining datasets into one interface.

> **Status:** Live. Real data only — every layer, detail page, search result, and opportunity score is sourced from BLM, USGS, and state oil/gas commission public endpoints. No mock or synthetic data anywhere in the codebase.

---

## Architecture

```
subterra/
├── apps/
│   ├── web/           Next.js 14 frontend (App Router, TS strict, Tailwind)
│   └── api/           Node.js + Express backend (REST, Prisma)
├── packages/
│   └── shared/        Shared types and constants
├── scripts/
│   └── etl/           Data ingestion jobs (BLM, USGS, state oil/gas)
├── db/
│   └── schema.sql     PostgreSQL + PostGIS schema
└── package.json       npm workspaces root
```

**Stack**

- **Frontend:** Next.js 14, TypeScript, TailwindCSS, MapLibre GL JS (no token, no caps), React Query, Zustand, Recharts
- **Backend:** Node.js + Express, Prisma, PostgreSQL + PostGIS, Redis
- **Infra:** Vercel (web), Railway/Render (api + db), R2/S3 (assets)
- **Basemap:** OpenFreeMap dark vector tiles by default — free, no API key, no usage caps. Drop in any MapLibre style URL via `NEXT_PUBLIC_MAP_STYLE_URL` (Protomaps for fully self-hosted, Esri Dark Gray, etc.).

---

## Quickstart

### 1. Prerequisites

- Node.js 20+
- PostgreSQL 15+ with PostGIS 3+
- Redis 7+

No Mapbox account, no Mapbox token, no usage caps. The map renders MapLibre GL
JS against OpenFreeMap's free vector tile servers by default. To go fully
self-hosted, point `NEXT_PUBLIC_MAP_STYLE_URL` at your own Protomaps PMTiles
service or any MapLibre-compatible style.

### 2. Install

```bash
npm install
cp .env.example .env
cp apps/web/.env.example apps/web/.env.local
# Fill in DATABASE_URL and REDIS_URL. The default basemap works as-is.
```

### 3. Database

```bash
createdb subterra
psql subterra -c "CREATE EXTENSION IF NOT EXISTS postgis;"
npm run db:migrate
npm run db:seed
```

### 4. Run

```bash
npm run dev
# web   → http://localhost:3000
# api   → http://localhost:4000
```

---

## Map dashboard

Open `http://localhost:3000/map`. The map page uses MapLibre GL JS and ships with:

- **Base layers** — OpenFreeMap dark vector tiles + USGS topo overlay
- **Federal/BLM** surface management areas (BLM ArcGIS REST)
- **PLSS grid** (BLM Cadastral)
- **Wells** — live ND/CO/WY state-commission FeatureServers; click opens right drawer with real production chart (when ingested)
- **Layer toggles** in the left sidebar
- **Bottom data panel** with the result table for currently visible features
- **AOI bbox draw** tool for selection

---

## Data sources (Phase 2 wiring)

| Source | Endpoint |
|---|---|
| BLM Surface Mgmt | `https://gis.blm.gov/arcgis/rest/services/lands/BLM_Natl_SMA_LimitedScale/MapServer` |
| BLM PLSS | `https://gis.blm.gov/arcgis/rest/services/Cadastral/BLM_Natl_PLSS_CadNSDI/MapServer` |
| USGS Topo | `https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer` |
| BLM MLRS Mining Claims | `https://reports.blm.gov/reports/MLRS` |
| USGS MRDS | `https://mrdata.usgs.gov/mrds/` |
| Texas RRC | `https://www.rrc.texas.gov/` |
| North Dakota NDIC | `https://www.dmr.nd.gov/oilgas/` |
| Colorado ECMC | `https://ecmc.state.co.us/data2.html` |

---

## Scripts

```bash
npm run dev              # web + api in parallel
npm run build            # build everything
npm run typecheck        # strict TS check both apps
npm run lint             # eslint
npm run db:migrate       # apply schema.sql
npm run etl              # run all ETL jobs
```

Individual ETL jobs (run from repo root):

```bash
npx tsx scripts/etl/ingest-blm-claims.ts
npx tsx scripts/etl/ingest-wells.ts
npx tsx scripts/etl/ingest-usgs-mrds.ts
npx tsx scripts/etl/refresh-production.ts
npx tsx scripts/etl/score-parcels.ts
```

---

## Data sourcing principles

1. **Real data only, always and forever.** Every feature on the map and every value
   on a detail page is fetched live from a public endpoint, queried out of
   PostGIS after ETL from a public endpoint, or computed deterministically from
   user-supplied inputs (e.g. the NPV calculator). The codebase contains no
   mock, fixture, or synthetic data.
2. **Source attribution surfaces in the API response.** Every layer/detail
   endpoint includes a `meta.sources` (or `source`) field naming the upstream.
3. **Gaps are surfaced, not hidden.** When an upstream source is unreachable
   or hasn't been ingested yet, responses include `meta.unavailable` with the
   list of missing sources. The frontend shows that gap to users — it never
   substitutes synthetic data.

## Phases

- **Phase 1** — scaffold + live wiring of BLM SMA/PLSS rasters, BLM National
  Mining Claims FeatureServer, USGS MRDS WFS, ND/CO/WY oil & gas wells.
- **Phase 2** — county parcel ingest (Regrid + assessor extracts), state
  production CSV refresh jobs, BLM ePlanning permits.
- **Phase 3** — staking toolkit polish, alert delivery (email/SMS/webhook),
  saved projects UI.
- **Phase 4** — TX/NM/OK well coverage as agencies publish spatial endpoints,
  mobile, perf, docs.

---

## License

Proprietary.
