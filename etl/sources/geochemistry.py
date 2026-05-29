"""
USGS National Geochemical Database — bulk shapefile download.

Replaces the candidate-endpoint guessing strategy. NGDB sediment is
distributed as a single static shapefile bundle on mrdata.usgs.gov, same
proven pattern as mrds.py:

  https://mrdata.usgs.gov/ngdb/sediment/ngdbsed-csv.zip   (~159 MB zip)

The expanded shapefile is ~1.35 GB with every element column. We aggressively
filter at parse time:
  - keep only WEST_BBOX samples (CONUS-west prospecting target)
  - keep only samples with at least one element value above the
    "useful for the pathfinder color ramp" threshold
That drops the in-tile output to a few MB while preserving every actual
anomaly signal.

Falls back gracefully if the download or shapefile read fails — the
ETL orchestrator catches per-source errors so the rest of the pipeline
continues either way.

Source: https://mrdata.usgs.gov/ngdb/sediment/
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import requests

PRIMARY_URL = "https://mrdata.usgs.gov/ngdb/sediment/ngdbsed-csv.zip"
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0 "
    "(Subterra-ETL +https://github.com/salamndrgaming-lab/subterra)"
)
REQUEST_TIMEOUT = 1800.0  # generous — large file, possibly slow mirror

# Western-US prospecting target. Anything outside this is dropped at parse
# time to keep the output tile-friendly.
WEST_BBOX = (-125.0, 31.0, -100.0, 49.5)

# Candidate column-name lists per pathfinder element. mrdata NGDB column
# naming is inconsistent across vintages — some use AU_PPM_ICP40,
# AU_PPB_INAA, etc. Try them in priority order.
ELEMENT_COLUMN_CANDIDATES: dict[str, list[str]] = {
    "au_ppb": ["AU_PPB", "AU_PPB_INAA", "AU_PPB_ICP", "AU_PPB_FA", "AU_PPB_FIRE"],
    "ag_ppm": ["AG_PPM", "AG_PPM_ICP40", "AG_PPM_INAA"],
    "cu_ppm": ["CU_PPM", "CU_PPM_ICP40", "CU_PPM_INAA"],
    "pb_ppm": ["PB_PPM", "PB_PPM_ICP40", "PB_PPM_INAA"],
    "zn_ppm": ["ZN_PPM", "ZN_PPM_ICP40", "ZN_PPM_INAA"],
    "li_ppm": ["LI_PPM", "LI_PPM_ICP40"],
    "mo_ppm": ["MO_PPM", "MO_PPM_ICP40", "MO_PPM_INAA"],
    "as_ppm": ["AS_PPM", "AS_PPM_ICP40", "AS_PPM_INAA"],
    "u_ppm": ["U_PPM", "U_PPM_INAA"],
    "ree_ppm": ["LA_PPM", "CE_PPM", "LA_PPM_INAA", "CE_PPM_INAA"],
}

# "Worth keeping" threshold per element — at least one value above this
# qualifies the sample for inclusion. Looser than the hotspot anomaly
# threshold so users can still see surrounding context, not just the
# screaming anomalies.
KEEP_THRESHOLDS = {
    "au_ppb": 5.0, "ag_ppm": 0.5, "cu_ppm": 30.0, "pb_ppm": 30.0,
    "zn_ppm": 80.0, "li_ppm": 20.0, "mo_ppm": 2.0, "as_ppm": 10.0,
    "u_ppm": 2.0, "ree_ppm": 50.0,
}


@dataclass
class SourceResult:
    layer_id: str
    geojson_path: Path
    feature_count: int


def _download(work_dir: Path, log: logging.Logger) -> Path:
    zip_path = work_dir / "ngdbsed.zip"
    if zip_path.exists() and zip_path.stat().st_size > 1_000_000:
        log.info("using cached %s (%d MB)", zip_path.name, zip_path.stat().st_size // 1_000_000)
        return zip_path
    log.info("downloading %s", PRIMARY_URL)
    started = time.monotonic()
    with requests.get(
        PRIMARY_URL,
        headers={"User-Agent": USER_AGENT, "accept": "application/zip, */*"},
        stream=True,
        timeout=REQUEST_TIMEOUT,
    ) as resp:
        resp.raise_for_status()
        with zip_path.open("wb") as out:
            for chunk in resp.iter_content(chunk_size=1 << 20):
                out.write(chunk)
    log.info(
        "downloaded %d MB in %.1fs",
        zip_path.stat().st_size // 1_000_000,
        time.monotonic() - started,
    )
    return zip_path


def _find_shapefile(zip_path: Path, log: logging.Logger) -> str | None:
    """Inspect the zip to find the main .shp filename so we can pass
    /vsizip/<zip>/<shp> to geopandas."""
    import zipfile
    with zipfile.ZipFile(zip_path) as zf:
        names = zf.namelist()
    shp = [n for n in names if n.lower().endswith(".shp")]
    log.info("zip contains %d files; %d shapefiles: %s", len(names), len(shp), shp[:3])
    return shp[0] if shp else None


def _num(v: Any) -> float | None:
    if v in (None, "", " "):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    # NGDB uses negatives as below-detection-limit sentinels.
    return f if f >= 0 else None


def _pick_element(row: dict[str, Any], candidates: list[str]) -> float | None:
    for col in candidates:
        for cased in (col, col.upper(), col.lower()):
            if cased in row:
                n = _num(row[cased])
                if n is not None:
                    return n
    return None


def run(work_dir: Path) -> SourceResult:
    log = logging.getLogger("etl.geochemistry")
    log.info("starting NGDB sediment bulk download")
    started = time.monotonic()

    zip_path = _download(work_dir, log)
    shp_name = _find_shapefile(zip_path, log)
    if not shp_name:
        log.error("no .shp file found inside %s — abort", zip_path.name)
        # Return an empty layer so the orchestrator records 0 features
        # without aborting the rest of the pipeline.
        empty = work_dir / "geochemistry.geojson"
        empty.write_text('{"type":"FeatureCollection","features":[]}')
        return SourceResult(layer_id="geochemistry", geojson_path=empty, feature_count=0)

    # geopandas + fiona handle the shapefile inside the zip via the GDAL
    # /vsizip/ virtual filesystem.
    import geopandas as gpd
    vsi_path = f"/vsizip/{zip_path.resolve()}/{shp_name}"
    log.info("reading %s with geopandas", vsi_path)
    gdf = gpd.read_file(vsi_path)
    log.info("read %d rows × %d cols", len(gdf), len(gdf.columns))

    # Reproject to WGS84 if needed.
    if gdf.crs is not None and gdf.crs.to_epsg() != 4326:
        log.info("reprojecting from %s → EPSG:4326", gdf.crs)
        gdf = gdf.to_crs("EPSG:4326")

    out_path = work_dir / "geochemistry.geojson"
    total = 0
    kept = 0
    first = True
    with out_path.open("w", encoding="utf-8") as out:
        out.write('{"type":"FeatureCollection","features":[')
        for _, row in gdf.iterrows():
            total += 1
            geom = row.geometry
            if geom is None or geom.is_empty:
                continue
            # Point or shapefile multipoint — grab the representative xy.
            try:
                x = float(geom.x); y = float(geom.y)
            except Exception:  # noqa: BLE001
                rep = geom.representative_point()
                x, y = float(rep.x), float(rep.y)
            if not (WEST_BBOX[0] <= x <= WEST_BBOX[2] and WEST_BBOX[1] <= y <= WEST_BBOX[3]):
                continue

            row_d = row.to_dict()
            props: dict[str, Any] = {"medium": "sediment"}
            any_above_keep = False
            for out_key, candidates in ELEMENT_COLUMN_CANDIDATES.items():
                v = _pick_element(row_d, candidates)
                if v is not None:
                    props[out_key] = v
                    if v >= KEEP_THRESHOLDS.get(out_key, float("inf")):
                        any_above_keep = True
            if not any_above_keep:
                continue
            # carry sample id if present
            for idk in ("LAB_ID", "lab_id", "SAMPLE_ID", "sample_id"):
                if idk in row_d and row_d[idk] not in (None, ""):
                    props["sample_id"] = str(row_d[idk])
                    break

            if not first:
                out.write(",")
            first = False
            json.dump({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [x, y]},
                "properties": props,
            }, out)
            kept += 1
        out.write("]}")

    elapsed = time.monotonic() - started
    log.info("wrote %d / %d samples (%.1f%% kept) in %.1fs",
             kept, total, (kept / total * 100) if total else 0.0, elapsed)
    return SourceResult(layer_id="geochemistry", geojson_path=out_path, feature_count=kept)
