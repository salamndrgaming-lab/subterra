"""
USGS Mineral Resources Data System (MRDS).

USGS publishes the entire MRDS database — ~310,000 mineral occurrence
points covering every U.S. state — as a single CSV bulk download. The
URL has been stable since 2011, no auth required, no rate limit. This
makes it the ideal Phase 1 dataset: one HTTP request, no pagination
games, no agency reorgs to chase.

Source: https://mrdata.usgs.gov/mrds/
Bulk:   https://mrdata.usgs.gov/mrds/mrds-csv.zip
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

PRIMARY_URL = "https://mrdata.usgs.gov/mrds/mrds-csv.zip"
USER_AGENT = "Subterra-ETL/0.1 (+https://github.com/salamndrgaming-lab/subterra)"
REQUEST_TIMEOUT = 120.0  # bulk download, allow up to 2 min


@dataclass
class SourceResult:
    layer_id: str
    geojson_path: Path
    feature_count: int


def _download(url: str, dest: Path) -> None:
    log = logging.getLogger("etl.mrds")
    log.info("downloading %s", url)
    resp = requests.get(
        url,
        headers={"User-Agent": USER_AGENT},
        stream=True,
        timeout=REQUEST_TIMEOUT,
    )
    resp.raise_for_status()
    total = int(resp.headers.get("content-length", 0)) or None
    with dest.open("wb") as f, tqdm(total=total, unit="B", unit_scale=True, desc="mrds zip") as pbar:
        for chunk in resp.iter_content(chunk_size=1 << 16):
            if chunk:
                f.write(chunk)
                pbar.update(len(chunk))


def _find_csv_in_zip(zip_path: Path) -> str:
    """USGS sometimes nests the CSV inside an extra folder; find the first
    .csv that looks like the MRDS export (has dep_id + latitude columns)."""
    with zipfile.ZipFile(zip_path) as zf:
        candidates = [n for n in zf.namelist() if n.lower().endswith(".csv")]
        for name in candidates:
            with zf.open(name) as f:
                head = f.read(1024).decode("utf-8", errors="ignore").lower()
                if "dep_id" in head or "latitude" in head:
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
    log = logging.getLogger("etl.mrds")
    log.info("starting MRDS bulk download")

    url = os.environ.get("MRDS_URL", PRIMARY_URL)
    zip_path = work_dir / "mrds.zip"
    if not zip_path.exists():
        _download(url, zip_path)
    else:
        log.info("reusing cached %s (%.1f MB)", zip_path.name, zip_path.stat().st_size / 1e6)

    csv_name = _find_csv_in_zip(zip_path)
    log.info("reading %s from archive", csv_name)

    out_path = work_dir / "mrds.geojson"
    feature_count = 0
    skipped = 0
    started = time.monotonic()

    with zipfile.ZipFile(zip_path) as zf, zf.open(csv_name) as raw:
        # MRDS CSV has Windows line endings + UTF-8 BOM.
        text = io.TextIOWrapper(raw, encoding="utf-8-sig", newline="")
        reader = csv.DictReader(text)
        with out_path.open("w", encoding="utf-8") as out:
            out.write('{"type":"FeatureCollection","features":[')
            first = True

            for row in tqdm(reader, desc="mrds rows", unit="row", smoothing=0.1):
                lat = _to_float(_coalesce(row, "latitude", "lat"))
                lng = _to_float(_coalesce(row, "longitude", "long", "lng"))
                if lat is None or lng is None or abs(lat) > 90 or abs(lng) > 180:
                    skipped += 1
                    continue
                props = {
                    "mrds_id": _coalesce(row, "dep_id", "mrds_id"),
                    "name": _coalesce(row, "site_name", "name"),
                    "state": _coalesce(row, "state"),
                    "county": _coalesce(row, "county"),
                    "commodity": _coalesce(row, "commod1", "commodity"),
                    "deposit_type": _coalesce(row, "dep_type", "model", "type"),
                    "development_status": _coalesce(row, "dev_stat"),
                    "discovery_year": _coalesce(row, "disc_yr", "discovery_year"),
                }
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

            out.write("]}")

    elapsed = time.monotonic() - started
    log.info(
        "wrote %d features (skipped %d invalid coords) in %.1fs → %s",
        feature_count, skipped, elapsed, out_path.name,
    )

    return SourceResult(
        layer_id="mrds",  # matches tilesetLayer in shared/layers.ts
        geojson_path=out_path,
        feature_count=feature_count,
    )
