# Fixing / overriding data sources (no code change)

Every ETL source has a **repo-variable override** for its upstream URL.
When a government endpoint changes its slug, moves, or a layer we shipped
points at the wrong place, you can fix it in ~2 minutes by setting a
GitHub **repository variable** — no code edit, no PR. The next ETL run
picks it up.

This doc lists, per broken/overridable source: the **variable name**,
**exactly what to paste**, **where to find it**, and **how to confirm
it's the right URL before you paste it.**

---

## How to set a repo variable (one-time, 30 seconds)

1. GitHub → the `subterra` repo → **Settings**
2. Left sidebar → **Secrets and variables** → **Actions**
3. **Variables** tab (NOT Secrets) → **New repository variable**
4. **Name** = the variable from the table below (e.g. `SUBTERRA_SAGE_GROUSE_URL`)
5. **Value** = the URL you validated (see each source below)
6. Save. Then **Actions → pipeline → Run workflow** (optionally put the
   source name in the `only` box for a fast ~2-min verification run that
   skips the tile build).

> Secrets vs Variables: these are **Variables** (non-sensitive URLs).
> The only true *Secret* is `EIA_API_KEY` (for live WTI/Henry Hub prices).

---

## How to find + validate an ArcGIS REST URL (applies to most sources)

Most of these are **Esri ArcGIS REST** services. What you paste is the
**layer query endpoint**, which always ends in:

```
.../FeatureServer/<layerNumber>/query      ← or ...
.../MapServer/<layerNumber>/query
```

To find and confirm one:

1. Open the agency's ArcGIS site (links per-source below). You want the
   **REST services directory** page for the dataset — a URL that looks
   like `https://<host>/arcgis/rest/services/<folder>/<Service>/FeatureServer`.
2. On that page you'll see numbered **Layers** (e.g. `0 - Priority Habitat`).
   Pick the one whose name + **Geometry Type** matches what we need
   (Polygon for boundaries, Point for facilities/wells).
3. **Validate it returns data** — paste this in a browser (swap in the
   service + layer number):
   ```
   https://<host>/.../FeatureServer/0/query?where=1=1&returnCountOnly=true&f=json
   ```
   A healthy layer returns `{"count": 12345}` with a non-zero count.
   If you get `{"error": ... "Token Required"}` the layer is auth-gated —
   find a public one instead.
4. The value you paste into the repo variable is that URL **through
   `/query`** (you can drop the `?where=...` part — the ETL adds its own).
   Example: `https://services5.arcgis.com/HDRa0B57OVrv2E1q/arcgis/rest/services/Natural_Gas_Compressor_Stations/FeatureServer/0/query`

The ETL is tolerant: it appends `/query` if you forget it, and per-source
failures never crash the run.

---

## Broken sources — what each needs

### Stake-ability blockers

| Variable | Geometry | Where to find it |
|---|---|---|
| `SUBTERRA_WITHDRAWALS_URL` | Polygon | BLM EGIS Hub → search **"withdrawal"** / **"mineral segregation"**. Want a **national** layer, not a single state. Try `blm-egis.maps.arcgis.com` or `gis.blm.gov/arcgis/rest/services/lands/`. |
| `SUBTERRA_CRITICAL_HABITAT_URL` | Polygon | USFWS ECOS. Current default (`services.arcgis.com/QVENGdaPbd4LUkLV/.../USFWS_Critical_Habitat/FeatureServer`) returns empty — open that FeatureServer and pick the **polygon** layer index that has a non-zero count (there are separate line/polygon layers). |
| `SUBTERRA_SAGE_GROUSE_URL` | Polygon | BLM EGIS Hub → search **"Greater Sage-Grouse Habitat Management"**. Want the **national** PHMA/GHMA layer. State layers (OR/ID/CO) exist but only cover one state. |
| `SUBTERRA_ROADLESS_URL` | Polygon | USFS EDW: `apps.fs.usda.gov/arcx/rest/services/EDW` → find the **Roadless Area** service (the `_01` suffix in our default may be wrong; browse the EDW list for the current one). Validate count > 0. |

### Subsurface / geology

