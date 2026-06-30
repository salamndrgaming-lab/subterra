"""
Greater Sage-Grouse Priority Habitat Management Areas (PHMA + GHMA).

Sage-grouse habitat is a distinct management regime from generic
ESA critical habitat — the BLM's 2015/2019 management plans impose
no-surface-occupancy and density caps that effectively block mining
claim development inside Priority Habitat (PHMA). General Habitat
(GHMA) and Important Habitat (IHMA) carry softer but still material
restrictions. Together they cover huge fractions of NV, WY, ID, OR,
UT — exactly the basin-range mineral country we care about most.

Source: BLM EGIS Hub publishes the canonical layer at:
  https://gis.blm.gov/EGISDownload/LayerPackages/
That's the layer-package distribution; the live FeatureServer mirror
is at services1.arcgis.com (BLM's AGOL org). Both have shifted
endpoints multiple times since 2018 — env-overridable URL with the
same `_arcgis` pagination pattern as critical_habitat.

Env override: SUBTERRA_SAGE_GROUSE_URL.

Listed in ACCEPT_BROKEN on first run because the BLM AGOL hub's
service slug changes whenever they republish — first production run
verifies the default, and SUBTERRA_SAGE_GROUSE_URL is the escape
hatch if the slug drifts.
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass
from pathlib import Path

from sources._arcgis import iter_features_concurrent

# Canonical BLM AGOL hub FeatureServer for the western-states
# Greater Sage-Grouse Priority + General Habitat Management Areas.
DEFAULT_QUERY_URL = (
    "https://services1.arcgis.com/9HZSrhE9rE0bU48F/arcgis/rest/services/"
    "BLM_Natl_GRSG_Habitat_Mgmt_Areas/FeatureServer/0/query"
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
    """BLM's sage-grouse layers carry slightly different field schemas
    depending on which vintage / state-cooperator merged in. Surface
    the canonical attrs the sidebar drawer + eligibility check
    consume."""
    out: dict = {}
    # PHMA / GHMA / IHMA designation — drives paint + the user-facing
    # stake-blocker severity.
    mgmt = _first(props, "MGMT_CAT", "HMA_TYPE", "CATEGORY", "HabitatCategory", "category")
    if mgmt is not None:
        out["mgmt_cat"] = mgmt
    name = _first(props, "NAME", "PHMA_NAME", "AREA_NAME", "Name")
    if name is not None:
        out["name"] = name
    state = _first(props, "ST_ABBREV", "STATE", "ST", "STATE_ABBR")
    if state is not None:
        out["state"] = state
    agency = _first(props, "AGENCY", "AGENCY_NAM", "MGMT_AGNCY")
    if agency is not None:
        out["agency"] = agency
    return out


def run(work_dir: Path) -> SourceResult:
    log = logging.getLogger("etl.sage_grouse")
    log.info("starting BLM Greater Sage-Grouse PGMA download")

    # `.strip() or DEFAULT` — guards against an empty-string env var
    # (a pipeline.yml `${{ vars.X }}` for an undefined repo variable),
    # which get(KEY, DEFAULT) would pass through as a broken empty URL.
    url = os.environ.get("SUBTERRA_SAGE_GROUSE_URL", "").strip() or DEFAULT_QUERY_URL
    log.info("source URL: %s", url)

    out_path = work_dir / "sage_grouse.geojson"
    feature_count = 0
    skipped = 0
    started = time.monotonic()
    first = [True]
    per_cat: dict[str, int] = {}
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
                cat = str(props.get("mgmt_cat", "Unknown"))
                per_cat[cat] = per_cat.get(cat, 0) + 1

            iter_features_concurrent(
                url,
                on_feature=on_feature,
                workers=4,
                progress_label="sage_grouse",
            )

            out.write("]}")
    except Exception:
        if out_path.exists():
            out_path.unlink()
        raise

    elapsed = time.monotonic() - started
    log.info(
        "wrote %d sage-grouse PGMA polygons (skipped %d, reasons=%s) in %.1fs (by mgmt_cat: %s)",
        feature_count, skipped, skip_reasons, elapsed, per_cat,
    )

    return SourceResult(
        layer_id="sage_grouse",
        geojson_path=out_path,
        feature_count=feature_count,
    )
