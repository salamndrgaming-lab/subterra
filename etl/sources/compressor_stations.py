"""
HIFLD Natural Gas Compressor Stations.

Compressor stations sit along trunk pipelines and push gas through —
the bottlenecks of the natural-gas takeaway system. Outage at a major
compressor halts deliveries from upstream wells; new compressor
construction signals planned takeaway expansion. For an O&G analyst,
compressor-station proximity is a primary "can my gas reach market?"
signal that the existing pipelines layer alone can't answer (a
pipeline is only as useful as the compressors keeping it pressurized).

Source: HIFLD Open Data (Homeland Infrastructure Foundation-Level
Data) hosted on the geoplatform.gov AGOL org at services.arcgis.com.
~1,700 compressor stations CONUS-wide. Same ArcGIS REST pattern as
critical_habitat / sage_grouse / roadless_areas — paginated _arcgis
helper, env-overridable URL, point-geometry filter.

Env override: SUBTERRA_COMPRESSOR_STATIONS_URL.

Listed in ACCEPT_BROKEN on first run since the HIFLD AGOL service
slugs (the alphanumeric org ID prefix) periodically rotate. Iterate
via the env var on failure.
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass
from pathlib import Path

from sources._arcgis import iter_features_concurrent

# HIFLD geoplatform AGOL org, verified 2026-06-30 via search — the
# Natural_Gas_Compressor_Stations FeatureServer lives under
# services5.arcgis.com/HDRa0B57OVrv2E1q (an earlier guessed org was
# wrong, which combined with the empty-env-var bug is why this never
# fetched). Override with SUBTERRA_COMPRESSOR_STATIONS_URL if it moves.
DEFAULT_QUERY_URL = (
    "https://services5.arcgis.com/HDRa0B57OVrv2E1q/arcgis/rest/services/"
    "Natural_Gas_Compressor_Stations/FeatureServer/0/query"
)


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


def _normalize(props: dict) -> dict:
    """HIFLD compressor-station attrs: NAME, OPERATOR, TYPE (booster /
    transmission), STATUS (active / proposed / retired), CAPACITY_HP,
    STATE, COUNTY. Surface the lookup-relevant ones for the drawer."""
    out: dict = {}
    name = _first(props, "NAME", "STATION_NAME", "Name")
    if name is not None:
        out["name"] = name
    operator = _first(props, "OPERATOR", "Operator", "OWNER", "COMPANY")
    if operator is not None:
        out["operator"] = operator
    status = _first(props, "STATUS", "Status", "STATIONSTA")
    if status is not None:
        out["status"] = status
    stype = _first(props, "TYPE", "Type", "STATION_TYPE")
    if stype is not None:
        out["type"] = stype
    hp = _first(props, "CAPACITY_HP", "TOTAL_HP", "HORSEPOWER", "HP", "Capacity")
    if hp is not None:
        try:
            out["horsepower"] = int(float(hp))
        except (TypeError, ValueError):
            pass
    state = _first(props, "STATE", "State", "ST_ABBREV")
    if state is not None:
        out["state"] = state
    county = _first(props, "COUNTY", "County", "COUNTYNAME")
    if county is not None:
        out["county"] = county
    return out


def run(work_dir: Path) -> SourceResult:
    log = logging.getLogger("etl.compressor_stations")
    log.info("starting HIFLD compressor stations download")

    # NB: `.strip() or DEFAULT`, not get(KEY, DEFAULT) — pipeline.yml
    # passes this env var as `${{ vars.X }}`, which is the empty string
    # (not unset) when the repo variable doesn't exist. get(KEY, DEFAULT)
    # would then hand back "" and the fetch would fail with
    # "Invalid URL '': No scheme supplied". Coalesce empties to the default.
    url = os.environ.get("SUBTERRA_COMPRESSOR_STATIONS_URL", "").strip() or DEFAULT_QUERY_URL
    log.info("source URL: %s", url)

    out_path = work_dir / "compressor_stations.geojson"
    feature_count = 0
    skipped = 0
    started = time.monotonic()
    first = [True]
    per_state: dict[str, int] = {}

    try:
        with out_path.open("w", encoding="utf-8") as out:
            out.write('{"type":"FeatureCollection","features":[')

            def on_feature(feat: dict) -> None:
                nonlocal feature_count, skipped
                geom = feat.get("geometry")
                if not geom or geom.get("type") != "Point":
                    skipped += 1
                    return
                coords = geom.get("coordinates") or []
                if len(coords) < 2 or coords[0] is None or coords[1] is None:
                    skipped += 1
                    return
                props = _normalize(feat.get("properties") or {})
                if not first[0]:
                    out.write(",")
                first[0] = False
                json.dump(
                    {"type": "Feature", "geometry": geom, "properties": props}, out,
                )
                feature_count += 1
                st = str(props.get("state", "Unknown"))
                per_state[st] = per_state.get(st, 0) + 1

            iter_features_concurrent(
                url,
                on_feature=on_feature,
                workers=4,
                progress_label="compressor_stations",
            )

            out.write("]}")
    except Exception:
        if out_path.exists():
            out_path.unlink()
        raise

    elapsed = time.monotonic() - started
    log.info(
        "wrote %d compressor stations (skipped %d) in %.1fs (top states: %s)",
        feature_count, skipped, elapsed,
        sorted(per_state.items(), key=lambda kv: -kv[1])[:5],
    )

    return SourceResult(
        layer_id="compressor_stations",
        geojson_path=out_path,
        feature_count=feature_count,
    )
