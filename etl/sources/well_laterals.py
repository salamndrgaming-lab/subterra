"""
Wellbore laterals — the horizontal portion of directional / horizontal
wells, drawn as polylines from kickoff point to bottom-hole location.
Mining audiences read laterals as "what's the horizontal extent of the
producing reservoir here?" — much more spatially honest than treating
each well as a vertical hole at its surface location, which is wrong
for ~all modern unconventional plays.

The layer is referenced in `packages/shared/src/layers.ts` as
`tilesetLayer: 'well_laterals'` but no ETL source existed until this
commit — the layer was silently empty in every published manifest.
That's exactly the kind of silent-broken-layer the new EXPECTED_MIN_FEATURES
floor + per-source summary table are designed to catch.

State commission endpoints that publish wellbore (deviated-survey) data:
  - ND DMR — Bakken laterals, the densest dataset by far
  - CO ECMC — Wattenberg + Piceance laterals
  - WY WOGCC — Powder River + Green River laterals
  - NM EMNRD — Permian + San Juan laterals (state line w/ TX)

TX RRC publishes laterals but only via a CSV bulk-download with a
slightly different schema — defer to a follow-up cluster.
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


@dataclass
class SourceResult:
    layer_id: str
    geojson_path: Path
    feature_count: int


# Per-state configuration. Endpoints are env-overridable: when a state
# commission republishes a service under a new slug, set the matching
# `SUBTERRA_WELL_LATERALS_<STATE>_URL` repo variable and the next
# pipeline run picks it up without a code change.
STATE_SOURCES: list[dict[str, Any]] = [
    {
        "code": "ND",
        "name": "North Dakota DMR (Bakken laterals)",
        "env_var": "SUBTERRA_WELL_LATERALS_ND_URL",
        "default_url": (
            "https://gis.dmr.nd.gov/dmrpublicservices/rest/services/"
            "OilGasPublicMapDataVectorTiles/Wellbores/FeatureServer/0/query"
        ),
        "workers": 4,
    },
    {
        "code": "CO",
        "name": "Colorado ECMC",
        "env_var": "SUBTERRA_WELL_LATERALS_CO_URL",
        "default_url": (
            "https://data.dnrgis.state.co.us/arcgis/rest/services/"
            "DNR_Public/OGCC_Directional_Lines/FeatureServer/0/query"
        ),
        "workers": 4,
    },
    {
        "code": "WY",
        "name": "Wyoming WOGCC",
        "env_var": "SUBTERRA_WELL_LATERALS_WY_URL",
        "default_url": (
            "https://gis.deq.wyoming.gov/arcgis/rest/services/"
            "WOGCC/Directional_Surveys/MapServer/0/query"
        ),
        "workers": 3,
    },
    {
        "code": "NM",
        "name": "New Mexico EMNRD OCD",
        "env_var": "SUBTERRA_WELL_LATERALS_NM_URL",
        "default_url": (
            "https://gis.emnrd.nm.gov/arcgis/rest/services/"
            "OCD/OCD_Public/MapServer/2/query"
        ),
        "workers": 3,
    },
]


def _first(props: dict[str, Any], *keys: str) -> Any:
    for k in keys:
        v = props.get(k)
        if v not in (None, "", " ", "NULL", "null"):
            return v
    return None


def _normalize(state: str, raw: dict[str, Any]) -> dict[str, Any]:
    """Canonical lateral attributes — every state names them differently."""
    out: dict[str, Any] = {"state": state}
    api = _first(raw, "API_NUM", "API_NUMBER", "APINumber", "api", "API")
    if api is not None:
        out["api"] = str(api).strip()
    name = _first(raw, "WELL_NAME", "WellName", "well_name", "NAME", "name")
    if name is not None:
        out["name"] = str(name).strip()
    operator = _first(raw, "OPERATOR", "Operator", "OPERATOR_NAME", "operator_name", "OPERATOR1")
    if operator is not None:
        out["operator"] = str(operator).strip()
    field = _first(raw, "FIELD", "Field", "FIELD_NAME", "field_name", "POOL")
    if field is not None:
        out["field"] = str(field).strip()
    status = _first(raw, "STATUS", "Status", "WELL_STATUS", "well_status")
    if status is not None:
        out["status"] = str(status).strip()
    return out


def run(work_dir: Path) -> SourceResult:
    log = logging.getLogger("etl.well_laterals")
    log.info("starting well-lateral download (%d states)", len(STATE_SOURCES))

    out_path = work_dir / "well_laterals.geojson"
    total_count = 0
    per_state: dict[str, int] = {}
    started = time.monotonic()
    first = [True]

    try:
        with out_path.open("w", encoding="utf-8") as out:
            out.write('{"type":"FeatureCollection","features":[')

            def on_feature(state_code: str, feat: dict[str, Any]) -> None:
                nonlocal total_count
                geom = feat.get("geometry")
                if not geom:
                    return
                # Laterals are LineStrings. Some services serve them
                # as MultiLineStrings (one feature per surveyed run);
                # accept both.
                if geom.get("type") not in ("LineString", "MultiLineString"):
                    return
                normalized = _normalize(state_code, feat.get("properties") or {})
                if not first[0]:
                    out.write(",")
                first[0] = False
                json.dump(
                    {"type": "Feature", "geometry": geom, "properties": normalized},
                    out,
                )
                total_count += 1

            for src in STATE_SOURCES:
                code = src["code"]
                # `or`-fallback so an empty env var (GitHub Actions sets
                # unset repo Variables to "") doesn't override the default.
                url = os.environ.get(src["env_var"]) or src["default_url"]
                log.info("%s: %s", code, url)
                before = total_count

                def per_feature(feat: dict[str, Any], _code: str = code) -> None:
                    on_feature(_code, feat)

                try:
                    iter_features_concurrent(
                        url,
                        on_feature=per_feature,
                        workers=src.get("workers", 4),
                        progress_label=f"well_laterals-{code}",
                    )
                except Exception as err:  # noqa: BLE001
                    log.warning("%s: fetch failed after %d lats — %s",
                                code, total_count - before, err)
                state_count = total_count - before
                if state_count > 0:
                    per_state[code] = state_count
                    log.info("  %s: %d laterals", code, state_count)

            out.write("]}")
    except Exception:
        if out_path.exists():
            out_path.unlink()
        raise

    elapsed = time.monotonic() - started
    log.info("wrote %d laterals across %d states in %.1fs",
             total_count, len(per_state), elapsed)
    log.info("per state: %s", per_state)
    return SourceResult(
        layer_id="well_laterals",
        geojson_path=out_path,
        feature_count=total_count,
    )
