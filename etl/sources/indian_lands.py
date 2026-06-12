"""
American Indian / Alaska Native / Native Hawaiian Areas (AIANNH).

Tribal lands are a hard exclusion for mining-claim eligibility under
30 U.S.C. § 22 et seq. — the 1872 mining law does not apply to
tribal trust or restricted land. Drawing this layer is non-negotiable.

Source: US Census TIGER/Line AIANNH shapefile. Census refreshes the
file annually and the URL is rock-stable; this is the authoritative
public dataset for federally recognized tribal land boundaries.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import time
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import requests

DEFAULT_YEAR = "2024"
DEFAULT_URL_TEMPLATE = (
    "https://www2.census.gov/geo/tiger/TIGER{year}/AIANNH/tl_{year}_us_aiannh.zip"
)
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


def run(work_dir: Path) -> SourceResult:
    log = logging.getLogger("etl.indian_lands")
    year = os.environ.get("AIANNH_YEAR", DEFAULT_YEAR)
    url = os.environ.get("AIANNH_URL", DEFAULT_URL_TEMPLATE.format(year=year))
    out_path = work_dir / "indian_lands.geojson"
    started = time.monotonic()

    import geopandas as gpd

    with tempfile.TemporaryDirectory(prefix="aiannh-") as tmp:
        tmpdir = Path(tmp)
        zip_path = tmpdir / "aiannh.zip"
        _download_zip(url, zip_path, log)

        with zipfile.ZipFile(zip_path) as zf:
            zf.extractall(tmpdir / "extracted")

        shps = list((tmpdir / "extracted").rglob("*.shp"))
        if not shps:
            raise RuntimeError("AIANNH zip did not contain a shapefile")
        shp = shps[0]
        log.info("reading shapefile %s", shp.name)
        gdf = gpd.read_file(shp)
        log.info("read %d polygons (CRS=%s)", len(gdf), gdf.crs)

        if gdf.crs is not None and str(gdf.crs).lower() not in {"epsg:4326", "wgs 84"}:
            gdf = gdf.to_crs(epsg=4326)

        # TIGER AIANNH columns: AIANNHCE (5-digit Census FIPS), NAME,
        # NAMELSAD (e.g. "Navajo Nation Reservation"), LSAD (legal/
        # statistical descriptor), MTFCC. NAMELSAD is the human-readable
        # field worth showing in the drawer.
        feature_count = 0
        try:
            with out_path.open("w", encoding="utf-8") as out:
                out.write('{"type":"FeatureCollection","features":[')
                first = True
                for _, row in gdf.iterrows():
                    geom = row.geometry
                    if geom is None or geom.is_empty:
                        continue
                    props: dict[str, Any] = {
                        "name": row.get("NAMELSAD") or row.get("NAME"),
                        "aiannhce": row.get("AIANNHCE"),
                        "lsad": row.get("LSAD"),
                        "mtfcc": row.get("MTFCC"),
                    }
                    props = {k: v for k, v in props.items() if v not in (None, "")}
                    if not first:
                        out.write(",")
                    first = False
                    json.dump(
                        {"type": "Feature", "geometry": geom.__geo_interface__, "properties": props},
                        out,
                    )
                    feature_count += 1
                out.write("]}")
        except Exception:
            if out_path.exists():
                out_path.unlink()
            raise

    elapsed = time.monotonic() - started
    log.info("wrote %d AIANNH polygons in %.1fs", feature_count, elapsed)
    return SourceResult(
        layer_id="indian_lands",
        geojson_path=out_path,
        feature_count=feature_count,
    )
