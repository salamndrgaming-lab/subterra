"""
USGS Critical Minerals Mapping Initiative (CMMI) — occurrence database.

Dedicated layer for the ~50 critical-mineral commodities the US has
declared strategic: REE, Li, Co, Ni, Ga, Ge, In, Sc, Ta, V, W, Te, plus
a handful more. Smaller dataset than MRDS or USMIN (~10k occurrences)
but every one is vetted for critical-mineral relevance — perfect
signal-to-noise for the lithium / rare-earth / cobalt prospector who
doesn't want to dig through 300k industrial-mineral records.

Source: https://mrdata.usgs.gov/critical-minerals/
Bulk:   https://mrdata.usgs.gov/critical-minerals/critical-minerals-csv.zip
        (canonical URL pattern matching MRDS / USMIN bulk-download
        convention; override via CMMI_URL if it drifts)

Rendered as a distinct map layer with a magenta/violet palette so
critical-mineral hits visually pop against the gray/amber MRDS +
USMIN dot field.

Env override: CMMI_URL.
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

PRIMARY_URL = "https://mrdata.usgs.gov/critical-minerals/critical-minerals-csv.zip"
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
    with dest.open("wb") as f, tqdm(total=total, unit="B", unit_scale=True, desc="cmmi zip") as pbar:
        for chunk in resp.iter_content(chunk_size=1 << 16):
            if chunk:
                f.write(chunk)
                pbar.update(len(chunk))


def _find_csv_in_zip(zip_path: Path) -> str:
    with zipfile.ZipFile(zip_path) as zf:
        candidates = [n for n in zf.namelist() if n.lower().endswith(".csv")]
        for name in candidates:
            with zf.open(name) as f:
                head = f.read(1024).decode("utf-8", errors="ignore").lower()
                if any(k in head for k in ("critical", "rare_earth", "commodity", "latitude")):
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
    log = logging.getLogger("etl.cmmi")
    log.info("starting USGS Critical Minerals Mapping Initiative download")

    url = os.environ.get("CMMI_URL") or PRIMARY_URL
    zip_path = work_dir / "cmmi.zip"
    if not zip_path.exists():
        _download(url, zip_path, log)
    else:
        log.info("reusing cached %s (%.1f MB)", zip_path.name, zip_path.stat().st_size / 1e6)

    csv_name = _find_csv_in_zip(zip_path)
    log.info("reading %s from archive", csv_name)

    out_path = work_dir / "cmmi.geojson"
    feature_count = 0
    skipped = 0
    started = time.monotonic()
    per_critical: dict[str, int] = {}

    with zipfile.ZipFile(zip_path) as zf, zf.open(csv_name) as raw:
        text = io.TextIOWrapper(raw, encoding="utf-8-sig", newline="")
        reader = csv.DictReader(text)
        with out_path.open("w", encoding="utf-8") as out:
            out.write('{"type":"FeatureCollection","features":[')
            first = True

            for row in tqdm(reader, desc="cmmi rows", unit="row", smoothing=0.1):
                lat = _to_float(_coalesce(row, "latitude", "lat", "y_coord"))
                lng = _to_float(_coalesce(row, "longitude", "long", "lng", "x_coord"))
                if lat is None or lng is None or abs(lat) > 90 or abs(lng) > 180:
                    skipped += 1
                    continue
                # CMMI's distinctive column is `critical_minerals` — the
                # comma-joined list of critical commodities at the site.
                # Surface it as the primary commodity field; fall back to
                # MRDS-style `commodity` for older vintages.
                props = {
                    "cmmi_id": _coalesce(row, "site_id", "cmmi_id", "deposit_id"),
                    "name": _coalesce(row, "site_name", "name", "deposit_name"),
                    "state": _coalesce(row, "state", "stateabbr"),
                    "county": _coalesce(row, "county"),
                    "critical_minerals": _coalesce(row, "critical_minerals", "critical_mins", "commodities"),
                    "commodity": _coalesce(row, "commodities_main", "commodity", "commod1"),
                    "deposit_type": _coalesce(row, "dep_type", "deposit_type", "model"),
                    "development_status": _coalesce(row, "dev_stat", "development_status"),
                    "src_ref": _coalesce(row, "src_ref", "source", "reference"),
                }
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
                # Bucket counts by the first critical mineral named
                # (CMMI rows often list 2-4 critical commodities at one site).
                primary = props.get("critical_minerals", props.get("commodity", "(unknown)")).split(",")[0].strip()
                per_critical[primary] = per_critical.get(primary, 0) + 1

            out.write("]}")

    elapsed = time.monotonic() - started
    log.info(
        "wrote %d CMMI features (skipped %d invalid coords) in %.1fs",
        feature_count, skipped, elapsed,
    )
    top = sorted(per_critical.items(), key=lambda kv: -kv[1])[:10]
    log.info("top critical-mineral commodities: %s", top)

    return SourceResult(layer_id="cmmi", geojson_path=out_path, feature_count=feature_count)
