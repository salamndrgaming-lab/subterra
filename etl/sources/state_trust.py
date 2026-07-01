"""
State trust lands — public land that states actively lease + sell.

Answers the "public land I could potentially acquire or lease" question.
State trust lands are granted sections held by state land offices to fund
public institutions (mostly schools); they're routinely leased for
grazing, agriculture, minerals, and commercial use, and periodically
auctioned for sale. Unlike BLM/GSA "land for sale" — which is published
only as event-based web listings (realestatesales.gov / disposal.gsa.gov),
with no GIS feed — state trust land IS published as queryable GIS by the
state land departments, so it's the ingestible half of the "for sale /
public" picture.

Multi-state, same shape as parcels/wells: statewide FeatureServers,
env-overridable per state (SUBTERRA_STATE_TRUST_<STATE>_URL), per-state
try/except so one broken endpoint doesn't drop the layer.

Coverage today (search-confirmed 2026-07-01):
  AZ — ASLD State Trust surface parcels (services updated monthly)
  MT — DNRC Trust Lands surface tracts
Wanted next: NM (State Land Office), UT (SITLA), WY, CO, ID, OR, WA,
ND, SD, NE, OK, TX (GLO) — add each via its repo variable once a
statewide /query URL is confirmed.
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
        "code": "AZ",
        "name": "Arizona ASLD",
        "url": "https://server.azgeo.az.gov/arcgis/rest/services/azland/"
               "State_Trust_Parcels/FeatureServer/0/query",
        "env_var": "SUBTERRA_STATE_TRUST_AZ_URL",
        "workers": 4,
    },
    {
        "code": "MT",
        "name": "Montana DNRC",
        "url": "https://gis.dnrc.mt.gov/arcgis/rest/services/DNRALL/"
               "BasemapService/MapServer/32/query",
        "env_var": "SUBTERRA_STATE_TRUST_MT_URL",
        "workers": 3,
    },
]


@dataclass
class SourceResult:
    layer_id: str
    geojson_path: Path
    feature_count: int


def _first(props: dict, *keys: str) -> object:
    for k in keys:
        for cased in (k, k.upper(), k.lower()):
            v = props.get(cased)
            if v not in (None, "", " "):
                return v
    return None


def _normalize(props: dict, state_code: str) -> dict:
    """Surface the lease/use-relevant attrs. Field names vary by state
    land office; coalesce over the common ones."""
    out: dict = {"state": state_code}
    name = _first(props, "NAME", "PARCEL", "PARCEL_ID", "TRUST_ID", "TractName", "LEGALDESC")
    if name is not None:
        out["name"] = str(name).strip()
    use = _first(props, "USE", "USE_TYPE", "LEASE_TYPE", "LU", "LANDUSE", "SURFACE_USE")
    if use is not None:
        out["use_type"] = str(use).strip()
    trust = _first(props, "TRUST", "BENEFICIARY", "TRUST_BENE", "FUND")
    if trust is not None:
        out["beneficiary"] = str(trust).strip()
    acres = _first(props, "ACRES", "GIS_ACRES", "AREA_AC", "GISACRES", "LEGALACRE")
    if acres is not None:
        try:
            out["acres"] = round(float(acres), 1)
        except (TypeError, ValueError):
            pass
    return out


def run(work_dir: Path) -> SourceResult:
    log = logging.getLogger("etl.state_trust")
    log.info("starting multi-state trust-lands download")

    out_path = work_dir / "state_trust.geojson"
    total = 0
    started = time.monotonic()
    first = [True]
    per_state: dict[str, int] = {}

    try:
        with out_path.open("w", encoding="utf-8") as out:
            out.write('{"type":"FeatureCollection","features":[')

            for state in STATE_SOURCES:
                state_count = [0]

                def on_feature(feat: dict[str, Any], _st=state) -> None:
                    geom = feat.get("geometry")
                    if not geom or geom.get("type") not in ("Polygon", "MultiPolygon"):
                        return
                    props = _normalize(feat.get("properties") or {}, _st["code"])
                    if not first[0]:
                        out.write(",")
                    first[0] = False
                    json.dump(
                        {"type": "Feature", "geometry": geom, "properties": props}, out,
                    )
                    state_count[0] += 1

                url = os.environ.get(state["env_var"], "").strip() or state["url"]
                log.info("fetching %s trust lands: %s", state["name"], url)
                try:
                    iter_features_concurrent(
                        url,
                        on_feature=on_feature,
                        workers=state["workers"],
                        retries=4,
                        progress_label=f"state_trust-{state['code']}",
                    )
                    log.info("  %s: %d tracts", state["name"], state_count[0])
                    per_state[state["code"]] = state_count[0]
                    total += state_count[0]
                except Exception as err:  # noqa: BLE001
                    log.warning("  %s FAILED — %s: %s", state["name"], type(err).__name__, err)
                    msg = f"{type(err).__name__}: {err}".replace("\n", " ")[:200]
                    print(f"::warning::state_trust {state['code']} failed: {msg} [url={url}]")
                    continue

            out.write("]}")
    except Exception:
        if out_path.exists():
            out_path.unlink()
        raise

    elapsed = time.monotonic() - started
    log.info(
        "wrote %d trust-land tracts across %d states in %.1fs — %s",
        total, len(per_state), elapsed, per_state,
    )

    return SourceResult(
        layer_id="state_trust",
        geojson_path=out_path,
        feature_count=total,
    )
