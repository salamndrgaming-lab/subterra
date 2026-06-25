"""
USFS Inventoried Roadless Areas (IRAs) — 36 CFR 294 subpart B.

The 2001 Roadless Rule prohibits road construction + reconstruction
and most timber-cutting in Inventoried Roadless Areas. Mining
claims can still be located on IRA federal land (1872 mining law
prevails over Forest Service regulation for valid claims), but
the no-road rule effectively blocks any operation that needs
mechanized access. For a prospector evaluating stake-ability,
IRAs are a strong soft-block — surface the polygon, paint it
distinctly, let the user decide.

Source: USFS Enterprise Data Warehouse (EDW) publishes the
canonical layer at:
  https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_RoadlessArea_01/MapServer/0/query

EDW is a MapServer (not FeatureServer), but the `_arcgis` helper's
ArcGIS REST query semantics work identically for both — pagination,
returnCountOnly, outFields, f=geojson are all supported.

Env override: SUBTERRA_ROADLESS_URL.

Listed in ACCEPT_BROKEN on first run because USFS EDW occasionally
republishes layer slugs (the _01 suffix shifts to _02 etc. on each
schema revision); SUBTERRA_ROADLESS_URL is the escape hatch.
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass
from pathlib import Path

from sources._arcgis import iter_features_concurrent

DEFAULT_QUERY_URL = (
    "https://apps.fs.usda.gov/arcx/rest/services/EDW/"
    "EDW_RoadlessArea_01/MapServer/0/query"
)


@dataclass
class SourceResult:
    layer_id: str
    geojson_path: Path
    feature_count: int


def _first(props: dict, *keys: str) -> object:
    for k in keys:
        v = props.get(k)
        if v in (None, "", " "):
            v = props.get(k.upper())
        if v not in (None, "", " "):
            return v
    return None


def _normalize(props: dict) -> dict:
    """EDW IRA fields: AREA_NAME, FOREST, STATE, REVISION_TYPE,
    GIS_ACRES. Surface the human-readable + region attrs the drawer
    will show."""
    out: dict = {}
    name = _first(props, "AREA_NAME", "NAME", "IRA_NAME", "ROADLESSAR")
    if name is not None:
        out["name"] = name
    forest = _first(props, "FOREST", "FOREST_NAME", "FORESTNAME", "ADMINFORES")
    if forest is not None:
        out["forest"] = forest
    state = _first(props, "STATE", "ST_ABBREV", "STATE_ABBR")
    if state is not None:
        out["state"] = state
    revision = _first(props, "REVISION_TYPE", "REVISION", "REVTYPE")
    if revision is not None:
        out["revision"] = revision
    acres = _first(props, "GIS_ACRES", "ACRES", "GISACRES", "AREA_ACRES")
    if acres is not None:
        try:
            out["acres"] = int(float(acres))
        except (TypeError, ValueError):
            pass
    return out


def run(work_dir: Path) -> SourceResult:
    log = logging.getLogger("etl.roadless_areas")
    log.info("starting USFS Inventoried Roadless Areas download")

    url = os.environ.get("SUBTERRA_ROADLESS_URL", DEFAULT_QUERY_URL)
    log.info("source URL: %s", url)

    out_path = work_dir / "roadless_areas.geojson"
    feature_count = 0
    skipped = 0
    started = time.monotonic()
    first = [True]
    per_state: dict[str, int] = {}
    skip_reasons: dict[str, int] = {"no_geom": 0, "wrong_type": 0}

    try:
        with out_path.open("w", encoding="utf-8") as out:
            out.write('{"type":"FeatureCollection","features":[')

            def on_feature(feat: dict) -> None:
                nonlocal feature_count, skipped
                geom = feat.get("geometry")
                if not geom:
                    skipped += 1
                    skip_reasons["no_geom"] += 1
                    return
                if geom.get("type") not in ("Polygon", "MultiPolygon"):
                    skipped += 1
                    skip_reasons["wrong_type"] += 1
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
                progress_label="roadless_areas",
            )

            out.write("]}")
    except Exception:
        if out_path.exists():
            out_path.unlink()
        raise

    elapsed = time.monotonic() - started
    log.info(
        "wrote %d IRA polygons (skipped %d, reasons=%s) in %.1fs (top states: %s)",
        feature_count, skipped, skip_reasons, elapsed,
        sorted(per_state.items(), key=lambda kv: -kv[1])[:5],
    )

    return SourceResult(
        layer_id="roadless_areas",
        geojson_path=out_path,
        feature_count=feature_count,
    )
