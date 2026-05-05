# Subterra

A map-first geospatial intelligence portal that aggregates fragmented public and commercial land, mineral, oil/gas, and mining datasets into one interface.

> **Status:** Phase 1 — scaffold. Map dashboard renders BLM lands, PLSS grid, and mock wells. Data integrations and scoring engine are stubbed.

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

- **Frontend:** Next.js 14, TypeScript, TailwindCSS, Mapbox GL JS, React Query, Zustand, Recharts
- **Backend:** Node.js + Express, Prisma, PostgreSQL + PostGIS, Redis
- **Infra:** Vercel (web), Railway/Render (api + db), R2/S3 (assets)

---

## Quickstart

### 1. Prerequisites

- Node.js 20+
- PostgreSQL 15+ with PostGIS 3+
- Redis 7+
- A Mapbox public access token

### 2. Install

```bash
npm install
cp .env.example .env
# Fill in DATABASE_URL, REDIS_URL, NEXT_PUBLIC_MAPBOX_TOKEN
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

Open `http://localhost:3000/map`. The map page uses Mapbox GL JS and ships with:

- **Base layers** — dark Mapbox style + USGS topo overlay
- **Federal/BLM** surface management areas (BLM ArcGIS REST)
- **PLSS grid** (BLM Cadastral)
- **Mock wells** — clickable, opens right drawer with production chart
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

## Phases

- **Phase 1 (current)** — scaffold: layout, schema, route stubs, mock map data
- **Phase 2** — wire BLM MLRS, USGS MRDS, Texas RRC live data
- **Phase 3** — staking toolkit, opportunity scoring engine, alerts
- **Phase 4** — auth, saved projects, mobile, perf, docs

---

## License

Proprietary.
