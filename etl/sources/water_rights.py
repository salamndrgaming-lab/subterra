"""
Water rights — per-state diversion-point datasets (NV + UT + AZ).

Every western state publishes a water-rights GIS feed (usually as an
ArcGIS REST FeatureServer). We aggregate the three biggest mining
states first; the same pattern extends to CO / NM / ID / MT / WY / CA /
OR / WA in follow-up PRs.

Each state uses different attribute names for owner / priority date /
source / use-type. We normalize to a single canonical property shape:

    state          two-letter state code
    owner          claimant or owner of record
    priority_date  ISO-8601 (YYYY-MM-DD); null when the source doesn't
                   publish a date (e.g. vested rights pre-statehood)
    source         hydrologic source — stream name or "Underground"
    use_type       primary beneficial use (Mining / Stockwater / …)
    diversion_cfs  permitted diversion rate (cubic feet / second)
    diversion_afy  permitted annual volume (acre-feet / year)
    status         Certificated / Permitted / Vested / Decreed / …

URLs are env-overridable — every state's hub occasionally republishes
the endpoint under a new slug, and we don't want a URL refresh to
require a code change. Defaults below are the URLs current as of the
ETL pipeline's last verified run; override per state with:

    SUBTERRA_WATER_RIGHTS_NV_URL=...
    SUBTERRA_WATER_RIGHTS_UT_URL=...
    SUBTERRA_WATER_RIGHTS_AZ_URL=...

Per-state try/except so a single broken state doesn't drop the layer.
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

from etl.sources._arcgis import iter_features_concurrent


@dataclass
class SourceResult:
    layer_id: str
    geojson_path: Path
    feature_count: int


# ─── Per-state configuration ────────────────────────────────────────────

# Each entry: (env-var name, default endpoint, attribute-name mappings).
# Mappings are ordered candidate lists — the first non-empty hit wins.

# NV Division of Water Resources — Points of Diversion.
NV_DEFAULT_URL = (
    "https://services1.arcgis.com/cZxbsh07jHL5z9pp/arcgis/rest/services/"
    "Points_of_Diversion/FeatureServer/0/query"
)

# UT Division of Water Rights — Water Rights points.
UT_DEFAULT_URL = (
    "https://services.arcgis.com/ZzrwjTRez6FJiOq4/arcgis/rest/services/"
    "Water_Rights/FeatureServer/0/query"
)

# AZ Department of Water Resources — Surface + groundwater water rights.
AZ_DEFAULT_URL = (
    "https://gisweb.azwater.gov/arcgis/rest/services/PublicData/"
    "WaterRights/MapServer/0/query"
)

STATE_CONFIG: dict[str, dict[str, Any]] = {
    "NV": {
        "env_var": "SUBTERRA_WATER_RIGHTS_NV_URL",
        "default_url": NV_DEFAULT_URL,
        "fields": {
            "owner": ["OWNER", "OWNER_NAME", "owner", "applicant", "APPLICANT"],
            "priority_date": ["PRIORITY", "PRIORITY_DATE", "P_DATE", "priority_dt"],
            "source": ["SOURCE", "WATER_SOURCE", "source_name"],
            "use_type": ["USE", "USE_TYPE", "MAN_OF_USE", "manner_of_use"],
            "diversion_cfs": ["CFS", "DUTY_CFS", "RATE_CFS", "cfs"],
            "diversion_afy": ["AFY", "DUTY_AFY", "RATE_AFY", "duty_afy"],
            "status": ["STATUS", "APP_STATUS", "RIGHT_STATUS", "status"],
        },
    },
    "UT": {
        "env_var": "SUBTERRA_WATER_RIGHTS_UT_URL",
        "default_url": UT_DEFAULT_URL,
        "fields": {
            "owner": ["OWNER_NAME", "OWNER", "USER_NAME", "owner"],
            "priority_date": ["PRIORITY_DATE", "PRIORITY", "priority"],
            "source": ["SOURCE", "WATER_SOURCE", "source"],
            "use_type": ["USES", "USE_TYPE", "USE", "uses"],
            "diversion_cfs": ["FLOW_CFS", "CFS", "flow"],
            "diversion_afy": ["VOLUME_AF", "VOLUME", "AFY", "duty"],
            "status": ["STATUS", "WR_STATUS", "status"],
        },
    },
    "AZ": {
        "env_var": "SUBTERRA_WATER_RIGHTS_AZ_URL",
        "default_url": AZ_DEFAULT_URL,
        "fields": {
            "owner": ["OWNER", "OWNER_NAME", "APPLICANT", "owner"],
            "priority_date": ["PRIORITY_DATE", "PRIORITYDT", "PRIORITY", "p_date"],
            "source": ["SOURCE", "WATER_SRC", "source"],
            "use_type": ["USE", "USE_TYPE", "BENEF_USE", "use"],
            "diversion_cfs": ["CFS", "RATE_CFS", "RATE", "cfs"],
            "diversion_afy": ["AFY", "VOLUME_AF", "ANNUAL_VOL", "afy"],
            "status": ["STATUS", "RIGHT_STATUS", "status"],
        },
    },
}


# ─── Field normalization helpers ────────────────────────────────────────

def _first_nonempty(props: dict[str, Any], candidates: list[str]) -> Any:
    """Return the first non-null/empty value among the candidate keys.
    Empty strings, ' ', None, and the string 'NULL' are treated as absent."""
    for key in candidates:
        v = props.get(key)
        if v in (None, "", " ", "NULL", "null"):
            continue
        return v
    return None


def _parse_date_to_iso(raw: Any) -> str | None:
    """ArcGIS dates come as either epoch-ms ints or already-formatted
    strings depending on the service. Normalize to YYYY-MM-DD. Returns
    None when the value isn't a parseable date."""
    if raw is None:
        return None
    if isinstance(raw, (int, float)):
        # Epoch ms — most ArcGIS feature-services serialize dates this way.
        try:
            dt = datetime.fromtimestamp(raw / 1000.0, tz=timezone.utc)
            return dt.date().isoformat()
        except (OSError, OverflowError, ValueError):
            return None
    if isinstance(raw, str):
        s = raw.strip()
        if not s:
            return None
        # Strip time-of-day suffixes like " 00:00:00" before parsing.
        s = s.split(" ")[0].split("T")[0]
        for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%Y/%m/%d"):
            try:
                dt = datetime.strptime(s, fmt)
                return dt.date().isoformat()
            except ValueError:
                continue
    return None


