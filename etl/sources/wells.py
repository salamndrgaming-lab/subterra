"""
U.S. Oil and Natural Gas Wells (HIFLD mirror via NASA NCCS).

Uses sources/_arcgis.iter_features_concurrent for parallel paginated
fetching. ~1 million wells in CONUS; sequential pagination was ~10 min,
concurrent pulls it down to ~2-3 min.

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

from sources._arcgis import iter_features_concurrent

SERVICE = "https://maps.nccs.nasa.gov/mapping/rest/services/hifld_open/energy/MapServer"
LAYER_ID = 15


@dataclass
class SourceResult:
    layer_id: str
    geojson_path: Path
    feature_count: int


def _normalize_props(p: dict[str, Any]) -> dict[str, Any]:
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

    out_path = work_dir / "wells.geojson"
    feature_count = 0
    skipped = 0
    started = time.monotonic()

    try:
        with out_path.open("w", encoding="utf-8") as out:
            out.write('{"type":"FeatureCollection","features":[')
            first = [True]

            def emit(feat: dict[str, Any]) -> None:
                nonlocal skipped
                geom = feat.get("geometry")
                if not geom or geom.get("type") != "Point":
                    skipped += 1
                    return
                coords = geom.get("coordinates") or []
                if len(coords) < 2 or coords[0] is None or coords[1] is None:
                    skipped += 1
                    return
                props = _normalize_props(feat.get("properties") or feat.get("attributes") or {})
                if not first[0]:
                    out.write(",")
                first[0] = False
                json.dump({"type": "Feature", "geometry": geom, "properties": props}, out)

            # NASA NCCS hosts a public mirror with relaxed rate limits, so
            # we can run more workers than against gis.blm.gov.
            feature_count = iter_features_concurrent(
                query_url,
                on_feature=emit,
                workers=8,
                progress_label="wells",
            )
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
