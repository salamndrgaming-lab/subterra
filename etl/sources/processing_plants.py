"""
HIFLD Natural Gas Processing Plants.

Processing plants strip liquids (ethane / propane / butane / pentanes +)
out of raw gas before it enters interstate pipelines. The gas-handling
bottleneck of the midstream chain — a basin with limited processing
capacity flares gas at the wellhead because pipelines won't accept
un-processed product (Permian flaring is the canonical example). For
an O&G analyst, processing-plant proximity + capacity is a primary
"can my wet gas get marketed?" signal.

Source: HIFLD Open Data hosted on the geoplatform.gov AGOL org at
services.arcgis.com. ~520 plants CONUS-wide. Same ArcGIS REST pattern
as compressor_stations / critical_habitat — paginated _arcgis helper,
env-overridable URL, point-geometry filter.

Env override: SUBTERRA_PROCESSING_PLANTS_URL.

Listed in ACCEPT_BROKEN on first run since the HIFLD AGOL service
slugs periodically rotate.
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass
from pathlib import Path

from sources._arcgis import iter_features_concurrent

DEFAULT_QUERY_URL = (
    "https://services.arcgis.com/4yiQuRZ5x0jHCWPv/arcgis/rest/services/"
    "Natural_Gas_Processing_Plants/FeatureServer/0/query"
)


@dataclass
class SourceResult:
    layer_id: str
    geojson_path: Path
    feature_count: int


def _first(props: dict, *keys: str) -> object:
    for k in keys:
        for cased in (k, k.upper(), k.lower()):
            v = props.get(cased)
            if v not in (None, "", " "):
                return v
    return None


def _normalize(props: dict) -> dict:
    """HIFLD processing-plant attrs: NAME, OPERATOR, STATUS,
    CAPACITY_MMCFD (gas throughput, million cubic feet per day),
    NGL_CAPACITY_BPD (natural gas liquids, barrels per day), STATE,
    COUNTY."""
    out: dict = {}
    name = _first(props, "NAME", "PLANT_NAME", "Name")
    if name is not None:
        out["name"] = name
    operator = _first(props, "OPERATOR", "Operator", "OWNER", "COMPANY")
    if operator is not None:
        out["operator"] = operator
    status = _first(props, "STATUS", "Status")
    if status is not None:
        out["status"] = status
    capacity_mmcfd = _first(
        props,
        "CAPACITY", "CAPACITY_MMCFD", "GAS_CAPACITY", "DESIGN_CAP",
        "TOTAL_CAP", "Capacity",
    )
    if capacity_mmcfd is not None:
        try:
            out["capacity_mmcfd"] = int(float(capacity_mmcfd))
        except (TypeError, ValueError):
            pass
    ngl_bpd = _first(
        props, "NGL_CAPACITY", "NGL_CAPACITY_BPD", "NGL_BPD", "NGL_CAP",
    )
    if ngl_bpd is not None:
        try:
            out["ngl_bpd"] = int(float(ngl_bpd))
        except (TypeError, ValueError):
            pass
    state = _first(props, "STATE", "State", "ST_ABBREV")
    if state is not None:
        out["state"] = state
    county = _first(props, "COUNTY", "County", "COUNTYNAME")
    if county is not None:
        out["county"] = county
    return out


def run(work_dir: Path) -> SourceResult:
    log = logging.getLogger("etl.processing_plants")
    log.info("starting HIFLD processing plants download")

    url = os.environ.get("SUBTERRA_PROCESSING_PLANTS_URL", DEFAULT_QUERY_URL)
    log.info("source URL: %s", url)

    out_path = work_dir / "processing_plants.geojson"
    feature_count = 0
    skipped = 0
    started = time.monotonic()
    first = [True]
    per_state: dict[str, int] = {}

    try:
        with out_path.open("w", encoding="utf-8") as out:
            out.write('{"type":"FeatureCollection","features":[')

            def on_feature(feat: dict) -> None:
                nonlocal feature_count, skipped
                geom = feat.get("geometry")
                if not geom or geom.get("type") != "Point":
                    skipped += 1
                    return
                coords = geom.get("coordinates") or []
                if len(coords) < 2 or coords[0] is None or coords[1] is None:
                    skipped += 1
                    return
                props = _normalize(feat.get("properties") or {})
                if not first[0]:
                    out.write(",")
                first[0] = False
                json.dump(
                    {"type": "Feature", "geometry": geom, "properties": props}, out,
                )
                feature_count += 1
                st = str(props.get("state", "Unknown"))
                per_state[st] = per_state.get(st, 0) + 1

            iter_features_concurrent(
                url,
                on_feature=on_feature,
                workers=4,
                progress_label="processing_plants",
            )

            out.write("]}")
    except Exception:
        if out_path.exists():
            out_path.unlink()
        raise

    elapsed = time.monotonic() - started
    log.info(
        "wrote %d processing plants (skipped %d) in %.1fs (top states: %s)",
        feature_count, skipped, elapsed,
        sorted(per_state.items(), key=lambda kv: -kv[1])[:5],
    )

    return SourceResult(
        layer_id="processing_plants",
        geojson_path=out_path,
        feature_count=feature_count,
    )
