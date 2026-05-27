"""
BLM National Surface Management Agency (SMA) — federal land ownership.

Uses sources/_arcgis.iter_features_concurrent for parallel paginated
fetching from the canonical AGOL FeatureServer. Filters in-stream to
the four agencies most relevant for prospecting (BLM, USFS, NPS, BIA)
so the output stays compact.

Service: https://services3.arcgis.com/ZyW3beZDqER6f82o/ArcGIS/rest/services/SurfaceManagementAgency/FeatureServer/0
Hub:     https://gbp-blm-egis.hub.arcgis.com/datasets/BLM-EGIS::blm-national-sma-surface-management-agency-area-polygons
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

SERVICE = (
    "https://services3.arcgis.com/ZyW3beZDqER6f82o/ArcGIS/rest/services/"
    "SurfaceManagementAgency/FeatureServer"
)
LAYER_ID = 0

AGENCY_NORMALIZATION: dict[str, str] = {
    "BLM": "BLM",
    "BUREAU OF LAND MANAGEMENT": "BLM",
    "FS": "USFS",
    "USFS": "USFS",
    "FOREST SERVICE": "USFS",
    "USDA FOREST SERVICE": "USFS",
    "NPS": "NPS",
    "NATIONAL PARK SERVICE": "NPS",
    "BIA": "BIA",
    "BUREAU OF INDIAN AFFAIRS": "BIA",
    "INDIAN": "BIA",
    "TRIBAL": "BIA",
}
KEEP = set(AGENCY_NORMALIZATION.values())


@dataclass
class SourceResult:
    layer_id: str
    geojson_path: Path
    feature_count: int


def _agency_from(props: dict[str, Any]) -> str | None:
    for key in (
        "ADMIN_AGENCY_CODE", "admin_agency_code",
        "ADM_MANAGE", "adm_manage",
        "AGBUR", "agbur",
        "AGENCY", "agency",
        "MANAGER", "manager",
        "MGMT_AGENCY", "mgmt_agency",
        "OWNER_NAME", "owner_name",
    ):
        v = props.get(key)
        if not v:
            continue
        norm = AGENCY_NORMALIZATION.get(str(v).strip().upper())
        if norm:
            return norm
    return None


def _name_from(props: dict[str, Any]) -> str | None:
    for key in ("UNIT_NAME", "unit_name", "NAME", "name", "FEAT_NAME"):
        v = props.get(key)
        if v not in (None, "", " "):
            return str(v)
    return None


def _state_from(props: dict[str, Any]) -> str | None:
    for key in ("STATE", "state", "ST_ABBREV", "ST", "STATE_NM"):
        v = props.get(key)
        if v not in (None, "", " "):
            return str(v)
    return None


def _raw_agency_value(props: dict[str, Any]) -> str | None:
    """Diagnostic: return the first non-empty value from any candidate
    agency field, without normalization. Used to discover what field
    names + values the actual service is returning so we can refine the
    AGENCY_NORMALIZATION table later."""
    for key in (
        "ADMIN_AGENCY_CODE", "admin_agency_code",
        "ADM_MANAGE", "adm_manage",
        "AGBUR", "agbur",
        "AGENCY", "agency",
        "MANAGER", "manager",
        "MGMT_AGENCY", "mgmt_agency",
        "OWNER_NAME", "owner_name",
        "AGENCY_CODE", "agency_code",
        "AGENCY_TYP", "agency_typ",
        "OWN_AGCY", "own_agcy",
    ):
        v = props.get(key)
        if v not in (None, "", " "):
            return str(v).strip()
    return None


def run(work_dir: Path) -> SourceResult:
    log = logging.getLogger("etl.federal_lands")
    log.info("starting BLM National SMA paginated download")

    base = os.environ.get("FEDERAL_LANDS_SERVICE_URL", SERVICE)
    query_url = f"{base}/{LAYER_ID}/query"

    out_path = work_dir / "federal_lands.geojson"
    feature_count = 0
    skipped_no_geom = 0
    per_agency: dict[str, int] = {}
    seen_raw_agency: dict[str, int] = {}  # diagnostic: count raw values seen
    started = time.monotonic()

    try:
        with out_path.open("w", encoding="utf-8") as out:
            out.write('{"type":"FeatureCollection","features":[')
            first = [True]

            def emit(feat: dict[str, Any]) -> None:
                nonlocal skipped_no_geom
                geom = feat.get("geometry")
                if not geom:
                    skipped_no_geom += 1
                    return
                raw_props = feat.get("properties") or feat.get("attributes") or {}

                # Try to normalize agency, fall back to raw value verbatim,
                # final fallback "OTHER". Either way we emit the polygon —
                # filtering at ETL time before we know the schema was a
                # mistake; the web layer can color-by-agency with a default
                # for unknown values.
                agency = _agency_from(raw_props)
                if agency is None:
                    raw_val = _raw_agency_value(raw_props)
                    agency = raw_val or "OTHER"
                    if raw_val:
                        seen_raw_agency[raw_val] = seen_raw_agency.get(raw_val, 0) + 1
                props = {
                    "agency": agency,
                    "name": _name_from(raw_props),
                    "state": _state_from(raw_props),
                }
                props = {k: v for k, v in props.items() if v is not None}
                if not first[0]:
                    out.write(",")
                first[0] = False
                json.dump({"type": "Feature", "geometry": geom, "properties": props}, out)
                per_agency[agency] = per_agency.get(agency, 0) + 1

            iter_features_concurrent(
                query_url,
                on_feature=emit,
                progress_label="federal lands",
            )
            out.write("]}")
            feature_count = sum(per_agency.values())
    except Exception:
        if out_path.exists():
            out_path.unlink()
        raise

    elapsed = time.monotonic() - started
    log.info(
        "wrote %d federal polygons (skipped %d no-geom) in %.1fs",
        feature_count, skipped_no_geom, elapsed,
    )
    log.info("normalized agency breakdown: %s", per_agency)
    if seen_raw_agency:
        # Print up to top 20 raw values so we can refine the normalization
        # table in a follow-up commit.
        top = sorted(seen_raw_agency.items(), key=lambda kv: kv[1], reverse=True)[:20]
        log.info("top unrecognized agency values (raw): %s", dict(top))
    return SourceResult(
        layer_id="federal_lands",
        geojson_path=out_path,
        feature_count=feature_count,
    )
    return SourceResult(
        layer_id="federal_lands",
        geojson_path=out_path,
        feature_count=feature_count,
    )
