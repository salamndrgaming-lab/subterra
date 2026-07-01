"""
Per-well monthly production — the decline-curve prerequisite.

Production (oil bbl / gas mcf / water bbl per well per month) is the
backbone of every O&G valuation. It is NOT a map layer — it's tabular
time-series keyed by well API — so it doesn't go through tippecanoe or
the SOURCES list. Instead this module writes `work/production.csv`,
which etl/build_features.py loads into the features.db `production`
table; the well-detail drawer then renders a sparkline + cumulative,
and (future) an Arps decline fit.

State regulators publish production as large ArcGIS **tables** (no
geometry) or bulk CSVs. Unlike the map sources, a production table is
queried attributes-only (f=json, returnGeometry=false), so this module
has its own lightweight paginator rather than reusing the geojson
`_arcgis` helper.

INERT BY DESIGN: there is no committed default URL (same policy as the
raster GeoTIFFs). Production endpoints are per-state, large, and their
field names vary; committing a guess would add a broken source. Set
`SUBTERRA_PRODUCTION_<STATE>_URL` (currently CO) to a verified ArcGIS
table query endpoint and the next ETL run picks it up. With no URL set,
this writes nothing and the production table stays empty — the well
drawer simply omits the sparkline.

Field mapping is best-effort + diagnostic: the first record's attribute
keys are logged so the CSV column mapping can be tuned to whatever the
configured endpoint actually returns.
"""

from __future__ import annotations

import csv
import logging
import os
import time
from pathlib import Path

import requests

USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0 "
    "(Subterra-ETL +https://github.com/salamndrgaming-lab/subterra)"
)

# Per-state production endpoints. No committed defaults — set the repo
# variable to a verified ArcGIS table /query URL to activate a state.
STATE_ENV_VARS: dict[str, str] = {
    "CO": "SUBTERRA_PRODUCTION_CO_URL",
    "ND": "SUBTERRA_PRODUCTION_ND_URL",
}

# Candidate source-field names → our canonical CSV columns. Best-effort;
# the first record's keys are logged so this can be tuned per endpoint.
_FIELD_CANDIDATES: dict[str, tuple[str, ...]] = {
    "well_api": ("api", "api_num", "api_no", "api_label", "well_api", "api10", "api14", "API"),
    "period": ("period", "report_period", "prod_date", "date", "month", "rpt_date"),
    "oil_bbl": ("oil", "oil_bbl", "oil_prod", "oil_volume", "prod_oil"),
    "gas_mcf": ("gas", "gas_mcf", "gas_prod", "gas_volume", "prod_gas"),
    "water_bbl": ("water", "water_bbl", "water_prod", "water_volume", "prod_water"),
    "days": ("days", "days_prod", "prod_days", "producing_days"),
}


def _pick(attrs: dict, keys: tuple[str, ...]) -> object:
    for k in keys:
        for cased in (k, k.upper(), k.lower()):
            v = attrs.get(cased)
            if v not in (None, "", " "):
                return v
    return None


def _iter_table(url: str, log: logging.Logger, page_size: int = 2000):
    """Paginate an ArcGIS table query (attributes only). Yields attribute
    dicts. Stops when a page returns fewer than page_size records."""
    offset = 0
    first_logged = False
    while True:
        resp = requests.get(
            url,
            params={
                "where": "1=1",
                "outFields": "*",
                "returnGeometry": "false",
                "f": "json",
                "resultRecordCount": str(page_size),
                "resultOffset": str(offset),
                "orderByFields": "OBJECTID ASC",
            },
            headers={"User-Agent": USER_AGENT, "accept": "application/json"},
            timeout=180.0,
        )
        resp.raise_for_status()
        body = resp.json()
        if isinstance(body, dict) and body.get("error"):
            raise RuntimeError(f"ArcGIS error (offset={offset}): {body['error']}")
        feats = body.get("features") or []
        if not feats:
            break
        if not first_logged:
            sample = list((feats[0].get("attributes") or {}).keys())[:25]
            log.info("production first-record attribute keys: %s", sample)
            first_logged = True
        for feat in feats:
            yield feat.get("attributes") or {}
        if len(feats) < page_size:
            break
        offset += page_size


def build_production_csv(work_dir: Path) -> int:
    """Fetch configured states' production into work/production.csv.
    Returns row count. Never raises — logs + returns 0 on any failure so
    the ETL is unaffected (production is additive to the tileset)."""
    log = logging.getLogger("etl.production")
    active = [(st, os.environ.get(env, "").strip()) for st, env in STATE_ENV_VARS.items()]
    active = [(st, url) for st, url in active if url]
    out_path = work_dir / "production.csv"
    if not active:
        log.info("no SUBTERRA_PRODUCTION_*_URL configured — skipping production")
        return 0

    total = 0
    started = time.monotonic()
    try:
        with out_path.open("w", encoding="utf-8", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(["well_api", "period", "oil_bbl", "gas_mcf", "water_bbl", "days"])
            for state, url in active:
                q = url.rstrip("/")
                if not q.endswith("/query"):
                    q = f"{q}/query"
                log.info("fetching %s production: %s", state, q)
                n = 0
                try:
                    for attrs in _iter_table(q, log):
                        api = _pick(attrs, _FIELD_CANDIDATES["well_api"])
                        period = _pick(attrs, _FIELD_CANDIDATES["period"])
                        if not api or not period:
                            continue
                        writer.writerow(
                            [
                                api,
                                period,
                                _pick(attrs, _FIELD_CANDIDATES["oil_bbl"]) or "",
                                _pick(attrs, _FIELD_CANDIDATES["gas_mcf"]) or "",
                                _pick(attrs, _FIELD_CANDIDATES["water_bbl"]) or "",
                                _pick(attrs, _FIELD_CANDIDATES["days"]) or "",
                            ]
                        )
                        n += 1
                    log.info("  %s: %d production records", state, n)
                    total += n
                except Exception as err:  # noqa: BLE001
                    log.warning("  %s production FAILED — %s: %s", state, type(err).__name__, err)
                    print(f"::warning::production {state} failed: {err} [url={q}]")
                    continue
    except Exception as exc:  # noqa: BLE001
        log.warning("production build failed: %s", exc)
        if out_path.exists():
            out_path.unlink()
        return 0

    elapsed = time.monotonic() - started
    log.info("wrote %d production records in %.1fs → %s", total, elapsed, out_path.name)
    return total
