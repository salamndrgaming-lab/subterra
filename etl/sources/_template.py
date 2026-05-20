"""
Template for an ETL source module. Copy this file when adding a new
dataset, rename it to match the dataset key (e.g. `mrds.py`), then add
the same key to the SOURCES list in `etl/refresh.py`.

Every source module must:
1. Expose a `run(work_dir: Path) -> SourceResult` callable.
2. Download the bulk extract for ONE dataset.
3. Normalize features into the column shape the layer expects.
4. Write a single newline-delimited or array GeoJSON file under work_dir.
5. Return a SourceResult with the layer_id matching shared/layers.ts.

Do NOT call any live API endpoint at request time. This module runs
weekly in CI; downloads happen exactly once per refresh.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path


@dataclass
class SourceResult:
    layer_id: str
    geojson_path: Path
    feature_count: int


def run(work_dir: Path) -> SourceResult:
    """Concrete sources override this. The template is intentionally
    minimal — copy it, fill in the download + normalize logic, return."""
    log = logging.getLogger("etl.template")
    log.warning("template source module invoked — this is a no-op")
    out = work_dir / "template.geojson"
    out.write_text('{"type":"FeatureCollection","features":[]}')
    return SourceResult(layer_id="template", geojson_path=out, feature_count=0)
