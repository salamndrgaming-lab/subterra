"""
USFWS Critical Habitat polygon layer.

Critical habitat designated under ESA §7 doesn't withdraw land from
mineral entry by itself, but the consultation requirement makes
staking practically a non-starter for any operator who needs a
permit downstream. We flag it as an eligibility blocker.

Source: USFWS ECOS national critical-habitat bulk download. ECOS
publishes one zip containing polygon + line shapefiles for every
species with designated habitat. The URL has been stable for years.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import tempfile
import time
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import requests

DEFAULT_URL = "https://ecos.fws.gov/docs/crithab/crithab_all.zip"
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0 "
    "(Subterra-ETL +https://github.com/salamndrgaming-lab/subterra)"
)
REQUEST_TIMEOUT = 600.0


@dataclass
class SourceResult:
    layer_id: str
    geojson_path: Path
    feature_count: int


def _download_zip(url: str, dest: Path, log: logging.Logger) -> None:
    log.info("downloading %s", url)
    with requests.get(
        url,
        headers={"User-Agent": USER_AGENT, "accept": "application/zip, */*"},
        stream=True,
        timeout=REQUEST_TIMEOUT,
        allow_redirects=True,
    ) as resp:
        resp.raise_for_status()
        with dest.open("wb") as f:
            for chunk in resp.iter_content(1 << 20):
                if chunk:
                    f.write(chunk)


def _find_polygon_shapefile(extract_dir: Path) -> Path | None:
    """ECOS bundles several shapefiles inside the zip. We want the
    polygon set (typically named CRITHAB_POLY.shp). Falls back to any
    .shp whose name contains 'poly' if the canonical name moves."""
    canonical = list(extract_dir.rglob("CRITHAB_POLY.shp"))
    if canonical:
        return canonical[0]
    candidates = [p for p in extract_dir.rglob("*.shp") if "poly" in p.name.lower()]
    return candidates[0] if candidates else None


def run(work_dir: Path) -> SourceResult:
    log = logging.getLogger("etl.critical_habitat")
    url = os.environ.get("CRITHAB_URL", DEFAULT_URL)
    out_path = work_dir / "critical_habitat.geojson"
    started = time.monotonic()

    # Local-import geopandas to keep the module dependency-light at
    # import time (matches geophysics/geochemistry pattern).
    import geopandas as gpd

    with tempfile.TemporaryDirectory(prefix="crithab-") as tmp:
        tmpdir = Path(tmp)
        zip_path = tmpdir / "crithab.zip"
        _download_zip(url, zip_path, log)

        log.info("unzipping %s", zip_path.name)
        with zipfile.ZipFile(zip_path) as zf:
            zf.extractall(tmpdir / "extracted")

        shp = _find_polygon_shapefile(tmpdir / "extracted")
        if shp is None:
            raise RuntimeError(
                "critical-habitat zip did not contain a polygon shapefile",
            )
        log.info("reading shapefile %s", shp.name)
        gdf = gpd.read_file(shp)
        log.info("read %d polygons (CRS=%s)", len(gdf), gdf.crs)

        # Reproject to WGS84 if necessary — tippecanoe expects lat/lng.
        if gdf.crs is not None and str(gdf.crs).lower() not in {"epsg:4326", "wgs 84"}:
            gdf = gdf.to_crs(epsg=4326)

        # Keep only the columns the eligibility check uses. Different
        # CritHab vintages use slightly different field names, so we
        # coalesce a few candidates.
        def pick(row: Any, *keys: str) -> Any:
            for k in keys:
                if k in row.index and row[k] not in (None, "", " "):
                    return row[k]
            return None

        feature_count = 0
        per_status: dict[str, int] = {}
        try:
            with out_path.open("w", encoding="utf-8") as out:
                out.write('{"type":"FeatureCollection","features":[')
                first = True
                for _, row in gdf.iterrows():
                    geom = row.geometry
                    if geom is None or geom.is_empty:
                        continue
                    props = {
                        "species": pick(row, "comname", "common_nam", "comm_name", "sci_name", "species"),
                        "status": pick(row, "status", "listing_st"),
                        "unit": pick(row, "unit_name", "unit", "unitname"),
                        "doc_type": pick(row, "doc_type", "doctype"),
                    }
                    props = {k: v for k, v in props.items() if v is not None}
                    if not first:
                        out.write(",")
                    first = False
                    json.dump(
                        {"type": "Feature", "geometry": geom.__geo_interface__, "properties": props},
                        out,
                    )
                    feature_count += 1
                    s = str(props.get("status", "Unknown"))
                    per_status[s] = per_status.get(s, 0) + 1
                out.write("]}")
        except Exception:
            if out_path.exists():
                out_path.unlink()
            raise

    elapsed = time.monotonic() - started
    log.info(
        "wrote %d critical-habitat polygons in %.1fs (by status: %s)",
        feature_count, elapsed, per_status,
    )
    # Keep the cache dir tidy.
    if work_dir.exists():
        for stale in work_dir.glob("crithab-*"):
            shutil.rmtree(stale, ignore_errors=True)
    return SourceResult(
        layer_id="critical_habitat",
        geojson_path=out_path,
        feature_count=feature_count,
    )
