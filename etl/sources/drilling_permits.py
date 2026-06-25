"""
Multi-state oil & gas drilling permits — leading-indicator data.

A permit is filed weeks-to-months before a well is actually spudded.
Tracking the permit pipeline is the single most-requested O&G
analyst feature this app lacks today: it surfaces operator activity
*before* the well hits the wells layer, which is the killer feature
landmen + acreage scouts pay Enverus thousands of dollars per seat
for. Coverage today is the two highest-permit-volume western
shales:

  - ND  Bakken / Three Forks (Williston Basin) — DMR publishes
        permits in the same OilGasPublicMapDataVectorTiles
        FeatureServer family as wells. Highest US permit-count
        state per Baker Hughes weekly rig data.
  - CO  DJ Basin (Niobrara) — ECMC (was COGCC) publishes via the
        OGCC_Oil_and_Gas_Locations FeatureServer. Approved-for-
        drilling + recompletion points.

TX is the biggest gap — TX RRC publishes drilling permits only via
the W-1 webapp form (webapps2.rrc.texas.gov/EWA/...), no public GIS
endpoint. Adding it requires a separate HTML-scraper + CSV-pull path,
queued for a follow-up PR. OK + NM (next-highest permit-count states)
join in the same follow-up shape — both have ArcGIS REST endpoints,
just need confirmation of the layer index.

Per-state URL is env-overridable via SUBTERRA_PERMITS_<CODE>_URL.
Both states ship in ACCEPT_BROKEN on first run since the canonical
layer indices are best-guess (CO ECMC's locations FeatureServer has
multiple sublayers; the permits-specific index isn't public-
documented). Iterate via SUBTERRA_PERMITS_CO_URL or
SUBTERRA_PERMITS_ND_URL if the first run surfaces a 404.
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
        # ND DMR's permits sub-service in the OilGasPublicMapData family.
        # Same parent FeatureServer org as the existing ND wells entry —
        # high confidence the namespace exists; layer index is the
        # best-guess part.
        "code": "ND",
        "name": "North Dakota DMR Permits",
        "service": "https://gis.dmr.nd.gov/dmrpublicservices/rest/services/OilGasPublicMapDataVectorTiles/Permits/FeatureServer",
        "layer": 0,
        "workers": 3,
        "env_var": "SUBTERRA_PERMITS_ND_URL",
    },
    {
        # CO ECMC OGCC locations service — multiple sublayers
        # (wells, permits, locations). Layer 1 is the convention for
        # permits-as-points across DNR's similar services; iterate via
        # SUBTERRA_PERMITS_CO_URL if the actual index differs.
        "code": "CO",
        "name": "Colorado ECMC Permits",
        "service": "https://data.dnrgis.state.co.us/arcgis/rest/services/DNR_Public/OGCC_Oil_and_Gas_Locations/FeatureServer",
        "layer": 1,
        "workers": 3,
        "env_var": "SUBTERRA_PERMITS_CO_URL",
    },
]


@dataclass
class SourceResult:
    layer_id: str
    geojson_path: Path
    feature_count: int


def _normalize_props(p: dict[str, Any], state_code: str) -> dict[str, Any]:
    """Each state uses different field names — coalesce to a stable shape
    matching the LayerDef + features.db's expected attrs. Lines up with
    the wells normalization so the well drawer can reuse the same
    rendering code paths."""
    def first(*keys: str) -> object:
        for k in keys:
            for cased in (k, k.upper(), k.lower()):
                v = p.get(cased)
                if v not in (None, "", " ", -999):
                    return v
        return None

    raw = {
        # Permit / application identifier — distinct from the API number
        # because a permit can be issued before an API is assigned. Both
        # states use slightly different conventions; surface as
        # `permit_no` so the drawer can show "Permit: 12345" cleanly.
        "permit_no": first(
            "PERMIT_NO", "PERMITNO", "PERMIT_NUM", "PermitNo",
            "DOCKET_NO", "PERMIT_ID", "APD_ID", "FILE_NO",
        ),
        # When the permit was filed / approved — the leading-indicator
        # timestamp the sidebar pill will eventually diff against.
        "filed_at": first(
            "PERMIT_DATE", "PERMITDATE", "APP_DATE", "DATE_FILED",
            "DATE_RECVD", "DateApproved", "PERMITDATEAPPROVED",
            "RECEIVED_DATE", "ApprovalDate",
        ),
        "status": first(
            "STATUS", "PERMIT_STATUS", "APPROVAL_STATUS", "PermitStatus",
        ),
        # Operator filing the permit — the "who is moving" signal.
        "operator": first(
            "OPERATOR", "OPERATOR_NAME", "OPER_NAME", "COMPANY",
            "Operator", "CurrentOperator",
        ),
        "name": first("WELL_NAME", "well_name", "NAME", "Name", "WellName"),
        # Target formation / pool — the geologist's quick filter.
        "formation": first(
            "FORMATION", "POOL", "TARGET_FORMATION", "FORMATION_NAME",
            "Pool", "FieldName",
        ),
        # If the permit specifies a TVD/MD, surface it (informative
        # not authoritative — wells get re-measured at completion).
        "depth_ft": first(
            "TOTAL_DEPTH", "TOTAL_DEPT", "PROPOSED_TD", "TD", "td",
            "MeasuredDepth",
        ),
        "well_type": first(
            "WELL_TYPE", "WELL_TYPE_NAME", "PROPOSED_TYPE", "TYPE",
            "Permit_Type",
        ),
        "county": first("COUNTY", "County", "COUNTY_NAME"),
        "state": state_code,
    }
    return {k: v for k, v in raw.items() if v is not None}


def run(work_dir: Path) -> SourceResult:
    log = logging.getLogger("etl.drilling_permits")
    log.info("starting multi-state drilling-permits download")

    out_path = work_dir / "drilling_permits.geojson"
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
                        progress_label=f"permits-{state['code']}",
                    )
                    log.info("  %s: %d permits", state["name"], state_count[0])
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
    log.info(
        "wrote %d drilling permits across %d states in %.1fs — %s",
        total_count, len(per_state), elapsed, per_state,
    )
    return SourceResult(
        layer_id="drilling_permits",
        geojson_path=out_path,
        feature_count=total_count,
    )
