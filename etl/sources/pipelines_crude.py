"""
EIA Crude Oil pipelines.

Same fix as pipelines_natgas.py: the EIA Atlas ArcGIS Hub Downloads
endpoint has been returning HTTP 500 for some weeks, and DOT hosts the
same underlying EIA crude-pipeline data as a FeatureServer at
geo.dot.gov that we can paginate via the project's `_arcgis` helper.

Source URL:
  https://geo.dot.gov/server/rest/services/Hosted/Crude_Oil_Pipelines_US_EIA/FeatureServer/0

Env override: SUBTERRA_PIPELINES_CRUDE_URL.
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
    "https://geo.dot.gov/server/rest/services/Hosted/"
    "Crude_Oil_Pipelines_US_EIA/FeatureServer/0/query"
)


@dataclass
class SourceResult:
    layer_id: str
    geojson_path: Path
    feature_count: int


def _normalize_props(p: dict) -> dict:
    """Pipeline schema varies across EIA revisions; coalesce common fields."""
    def first(*keys: str) -> object:
        for k in keys:
            v = p.get(k) or p.get(k.upper()) or p.get(k.lower())
            if v not in (None, "", " "):
                return v
        return None

    out: dict = {}
    for label, candidates in [
        ("name", ["PipelineName", "PIPENAME", "Pipename", "PIPE_NAME"]),
        ("operator", ["Operator", "OPERATOR", "Owner", "OWNER_NAME"]),
        ("type", ["Type", "TYPE", "PipelineType"]),
        ("commodity", ["Commodity", "COMMODITY"]),
        ("status", ["Status", "STATUS"]),
        ("source", ["Source", "SOURCE"]),
        ("state", ["StateAbbr", "STATE", "state"]),
    ]:
        v = first(*candidates)
        if v is not None:
            out[label] = v
    return out


def run(work_dir: Path) -> SourceResult:
    log = logging.getLogger("etl.pipelines_crude")
    log.info("starting crude-oil pipelines download")

    url = (
        os.environ.get("SUBTERRA_PIPELINES_CRUDE_URL")
        or os.environ.get("PIPELINES_CRUDE_URL")
        or DEFAULT_QUERY_URL
    )
    log.info("source URL: %s", url)

    out_path = work_dir / "pipelines_crude.geojson"
    feature_count = 0
    skipped = 0
    started = time.monotonic()
    first = [True]

    try:
        with out_path.open("w", encoding="utf-8") as out:
            out.write('{"type":"FeatureCollection","features":[')

            def on_feature(feat: dict) -> None:
                nonlocal feature_count, skipped
                geom = feat.get("geometry")
                if not geom:
                    skipped += 1
                    return
                if geom.get("type") not in ("LineString", "MultiLineString"):
                    skipped += 1
                    return
                props = _normalize_props(feat.get("properties") or {})
                if not first[0]:
                    out.write(",")
                first[0] = False
                json.dump(
                    {"type": "Feature", "geometry": geom, "properties": props}, out,
                )
                feature_count += 1

            iter_features_concurrent(
                url,
                on_feature=on_feature,
                workers=4,
                progress_label="pipelines_crude",
            )

            out.write("]}")
    except Exception:
        if out_path.exists():
            out_path.unlink()
        raise

    elapsed = time.monotonic() - started
    log.info(
        "wrote %d crude pipeline segments (skipped %d) in %.1fs",
        feature_count, skipped, elapsed,
    )
    return SourceResult(
        layer_id="pipelines_crude",
        geojson_path=out_path,
        feature_count=feature_count,
    )
