"""
Multi-state oil & gas wells.

State commissions publish wellbore data via ArcGIS REST endpoints.
Fetches the major-state services in sequence; per-state failures are
caught so one broken endpoint doesn't drop the whole layer.

States covered:
  - TX  Texas RRC (Permian + Eagle Ford + Haynesville-TX + Anadarko-TX),
        via the Harris County GIS mirror at gis.hctx.net. TX RRC's own
        gis.rrc.texas.gov has historically slug-shifted on every
        republish; the HCTX TXRRC/Wells MapServer is a stable
        public-mirror of the same underlying RRC dataset. Largest
        single-state contribution by a wide margin (~1M wells when
        healthy vs ~100-200k for any other state).
  - CO  Colorado ECMC (DJ Basin + Piceance), via dnrgis.state.co.us
  - ND  North Dakota DMR (Bakken / Williston), via gis.dmr.nd.gov
  - WY  Wyoming WOGCC (Powder River + Green River), via gis.deq.wyoming.gov

The previous NASA NCCS HIFLD mirror was consistently returning 503
under our query load. State commissions are the authoritative source
anyway and have stable per-state ArcGIS REST endpoints that better
support paginated bulk fetches.

Per-state URL is env-overridable via SUBTERRA_WELLS_<CODE>_URL
(e.g. SUBTERRA_WELLS_TX_URL) so a slug shift can be fixed without
a code change. Document the names in pipeline.yml when adding new
states.

Next-state shortlist (post-TX): OK (OCC), NM (EMNRD), KS (KCC),
LA (DNR), MT (BOGC), CA (CalGEM), PA (DEP), OH (ODNR), WV (WVDEP),
AK (AOGCC). OK + NM are the highest-impact next adds — together with
TX they cover ~85% of US producing wells by count.
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

STATE_SOURCES: list[dict[str, Any]] = [
    {
        # TX RRC via the Harris County GIS mirror — gis.rrc.texas.gov
        # publishes through the HCTX/arcgishcpid org's TXRRC/Wells
        # MapServer. Same upstream RRC data; more stable URL surface
        # than the RRC's own GIS Viewer endpoints (which have
        # republished multiple times since 2020). Layer 0 = surface
        # holes (well point locations). Layer 1 is bottom holes; skip
        # for now since map-view use cases overlap with surface points.
        # Workers kept at 3 since the county GIS server isn't built
        # for high fan-out concurrency.
        "code": "TX",
        "name": "Texas RRC (HCTX mirror)",
        "service": "https://www.gis.hctx.net/arcgishcpid/rest/services/TXRRC/Wells/MapServer",
        "layer": 0,
        "workers": 3,
        "env_var": "SUBTERRA_WELLS_TX_URL",
    },
    {
        "code": "CO",
        "name": "Colorado ECMC",
        "service": "https://data.dnrgis.state.co.us/arcgis/rest/services/DNR_Public/OGCC_Wells/FeatureServer",
        "layer": 0,
        "workers": 4,
        "env_var": "SUBTERRA_WELLS_CO_URL",
    },
    {
        "code": "ND",
        "name": "North Dakota DMR",
        "service": "https://gis.dmr.nd.gov/dmrpublicservices/rest/services/OilGasPublicMapDataVectorTiles/Wells/FeatureServer",
        "layer": 0,
        "workers": 4,
        "env_var": "SUBTERRA_WELLS_ND_URL",
    },
    {
        "code": "WY",
        "name": "Wyoming WOGCC",
        "service": "https://gis.deq.wyoming.gov/arcgis_443/rest/services/WOGCC_WELLS/MapServer",
        "layer": 0,
        "workers": 3,
        "env_var": "SUBTERRA_WELLS_WY_URL",
    },
]


@dataclass
class SourceResult:
    layer_id: str
    geojson_path: Path
    feature_count: int


def _normalize_props(p: dict[str, Any], state_code: str) -> dict[str, Any]:
    """Each state uses different field names; coalesce to a stable shape."""
    def first(*keys: str) -> object:
        for k in keys:
            for cased in (k, k.upper(), k.lower()):
                v = p.get(cased)
                if v not in (None, "", " ", -999):
                    return v
        return None

    raw = {
        # TX RRC publishes API as API_NO / API_NO_14; existing aliases
        # carry the other states' variants (API14, API10, FileNumber).
        "api": first(
            "api", "API", "API_NUM", "API_LABEL", "API10", "API14",
            "API_NO", "API_NO_14", "API_NO_10",
            "FileNumber", "FILE_NUMBER",
        ),
        "name": first("WELL_NAME", "well_name", "NAME", "Name", "WellName", "well_name_t"),
        "operator": first(
            "OPERATOR", "OPERATOR_NAME", "OPER_NAME", "COMPANY", "Operator",
            "CURRENT_OP", "CurrentOperator", "ApiOperatorName",
        ),
        "status": first("STATUS", "WELL_STATUS", "WellStatus", "FAC_STATUS", "well_status"),
        # TX RRC uses WELL_TYPE_NAME (vs other states' WELL_TYPE/TYPE).
        "type": first(
            "WELL_TYPE", "TYPE", "PROD_TYPE", "well_type",
            "FAC_TYPE", "facility_type", "WELL_TYPE_NAME",
        ),
        "state": state_code,
        "county": first("COUNTY", "County", "COUNTY_NAME"),
        # TX RRC FIELD_NAME / FIELD_NO is the regulator-defined
        # producing field — Permian / Eagle Ford analysts rely on it
        # for sub-play grouping. Other states (ND, CO) also publish a
        # field name; surface it as a canonical attr so the well
        # detail drawer can show "Field: SPRABERRY (TREND AREA)".
        "field": first("FIELD_NAME", "FIELDNAME", "FIELD", "Field", "field_name"),
        "spud_at": first("SPUD_DATE", "SPUDDATE", "SPUD_DT", "spud_date"),
        "depth_ft": first("TOTAL_DEPTH", "TOTAL_DEPT", "TD", "td", "MeasuredDepth"),
    }
    return {k: v for k, v in raw.items() if v is not None}


def run(work_dir: Path) -> SourceResult:
    log = logging.getLogger("etl.wells")
    log.info("starting multi-state oil & gas wells download")

    out_path = work_dir / "wells.geojson"
    total_count = 0
    started = time.monotonic()
    first = [True]
    per_state: dict[str, int] = {}

    try:
        with out_path.open("w", encoding="utf-8") as out:
            out.write('{"type":"FeatureCollection","features":[')

            for state in STATE_SOURCES:
                state_count = [0]

                def emit(feat: dict[str, Any], _state=state) -> None:
                    geom = feat.get("geometry")
                    if not geom or geom.get("type") != "Point":
                        return
                    coords = geom.get("coordinates") or []
                    if len(coords) < 2 or coords[0] is None or coords[1] is None:
                        return
                    props = _normalize_props(
                        feat.get("properties") or feat.get("attributes") or {},
                        _state["code"],
                    )
                    if not first[0]:
                        out.write(",")
                    first[0] = False
                    json.dump({"type": "Feature", "geometry": geom, "properties": props}, out)
                    state_count[0] += 1

                # Per-state env override — slug shifts get fixed
                # without a code change. Default falls back to the
                # service URL committed in STATE_SOURCES.
                env_key = state.get("env_var")
                override = os.environ.get(env_key) if env_key else None
                if override:
                    query_url = override.rstrip("/")
                    if not query_url.endswith("/query"):
                        query_url = f"{query_url}/query"
                    log.info("using env override %s = %s", env_key, query_url)
                else:
                    query_url = f"{state['service']}/{state['layer']}/query"
                log.info("fetching %s (%s)", state["name"], query_url)
                try:
                    iter_features_concurrent(
                        query_url,
                        on_feature=emit,
                        workers=state["workers"],
                        retries=4,
                        progress_label=f"wells-{state['code']}",
                    )
                    log.info("  %s: %d wells", state["name"], state_count[0])
                    per_state[state["code"]] = state_count[0]
                    total_count += state_count[0]
                except Exception as err:  # noqa: BLE001
                    log.warning("  %s FAILED — %s: %s", state["name"], type(err).__name__, err)
                    continue

            out.write("]}")
    except Exception:
        if out_path.exists():
            out_path.unlink()
        raise

    elapsed = time.monotonic() - started
    log.info("wrote %d wells across %d states in %.1fs — %s", total_count, len(per_state), elapsed, per_state)
    return SourceResult(
        layer_id="wells",
        geojson_path=out_path,
        feature_count=total_count,
    )
