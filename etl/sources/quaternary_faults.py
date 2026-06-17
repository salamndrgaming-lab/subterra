"""
USGS Quaternary Faults and Folds database.

Hosted as an ArcGIS REST FeatureServer by the USGS Geologic Hazards
Science Center. Each feature is a fault trace (polyline) with slip
sense, age, slip rate, and a name. We use them in two places:

  - rendered as a thin red layer on the map so users can see seismic
    hazard along their AOI
  - intersected with the cross-section AB line in the modal to mark
    fault crossings (vertical-dashed per industry convention since
    the database doesn't ship dip)

The endpoint changes occasionally — env-overridable per the same
defensive pattern as water_rights.py.
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

USGS_QFAULTS_DEFAULT_URL = (
    # USGS canonical Quaternary Faults & Folds National Database.
    # Layer 21 of the haz/Qfaults MapServer is the "National Database"
    # layer (the other layers are subset views — Holocene only, etc.).
    # Discovered via search after the previous ArcGIS Online hosted
    # URL (services.arcgis.com/eqj5z0KbcWUcZxgQ/...) silently returned 0.
    "https://earthquake.usgs.gov/arcgis/rest/services/"
    "haz/Qfaults/MapServer/21/query"
)


@dataclass
class SourceResult:
    layer_id: str
    geojson_path: Path
    feature_count: int


def _first(props: dict[str, Any], *keys: str) -> Any:
    for k in keys:
        v = props.get(k)
        if v not in (None, "", " ", "NULL", "null"):
            return v
    return None


def _normalize(raw: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    name = _first(raw, "name", "FAULT_NAME", "FAULT_ZONE_NAME", "fault_name")
    if name:
        out["name"] = str(name).strip()
    age = _first(raw, "age", "AGE", "AGE_RANGE", "youngest_age", "younger_age")
    if age:
        out["age"] = str(age).strip()
    sense = _first(raw, "slip_sense", "SLIP_SENSE", "DIP_DIRECTION", "fault_type")
    if sense:
        out["slip_sense"] = str(sense).strip()
    rate = _first(raw, "slip_rate", "SLIP_RATE", "slip_rate_class")
    if rate:
        out["slip_rate"] = str(rate).strip()
    return out


def run(work_dir: Path) -> SourceResult:
    log = logging.getLogger("etl.quaternary_faults")
    # See water_rights.py for the rationale — empty env var must fall
    # through to the hardcoded default URL, not get used as the URL.
    url = os.environ.get("SUBTERRA_QFAULTS_URL") or USGS_QFAULTS_DEFAULT_URL
    log.info("starting USGS Quaternary Faults download — %s", url)

    out_path = work_dir / "quaternary_faults.geojson"
    total = 0
    first = [True]
    started = time.monotonic()

    try:
        with out_path.open("w", encoding="utf-8") as out:
            out.write('{"type":"FeatureCollection","features":[')

            def on_feature(feat: dict[str, Any]) -> None:
                nonlocal total
                geom = feat.get("geometry")
                if not geom:
                    return
                gt = geom.get("type")
                if gt not in ("LineString", "MultiLineString"):
                    return
                normalized = _normalize(feat.get("properties") or {})
                if not first[0]:
                    out.write(",")
                first[0] = False
                json.dump(
                    {"type": "Feature", "geometry": geom, "properties": normalized},
                    out,
                )
                total += 1

            try:
                iter_features_concurrent(
                    url,
                    on_feature=on_feature,
                    progress_label="quaternary_faults",
                )
            except Exception as err:  # noqa: BLE001
                log.warning("qfaults fetch failed after %d features — %s", total, err)

            out.write("]}")
    except Exception:
        if out_path.exists():
            out_path.unlink()
        raise

    elapsed = time.monotonic() - started
    log.info("wrote %d fault traces in %.1fs", total, elapsed)
    return SourceResult(
        layer_id="quaternary_faults",
        geojson_path=out_path,
        feature_count=total,
    )
