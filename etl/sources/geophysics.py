"""
USGS Airborne Geophysical Survey Inventory v5.0 — ScienceBase static
shapefile download.

Replaces the ArcGIS-REST-guessing approach. The dataset is a single
ScienceBase item (DOI 10.5066/P9K8YTW1, item id 5d38aac0e4b01d82ce8b940a)
that ships its survey-footprint shapefile as a downloadable zip. We
enumerate the item's files via the ScienceBase JSON API, find the
shapefile bundle, download it, and parse it with geopandas.

Why this is more robust than ArcGIS REST guessing: the ScienceBase item
URL is the DOI-cited landing page and is stable (items don't move).
File names within the item DO change between versions, hence the
enumeration step.

Source: https://www.sciencebase.gov/catalog/item/5d38aac0e4b01d82ce8b940a
"""

from __future__ import annotations

import json
import logging
import time
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import requests

SCIENCEBASE_ITEM_ID = "5d38aac0e4b01d82ce8b940a"
ITEM_JSON_URL = f"https://www.sciencebase.gov/catalog/item/{SCIENCEBASE_ITEM_ID}?format=json"
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0 "
    "(Subterra-ETL +https://github.com/salamndrgaming-lab/subterra)"
)
REQUEST_TIMEOUT = 600.0

SURVEY_TYPE_LABELS = {
    "M": "Aeromagnetic",
    "EM": "Electromagnetic",
    "R": "Radiometric",
    "G": "Gravity",
    "V": "VLF-EM",
}


@dataclass
class SourceResult:
    layer_id: str
    geojson_path: Path
    feature_count: int


def _find_shapefile_download_url(log: logging.Logger) -> str | None:
    """Query the ScienceBase item JSON to discover the shapefile zip URL.

    ScienceBase items expose a `files` array with each file's `name`,
    `url`, `contentType`, and `size`. We pick the .zip that names itself
    as a shapefile or contains 'shp'/'shape' in the title."""
    log.info("querying ScienceBase item %s", SCIENCEBASE_ITEM_ID)
    resp = requests.get(
        ITEM_JSON_URL,
        headers={"User-Agent": USER_AGENT, "accept": "application/json"},
        timeout=REQUEST_TIMEOUT,
    )
    resp.raise_for_status()
    item = resp.json()
    files = item.get("files") or []
    log.info("item has %d files", len(files))
    # Score each file by zip-ness + shapefile-ness.
    best: tuple[int, dict[str, Any]] | None = None
    for f in files:
        name = (f.get("name") or "").lower()
        title = (f.get("title") or "").lower()
        url = f.get("url") or f.get("downloadUri")
        if not url:
            continue
        score = 0
        if name.endswith(".zip"):
            score += 3
        if any(k in name or k in title for k in ("shape", "shp", "feature", "footprint", "polygon")):
            score += 5
        # The geophysics inventory zip is usually multi-MB; prefer larger files.
        size_mb = (f.get("size") or 0) / 1_000_000
        if size_mb > 0.5:
            score += 1
        if score >= 3 and (best is None or score > best[0]):
            best = (score, f)
    if best:
        f = best[1]
        url = f.get("url") or f.get("downloadUri")
        log.info("selected file: %s (score=%d, %.1f MB)", f.get("name"), best[0], (f.get("size") or 0) / 1_000_000)
        return url
    log.warning("no shapefile-looking zip found among %d files", len(files))
    return None


