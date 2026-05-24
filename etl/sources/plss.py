"""
BLM National PLSS — Public Land Survey System grid.

Township polygons from BLM's CadNSDI national service. We convert each
polygon to a MultiLineString so tippecanoe + the web app render the
grid as outlines (matches the 'line' geometry kind in the layer
registry; township interiors don't need fill).

CadNSDI covers the 30 PLSS states (most of the western US + parts of
the midwest). Eastern US is metes-and-bounds and has no PLSS.

Source: https://gis.blm.gov/arcgis/rest/services/Cadastral/BLM_Natl_PLSS_CadNSDI/MapServer
Layer 2 = Township polygons (~50k features in CONUS).

Unlike the Hub Downloads API used by blm_claims / blm_leases, this is
a paginated FeatureServer/MapServer query — robust against the on-demand
generator's size limits.
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import requests
from tqdm import tqdm

SERVICE = "https://gis.blm.gov/arcgis/rest/services/Cadastral/BLM_Natl_PLSS_CadNSDI/MapServer"
LAYER_ID = 2  # PLSS Township polygons
PAGE_SIZE = 2000
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0 "
    "(Subterra-ETL +https://github.com/salamndrgaming-lab/subterra)"
)
REQUEST_TIMEOUT = 120.0


@dataclass
class SourceResult:
    layer_id: str
    geojson_path: Path
    feature_count: int


def _fetch_page(query_url: str, offset: int) -> dict[str, Any]:
    """One paginated request. ArcGIS returns exceededTransferLimit when
    more pages exist; we stop when that's false AND we got fewer records
    than the page size.

    The orderByFields param is required for stable pagination on many
    ArcGIS services — without it, resultOffset-style paging returns
    HTTP 400 "Failed to execute query" on layers backed by Hosted Tile
    Layers. outFields=* avoids field-name-mismatch errors across BLM
    service revisions; tippecanoe will simplify properties later anyway.
    """
    params = {
        "where": "1=1",
        "outFields": "*",
        "returnGeometry": "true",
        "outSR": "4326",
        "f": "geojson",
        "resultRecordCount": str(PAGE_SIZE),
        "resultOffset": str(offset),
        "orderByFields": "OBJECTID ASC",
    }
    resp = requests.get(
        query_url,
        params=params,
        headers={"User-Agent": USER_AGENT, "accept": "application/geo+json, application/json"},
        timeout=REQUEST_TIMEOUT,
    )
    resp.raise_for_status()
    body = resp.json()
    if isinstance(body, dict) and body.get("error"):
        raise RuntimeError(f"ArcGIS error from {query_url}: {body['error']}")
    return body


def _polygon_to_lines(geom: dict[str, Any]) -> dict[str, Any]:
    """Convert (Multi)Polygon → MultiLineString so tippecanoe gets line
    geometry matching the layer registry."""
    if geom["type"] == "Polygon":
        return {"type": "MultiLineString", "coordinates": geom["coordinates"]}
    if geom["type"] == "MultiPolygon":
        lines: list[Any] = []
        for poly_rings in geom["coordinates"]:
            for ring in poly_rings:
                lines.append(ring)
        return {"type": "MultiLineString", "coordinates": lines}
    # Already a line or unsupported type — pass through.
    return geom


def _normalize_props(props: dict[str, Any]) -> dict[str, Any]:
    """PLSSID encodes everything (e.g. 'ID010230N0030W0SN380'); we expose
    the human-readable parts too so the click drawer is readable."""
    out: dict[str, Any] = {}
    for key in ("PLSSID", "STATEABBR", "FRSTDIVID", "TWNSHPNO", "RANGENO", "MERIDIAN"):
        v = props.get(key) or props.get(key.lower())
        if v not in (None, "", " "):
            out[key.lower()] = v
    return out


def run(work_dir: Path) -> SourceResult:
    log = logging.getLogger("etl.plss")
    log.info("starting PLSS township download from BLM CadNSDI")

    base = os.environ.get("PLSS_SERVICE_URL", SERVICE)
    query_url = f"{base}/{LAYER_ID}/query"
    log.info("querying %s", query_url)

    out_path = work_dir / "plss.geojson"
    feature_count = 0
    offset = 0
    started = time.monotonic()
    no_progress_iterations = 0  # guard against infinite loop on broken services

    try:
        with out_path.open("w", encoding="utf-8") as out:
            out.write('{"type":"FeatureCollection","features":[')
            first = True
            pbar = tqdm(desc="plss townships", unit="feat", smoothing=0.1)
            while True:
                body = _fetch_page(query_url, offset)
                features = body.get("features", [])
                if not features:
                    break
                for feat in features:
                    geom = feat.get("geometry")
                    if not geom:
                        continue
                    line_geom = _polygon_to_lines(geom)
                    props = _normalize_props(feat.get("properties") or feat.get("attributes") or {})
                    if not first:
                        out.write(",")
                    first = False
                    json.dump(
                        {"type": "Feature", "geometry": line_geom, "properties": props},
                        out,
                    )
                    feature_count += 1
                pbar.update(len(features))

                exceeded = body.get("exceededTransferLimit", False)
                if not exceeded and len(features) < PAGE_SIZE:
                    break
                offset += len(features)
                # Defensive: if a buggy service keeps returning the same page,
                # bail rather than loop forever.
                if len(features) == 0:
                    no_progress_iterations += 1
                    if no_progress_iterations >= 3:
                        log.warning("no progress for 3 consecutive pages, stopping")
                        break
                else:
                    no_progress_iterations = 0
            pbar.close()
            out.write("]}")
    except Exception:
        if out_path.exists():
            out_path.unlink()
        raise

    elapsed = time.monotonic() - started
    log.info(
        "wrote %d township outlines in %.1fs → %s",
        feature_count, elapsed, out_path.name,
    )

    return SourceResult(
        layer_id="plss",  # matches tilesetLayer in shared/layers.ts
        geojson_path=out_path,
        feature_count=feature_count,
    )
