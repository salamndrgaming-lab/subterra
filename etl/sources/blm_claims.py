"""
BLM National Mining Claims (active polygons).

Phase 1 will replace the stub `run()` below with the real download of
the quarterly bulk shapefile zip from BLM Navigator. Phase 0 ships the
stub so `etl/refresh.py` runs end-to-end against the orchestrator
without doing any network I/O — useful for CI smoke tests.

Real source URL (Phase 1):
    https://navigator.blm.gov/data → search "Mining Claims" → zipped
    shapefile. The download is published quarterly and the URL is
    stable; capture it as BLM_CLAIMS_URL in the GitHub Actions env.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from sources._template import SourceResult


def run(work_dir: Path) -> SourceResult:
    log = logging.getLogger("etl.blm_claims")
    log.info("phase 0 stub — emitting empty FeatureCollection")

    out = work_dir / "blm_claims.geojson"
    out.write_text(json.dumps({"type": "FeatureCollection", "features": []}))

    return SourceResult(
        layer_id="mining_claims",  # matches tilesetLayer in shared/layers.ts
        geojson_path=out,
        feature_count=0,
    )
