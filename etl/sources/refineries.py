"""
HIFLD Petroleum Refineries.

Refineries are the demand-side end of the crude-oil takeaway chain.
Refinery proximity + capacity + accepted crude slate (sweet / sour /
heavy) determines basis differentials at the wellhead — a basin
trapped far from a refinery that takes its crude type sells at a
discount (the WCS-vs-WTI heavy-sour example is the canonical case).
For an O&G analyst evaluating a play, refinery proximity + accepted
slate is a direct dollar-per-barrel signal.

Source: HIFLD Open Data hosted on the geoplatform.gov AGOL org at
services.arcgis.com. ~140 refineries CONUS-wide. Smallest of the
midstream-pack trio (compressor stations + processing plants +
refineries) but the most economically dense per feature — every
refinery represents 50-500 kbpd of crude demand.

Env override: SUBTERRA_REFINERIES_URL.

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
    "Petroleum_Refineries/FeatureServer/0/query"
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
    """HIFLD refinery attrs: SITE_NAME / NAME (refinery name),
    OPERATOR (refining company), CAPACITY_BPD (crude throughput,
    barrels per day), STATE, COUNTY, TYPE (atmospheric / vacuum /
    coker / cracker)."""
    out: dict = {}
    name = _first(props, "SITE_NAME", "NAME", "REFINERY_NAME", "Name")
    if name is not None:
        out["name"] = name
    operator = _first(props, "OPERATOR", "Operator", "OWNER", "COMPANY", "CORPORATE")
    if operator is not None:
        out["operator"] = operator
    capacity_bpd = _first(
        props,
        "CAPACITY", "CAPACITY_BPD", "CAP_BPD", "CRUDE_CAP",
        "ATM_CRUDE_CAP", "TOTAL_CAP", "Capacity",
    )
    if capacity_bpd is not None:
        try:
            out["capacity_bpd"] = int(float(capacity_bpd))
        except (TypeError, ValueError):
            pass
    rtype = _first(props, "TYPE", "Type", "REF_TYPE")
    if rtype is not None:
        out["type"] = rtype
    status = _first(props, "STATUS", "Status")
    if status is not None:
        out["status"] = status
    state = _first(props, "STATE", "State", "ST_ABBREV")
    if state is not None:
        out["state"] = state
    county = _first(props, "COUNTY", "County", "COUNTYNAME")
    if county is not None:
        out["county"] = county
    return out


def run(work_dir: Path) -> SourceResult:
    log = logging.getLogger("etl.refineries")
    log.info("starting HIFLD petroleum refineries download")

    url = os.environ.get("SUBTERRA_REFINERIES_URL", DEFAULT_QUERY_URL)
    log.info("source URL: %s", url)

    out_path = work_dir / "refineries.geojson"
    feature_count = 0
    skipped = 0
    started = time.monotonic()
    first = [True]
    per_state: dict[str, int] = {}
    total_capacity_bpd = 0

    try:
        with out_path.open("w", encoding="utf-8") as out:
            out.write('{"type":"FeatureCollection","features":[')

            def on_feature(feat: dict) -> None:
                nonlocal feature_count, skipped, total_capacity_bpd
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
                cap = props.get("capacity_bpd")
                if isinstance(cap, int):
                    total_capacity_bpd += cap

            iter_features_concurrent(
                url,
                on_feature=on_feature,
                workers=3,
                progress_label="refineries",
            )

            out.write("]}")
    except Exception:
        if out_path.exists():
            out_path.unlink()
        raise

    elapsed = time.monotonic() - started
    log.info(
        "wrote %d refineries (skipped %d, total capacity %d bpd) in %.1fs (top states: %s)",
        feature_count, skipped, total_capacity_bpd, elapsed,
        sorted(per_state.items(), key=lambda kv: -kv[1])[:5],
    )

    return SourceResult(
        layer_id="refineries",
        geojson_path=out_path,
        feature_count=feature_count,
    )