| Variable | What to paste | Where to find it |
|---|---|---|
| `USMIN_URL` | mrdata **CSV zip** URL | `mrdata.usgs.gov/deposit/` → download → CSV. Already defaulted to `deposit/deposit-csv.zip` (fixed). Only set this if that 404s. |
| `CMMI_URL` | CSV zip URL | `mrdata.usgs.gov` critical-minerals, or a USGS ScienceBase CSV. No clean mrdata CSV confirmed — may need a ScienceBase data-release download link. |
| `NURE_URL` | CSV zip URL | ⚠️ **Design note:** NURE HSSR is stream-sediment + water **geochemistry**, not drill holes — see `mrdata.usgs.gov/nure/sediment/`. The "Drill Holes" layer needs a real drill-hole dataset (state well/bore DBs), not NURE. Flag for redesign rather than a URL swap. |
| `NGDB_URL` | CSV zip URL | `mrdata.usgs.gov/geochem/` (NGDB sediment). URL is likely fine — "empty" is our 2-CSV join logic, not the URL. |
| `SUBTERRA_SGMC_DIRECT_URL` | Direct **.gdb.zip** download URL | ScienceBase item `5888bf4fe4b05ccb964bab9d` → Attached Files → the geodatabase `.zip`. (Or set `SUBTERRA_SGMC_ITEM_ID` to a different ScienceBase item id.) "empty" is the geodatabase download/enumeration, so a direct .zip link is the reliable fix. |

### Oil & Gas

| Variable | Geometry | Where to find it |
|---|---|---|
| `SUBTERRA_PIPELINES_NATGAS_URL` | Line | HIFLD natural-gas pipelines FeatureServer `/query`. Try the HIFLD org `services5.arcgis.com/HDRa0B57OVrv2E1q` or search "HIFLD natural gas pipelines FeatureServer". |
| `SUBTERRA_PIPELINES_CRUDE_URL` | Line | HIFLD crude/petroleum pipelines FeatureServer `/query`. |
| `SUBTERRA_PERMITS_ND_URL` | Point | ND DMR **public** (non-token) permits layer. The vector-tile service is token-gated (`499 Token Required`) — find the public NorthSTAR/DMR permits FeatureServer. |
| `SUBTERRA_PERMITS_CO_URL` | Point | CO ECMC. Our default used layer **1** of `OGCC_Oil_and_Gas_Locations` → `400 Invalid Layer ID`. Open that FeatureServer, find the permits/locations layer's real index, paste `.../FeatureServer/<realIndex>/query`. |
| `SUBTERRA_WELLS_TX_URL` | Point | TX RRC. Current HCTX mirror loads only ~12.8k (a subset). For statewide TX, find the full RRC wells FeatureServer (RRC GIS Viewer services or a complete mirror). |
| `SUBTERRA_PRODUCTION_CO_URL` | Table (no geometry) | **Per-well monthly production** → features.db `production` table → the well-detail sparkline. Point at a state ArcGIS **table** `/query` endpoint that returns rows of (API, month, oil, gas, water, days) — e.g. CO ECMC production. Inert until set (no default). Field names are auto-mapped best-effort; the first record's keys are logged so mapping can be tuned. `SUBTERRA_PRODUCTION_ND_URL` also wired. |

### Already fixed (override only if they regress)

`SUBTERRA_COMPRESSOR_STATIONS_URL`, `SUBTERRA_PROCESSING_PLANTS_URL`,
`SUBTERRA_REFINERIES_URL` — now point at the confirmed HIFLD org
(`services5.arcgis.com/HDRa0B57OVrv2E1q`).

---

## Fastest path for you

The four **stake-blocker polygons** (withdrawals, critical-habitat,
sage-grouse, roadless) are the highest-value + most-findable — they're
all public BLM/USFS/USFWS ArcGIS FeatureServers. Find each one's
`/FeatureServer/<n>/query`, validate the count, paste into the matching
variable, and run the pipeline with
`only: withdrawals,critical_habitat,sage_grouse,roadless_areas` for a
2-minute confirm. That alone clears 4 of the red badges.

Paste the URLs here in chat and I'll validate the shape + wire anything
that needs a code-level tweak (e.g. a per-layer filter).
