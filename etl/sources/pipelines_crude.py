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

# Try these URLs in order — first one that returns features wins.
# Same shape + rationale as pipelines_natgas.py.
CANDIDATE_URLS = [
    "https://geo.dot.gov/server/rest/services/Hosted/"
    "Crude_Oil_Pipelines_US_EIA/FeatureServer/0/query",
    # NASA NCCS HIFLD mirror — energy-infrastructure service. The
    # exact layer index for crude vs natgas may differ from natgas
    # (0); HIFLD mirror typically uses layer 1 or 2 for crude. If 0
    # returns gas data, override via SUBTERRA_PIPELINES_CRUDE_URL.
    "https://maps.nccs.nasa.gov/mapping/rest/services/"
    "hifld_open/energy/FeatureServer/1/query",
]
DEFAULT_QUERY_URL = CANDIDATE_URLS[0]


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

    env_url = (
        os.environ.get("SUBTERRA_PIPELINES_CRUDE_URL")
        or os.environ.get("PIPELINES_CRUDE_URL")
        or ""
    )
    urls = [u for u in [env_url, *CANDIDATE_URLS] if u]

    out_path = work_dir / "pipelines_crude.geojson"
    feature_count = 0
    skipped = 0
    started = time.monotonic()
    chosen_url: str | None = None
    last_error: Exception | None = None

    for attempt_url in urls:
        log.info("attempt URL: %s", attempt_url)
        first = [True]
        feature_count = 0
        skipped = 0
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
                    attempt_url,
                    on_feature=on_feature,
                    workers=4,
                    progress_label="pipelines_crude",
                )

                out.write("]}")
            if feature_count > 0:
                chosen_url = attempt_url
                break
            log.warning("URL produced 0 features — trying next candidate")
        except Exception as err:  # noqa: BLE001
            last_error = err
            log.warning("URL failed (%s) — trying next candidate", err)
            continue

    if feature_count == 0:
        if out_path.exists():
            out_path.unlink()
        raise RuntimeError(
            f"all {len(urls)} candidate URLs failed for pipelines_crude — "
            f"last error: {last_error}"
        )
    log.info("succeeded via %s", chosen_url)

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
