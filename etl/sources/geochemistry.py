"""
USGS National Geochemical Database (NGDB) — sediment + soil samples.

This is the single most important exploration dataset after MRDS: ~1.5M
rock/sediment/soil samples analyzed for elemental concentrations (1962–
2023). Stream-sediment geochemistry is how modern exploration actually
finds targets — an anomalously high Au/Cu/Li value in a drainage points
upstream to a source. Enterprise tools (S&P, KoBold, Earth AI) all layer
this on top of occurrence maps.

We pull the sample locations + their headline element concentrations and
emit them as a point layer. The web app paints them graduated by the
selected pathfinder element so anomalies stand out.

Endpoints are tried in order with per-endpoint try/except — mrdata.usgs.gov
periodically reorganizes its service layout, so we keep a candidate list
and use the first that responds (same defensive pattern as federal_lands).

Sources:
  https://mrdata.usgs.gov/ngdb/sediment/
  https://mrdata.usgs.gov/ngdb/soil/
  https://energy.usgs.gov/arcgis/rest/services/MRData
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sources._arcgis import iter_features_concurrent

# Candidate ArcGIS query endpoints, tried in order. Each entry is a full
# layer query URL (without /query — appended below). The first that
# returns a non-zero count wins.
CANDIDATE_ENDPOINTS: list[dict[str, Any]] = [
    {
        "label": "NGDB sediment (energy.usgs.gov MRData)",
        "service": "https://energy.usgs.gov/arcgis/rest/services/MRData/ngdb_sediment/MapServer",
        "layer": 0,
        "medium": "sediment",
    },
    {
        "label": "NGDB sediment (mrdata MapServer)",
        "service": "https://mrdata.usgs.gov/arcgis/rest/services/ngdb/sediment/MapServer",
        "layer": 0,
        "medium": "sediment",
    },
    {
        "label": "NGDB soil (mrdata MapServer)",
        "service": "https://mrdata.usgs.gov/arcgis/rest/services/ngdb/soil/MapServer",
        "layer": 0,
        "medium": "soil",
    },
]

# Pathfinder elements we surface. NGDB column names vary by service, so
# each maps to a list of candidate field names. Values are ppm unless the
# element is reported as pct (handled at read time isn't worth it — we
# keep the raw reported value + unit hint in the property name).
ELEMENT_FIELDS: dict[str, list[str]] = {
    "au_ppb": ["AU_PPB", "au_ppb", "AU", "GOLD"],
    "ag_ppm": ["AG_PPM", "ag_ppm", "AG", "SILVER"],
    "cu_ppm": ["CU_PPM", "cu_ppm", "CU", "COPPER"],
    "pb_ppm": ["PB_PPM", "pb_ppm", "PB", "LEAD"],
    "zn_ppm": ["ZN_PPM", "zn_ppm", "ZN", "ZINC"],
    "li_ppm": ["LI_PPM", "li_ppm", "LI", "LITHIUM"],
    "mo_ppm": ["MO_PPM", "mo_ppm", "MO"],
    "as_ppm": ["AS_PPM", "as_ppm", "AS", "ARSENIC"],  # classic Au pathfinder
    "u_ppm": ["U_PPM", "u_ppm", "U", "URANIUM"],
    "ree_ppm": ["REE_PPM", "ce_ppm", "CE_PPM", "la_ppm", "LA_PPM"],
}


@dataclass
class SourceResult:
    layer_id: str
    geojson_path: Path
    feature_count: int


def _num(v: Any) -> float | None:
    if v in (None, "", " ", -999, "-999"):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    # NGDB uses negative sentinels for below-detection-limit. Treat as None.
    return f if f >= 0 else None


def _normalize(p: dict[str, Any], medium: str) -> dict[str, Any]:
    def first(keys: list[str]) -> Any:
        for k in keys:
            for cased in (k, k.upper(), k.lower()):
                if cased in p:
                    n = _num(p[cased])
                    if n is not None:
                        return n
        return None

    out: dict[str, Any] = {"medium": medium}
    for out_key, candidates in ELEMENT_FIELDS.items():
        v = first(candidates)
        if v is not None:
            out[out_key] = v
    # carry a sample id + collection year when available
    for idk in ("LAB_ID", "lab_id", "SAMPLE_ID", "sample_id", "ID"):
        if idk in p and p[idk] not in (None, ""):
            out["sample_id"] = str(p[idk])
            break
    return out


def run(work_dir: Path) -> SourceResult:
    log = logging.getLogger("etl.geochemistry")
    log.info("starting NGDB geochemistry download")

    out_path = work_dir / "geochemistry.geojson"
    total = 0
    first = [True]
    started = time.monotonic()

    try:
        with out_path.open("w", encoding="utf-8") as out:
            out.write('{"type":"FeatureCollection","features":[')

            for ep in CANDIDATE_ENDPOINTS:
                count_before = total

                def emit(feat: dict[str, Any], _ep=ep) -> None:
                    nonlocal total
                    geom = feat.get("geometry")
                    if not geom or geom.get("type") != "Point":
                        return
                    coords = geom.get("coordinates") or []
                    if len(coords) < 2 or coords[0] is None or coords[1] is None:
                        return
                    props = _normalize(
                        feat.get("properties") or feat.get("attributes") or {},
                        _ep["medium"],
                    )
                    # Skip samples with no usable element data — they add
                    # weight to the tileset without adding signal.
                    if len(props) <= 1:  # only "medium"
                        return
                    if not first[0]:
                        out.write(",")
                    first[0] = False
                    json.dump({"type": "Feature", "geometry": geom, "properties": props}, out)
                    total += 1

                query_url = f"{ep['service']}/{ep['layer']}/query"
                log.info("trying %s (%s)", ep["label"], query_url)
                try:
                    iter_features_concurrent(
                        query_url,
                        on_feature=emit,
                        workers=4,
                        retries=3,
                        progress_label="geochemistry",
                    )
                except Exception as err:  # noqa: BLE001
                    log.warning("  %s FAILED — %s: %s", ep["label"], type(err).__name__, err)
                    continue

                got = total - count_before
                log.info("  %s: %d usable samples", ep["label"], got)
                # First endpoint that yields real data wins — don't double-count
                # sediment across mirrors.
                if got > 0 and ep["medium"] == "sediment":
                    break

            out.write("]}")
    except Exception:
        if out_path.exists():
            out_path.unlink()
        raise

    elapsed = time.monotonic() - started
    log.info("wrote %d geochemistry samples in %.1fs", total, elapsed)
    return SourceResult(
        layer_id="geochemistry",
        geojson_path=out_path,
        feature_count=total,
    )
