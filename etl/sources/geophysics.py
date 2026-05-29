"""
USGS Airborne Geophysical Survey Inventory (Earth MRI, v5.0 April 2024).

Polygon footprints of every public airborne geophysical survey flown by
or for the USGS from 1943 to present — aeromagnetic (M), electromagnetic
(EM), radiometric (R), gravity (G), and VLF-EM (V). This tells a
prospector *where modern subsurface data exists*: a cell with recent
high-resolution aeromag + radiometric coverage is far more investable
than one that's never been flown, because the data to vector a drill
target already exists.

Earth MRI is the federal critical-minerals mapping push — its survey
footprints are the leading indicator of where the USGS itself thinks the
prospectivity is.

Hosted on ScienceBase (item 5d38aac0e4b01d82ce8b940a). ScienceBase items
expose an ArcGIS-style service when published; we try the known service
URLs and fall back gracefully.

Source: https://www.sciencebase.gov/catalog/item/5d38aac0e4b01d82ce8b940a
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sources._arcgis import iter_features_concurrent

CANDIDATE_ENDPOINTS: list[dict[str, Any]] = [
    {
        "label": "Earth MRI airborne inventory (cmerwebmap)",
        "service": "https://cmerwebmap.cr.usgs.gov/arcgis/rest/services/earthmri/airborne_survey_inventory/MapServer",
        "layer": 0,
    },
    {
        "label": "Earth MRI airborne inventory (mrdata)",
        "service": "https://mrdata.usgs.gov/arcgis/rest/services/earthmri/airborne/MapServer",
        "layer": 0,
    },
]

# Single-letter data-type codes → readable labels.
SURVEY_TYPE_LABELS = {
    "M": "Aeromagnetic",
    "EM": "Electromagnetic",
    "R": "Radiometric",
    "G": "Gravity",
    "V": "VLF-EM",
}


@dataclass
class SourceResult:
    layer_id: str
    geojson_path: Path
    feature_count: int


def _normalize(p: dict[str, Any]) -> dict[str, Any]:
    def first(*keys: str) -> Any:
        for k in keys:
            for cased in (k, k.upper(), k.lower()):
                v = p.get(cased)
                if v not in (None, "", " "):
                    return v
        return None

    raw_types = first("DATA_TYPES", "data_types", "TYPE", "SURVEY_TYP", "datatype") or ""
    # Decode the compact type string ("MR", "MEMR" etc.) into labels.
    labels: list[str] = []
    s = str(raw_types).upper()
    for code in ("EM", "M", "R", "G", "V"):
        if code in s:
            labels.append(SURVEY_TYPE_LABELS[code])
            s = s.replace(code, "")
    out = {
        "name": first("NAME", "SURVEY_NAME", "PROJ_NAME", "title"),
        "types": ", ".join(labels) if labels else (str(raw_types) or None),
        "year": first("YEAR", "FLIGHT_YR", "year", "ACQ_YEAR", "SURVEY_YR"),
        "agency": first("AGENCY", "SOURCE", "agency"),
        "resolution": first("LINE_SPACE", "line_spacing", "RESOLUTION"),
    }
    return {k: v for k, v in out.items() if v is not None}


def run(work_dir: Path) -> SourceResult:
    log = logging.getLogger("etl.geophysics")
    log.info("starting Earth MRI geophysical survey footprints download")

    out_path = work_dir / "geophysics.geojson"
    total = 0
    first = [True]
    started = time.monotonic()

    try:
        with out_path.open("w", encoding="utf-8") as out:
            out.write('{"type":"FeatureCollection","features":[')

            for ep in CANDIDATE_ENDPOINTS:
                count_before = total

                def emit(feat: dict[str, Any]) -> None:
                    nonlocal total
                    geom = feat.get("geometry")
                    if not geom:
                        return
                    props = _normalize(
                        feat.get("properties") or feat.get("attributes") or {}
                    )
                    if not first[0]:
                        out.write(",")
                    first[0] = False
                    json.dump({"type": "Feature", "geometry": geom, "properties": props}, out)
                    total += 1

                query_url = f"{ep['service']}/{ep['layer']}/query"
                log.info("trying %s (%s)", ep["label"], query_url)
                try:
                    iter_features_concurrent(
                        query_url,
                        on_feature=emit,
                        workers=3,
                        retries=3,
                        progress_label="geophysics",
                    )
                except Exception as err:  # noqa: BLE001
                    log.warning("  %s FAILED — %s: %s", ep["label"], type(err).__name__, err)
                    continue

                got = total - count_before
                log.info("  %s: %d survey footprints", ep["label"], got)
                if got > 0:
                    break

            out.write("]}")
    except Exception:
        if out_path.exists():
            out_path.unlink()
        raise

    elapsed = time.monotonic() - started
    log.info("wrote %d geophysical survey footprints in %.1fs", total, elapsed)
    return SourceResult(
        layer_id="geophysics",
        geojson_path=out_path,
        feature_count=total,
    )
