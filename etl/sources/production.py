"""
Per-well monthly production — the decline-curve prerequisite.

Production (oil bbl / gas mcf / water bbl per well per month) is the
backbone of every O&G valuation. It is NOT a map layer — it's tabular
time-series keyed by well API — so it doesn't go through tippecanoe or
the SOURCES list. This module writes `work/production.csv`, which
etl/build_features.py loads into the features.db `production` table; the
well-detail drawer then renders a sparkline + cumulative and fits an
Arps decline curve.

State regulators publish production as **bulk CSV/zip downloads**, not
queryable APIs (Colorado ECMC ships annual "Production Data" CSVs from
1999 on; Oklahoma OCC + Texas RRC have their own bulk files). So this is
a bulk-file ingester: download each configured URL (plain .csv or a .zip
wrapping one), stream-parse rows into the canonical
(api, period, oil, gas, water, days) shape, and write one CSV.

INERT BY DESIGN: no committed default URL. Set a comma-separated list of
bulk-production URLs on SUBTERRA_PRODUCTION_URL (e.g. a couple of recent
Colorado annual-production CSVs) and the next ETL run ingests them. The
legacy SUBTERRA_PRODUCTION_CO_URL / _ND_URL are also honored. With none
set, this writes nothing and the well drawer omits the sparkline. See
docs/data-sources-setup.md for where each state's file lives.
"""

from __future__ import annotations

import csv
import io
import logging
import os
import re
import time
import zipfile
from pathlib import Path
from typing import Iterable, Iterator

import requests

USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0 "
    "(Subterra-ETL +https://github.com/salamndrgaming-lab/subterra)"
)
REQUEST_TIMEOUT = 900.0

# Safety cap so a full multi-year state file can't blow up features.db /
# memory. Rows beyond this are dropped (logged). ~8M well-months covers
# several recent years of a big state.
MAX_ROWS = 8_000_000

# Canonical column → candidate source names (case-insensitive).
_COLS: dict[str, tuple[str, ...]] = {
    "api": ("api", "api14", "api_14", "api_no", "api_number", "apinumber", "well_api"),
    "period": ("first_of_month", "report_date", "prod_date", "period", "date", "month", "rpt_date"),
    "oil": ("oil_prod", "oil", "oil_bbl", "prod_oil", "oilprod", "oil_volume"),
    "gas": ("gas_prod", "gas", "gas_mcf", "prod_gas", "gasprod", "gas_volume"),
    "water": ("water_prod", "water", "water_bbl", "prod_water", "waterprod", "water_volume"),
    "days": ("prod_days", "days", "days_prod", "producing_days", "daysprod"),
}


def _pick(row: dict, keys: tuple[str, ...]) -> str | None:
    for k in keys:
        for cased in (k, k.upper(), k.lower()):
            v = row.get(cased)
            if v not in (None, "", " "):
                return str(v)
    return None


def _norm_period(raw: str | None) -> str | None:
    """Normalize a date-ish cell to YYYY-MM. Accepts 2024-12-01,
    12/1/2024, 202412, etc."""
    if not raw:
        return None
    s = raw.strip()
    m = re.match(r"^(\d{4})[-/](\d{1,2})", s)  # 2024-12-... / 2024/12
    if m:
        return f"{m.group(1)}-{int(m.group(2)):02d}"
    m = re.match(r"^(\d{1,2})[-/]\d{1,2}[-/](\d{4})", s)  # 12/1/2024
    if m:
        return f"{m.group(2)}-{int(m.group(1)):02d}"
    m = re.match(r"^(\d{4})(\d{2})$", s)  # 202412
    if m:
        return f"{m.group(1)}-{m.group(2)}"
    return None


def _api_from_row(row: dict) -> str | None:
    """Direct API column, else build one from the Colorado-style
    county+seq pair (state prefix 05 for CO)."""
    direct = _pick(row, _COLS["api"])
    if direct:
        return direct.strip()
    county = _pick(row, ("api_county_code", "API_COUNTY_CODE", "county_code"))
    seq = _pick(row, ("api_seq_num", "API_SEQ_NUM", "seq_num"))
    if county and seq:
        try:
            return f"05{int(county):03d}{int(seq):05d}"
        except ValueError:
            return None
    return None


