"""
BLM National PLSS — Public Land Survey System grid.

Township polygons from BLM's CadNSDI national service. We convert each
polygon to a MultiLineString so tippecanoe + the web app render the
grid as outlines (matches the 'line' geometry kind in the layer
registry; township interiors don't need fill).

Uses sources/_arcgis.iter_features_concurrent for parallel paginated
fetching — 6 workers cuts what was a 15–25 min sequential walk down to
~3–5 min.

Source: https://gis.blm.gov/arcgis/rest/services/Cadastral/BLM_Natl_PLSS_CadNSDI/MapServer
Layer 2 — turned out to be PLSS sections (~2M+ features in CONUS),
which is denser than townships but more useful for staking workflows
(claims are filed by section).
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

SERVICE = "https://gis.blm.gov/arcgis/rest/services/Cadastral/BLM_Natl_PLSS_CadNSDI/MapServer"
LAYER_ID = 2


@dataclass
class SourceResult:
    layer_id: str
    geojson_path: Path
    feature_count: int


def _polygon_to_lines(geom: dict[str, Any]) -> dict[str, Any]:
    """Convert (Multi)Polygon → MultiLineString so tippecanoe gets line
    geometry matching the layer registry."""
    if geom["type"] == "Polygon":
        return {"type": "MultiLineString", "coordinates": geom["coordinates"]}
    if geom["type"] == "MultiPolygon":
        lines: list[Any] = []
        for poly_rings in geom["coordinates"]:
            for ring in poly_rings:
                lines.append(ring)
        return {"type": "MultiLineString", "coordinates": lines}
    return geom


def _normalize_props(props: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key in ("PLSSID", "STATEABBR", "FRSTDIVID", "TWNSHPNO", "RANGENO", "MERIDIAN"):
        v = props.get(key) or props.get(key.lower())
        if v not in (None, "", " "):
            out[key.lower()] = v
    return out


def run(work_dir: Path) -> SourceResult:
    log = logging.getLogger("etl.plss")
    log.info("starting PLSS township download from BLM CadNSDI")

    base = os.environ.get("PLSS_SERVICE_URL", SERVICE)
    query_url = f"{base}/{LAYER_ID}/query"

    out_path = work_dir / "plss.geojson"
    feature_count = 0
    skipped = 0
    started = time.monotonic()

    try:
        with out_path.open("w", encoding="utf-8") as out:
            out.write('{"type":"FeatureCollection","features":[')
            # tqdm prints to stderr so its progress doesn't interleave with
            # the streaming JSON we're emitting on stdout to disk.
            first = [True]

            def emit(feat: dict[str, Any]) -> None:
                nonlocal skipped
                geom = feat.get("geometry")
                if not geom:
                    skipped += 1
                    return
                line_geom = _polygon_to_lines(geom)
                props = _normalize_props(feat.get("properties") or feat.get("attributes") or {})
                if not first[0]:
                    out.write(",")
                first[0] = False
                json.dump({"type": "Feature", "geometry": line_geom, "properties": props}, out)

            feature_count = iter_features_concurrent(
                query_url,
                on_feature=emit,
                progress_label="plss",
            )
            out.write("]}")
    except Exception:
        if out_path.exists():
            out_path.unlink()
        raise

    elapsed = time.monotonic() - started
    log.info(
        "wrote %d township outlines (skipped %d) in %.1fs → %s",
        feature_count, skipped, elapsed, out_path.name,
    )
    return SourceResult(
        layer_id="plss",
        geojson_path=out_path,
        feature_count=feature_count,
    )
