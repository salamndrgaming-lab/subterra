"""
USFWS Critical Habitat polygon layer.

Critical habitat designated under ESA §7 doesn't withdraw land from
mineral entry by itself, but the consultation requirement makes
staking practically a non-starter for any operator who needs a
permit downstream. We flag it as an eligibility blocker.

The previous implementation used USFWS's ECOS bulk-zip download at
`https://ecos.fws.gov/docs/crithab/crithab_all.zip`. That host
intermittently fails SSL handshakes (observed 2026-06-16:
SSLError → SOURCE failed → layer empty in UI). Switching to the
canonical ArcGIS Online FeatureServer that USFWS publishes via:
  https://services.arcgis.com/QVENGdaPbd4LUkLV/arcgis/rest/services/
    USFWS_Critical_Habitat/FeatureServer
…paginated via the project's `_arcgis` helper (same pattern as
blm_claims, withdrawals, etc.). Drops the geopandas + shapefile
parsing path that the bulk-zip approach needed.

Env override: SUBTERRA_CRITICAL_HABITAT_URL.
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
    "https://services.arcgis.com/QVENGdaPbd4LUkLV/arcgis/rest/services/"
    "USFWS_Critical_Habitat/FeatureServer/0/query"
)


@dataclass
class SourceResult:
    layer_id: str
    geojson_path: Path
    feature_count: int


def _first(props: dict, *keys: str) -> object:
    for k in keys:
        v = props.get(k)
        if v in (None, "", " "):
            # ArcGIS often uppercases attrs; try both cases.
            v = props.get(k.upper())
        if v not in (None, "", " "):
            return v
    return None


def _normalize(props: dict) -> dict:
    """Different CritHab vintages use slightly different field names —
    surface the same canonical attrs the UI's eligibility check expects."""
    out: dict = {}
    species = _first(props, "comname", "common_nam", "comm_name", "sci_name", "species")
    if species is not None:
        out["species"] = species
    status = _first(props, "status", "listing_st")
    if status is not None:
        out["status"] = status
    unit = _first(props, "unit_name", "unit", "unitname")
    if unit is not None:
        out["unit"] = unit
    doc_type = _first(props, "doc_type", "doctype")
    if doc_type is not None:
        out["doc_type"] = doc_type
    return out


def run(work_dir: Path) -> SourceResult:
    log = logging.getLogger("etl.critical_habitat")
    log.info("starting USFWS critical-habitat download")

    # Accept the canonical SUBTERRA_* name + legacy CRITHAB_URL.
    url = (
        os.environ.get("SUBTERRA_CRITICAL_HABITAT_URL")
        or os.environ.get("CRITHAB_URL")
        or DEFAULT_QUERY_URL
    )
    log.info("source URL: %s", url)

    out_path = work_dir / "critical_habitat.geojson"
    feature_count = 0
    skipped = 0
    started = time.monotonic()
    first = [True]
    per_status: dict[str, int] = {}

    try:
        with out_path.open("w", encoding="utf-8") as out:
            out.write('{"type":"FeatureCollection","features":[')

            def on_feature(feat: dict) -> None:
                nonlocal feature_count, skipped
                geom = feat.get("geometry")
                if not geom:
                    skipped += 1
                    return
                # FeatureServer returns polygons; tippecanoe accepts
                # both Polygon and MultiPolygon as-is.
                if geom.get("type") not in ("Polygon", "MultiPolygon"):
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
                s = str(props.get("status", "Unknown"))
                per_status[s] = per_status.get(s, 0) + 1

            iter_features_concurrent(
                url,
                on_feature=on_feature,
                workers=4,
                progress_label="critical_habitat",
            )

            out.write("]}")
    except Exception:
        if out_path.exists():
            out_path.unlink()
        raise

    elapsed = time.monotonic() - started
    log.info(
        "wrote %d critical-habitat polygons (skipped %d) in %.1fs (by status: %s)",
        feature_count, skipped, elapsed, per_status,
    )

    return SourceResult(
        layer_id="critical_habitat",
        geojson_path=out_path,
        feature_count=feature_count,
    )
