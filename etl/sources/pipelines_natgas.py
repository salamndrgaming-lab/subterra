"""
EIA Natural Gas transmission + distribution pipelines.

The previous implementation hit EIA Atlas's ArcGIS Hub Downloads
endpoint (opendata.arcgis.com/api/v3/datasets/.../downloads/data)
to grab the bulk GeoJSON. That endpoint returns HTTP 500 when the
EIA-side export job fails — which it has been for some weeks
(2026-06-16: HTTPError 500 → source failed → ETL × in UI).

DOT publishes the SAME underlying EIA pipeline data via a hosted
ArcGIS FeatureServer at geo.dot.gov, served from a different
infrastructure that doesn't run the export-job pipeline. Paginated
queries work even when the EIA Hub bulk export is broken.

Source URL:
  https://geo.dot.gov/server/rest/services/Hosted/Natural_Gas_Pipelines_US_EIA/FeatureServer/0

Env override: SUBTERRA_PIPELINES_NATGAS_URL.
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
# The DOT-hosted EIA service was observed returning HTTP 500 in
# 2026-06 production runs. NASA NCCS hosts a HIFLD mirror of the same
# pipeline-network data that's more reliable as a backup.
CANDIDATE_URLS = [
    # geo.dot.gov — official DOT host of EIA pipeline data. Historically
    # the canonical one; intermittently 500s.
    "https://geo.dot.gov/server/rest/services/Hosted/"
    "Natural_Gas_Pipelines_US_EIA/FeatureServer/0/query",
    # NASA NCCS HIFLD mirror — energy-infrastructure service that
    # includes natural gas pipelines as one of its layers.
    "https://maps.nccs.nasa.gov/mapping/rest/services/"
    "hifld_open/energy/FeatureServer/0/query",
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
    log = logging.getLogger("etl.pipelines_natgas")
    log.info("starting natural-gas pipelines download")

    # Build the URL try-list: env override first, then candidates in
    # order. First URL that produces features wins; subsequent ones
    # don't run. We don't merge across hosts because schemas may
    # differ — wholesale-replacement is safer than partial-mix.
    env_url = (
        os.environ.get("SUBTERRA_PIPELINES_NATGAS_URL")
        or os.environ.get("PIPELINES_NATGAS_URL")
        or ""
    )
    urls = [u for u in [env_url, *CANDIDATE_URLS] if u]

    out_path = work_dir / "pipelines_natgas.geojson"
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
                    workers=6,
                    progress_label="pipelines_natgas",
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
        # All candidates exhausted; clean up the file and raise the
        # last error so the source surfaces as `failed` (not silently
        # empty) in the per-source summary.
        if out_path.exists():
            out_path.unlink()
        raise RuntimeError(
            f"all {len(urls)} candidate URLs failed for pipelines_natgas — "
            f"last error: {last_error}"
        )
    log.info("succeeded via %s", chosen_url)

    elapsed = time.monotonic() - started
    log.info(
        "wrote %d natgas pipeline segments (skipped %d) in %.1fs",
        feature_count, skipped, elapsed,
    )
    return SourceResult(
        layer_id="pipelines_natgas",
        geojson_path=out_path,
        feature_count=feature_count,
    )
