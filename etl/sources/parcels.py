"""
County parcel layer — per-county ArcGIS endpoints for the heaviest
mining counties first (NV's Clark / Washoe / Elko / Lyon), expandable
later.

Why not a national parcel feed? The only national US parcel dataset
available without per-state licensing is Regrid's open dataset, which
caps free use and rate-limits hard. Per-county ArcGIS feeds are free,
permissive, and already maintained by every county GIS office —
they're the same data Regrid aggregates.

Normalized property shape per parcel:

    county         "NV-Lyon", "NV-Washoe", …
    apn            assessor parcel number (county-local)
    owner          owner of record
    land_use       land use code or description
    acres          acreage
    assessed_value USD (current assessed value; updated annually)
    sale_price     USD (last recorded sale price; null when not on file)
    sale_date      ISO-8601 (last recorded sale; null when not on file)
    address        site address

URLs are env-overridable — county GIS offices reshuffle URLs more
often than state DWRs do, so every county has its own var.
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from sources._arcgis import iter_features_concurrent


@dataclass
class SourceResult:
    layer_id: str
    geojson_path: Path
    feature_count: int


# Per-county configuration. The default URLs are best-effort — county
# GIS offices republish under new slugs frequently; every URL is
# env-overridable below.
COUNTY_CONFIG: dict[str, dict[str, Any]] = {
    "NV-Washoe": {
        "env_var": "SUBTERRA_PARCELS_NV_WASHOE_URL",
        "default_url": (
            "https://maps.washoecounty.gov/arcgis/rest/services/"
            "Assessor/Parcels/MapServer/0/query"
        ),
        "fields": {
            "apn":            ["APN", "PARCEL_ID", "PARCELNO"],
            "owner":          ["OWNER", "OWNER_NAME", "OWNER1"],
            "land_use":       ["LAND_USE", "LANDUSE", "USE_CODE_DESC", "USE_DESC"],
            "acres":          ["ACRES", "AREA_AC", "TOTAL_ACRE"],
            "assessed_value": ["ASSD_VALUE", "ASSESSED_VALUE", "TOTAL_AV", "AV_TOTAL"],
            "sale_price":     ["SALE_PRICE", "LASTSALE_AMT", "SALE_AMT"],
            "sale_date":      ["SALE_DATE", "LASTSALE_DT", "SALEDATE"],
            "address":        ["SITE_ADDR", "SITUS_ADDR", "ADDRESS", "ADDR"],
        },
    },
    "NV-Clark": {
        "env_var": "SUBTERRA_PARCELS_NV_CLARK_URL",
        "default_url": (
            "https://gisgate.co.clark.nv.us/gisweb/rest/services/"
            "Assessor/Assessor/MapServer/0/query"
        ),
        "fields": {
            "apn":            ["APN", "PARCEL", "PARCELNO"],
            "owner":          ["OWNER", "OWNER_NAME", "OWNER1"],
            "land_use":       ["LAND_USE_DESC", "USE_DESC", "USE_CODE_DESC"],
            "acres":          ["ACRES", "TOTAL_ACRES"],
            "assessed_value": ["TOTAL_ASSESSED_VALUE", "TOTAL_AV", "ASSD_VAL"],
            "sale_price":     ["SALE_AMOUNT", "SALE_PRICE", "LAST_SALE_PRICE"],
            "sale_date":      ["SALE_DATE", "LAST_SALE_DATE"],
            "address":        ["SITUS_ADDRESS", "SITE_ADDR", "ADDRESS"],
        },
    },
    "NV-Elko": {
        "env_var": "SUBTERRA_PARCELS_NV_ELKO_URL",
        "default_url": (
            "https://gis.elkocountynv.net/arcgis/rest/services/"
            "Public/ElkoCountyParcels/MapServer/0/query"
        ),
        "fields": {
            "apn":            ["APN", "PARCEL_ID"],
            "owner":          ["OWNER", "OWNER_NAME"],
            "land_use":       ["USE_CODE_DESC", "LAND_USE", "USE_DESC"],
            "acres":          ["ACRES", "TOTAL_ACRES"],
            "assessed_value": ["TOTAL_AV", "ASSD_VALUE"],
            "sale_price":     ["SALE_PRICE", "SALE_AMOUNT"],
            "sale_date":      ["SALE_DATE"],
            "address":        ["SITUS_ADDR", "ADDRESS"],
        },
    },
    "NV-Lyon": {
        "env_var": "SUBTERRA_PARCELS_NV_LYON_URL",
        "default_url": (
            "https://gis.lyon-county.org/arcgis/rest/services/"
            "Public/Parcels/MapServer/0/query"
        ),
        "fields": {
            "apn":            ["APN", "PARCEL_ID"],
            "owner":          ["OWNER", "OWNER_NAME"],
            "land_use":       ["LAND_USE", "USE_CODE_DESC"],
            "acres":          ["ACRES"],
            "assessed_value": ["TOTAL_AV", "ASSD_VALUE"],
            "sale_price":     ["SALE_PRICE", "SALE_AMOUNT"],
            "sale_date":      ["SALE_DATE"],
            "address":        ["SITUS_ADDR", "ADDRESS"],
        },
    },
}


def _first(props: dict[str, Any], keys: list[str]) -> Any:
    for key in keys:
        v = props.get(key)
        if v in (None, "", " ", "NULL", "null"):
            continue
        return v
    return None


def _parse_date_to_iso(raw: Any) -> str | None:
    if raw is None:
        return None
    if isinstance(raw, (int, float)):
        try:
            return datetime.fromtimestamp(raw / 1000.0, tz=timezone.utc).date().isoformat()
        except (OSError, OverflowError, ValueError):
            return None
    if isinstance(raw, str):
        s = raw.strip().split(" ")[0].split("T")[0]
        for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%Y/%m/%d"):
            try:
                return datetime.strptime(s, fmt).date().isoformat()
            except ValueError:
                continue
    return None


def _parse_money(raw: Any) -> float | None:
    if raw is None or raw == "":
        return None
    try:
        # Strip $ and commas commonly present in assessor strings.
        if isinstance(raw, str):
            raw = raw.replace("$", "").replace(",", "").strip()
        f = float(raw)
        if f != f or f < 0:
            return None
        return f
    except (TypeError, ValueError):
        return None


def _normalize(county: str, fmap: dict[str, list[str]], raw: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {"county": county}
    apn = _first(raw, fmap["apn"])
    if apn is not None:
        out["apn"] = str(apn).strip()
    owner = _first(raw, fmap["owner"])
    if owner is not None:
        out["owner"] = str(owner).strip()
    use = _first(raw, fmap["land_use"])
    if use is not None:
        out["land_use"] = str(use).strip()
    acres = _parse_money(_first(raw, fmap["acres"]))
    if acres is not None:
        out["acres"] = acres
    av = _parse_money(_first(raw, fmap["assessed_value"]))
    if av is not None:
        out["assessed_value"] = av
    sp = _parse_money(_first(raw, fmap["sale_price"]))
    if sp is not None:
        out["sale_price"] = sp
    sd = _parse_date_to_iso(_first(raw, fmap["sale_date"]))
    if sd:
        out["sale_date"] = sd
    addr = _first(raw, fmap["address"])
    if addr is not None:
        out["address"] = str(addr).strip()
    return out


def _fetch_county(
    county: str,
    cfg: dict[str, Any],
    on_feature: Callable[[dict[str, Any]], None],
    log: logging.Logger,
) -> int:
    # See water_rights.py for the rationale — empty env var must fall
    # through to the hardcoded default URL, not get used as the URL.
    url = os.environ.get(cfg["env_var"]) or cfg["default_url"]
    log.info("%s: %s", county, url)
    fmap = cfg["fields"]
    written = 0

    def per_feature(feat: dict[str, Any]) -> None:
        nonlocal written
        geom = feat.get("geometry")
        if not geom or geom.get("type") not in ("Polygon", "MultiPolygon"):
            return
        normalized = _normalize(county, fmap, feat.get("properties") or {})
        on_feature({"type": "Feature", "geometry": geom, "properties": normalized})
        written += 1

    try:
        iter_features_concurrent(
            url,
            on_feature=per_feature,
            progress_label=f"parcels-{county}",
        )
    except Exception as err:  # noqa: BLE001
        log.warning("%s: fetch failed after %d parcels — %s", county, written, err)
    return written


def run(work_dir: Path) -> SourceResult:
    log = logging.getLogger("etl.parcels")
    log.info("starting county parcel download (%d counties)", len(COUNTY_CONFIG))

    out_path = work_dir / "parcels.geojson"
    total_count = 0
    per_county: dict[str, int] = {}
    started = time.monotonic()
    first = [True]

    try:
        with out_path.open("w", encoding="utf-8") as out:
            out.write('{"type":"FeatureCollection","features":[')

            def on_feature(feat: dict[str, Any]) -> None:
                if not first[0]:
                    out.write(",")
                first[0] = False
                json.dump(feat, out)

            for county, cfg in COUNTY_CONFIG.items():
                county_count = _fetch_county(county, cfg, on_feature, log)
                if county_count > 0:
                    per_county[county] = county_count
                    total_count += county_count
                    log.info("  %s: %d parcels", county, county_count)

            out.write("]}")
    except Exception:
        if out_path.exists():
            out_path.unlink()
        raise

    elapsed = time.monotonic() - started
    log.info("wrote %d parcels across %d counties in %.1fs",
             total_count, len(per_county), elapsed)
    log.info("per county: %s", per_county)
    return SourceResult(
        layer_id="parcels",
        geojson_path=out_path,
        feature_count=total_count,
    )
