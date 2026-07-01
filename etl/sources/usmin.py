"""
USGS USMIN — Mineral Deposit Database (2020+).

Successor to MRDS. Smaller record count (~80k vs MRDS's ~310k) but
better-vetted: every entry has been reviewed against modern commodity
codes, deposit-type classifications, and source references. Where MRDS
is "every mineral occurrence ever recorded," USMIN is "every mineral
occurrence with a peer-reviewed source."

Source: https://mrdata.usgs.gov/usmin/
Bulk:   https://mrdata.usgs.gov/usmin/usmin-csv.zip (canonical URL pattern;
        mirrors the MRDS bulk-download convention)

Ship side-by-side with MRDS — users toggle each independently. Once
coverage parity is confirmed in a couple of regions, MRDS gets dropped
from the default-visible set (kept toggleable for legacy compatibility).

Env override: USMIN_URL.
"""

from __future__ import annotations

import csv
import io
import json
import logging
import os
import time
import zipfile
from dataclasses import dataclass
from pathlib import Path

import requests
from tqdm import tqdm

# USGS mrdata uses the path pattern /<slug>/<slug>-csv.zip (the working
# MRDS source uses mrds/mrds-csv.zip). USMIN's Mineral Deposit Database
# is published under the `deposit` slug (mrdata.usgs.gov/deposit/) —
# search-confirmed 2026-06-30 — NOT `usmin`, which is why the previous
# usmin/usmin-csv.zip URL 404'd (ETL ×). Try the deposit slug first,
# then the legacy usmin slug as a fallback. Override via USMIN_URL.
CANDIDATE_URLS = [
    "https://mrdata.usgs.gov/deposit/deposit-csv.zip",
    "https://mrdata.usgs.gov/usmin/usmin-csv.zip",
]
PRIMARY_URL = CANDIDATE_URLS[0]
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0 "
    "(Subterra-ETL +https://github.com/salamndrgaming-lab/subterra)"
)
REQUEST_TIMEOUT = 300.0


@dataclass
class SourceResult:
    layer_id: str
    geojson_path: Path
    feature_count: int


def _download(url: str, dest: Path, log: logging.Logger) -> None:
    log.info("downloading %s", url)
    resp = requests.get(
        url, headers={"User-Agent": USER_AGENT}, stream=True, timeout=REQUEST_TIMEOUT,
    )
    resp.raise_for_status()
    total = int(resp.headers.get("content-length", 0)) or None
    with dest.open("wb") as f, tqdm(total=total, unit="B", unit_scale=True, desc="usmin zip") as pbar:
        for chunk in resp.iter_content(chunk_size=1 << 16):
            if chunk:
                f.write(chunk)
                pbar.update(len(chunk))


def _find_csv_in_zip(zip_path: Path) -> str:
    """Pick the first .csv that looks like the USMIN export (has a site
    identifier + lat/lng columns). USMIN's column set tracks MRDS-style
    naming so the heuristic carries over."""
    with zipfile.ZipFile(zip_path) as zf:
        candidates = [n for n in zf.namelist() if n.lower().endswith(".csv")]
        for name in candidates:
            with zf.open(name) as f:
                head = f.read(1024).decode("utf-8", errors="ignore").lower()
                if any(k in head for k in ("site_id", "deposit_id", "usmin_id", "latitude")):
                    return name
        if candidates:
            return candidates[0]
    raise RuntimeError(f"No CSV found inside {zip_path.name}")


def _coalesce(row: dict[str, str], *names: str) -> str:
    for n in names:
        v = row.get(n) or row.get(n.upper()) or row.get(n.lower())
        if v and v.strip():
            return v.strip()
    return ""


def _to_float(v: str) -> float | None:
    if not v:
        return None
    try:
        return float(v)
    except ValueError:
        return None


def run(work_dir: Path) -> SourceResult:
    log = logging.getLogger("etl.usmin")
    log.info("starting USGS USMIN bulk download")

    # Env override wins; otherwise try each candidate slug until one
    # downloads a zip that actually contains a CSV. A 404 on the first
    # slug falls through to the next instead of failing the source.
    env_url = os.environ.get("USMIN_URL")
    urls = [env_url] if env_url else list(CANDIDATE_URLS)
    zip_path = work_dir / "usmin.zip"
    csv_name = None
    last_err: Exception | None = None
    for candidate in urls:
        try:
            if zip_path.exists():
                zip_path.unlink()
            _download(candidate, zip_path, log)
            csv_name = _find_csv_in_zip(zip_path)
            log.info("using USMIN source %s", candidate)
            break
        except Exception as err:  # noqa: BLE001
            last_err = err
            log.warning("USMIN candidate failed (%s): %s", candidate, err)
            continue
    if csv_name is None:
        raise RuntimeError(f"all USMIN candidate URLs failed — last: {last_err}")
    log.info("reading %s from archive", csv_name)

    out_path = work_dir / "usmin.geojson"
    feature_count = 0
    skipped = 0
    started = time.monotonic()
    per_commodity: dict[str, int] = {}

    with zipfile.ZipFile(zip_path) as zf, zf.open(csv_name) as raw:
        text = io.TextIOWrapper(raw, encoding="utf-8-sig", newline="")
        reader = csv.DictReader(text)
        with out_path.open("w", encoding="utf-8") as out:
            out.write('{"type":"FeatureCollection","features":[')
            first = True

            for row in tqdm(reader, desc="usmin rows", unit="row", smoothing=0.1):
                lat = _to_float(_coalesce(row, "latitude", "lat", "y_coord"))
                lng = _to_float(_coalesce(row, "longitude", "long", "lng", "x_coord"))
                if lat is None or lng is None or abs(lat) > 90 or abs(lng) > 180:
                    skipped += 1
                    continue
                # USMIN field set tracks MRDS but uses cleaner names:
                #   site_id (was dep_id), site_name (was site_name),
                #   commodities_main (was commod1), dep_type (was dep_type),
                #   dev_stat (was dev_stat), src_ref (citation).
                props = {
                    "usmin_id": _coalesce(row, "site_id", "usmin_id", "deposit_id"),
                    "name": _coalesce(row, "site_name", "name", "deposit_name"),
                    "state": _coalesce(row, "state", "stateabbr"),
                    "county": _coalesce(row, "county"),
                    "commodity": _coalesce(row, "commodities_main", "commodities", "commod1", "commodity"),
                    "deposit_type": _coalesce(row, "dep_type", "deposit_type", "model"),
                    "development_status": _coalesce(row, "dev_stat", "development_status"),
                    "discovery_year": _coalesce(row, "disc_yr", "discovery_year"),
                    "src_ref": _coalesce(row, "src_ref", "source", "reference"),
                }
                # Strip empties so the tile features stay compact.
                props = {k: v for k, v in props.items() if v}
                if not first:
                    out.write(",")
                first = False
                json.dump(
                    {
                        "type": "Feature",
                        "geometry": {"type": "Point", "coordinates": [lng, lat]},
                        "properties": props,
                    },
                    out,
                )
                feature_count += 1
                c = props.get("commodity", "(unknown)")
                per_commodity[c] = per_commodity.get(c, 0) + 1

            out.write("]}")

    elapsed = time.monotonic() - started
    log.info(
        "wrote %d USMIN features (skipped %d invalid coords) in %.1fs",
        feature_count, skipped, elapsed,
    )
    top = sorted(per_commodity.items(), key=lambda kv: -kv[1])[:10]
    log.info("top commodities: %s", top)

    return SourceResult(layer_id="usmin", geojson_path=out_path, feature_count=feature_count)