def _parse_row(row: dict) -> tuple[str, str, str, str, str, str] | None:
    """Row dict → (api, period, oil, gas, water, days) or None if it lacks
    an API + period. Exposed for testing."""
    api = _api_from_row(row)
    period = _norm_period(_pick(row, _COLS["period"]))
    if not api or not period:
        return None
    return (
        api,
        period,
        _pick(row, _COLS["oil"]) or "",
        _pick(row, _COLS["gas"]) or "",
        _pick(row, _COLS["water"]) or "",
        _pick(row, _COLS["days"]) or "",
    )


def _iter_csv_rows(url: str, log: logging.Logger) -> Iterator[dict]:
    """Download a .csv or .zip(.csv) and yield row dicts. Streams the CSV
    so a multi-hundred-MB file doesn't have to fit in memory at once."""
    log.info("downloading production file: %s", url)
    resp = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=REQUEST_TIMEOUT)
    resp.raise_for_status()
    content = resp.content
    if content[:4] == b"PK\x03\x04" or url.lower().endswith(".zip"):
        with zipfile.ZipFile(io.BytesIO(content)) as zf:
            members = [n for n in zf.namelist() if n.lower().endswith(".csv")]
            if not members:
                raise RuntimeError(f"zip {url} has no .csv")
            with zf.open(members[0]) as fh:
                text = io.TextIOWrapper(fh, encoding="utf-8", errors="replace")
                yield from csv.DictReader(text)
    else:
        text = io.StringIO(content.decode("utf-8", errors="replace"))
        yield from csv.DictReader(text)


def _urls() -> Iterable[str]:
    """Comma-separated bulk-production URLs. Honors the generic
    SUBTERRA_PRODUCTION_URL plus the legacy per-state names."""
    raw = ",".join(
        v
        for v in (
            os.environ.get("SUBTERRA_PRODUCTION_URL", ""),
            os.environ.get("SUBTERRA_PRODUCTION_CO_URL", ""),
            os.environ.get("SUBTERRA_PRODUCTION_ND_URL", ""),
        )
        if v
    )
    return [u.strip() for u in raw.split(",") if u.strip()]


def build_production_csv(work_dir: Path) -> int:
    """Ingest the configured bulk-production files into
    work/production.csv. Returns row count. Never raises — logs + returns
    what it wrote (production is additive to the tileset)."""
    log = logging.getLogger("etl.production")
    urls = list(_urls())
    out_path = work_dir / "production.csv"
    if not urls:
        log.info("no SUBTERRA_PRODUCTION*_URL configured — skipping production")
        return 0

    total = 0
    started = time.monotonic()
    truncated = False
    with out_path.open("w", encoding="utf-8", newline="") as out:
        writer = csv.writer(out)
        writer.writerow(["well_api", "period", "oil_bbl", "gas_mcf", "water_bbl", "days"])
        for url in urls:
            if truncated:
                break
            n = 0
            logged_keys = False
            try:
                for row in _iter_csv_rows(url, log):
                    if not logged_keys:
                        log.info("production columns: %s", list(row.keys())[:20])
                        logged_keys = True
                    parsed = _parse_row(row)
                    if parsed is None:
                        continue
                    writer.writerow(parsed)
                    n += 1
                    total += 1
                    if total >= MAX_ROWS:
                        log.warning("hit MAX_ROWS=%d — truncating production ingest", MAX_ROWS)
                        truncated = True
                        break
                log.info("  %s → %d rows", url, n)
            except Exception as err:  # noqa: BLE001
                log.warning("  production URL failed — %s: %s", type(err).__name__, err)
                print(f"::warning::production failed: {err} [url={url}]")
                continue

    elapsed = time.monotonic() - started
    log.info("wrote %d production rows in %.1fs → %s", total, elapsed, out_path.name)
    return total
