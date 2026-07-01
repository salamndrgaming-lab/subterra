"""
Nevada parcels — statewide layer from NDOT.

The Nevada Division of State Lands (via NDOT GIS hosting)
aggregates every county's parcel layer into one statewide service
that's stable and free to query. This replaces the previous
per-county approach (Washoe / Clark / Elko / Lyon), every URL of
which had moved or 404'd as of 2026-06-17.

Source:
  https://gis.dot.nv.gov/agsphs/rest/services/Reference/Statewide_Parcels/MapServer/0/query

The statewide layer's attribute schema is the lowest common
denominator across counties — APN, county, owner, acreage — without
the county-specific sale-history or assessed-value fields the
per-county feeds carried. If those richer attributes are needed
later, re-introduce per-county overrides via env vars.

Env override: SUBTERRA_PARCELS_URL — point at any alternative
statewide / per-county parcel service if NDOT's slug changes.
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

DEFAULT_QUERY_URL = (
    "https://gis.dot.nv.gov/agsphs/rest/services/Reference/"
    "Statewide_Parcels/MapServer/0/query"
)


@dataclass
class SourceResult:
    layer_id: str
    geojson_path: Path
    feature_count: int


def _first(props: dict[str, Any], keys: list[str]) -> Any:
    for key in keys:
        v = props.get(key)
        if v in (None, "", " ", "NULL", "null"):
            continue
        return v
    return None


def _parse_money(raw: Any) -> float | None:
    if raw is None or raw == "":
        return None
    try:
        if isinstance(raw, str):
            raw = raw.replace("$", "").replace(",", "").strip()
        f = float(raw)
        if f != f or f < 0:
            return None
        return f
    except (TypeError, ValueError):
        return None


def _normalize(raw: dict[str, Any]) -> dict[str, Any]:
    """Normalize NDOT statewide-parcels schema. Field names defensively
    coalesced because the NDOT layer's docs aren't authoritative on
    exact casing — try the common variants."""
    out: dict[str, Any] = {}
    county = _first(raw, ["COUNTY", "County", "county"])
    if county is not None:
        out["county"] = str(county).strip()
    apn = _first(raw, ["APN", "PARCEL_ID", "PARCELNO", "PARCEL", "APN_FORMAT"])
    if apn is not None:
        out["apn"] = str(apn).strip()
    owner = _first(raw, ["OWNER", "OWNER_NAME", "OWNER1", "OwnerName", "OWNERNME1", "TAXPAYER"])
    if owner is not None:
        out["owner"] = str(owner).strip()
    acres = _parse_money(_first(raw, ["ACRES", "AREA_AC", "TOTAL_ACRE", "GISACRES", "LEGALACRE"]))
    if acres is not None:
        out["acres"] = acres
    # Assessor attributes — the "owner + price + use" the property card
    # renders. The NDOT statewide layer usually lacks these (it's a
    # geometry + APN + owner cadastral layer); they populate whenever a
    # value-bearing source is configured (per-county assessor via the
    # SUBTERRA_PARCELS_*_URL overrides, or a national parcel provider).
    # Best-effort coalesce over the common assessor field names so any
    # source that carries them flows straight through to the drawer.
    assessed = _parse_money(_first(raw, [
        "assessed_value", "ASSESSED", "ASSESSEDVA", "ASSDTTLVAL",
        "TOTALVALUE", "TOTAL_VAL", "MKT_VAL", "MARKETVAL", "JUST_VALUE",
    ]))
    if assessed is not None:
        out["assessed_value"] = assessed
    sale_price = _parse_money(_first(raw, [
        "sale_price", "SALEPRICE", "SALE_PRICE", "SALEAMT", "LASTSALE",
    ]))
    if sale_price is not None:
        out["sale_price"] = sale_price
    sale_date = _first(raw, ["sale_date", "SALEDATE", "SALE_DATE", "LASTSALEDT", "DEEDDATE"])
    if sale_date is not None:
        out["sale_date"] = str(sale_date).strip()
    land_use = _first(raw, [
        "land_use", "LANDUSE", "USE_CODE", "USECODE", "USEDESC",
        "PROPCLASS", "PROP_CLASS", "ZONING", "CLASS",
    ])
    if land_use is not None:
        out["land_use"] = str(land_use).strip()
    zoning = _first(raw, ["zoning", "ZONING", "ZONE", "ZONE_CODE", "ZONECLASS"])
    if zoning is not None:
        out["zoning"] = str(zoning).strip()
    address = _first(raw, [
        "address", "SITE_ADDR", "SITUS", "SITUSADDR", "PROP_ADDR",
        "PHYSADDR", "ADDRESS", "SITEADDRES",
    ])
    if address is not None:
        out["address"] = str(address).strip()
    return out


def run(work_dir: Path) -> SourceResult:
    log = logging.getLogger("etl.parcels")
    url = os.environ.get("SUBTERRA_PARCELS_URL") or DEFAULT_QUERY_URL
    log.info("starting NDOT statewide-parcels download: %s", url)

    out_path = work_dir / "parcels.geojson"
    feature_count = 0
    skipped = 0
    started = time.monotonic()
    first = [True]

    try:
        with out_path.open("w", encoding="utf-8") as out:
            out.write('{"type":"FeatureCollection","features":[')

            def on_feature(feat: dict[str, Any]) -> None:
                nonlocal feature_count, skipped
                geom = feat.get("geometry")
                if not geom or geom.get("type") not in ("Polygon", "MultiPolygon"):
                    skipped += 1
                    return
                normalized = _normalize(feat.get("properties") or {})
                if not first[0]:
                    out.write(",")
                first[0] = False
                json.dump(
                    {"type": "Feature", "geometry": geom, "properties": normalized}, out,
                )
                feature_count += 1

            iter_features_concurrent(
                url,
                on_feature=on_feature,
                workers=6,
                progress_label="parcels",
            )

            out.write("]}")
    except Exception:
        if out_path.exists():
            out_path.unlink()
        raise

    elapsed = time.monotonic() - started
    log.info(
        "wrote %d parcels (skipped %d non-polygon) in %.1fs",
        feature_count, skipped, elapsed,
    )

    return SourceResult(
        layer_id="parcels",
        geojson_path=out_path,
        feature_count=feature_count,
    )
