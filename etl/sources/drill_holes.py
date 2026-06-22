"""
USGS NURE drill holes — National Uranium Resource Evaluation database.

The Carter-era NURE program (1973–1984) drilled tens of thousands of
holes nationwide to assay for uranium, thorium, and a long pathfinder
suite (As, Sb, Ag, Au, Cu, Pb, Zn, Mo, etc.). The geographic coverage
is the best-bulk-published national drillhole archive: a single CSV
gives every collar location + assay results + the source publication.

Modern industry drillholes (post-1990 mineral-exploration, O&G, geothermal)
are scattered across per-state state-survey APIs with inconsistent
schemas — those become follow-up state-by-state PRs. NURE ships first
because (a) one canonical URL, (b) one bulk CSV, (c) MRDS-style
clean schema we already know how to parse.

Source: https://mrdata.usgs.gov/nure/
Bulk:   https://mrdata.usgs.gov/nure/nure-csv.zip
        (canonical mrdata.usgs.gov/<ds>/<ds>-csv.zip pattern; same as
        MRDS / USMIN / CMMI bulk downloads.)

Output: drill_holes.geojson with collar points + bulk assay attributes.
Renders on the main map as drill-collar dots, and in the cross-section
as vertical drill sticks (depth bar at each collar projected onto the
section line).

Env override: NURE_URL.
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

PRIMARY_URL = "https://mrdata.usgs.gov/nure/nure-csv.zip"
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0 "
    "(Subterra-ETL +https://github.com/salamndrgaming-lab/subterra)"
)
REQUEST_TIMEOUT = 600.0


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
    with dest.open("wb") as f, tqdm(total=total, unit="B", unit_scale=True, desc="nure zip") as pbar:
        for chunk in resp.iter_content(chunk_size=1 << 16):
            if chunk:
                f.write(chunk)
                pbar.update(len(chunk))


def _find_csv_in_zip(zip_path: Path) -> str:
    """NURE bulk ships a single big CSV — pick the .csv with lat/lng cols."""
    with zipfile.ZipFile(zip_path) as zf:
        candidates = [n for n in zf.namelist() if n.lower().endswith(".csv")]
        for name in candidates:
            with zf.open(name) as f:
                head = f.read(2048).decode("utf-8", errors="ignore").lower()
                if "latitude" in head or "lat_dd" in head:
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
    log = logging.getLogger("etl.drill_holes")
    log.info("starting USGS NURE drillhole bulk download")

    url = os.environ.get("NURE_URL") or PRIMARY_URL
    zip_path = work_dir / "nure.zip"
    if not zip_path.exists():
        _download(url, zip_path, log)
    else:
        log.info("reusing cached %s (%.1f MB)", zip_path.name, zip_path.stat().st_size / 1e6)

    csv_name = _find_csv_in_zip(zip_path)
    log.info("reading %s from archive", csv_name)

    out_path = work_dir / "drill_holes.geojson"
    feature_count = 0
    skipped = 0
    started = time.monotonic()
    per_state: dict[str, int] = {}

    with zipfile.ZipFile(zip_path) as zf, zf.open(csv_name) as raw:
        text = io.TextIOWrapper(raw, encoding="utf-8-sig", newline="")
        reader = csv.DictReader(text)
        with out_path.open("w", encoding="utf-8") as out:
            out.write('{"type":"FeatureCollection","features":[')
            first = True

            for row in tqdm(reader, desc="nure rows", unit="row", smoothing=0.1):
                lat = _to_float(_coalesce(row, "latitude", "lat", "lat_dd", "y_coord"))
                lng = _to_float(_coalesce(row, "longitude", "long", "lng", "long_dd", "x_coord"))
                if lat is None or lng is None or abs(lat) > 90 or abs(lng) > 180:
                    skipped += 1
                    continue
                # NURE-specific schema: holes are uranium-targeted, but the
                # assay panel also captures the standard pathfinder suite.
                # Surface depth + primary U assay; downstream cross-section
                # render uses depth_ft to size the drill stick.
                u_ppm = _coalesce(row, "u_ppm", "uranium_ppm", "u")
                depth_ft = _coalesce(row, "depth_ft", "depth", "td_ft", "total_depth")
                props = {
                    "nure_id": _coalesce(row, "site_id", "nure_id", "id"),
                    "name": _coalesce(row, "site_name", "name", "hole_name"),
                    "state": _coalesce(row, "state", "state_abbr", "stateabbr"),
                    "county": _coalesce(row, "county"),
                    "year": _coalesce(row, "year_drilled", "year", "yr"),
                    "depth_ft": depth_ft,
                    "u_ppm": u_ppm,
                    "primary_commodity": "Uranium",
                    "operator": _coalesce(row, "operator", "company", "contractor"),
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
                st = props.get("state", "?")
                per_state[st] = per_state.get(st, 0) + 1

            out.write("]}")

    elapsed = time.monotonic() - started
    log.info(
        "wrote %d NURE drill holes (skipped %d invalid coords) in %.1fs",
        feature_count, skipped, elapsed,
    )
    top = sorted(per_state.items(), key=lambda kv: -kv[1])[:10]
    log.info("top states by hole count: %s", top)

    return SourceResult(
        layer_id="drill_holes", geojson_path=out_path, feature_count=feature_count,
    )
