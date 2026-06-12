"""
USGS National Geochemical Database — sediment samples.

NGDB sediment is published by mrdata.usgs.gov as a bulk CSV zip — same
distribution pattern as MRDS. The previous incarnation of this module
chased a shapefile inside the same archive, which silently emitted an
empty layer because the zip only contains CSV. We read the CSV
directly, identical to `mrds.py`.

We aggressively filter at parse time:
  - keep only WEST_BBOX samples (CONUS-west prospecting target)
  - keep only samples with at least one element value above its
    "useful for the pathfinder color ramp" threshold

That keeps the in-tile output tractable while preserving every actual
anomaly signal. Carrier features without anomalies just become noise
on a map of ~1.5M points.

Source: https://mrdata.usgs.gov/ngdb/sediment/
Bulk:   https://mrdata.usgs.gov/ngdb/sediment/ngdbsed-csv.zip
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
from typing import Any

import requests
from tqdm import tqdm

PRIMARY_URL = "https://mrdata.usgs.gov/ngdb/sediment/ngdbsed-csv.zip"
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0 "
    "(Subterra-ETL +https://github.com/salamndrgaming-lab/subterra)"
)
REQUEST_TIMEOUT = 1800.0

# Western-US prospecting target. Anything outside is dropped at parse time.
WEST_BBOX = (-125.0, 31.0, -100.0, 49.5)

# Candidate column-name lists per pathfinder element. NGDB column naming
# is inconsistent across vintages — some use AU_PPB_INAA, some AU_PPB_FA,
# some plain AU_PPB. Try them in priority order.
ELEMENT_COLUMN_CANDIDATES: dict[str, list[str]] = {
    "au_ppb": ["AU_PPB", "AU_PPB_INAA", "AU_PPB_ICP", "AU_PPB_FA", "AU_PPB_FIRE"],
    "ag_ppm": ["AG_PPM", "AG_PPM_ICP40", "AG_PPM_INAA"],
    "cu_ppm": ["CU_PPM", "CU_PPM_ICP40", "CU_PPM_INAA"],
    "pb_ppm": ["PB_PPM", "PB_PPM_ICP40", "PB_PPM_INAA"],
    "zn_ppm": ["ZN_PPM", "ZN_PPM_ICP40", "ZN_PPM_INAA"],
    "li_ppm": ["LI_PPM", "LI_PPM_ICP40"],
    "mo_ppm": ["MO_PPM", "MO_PPM_ICP40", "MO_PPM_INAA"],
    "as_ppm": ["AS_PPM", "AS_PPM_ICP40", "AS_PPM_INAA"],
    "u_ppm": ["U_PPM", "U_PPM_INAA"],
    "ree_ppm": ["LA_PPM", "CE_PPM", "LA_PPM_INAA", "CE_PPM_INAA"],
}

# "Worth keeping" threshold per element — at least one value above this
# qualifies a sample for inclusion. Looser than the hotspot anomaly
# threshold so users still see surrounding context.
KEEP_THRESHOLDS = {
    "au_ppb": 5.0, "ag_ppm": 0.5, "cu_ppm": 30.0, "pb_ppm": 30.0,
    "zn_ppm": 80.0, "li_ppm": 20.0, "mo_ppm": 2.0, "as_ppm": 10.0,
    "u_ppm": 2.0, "ree_ppm": 50.0,
}


@dataclass
class SourceResult:
    layer_id: str
    geojson_path: Path
    feature_count: int


def _download(url: str, dest: Path, log: logging.Logger) -> None:
    log.info("downloading %s", url)
    resp = requests.get(
        url,
        headers={"User-Agent": USER_AGENT, "accept": "application/zip, */*"},
        stream=True,
        timeout=REQUEST_TIMEOUT,
    )
    resp.raise_for_status()
    total = int(resp.headers.get("content-length", 0)) or None
    with dest.open("wb") as f, tqdm(total=total, unit="B", unit_scale=True, desc="ngdb zip") as pbar:
        for chunk in resp.iter_content(chunk_size=1 << 16):
            if chunk:
                f.write(chunk)
                pbar.update(len(chunk))


def _find_csv_in_zip(zip_path: Path, log: logging.Logger) -> str:
    """Pick the CSV whose header looks like NGDB sediment data. The bundle
    sometimes contains lookup tables (laboratories, methods) alongside the
    main sample file; we want the one with coordinates + element columns."""
    with zipfile.ZipFile(zip_path) as zf:
        candidates = [n for n in zf.namelist() if n.lower().endswith(".csv")]
        log.info("zip contains %d CSV file(s): %s", len(candidates), candidates[:5])
        scored: list[tuple[int, str]] = []
        for name in candidates:
            with zf.open(name) as f:
                head = f.read(2048).decode("utf-8", errors="ignore").lower()
            score = 0
            if "latitude" in head or "lat_dd" in head or "lat_wgs" in head:
                score += 4
            if "longitude" in head or "lon_dd" in head or "long_dd" in head:
                score += 4
            if any(t in head for t in ("au_ppb", "ag_ppm", "as_ppm", "cu_ppm")):
                score += 3
            scored.append((score, name))
        scored.sort(reverse=True)
        if scored and scored[0][0] > 0:
            return scored[0][1]
        if candidates:
            log.warning("no CSV scored as NGDB sediment; falling back to %s", candidates[0])
            return candidates[0]
    raise RuntimeError(f"no CSV found inside {zip_path.name}")


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
        f = float(v)
    except ValueError:
        return None
    # NGDB uses negative sentinels for below-detection-limit.
    return f if f >= 0 else None


def _pick_element(row: dict[str, str], candidates: list[str]) -> float | None:
    for col in candidates:
        for cased in (col, col.upper(), col.lower()):
            v = row.get(cased)
            if v is None:
                continue
            n = _to_float(v)
            if n is not None:
                return n
    return None


def run(work_dir: Path) -> SourceResult:
    log = logging.getLogger("etl.geochemistry")
    log.info("starting NGDB sediment bulk download")
    started = time.monotonic()

    url = os.environ.get("NGDB_URL", PRIMARY_URL)
    zip_path = work_dir / "ngdbsed.zip"
    if not zip_path.exists() or zip_path.stat().st_size < 1_000_000:
        _download(url, zip_path, log)
    else:
        log.info(
            "reusing cached %s (%.1f MB)",
            zip_path.name, zip_path.stat().st_size / 1e6,
        )

    csv_name = _find_csv_in_zip(zip_path, log)
    log.info("reading %s from archive", csv_name)

    out_path = work_dir / "geochemistry.geojson"
    total = 0
    kept = 0
    out_of_bbox = 0
    no_anomaly = 0
    bad_coords = 0

    with zipfile.ZipFile(zip_path) as zf, zf.open(csv_name) as raw:
        text = io.TextIOWrapper(raw, encoding="utf-8-sig", newline="")
        reader = csv.DictReader(text)
        with out_path.open("w", encoding="utf-8") as out:
            out.write('{"type":"FeatureCollection","features":[')
            first = True
            for row in tqdm(reader, desc="ngdb rows", unit="row", smoothing=0.1):
                total += 1
                lat = _to_float(_coalesce(row, "latitude", "lat", "lat_dd", "lat_wgs84"))
                lng = _to_float(_coalesce(row, "longitude", "long", "lng", "lon_dd", "long_dd", "lon_wgs84"))
                if lat is None or lng is None or abs(lat) > 90 or abs(lng) > 180:
                    bad_coords += 1
                    continue
                if not (WEST_BBOX[0] <= lng <= WEST_BBOX[2]
                        and WEST_BBOX[1] <= lat <= WEST_BBOX[3]):
                    out_of_bbox += 1
                    continue

                props: dict[str, Any] = {"medium": "sediment"}
                any_above = False
                for out_key, candidates in ELEMENT_COLUMN_CANDIDATES.items():
                    v = _pick_element(row, candidates)
                    if v is not None:
                        props[out_key] = v
                        if v >= KEEP_THRESHOLDS.get(out_key, float("inf")):
                            any_above = True
                if not any_above:
                    no_anomaly += 1
                    continue

                sid = _coalesce(row, "lab_id", "sample_id", "sampleid", "id")
                if sid:
                    props["sample_id"] = sid

                if not first:
                    out.write(",")
                first = False
                json.dump({
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [lng, lat]},
                    "properties": props,
                }, out)
                kept += 1
            out.write("]}")

    elapsed = time.monotonic() - started
    log.info(
        "wrote %d / %d samples (out_of_bbox=%d, no_anomaly=%d, bad_coords=%d) in %.1fs",
        kept, total, out_of_bbox, no_anomaly, bad_coords, elapsed,
    )
    return SourceResult(
        layer_id="geochemistry",
        geojson_path=out_path,
        feature_count=kept,
    )