def _parse_float(raw: Any) -> float | None:
    if raw is None or raw == "":
        return None
    try:
        f = float(raw)
        if f != f:  # NaN
            return None
        return f
    except (TypeError, ValueError):
        return None


def _normalize(state: str, fields_map: dict[str, list[str]], raw: dict[str, Any]) -> dict[str, Any]:
    """Translate a state-specific raw attribute dict into the canonical
    property shape documented at the top of this module."""
    out: dict[str, Any] = {"state": state}

    owner = _first_nonempty(raw, fields_map["owner"])
    if owner is not None:
        out["owner"] = str(owner).strip()

    pd = _first_nonempty(raw, fields_map["priority_date"])
    iso = _parse_date_to_iso(pd)
    if iso:
        out["priority_date"] = iso

    src = _first_nonempty(raw, fields_map["source"])
    if src is not None:
        out["source"] = str(src).strip()

    use = _first_nonempty(raw, fields_map["use_type"])
    if use is not None:
        out["use_type"] = str(use).strip()

    cfs = _parse_float(_first_nonempty(raw, fields_map["diversion_cfs"]))
    if cfs is not None:
        out["diversion_cfs"] = cfs

    afy = _parse_float(_first_nonempty(raw, fields_map["diversion_afy"]))
    if afy is not None:
        out["diversion_afy"] = afy

    status = _first_nonempty(raw, fields_map["status"])
    if status is not None:
        out["status"] = str(status).strip()

    return out


# ─── Main entry point ───────────────────────────────────────────────────

def _fetch_state(
    state: str,
    cfg: dict[str, Any],
    on_feature: Callable[[dict[str, Any]], None],
    log: logging.Logger,
) -> int:
    url = os.environ.get(cfg["env_var"], cfg["default_url"])
    log.info("%s: %s", state, url)
    fields_map = cfg["fields"]
    written = 0

    def per_feature(feat: dict[str, Any]) -> None:
        nonlocal written
        geom = feat.get("geometry")
        if not geom:
            return
        # Restrict to Point-of-Diversion geometry. Some state services
        # also publish polygon service areas; those would need a paired
        # fill layer in shared/layers.ts and double the rendering work.
        # Initial ship: points only. Polygons can land as a follow-up.
        if geom.get("type") != "Point":
            return
        raw_props = feat.get("properties") or {}
        normalized = _normalize(state, fields_map, raw_props)
        on_feature({"type": "Feature", "geometry": geom, "properties": normalized})
        written += 1

    try:
        iter_features_concurrent(
            url,
            on_feature=per_feature,
            progress_label=f"water_rights-{state}",
        )
    except Exception as err:  # noqa: BLE001
        log.warning("%s: fetch failed after %d features — %s", state, written, err)
    return written


def run(work_dir: Path) -> SourceResult:
    log = logging.getLogger("etl.water_rights")
    log.info("starting water-rights download (%d states)", len(STATE_CONFIG))

    out_path = work_dir / "water_rights.geojson"
    total_count = 0
    per_state: dict[str, int] = {}
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

            for state, cfg in STATE_CONFIG.items():
                state_count = _fetch_state(state, cfg, on_feature, log)
                if state_count > 0:
                    per_state[state] = state_count
                    total_count += state_count
                    log.info("  %s: %d features", state, state_count)

            out.write("]}")
    except Exception:
        if out_path.exists():
            out_path.unlink()
        raise

    elapsed = time.monotonic() - started
    log.info(
        "wrote %d water-rights features across %d states in %.1fs",
        total_count, len(per_state), elapsed,
    )
    log.info("per state: %s", per_state)
    return SourceResult(
        layer_id="water_rights",
        geojson_path=out_path,
        feature_count=total_count,
    )