def _download(url: str, work_dir: Path, log: logging.Logger) -> Path:
    zip_path = work_dir / "geophysics.zip"
    if zip_path.exists() and zip_path.stat().st_size > 50_000:
        log.info("using cached %s (%d KB)", zip_path.name, zip_path.stat().st_size // 1000)
        return zip_path
    log.info("downloading %s", url)
    with requests.get(
        url,
        headers={"User-Agent": USER_AGENT, "accept": "application/zip, */*"},
        stream=True,
        timeout=REQUEST_TIMEOUT,
        allow_redirects=True,
    ) as resp:
        resp.raise_for_status()
        with zip_path.open("wb") as out:
            for chunk in resp.iter_content(chunk_size=1 << 20):
                out.write(chunk)
    log.info("downloaded %d KB", zip_path.stat().st_size // 1000)
    return zip_path


def _find_shp_in_zip(zip_path: Path, log: logging.Logger) -> str | None:
    with zipfile.ZipFile(zip_path) as zf:
        names = zf.namelist()
    shps = [n for n in names if n.lower().endswith(".shp")]
    log.info("zip contains %d entries, %d shapefiles: %s", len(names), len(shps), shps[:3])
    if not shps:
        return None
    # Prefer polygon-named over line/point if multiple — the survey
    # FOOTPRINTS are what we want.
    polys = [n for n in shps if any(k in n.lower() for k in ("poly", "footprint", "survey"))]
    return (polys or shps)[0]


def _decode_types(raw: Any) -> str | None:
    if raw in (None, "", " "):
        return None
    s = str(raw).upper()
    labels: list[str] = []
    for code in ("EM", "M", "R", "G", "V"):
        if code in s:
            labels.append(SURVEY_TYPE_LABELS[code])
            s = s.replace(code, "")
    return ", ".join(labels) if labels else str(raw)


def _normalize(row: dict[str, Any]) -> dict[str, Any]:
    def first(*keys: str) -> Any:
        for k in keys:
            for cased in (k, k.upper(), k.lower()):
                if cased in row and row[cased] not in (None, "", " "):
                    return row[cased]
        return None
    out = {
        "name": first("NAME", "SURVEY_NAME", "PROJ_NAME", "title"),
        "types": _decode_types(first("DATA_TYPES", "TYPE", "SURVEY_TYP", "datatype")),
        "year": first("YEAR", "FLIGHT_YR", "ACQ_YEAR", "SURVEY_YR"),
        "agency": first("AGENCY", "SOURCE"),
        "resolution": first("LINE_SPACE", "line_spacing", "RESOLUTION"),
    }
    return {k: v for k, v in out.items() if v is not None}


def run(work_dir: Path) -> SourceResult:
    log = logging.getLogger("etl.geophysics")
    log.info("starting Earth MRI geophysical survey download")
    started = time.monotonic()

    try:
        url = _find_shapefile_download_url(log)
    except Exception as err:  # noqa: BLE001
        log.warning("ScienceBase item lookup failed: %s", err)
        url = None
    if not url:
        empty = work_dir / "geophysics.geojson"
        empty.write_text('{"type":"FeatureCollection","features":[]}')
        return SourceResult(layer_id="geophysics", geojson_path=empty, feature_count=0)

    zip_path = _download(url, work_dir, log)
    shp_name = _find_shp_in_zip(zip_path, log)
    if not shp_name:
        empty = work_dir / "geophysics.geojson"
        empty.write_text('{"type":"FeatureCollection","features":[]}')
        return SourceResult(layer_id="geophysics", geojson_path=empty, feature_count=0)

    import geopandas as gpd
    vsi_path = f"/vsizip/{zip_path.resolve()}/{shp_name}"
    log.info("reading %s with geopandas", vsi_path)
    gdf = gpd.read_file(vsi_path)
    log.info("read %d rows × %d cols", len(gdf), len(gdf.columns))

    if gdf.crs is not None and gdf.crs.to_epsg() != 4326:
        log.info("reprojecting from %s → EPSG:4326", gdf.crs)
        gdf = gdf.to_crs("EPSG:4326")

    out_path = work_dir / "geophysics.geojson"
    count = 0
    first = True
    with out_path.open("w", encoding="utf-8") as out:
        out.write('{"type":"FeatureCollection","features":[')
        for _, row in gdf.iterrows():
            geom = row.geometry
            if geom is None or geom.is_empty:
                continue
            row_d = row.to_dict()
            row_d.pop("geometry", None)
            props = _normalize(row_d)
            if not first:
                out.write(",")
            first = False
            geom_json = json.loads(gpd.GeoSeries([geom], crs="EPSG:4326").to_json())
            # Extract just the geometry from the FeatureCollection wrapper.
            feat_geom = geom_json["features"][0]["geometry"] if geom_json.get("features") else None
            if not feat_geom:
                continue
            json.dump({"type": "Feature", "geometry": feat_geom, "properties": props}, out)
            count += 1
        out.write("]}")

    elapsed = time.monotonic() - started
    log.info("wrote %d survey footprints in %.1fs", count, elapsed)
    return SourceResult(layer_id="geophysics", geojson_path=out_path, feature_count=count)
