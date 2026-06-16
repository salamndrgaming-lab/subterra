"""
BLM Mineral Withdrawals — national withdrawn-lands polygon layer.

Withdrawals are the single biggest correctness blocker for the
"open BLM land" set difference: a polygon can be agency=BLM in the
SMA layer but still be closed to mineral entry because Congress or
an executive order withdrew it from location under the 1872 mining
law. Without this layer the Notice-of-Location export sits on top
of a layer that lies.

Source: BLM National Withdrawn Lands (ArcGIS MapServer published by
the BLM National Operations Center). The endpoint exposes the LR2000
case-recordation data as polygon features with attributes for
withdrawal type, effective date, and mineral status.

Endpoint discovery
------------------
The MapServer URL has moved a few times; we keep the most recent
known-good default and let the operator override via env. The
ArcGIS REST query helper in `_arcgis.py` handles pagination + retry.
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
    "https://gis.blm.gov/arcgis/rest/services/lands/"
    "BLM_Natl_Withdrawn_Lands/MapServer/0/query"
)


@dataclass
class SourceResult:
    layer_id: str
    geojson_path: Path
    feature_count: int


_PROP_KEYS = {
    "name": ["case_name", "name", "withdraw_n", "withdrawal_name"],
    "type": [
        "withdraw_t", "withdrawal_type", "wd_type",
        "case_type", "type_code",
    ],
    "purpose": ["purpose", "wd_purpose", "withdrawal_purpose"],
    "mineral_status": [
        "min_status", "mineral_status", "mineral_seg_status",
        "segregation_type",
    ],
    "agency": ["admin_agcy", "admin_agency", "agency", "agcy"],
    "effective_at": [
        "effective_date", "eff_date", "effective_dt",
        "wd_eff_dt", "date_effective",
    ],
    "expires_at": [
        "expiration_date", "exp_date", "expir_date", "wd_exp_dt",
    ],
    "case_serial": ["serial_nr", "case_serial_nr", "serial", "case_nr"],
}


def _coalesce(props: dict[str, Any], keys: list[str]) -> Any:
    for k in keys:
        if k in props and props[k] not in (None, "", " "):
            return props[k]
        ku = k.upper()
        if ku in props and props[ku] not in (None, "", " "):
            return props[ku]
    return None


def _normalize(props: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for canon, candidates in _PROP_KEYS.items():
        v = _coalesce(props, candidates)
        if v is not None:
            out[canon] = v
    # Default mineral_status to "Closed" when the field is absent — the
    # presence of a polygon in the withdrawn-lands service implies the
    # area is at least segregated from new entry; we'd rather over-flag
    # than under-flag for the eligibility check.
    out.setdefault("mineral_status", "Closed")
    return out


def run(work_dir: Path) -> SourceResult:
    log = logging.getLogger("etl.withdrawals")
    # Accept either SUBTERRA_WITHDRAWALS_URL (canonical, set in
    # pipeline.yml) or BLM_WITHDRAWALS_URL (legacy) for the override.
    url = (
        os.environ.get("SUBTERRA_WITHDRAWALS_URL")
        or os.environ.get("BLM_WITHDRAWALS_URL")
        or DEFAULT_QUERY_URL
    )
    log.info("starting BLM withdrawals download from %s", url)

    out_path = work_dir / "withdrawals.geojson"
    started = time.monotonic()
    feature_count = 0
    by_status: dict[str, int] = {}

    try:
        with out_path.open("w", encoding="utf-8") as out:
            out.write('{"type":"FeatureCollection","features":[')
            first = [True]

            def on_feature(feat: dict[str, Any]) -> None:
                nonlocal feature_count
                geom = feat.get("geometry")
                if not geom:
                    return
                props = _normalize(feat.get("properties") or {})
                if not first[0]:
                    out.write(",")
                first[0] = False
                json.dump({"type": "Feature", "geometry": geom, "properties": props}, out)
                feature_count += 1
                status = str(props.get("mineral_status", "Unknown"))
                by_status[status] = by_status.get(status, 0) + 1

            iter_features_concurrent(
                url,
                on_feature=on_feature,
                progress_label="withdrawals",
            )
            out.write("]}")
    except Exception:
        if out_path.exists():
            out_path.unlink()
        raise

    elapsed = time.monotonic() - started
    log.info(
        "wrote %d withdrawal polygons in %.1fs (by status: %s)",
        feature_count, elapsed, by_status,
    )
    return SourceResult(
        layer_id="withdrawals",
        geojson_path=out_path,
        feature_count=feature_count,
    )
