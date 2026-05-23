"""
U.S. Oil and Natural Gas Wells (HIFLD mirror via NASA NCCS).

HIFLD's public open-data portal was deactivated August 26, 2025. NASA
Center for Climate Simulation maintains a public mirror of the HIFLD
energy services at maps.nccs.nasa.gov — same data, stable URL, paginated
ArcGIS MapServer query (same pattern as sources/plss.py).

~1 million wells across CONUS. Pages of 2000 = ~500 requests, ~5-10
min runtime.

Source: https://maps.nccs.nasa.gov/mapping/rest/services/hifld_open/energy/MapServer/15
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import requests
from tqdm import tqdm

SERVICE = "https://maps.nccs.nasa.gov/mapping/rest/services/hifld_open/energy/MapServer"
LAYER_ID = 15  # oil_and_natural_gas_wells
PAGE_SIZE = 2000
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0 "
    "(Subterra-ETL +https://github.com/salamndrgaming-lab/subterra)"
)
REQUEST_TIMEOUT = 180.0


@dataclass
class SourceResult:
    layer_id: str
    geojson_path: Path
    feature_count: int


def _fetch_page(query_url: str, offset: int) -> dict[str, Any]:
    params = {
        "where": "1=1",
        "outFields": "*",
        "returnGeometry": "true",
        "outSR": "4326",
        "f": "geojson",
        "resultRecordCount": str(PAGE_SIZE),
        "resultOffset": str(offset),
        "orderByFields": "OBJECTID ASC",
    }
    resp = requests.get(
        query_url,
        params=params,
        headers={"User-Agent": USER_AGENT, "accept": "application/geo+json, application/json"},
        timeout=REQUEST_TIMEOUT,
    )
    resp.raise_for_status()
    body = resp.json()
    if isinstance(body, dict) and body.get("error"):
        raise RuntimeError(f"ArcGIS error from {query_url}: {body['error']}")
    return body


def _normalize_props(p: dict[str, Any]) -> dict[str, Any]:
    """HIFLD wells schema is broad; pluck the fields a prospector actually
    wants in the click drawer and drop the rest."""
    def first(*keys: str) -> object:
        for k in keys:
            for cased in (k, k.upper(), k.lower()):
                v = p.get(cased)
                if v not in (None, "", " ", -999):
                    return v
        return None

    out: dict[str, Any] = {}
    for label, candidates in [
        ("api", ["api", "API", "API_NUM", "API_WELL"]),
        ("name", ["NAME", "WELL_NAME", "name"]),
        ("operator", ["OPERATOR", "CURRENT_OP", "operator"]),
        ("commodity", ["TYPE", "WELL_TYPE", "PROD_TYPE", "type"]),
        ("status", ["STATUS", "WELL_STATU", "STATE", "status"]),
        ("state", ["STATE_NAME", "STATE", "ST_ABBREV"]),
        ("county", ["COUNTY", "county"]),
        ("spud_at", ["SPUD_DATE", "SPUDDATE", "SPUD_DT"]),
        ("first_prod_at", ["FIRST_PROD", "FIRSTPROD", "F_PROD_DT"]),
        ("depth_ft", ["TOTAL_DEPT", "TD", "TOTAL_DEPTH"]),
    ]:
        v = first(*candidates)
        if v is not None:
            out[label] = v
    return out


def run(work_dir: Path) -> SourceResult:
    log = logging.getLogger("etl.wells")
    log.info("starting HIFLD oil & gas wells download (NASA NCCS mirror)")

    base = os.environ.get("WELLS_SERVICE_URL", SERVICE)
    query_url = f"{base}/{LAYER_ID}/query"
    log.info("querying %s", query_url)

    out_path = work_dir / "wells.geojson"
    feature_count = 0
    skipped = 0
    offset = 0
    started = time.monotonic()
    no_progress = 0

    try:
        with out_path.open("w", encoding="utf-8") as out:
            out.write('{"type":"FeatureCollection","features":[')
            first = True
            pbar = tqdm(desc="wells", unit="feat", smoothing=0.1)
            while True:
                body = _fetch_page(query_url, offset)
                features = body.get("features", [])
                if not features:
                    break
                for feat in features:
                    geom = feat.get("geometry")
                    if not geom or geom.get("type") != "Point":
                        skipped += 1
                        continue
                    coords = geom.get("coordinates") or []
                    if len(coords) < 2 or coords[0] is None or coords[1] is None:
                        skipped += 1
                        continue
                    props = _normalize_props(feat.get("properties") or feat.get("attributes") or {})
                    if not first:
                        out.write(",")
                    first = False
                    json.dump({"type": "Feature", "geometry": geom, "properties": props}, out)
                    feature_count += 1
                pbar.update(len(features))

                exceeded = body.get("exceededTransferLimit", False)
                if not exceeded and len(features) < PAGE_SIZE:
                    break
                offset += len(features)
                if len(features) == 0:
                    no_progress += 1
                    if no_progress >= 3:
                        log.warning("no progress for 3 consecutive pages, stopping")
                        break
                else:
                    no_progress = 0
            pbar.close()
            out.write("]}")
    except Exception:
        if out_path.exists():
            out_path.unlink()
        raise

    elapsed = time.monotonic() - started
    log.info("wrote %d wells (skipped %d) in %.1fs → %s", feature_count, skipped, elapsed, out_path.name)
    return SourceResult(
        layer_id="wells",
        geojson_path=out_path,
        feature_count=feature_count,
    )
