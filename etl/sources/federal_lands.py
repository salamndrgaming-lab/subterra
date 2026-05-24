"""
BLM National Surface Management Agency (SMA) — federal land ownership.

Paginated ArcGIS FeatureServer query (same pattern as sources/plss.py).
The Hub Downloads API returns 500 for this item because the dataset is
too big for on-demand generation; the underlying FeatureServer paginates
fine. We filter at ETL time to the four agencies most relevant for
mineral and oil/gas prospecting (BLM, USFS, NPS, BIA) and normalize
their codes into a stable vocabulary so the web app can color-by-agency.

Service: https://services3.arcgis.com/ZyW3beZDqER6f82o/ArcGIS/rest/services/SurfaceManagementAgency/FeatureServer/0
Hub:     https://gbp-blm-egis.hub.arcgis.com/datasets/BLM-EGIS::blm-national-sma-surface-management-agency-area-polygons

Output: a single GeoJSON with one polygon per federal unit, properties =
{agency, name, state}. The web layer colors by agency via a MapLibre
match expression.
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import requests
from tqdm import tqdm

SERVICE = (
    "https://services3.arcgis.com/ZyW3beZDqER6f82o/ArcGIS/rest/services/"
    "SurfaceManagementAgency/FeatureServer"
)
LAYER_ID = 0
PAGE_SIZE = 2000
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0 "
    "(Subterra-ETL +https://github.com/salamndrgaming-lab/subterra)"
)
REQUEST_TIMEOUT = 180.0

# Agency normalization: ArcGIS codes vary across BLM revisions, so map every
# alias to a canonical short code (matches the web app's color-by-agency
# match expression).
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


def _fetch_page(query_url: str, offset: int) -> dict[str, Any]:
    params = {
        "where": "1=1",
        "outFields": "*",
        "returnGeometry": "true",
        "outSR": "4326",
        "f": "geojson",
        "resultRecordCount": str(PAGE_SIZE),
        "resultOffset": str(offset),
        "orderByFields": "OBJECTID ASC",
    }
    resp = requests.get(
        query_url,
        params=params,
        headers={"User-Agent": USER_AGENT, "accept": "application/geo+json, application/json"},
        timeout=REQUEST_TIMEOUT,
    )
    resp.raise_for_status()
    body = resp.json()
    if isinstance(body, dict) and body.get("error"):
        raise RuntimeError(f"ArcGIS error from {query_url}: {body['error']}")
    return body


def _agency_from(props: dict[str, Any]) -> str | None:
    """Try several common agency-code field names, then normalize."""
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


def run(work_dir: Path) -> SourceResult:
    log = logging.getLogger("etl.federal_lands")
    log.info("starting BLM National SMA paginated download")

    base = os.environ.get("FEDERAL_LANDS_SERVICE_URL", SERVICE)
    query_url = f"{base}/{LAYER_ID}/query"
    log.info("querying %s", query_url)

    out_path = work_dir / "federal_lands.geojson"
    feature_count = 0
    skipped_no_geom = 0
    skipped_wrong_agency = 0
    per_agency: dict[str, int] = {}
    offset = 0
    started = time.monotonic()
    no_progress = 0

    try:
        with out_path.open("w", encoding="utf-8") as out:
            out.write('{"type":"FeatureCollection","features":[')
            first = True
            pbar = tqdm(desc="federal lands", unit="feat", smoothing=0.1)
            while True:
                body = _fetch_page(query_url, offset)
                features = body.get("features", [])
                if not features:
                    break
                for feat in features:
                    geom = feat.get("geometry")
                    if not geom:
                        skipped_no_geom += 1
                        continue
                    raw_props = feat.get("properties") or feat.get("attributes") or {}
                    agency = _agency_from(raw_props)
                    if agency is None:
                        skipped_wrong_agency += 1
                        continue
                    if agency not in KEEP:
                        skipped_wrong_agency += 1
                        continue
                    props = {
                        "agency": agency,
                        "name": _name_from(raw_props),
                        "state": _state_from(raw_props),
                    }
                    # Drop null values to keep tiles compact.
                    props = {k: v for k, v in props.items() if v is not None}
                    if not first:
                        out.write(",")
                    first = False
                    json.dump({"type": "Feature", "geometry": geom, "properties": props}, out)
                    feature_count += 1
                    per_agency[agency] = per_agency.get(agency, 0) + 1
                pbar.update(len(features))

                exceeded = body.get("exceededTransferLimit", False)
                if not exceeded and len(features) < PAGE_SIZE:
                    break
                offset += len(features)
                if len(features) == 0:
                    no_progress += 1
                    if no_progress >= 3:
                        log.warning("no progress for 3 consecutive pages, stopping")
                        break
                else:
                    no_progress = 0
            pbar.close()
            out.write("]}")
    except Exception:
        if out_path.exists():
            out_path.unlink()
        raise

    elapsed = time.monotonic() - started
    log.info(
        "wrote %d federal polygons (skipped %d no-geom, %d non-target agency) in %.1fs — %s",
        feature_count, skipped_no_geom, skipped_wrong_agency, elapsed, per_agency,
    )

    return SourceResult(
        layer_id="federal_lands",
        geojson_path=out_path,
        feature_count=feature_count,
    )
