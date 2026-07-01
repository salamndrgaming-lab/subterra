"""
USGS State Geologic Map Compilation (SGMC) v2 — bedrock geology polygons.

The first surface-bedrock vector layer on Subterra's main map. Today
bedrock is only visible inside the cross-section modal via Macrostrat's
sampled-column API; SGMC adds full polygon coverage at the surface so
users can see "I'm sitting on Eureka Quartzite, that ends 8 km west of
me" without opening a section.

Source: USGS SGMC v2 ScienceBase community at
  https://www.sciencebase.gov/catalog/item/5888bf4fe4b05ccb964bab9d
(DOI 10.5066/F7WH2N65) — successor to the per-state DDS series.
Published as a CONUS-wide GeoPackage + per-state shapefile mirrors.

Strategy mirrors etl/sources/geophysics.py:
  1. Query the ScienceBase item JSON to enumerate downloadable files.
  2. Pick the largest / most-geology-looking shapefile or GeoPackage.
  3. Download, unzip, read with geopandas.
  4. BBox-filter to the western US (lng -125 .. -95, lat 25 .. 49) so
     the output GeoJSON stays under ~500 MB before tippecanoe consumes
     it. The eastern US has bedrock too but isn't prospecting ground;
     skip until we have user demand.
  5. Normalize SGMC's standard schema (UNIT_NAME / UNIT_AGE / ROCKTYPE1
     / GENRSCLASS / SOURCE) into a flat property dict.

The ETL is defensive: if ScienceBase doesn't expose a shapefile we
recognize, we emit an empty GeoJSON and return 0 features. The
EXPECTED_MIN_FEATURES guard in refresh.py then trips and the sidebar
Unhealthy-Data Banner surfaces the issue.

Env overrides:
  SUBTERRA_SGMC_DIRECT_URL   — bypass ScienceBase enumeration, point
                               directly at a shapefile zip or GeoPackage.
  SUBTERRA_SGMC_ITEM_ID      — override the ScienceBase item id (if the
                               canonical v2 item is replaced by v3+).
"""

from __future__ import annotations

import json
import logging
import os
import time
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import requests

DEFAULT_ITEM_ID = "5888bf4fe4b05ccb964bab9d"  # SGMC v2 on ScienceBase
# Search-confirmed 2026-07-01 direct download — the ScienceBase item
# ships USGS_SGMC_Shapefiles.zip (readable via /vsizip/ .shp; the reader
# doesn't handle the .gdb geodatabase zip). Using the direct file URL
# bypasses the item-JSON enumeration that was returning empty. Override
# with SUBTERRA_SGMC_DIRECT_URL.
DEFAULT_DIRECT_URL = (
    "https://www.sciencebase.gov/catalog/file/get/"
    "5888bf4fe4b05ccb964bab9d?name=USGS_SGMC_Shapefiles.zip"
)
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0 "
    "(Subterra-ETL +https://github.com/salamndrgaming-lab/subterra)"
)
REQUEST_TIMEOUT = 1200.0  # SGMC zips can be ~500 MB; allow plenty.

# Western-US bounding box. Wider than the Map's default center so users
# in the Front Range / Sierra Nevada / Black Hills all see coverage.
WEST_BBOX = (-125.0, 25.0, -95.0, 49.0)  # (lng_min, lat_min, lng_max, lat_max)


@dataclass
class SourceResult:
    layer_id: str
    geojson_path: Path
    feature_count: int


def _item_json_url(item_id: str) -> str:
    return f"https://www.sciencebase.gov/catalog/item/{item_id}?format=json"


def _find_download_url(log: logging.Logger, item_id: str) -> str | None:
    """Score files in the ScienceBase item; return the best zip/gpkg url.

    SGMC v2 ships a CONUS GeoPackage as the primary download plus
    per-state shapefile zips as supporting files. Either format works
    with geopandas (.gpkg via fiona, .shp via /vsizip/). Prefer the
    largest zip first because it's almost always the CONUS-wide bundle.
    """
    log.info("querying ScienceBase item %s", item_id)
    resp = requests.get(
        _item_json_url(item_id),
        headers={"User-Agent": USER_AGENT, "accept": "application/json"},
        timeout=REQUEST_TIMEOUT,
    )
    resp.raise_for_status()
    item = resp.json()
    files = item.get("files") or []
    log.info("item has %d files", len(files))

    best: tuple[int, dict[str, Any]] | None = None
    for f in files:
        name = (f.get("name") or "").lower()
        title = (f.get("title") or "").lower()
        url = f.get("url") or f.get("downloadUri")
        if not url:
            continue
        score = 0
        # Strong signal: format
        if name.endswith(".gpkg") or name.endswith(".gpkg.zip"):
            score += 6  # GPKG is the canonical SGMC v2 format
        elif name.endswith(".zip"):
            score += 3
        # Strong signal: keyword match in filename or title
        for kw in ("sgmc", "geologic_units", "geologic-units", "bedrock", "lithology"):
            if kw in name or kw in title:
                score += 4
                break
        for kw in ("conus", "national", "all_states", "v2"):
            if kw in name or kw in title:
                score += 2
                break
        # Prefer larger files (the supplementary metadata zips are
        # tiny — we want the data zip).
        size_mb = (f.get("size") or 0) / 1_000_000
        if size_mb > 50:
            score += 3
        elif size_mb > 10:
            score += 1
        if score >= 5 and (best is None or score > best[0]):
            best = (score, f)
    if best:
        f = best[1]
        url = f.get("url") or f.get("downloadUri")
        log.info(
            "selected file: %s (score=%d, %.1f MB) → %s",
            f.get("name"), best[0], (f.get("size") or 0) / 1_000_000, url,
        )
        return url
    log.warning("no SGMC-looking download found among %d files", len(files))
    return None


def _download(url: str, work_dir: Path, log: logging.Logger) -> Path:
    """Stream the SGMC bundle to disk; cache between runs."""
    suffix = ".gpkg" if url.lower().endswith(".gpkg") else ".zip"
    dest = work_dir / f"sgmc{suffix}"
    if dest.exists() and dest.stat().st_size > 1_000_000:
        log.info("using cached %s (%d MB)", dest.name, dest.stat().st_size // 1_000_000)
        return dest
    log.info("downloading %s → %s", url, dest.name)
    with requests.get(
        url,
        headers={"User-Agent": USER_AGENT, "accept": "application/zip, application/octet-stream, */*"},
        stream=True,
        timeout=REQUEST_TIMEOUT,
        allow_redirects=True,
    ) as resp:
        resp.raise_for_status()
        total = 0
        with dest.open("wb") as out:
            for chunk in resp.iter_content(chunk_size=1 << 20):
                out.write(chunk)
                total += len(chunk)
        log.info("downloaded %d MB", total // 1_000_000)
    return dest


def _resolve_vsi_path(dest: Path, log: logging.Logger) -> str | None:
    """Pick the right read path: .gpkg directly, or first .shp inside .zip."""
    if dest.suffix.lower() == ".gpkg":
        return str(dest.resolve())
    if dest.suffix.lower() == ".zip":
        with zipfile.ZipFile(dest) as zf:
            names = zf.namelist()
        # First .gpkg if the zip wraps a GeoPackage
        gpkgs = [n for n in names if n.lower().endswith(".gpkg")]
        if gpkgs:
            return f"/vsizip/{dest.resolve()}/{gpkgs[0]}"
        # Otherwise pick the first .shp; prefer ones that name themselves
        # for the geologic-units polygons (skip the line/point sidecar
        # layers SGMC includes for unit boundaries + contacts).
        shps = [n for n in names if n.lower().endswith(".shp")]
        log.info("zip has %d entries, %d shapefiles: %s", len(names), len(shps), shps[:5])
        if not shps:
            return None
        polys = [n for n in shps if any(k in n.lower() for k in ("geo_units", "geologic_units", "units", "poly"))]
        chosen = (polys or shps)[0]
        return f"/vsizip/{dest.resolve()}/{chosen}"
    return None


# SGMC's `ROCKTYPE1` / `GENRSCLASS` controlled vocabulary maps to broad
# lithology buckets. Normalizing here keeps the downstream lithology
# color match expression simple.
ROCKTYPE_TO_LITHOLOGY: dict[str, str] = {
    "sandstone": "sandstone",
    "limestone": "limestone",
    "dolomite": "dolomite",
    "shale": "shale",
    "mudstone": "mudstone",
    "siltstone": "siltstone",
    "conglomerate": "conglomerate",
    "claystone": "claystone",
    "evaporite": "evaporite",
    "gypsum": "gypsum",
    "halite": "halite",
    "chert": "chert",
    "coal": "coal",
    "granite": "granite",
    "granodiorite": "granodiorite",
    "diorite": "diorite",
    "gabbro": "gabbro",
    "basalt": "basalt",
    "rhyolite": "rhyolite",
    "andesite": "andesite",
    "dacite": "dacite",
    "tuff": "tuff",
    "ignimbrite": "ignimbrite",
    "schist": "schist",
    "gneiss": "gneiss",
    "amphibolite": "amphibolite",
    "quartzite": "quartzite",
    "marble": "marble",
    "slate": "slate",
    "phyllite": "phyllite",
}


def _first_nonempty(d: dict[str, Any], *keys: str) -> Any:
    for k in keys:
        for cased in (k, k.upper(), k.lower(), k.title()):
            if cased in d and d[cased] not in (None, "", " "):
                return d[cased]
    return None


def _normalize_lith(raw: Any) -> str | None:
    if raw in (None, "", " "):
        return None
    s = str(raw).strip().lower()
    # SGMC ROCKTYPE1 is a controlled vocab but values arrive as
    # mixed-case multi-word ("Sandstone - fine grained"). Pick the first
    # matching keyword as our canonical lithology.
    for keyword, canon in ROCKTYPE_TO_LITHOLOGY.items():
        if keyword in s:
            return canon
    return s[:48]  # cap raw passthrough length


def _normalize(props: dict[str, Any], state_hint: str | None) -> dict[str, Any]:
    """SGMC's per-state schemas vary slightly; coalesce common fields."""
    unit_name = _first_nonempty(props, "UNIT_NAME", "unit_name", "UNIT", "NAME")
    age_text = _first_nonempty(props, "UNIT_AGE", "unit_age", "AGE", "AGE_TEXT")
    rocktype = _first_nonempty(props, "ROCKTYPE1", "rocktype1", "ROCKTYPE", "LITHOLOGY")
    gen_class = _first_nonempty(props, "GENRSCLASS", "genrsclass", "ROCK_CLASS", "GEN_LITH")
    source = _first_nonempty(props, "SOURCE", "source", "SRC_REF", "CITATION")
    state = _first_nonempty(props, "STATE", "state") or state_hint

    out: dict[str, Any] = {}
    if unit_name is not None:
        out["unit_name"] = str(unit_name)[:120]
    if age_text is not None:
        out["age_text"] = str(age_text)[:64]
    if rocktype is not None:
        out["rocktype"] = str(rocktype)[:48]
    lith = _normalize_lith(rocktype) or _normalize_lith(gen_class)
    if lith:
        out["lithology"] = lith
    if gen_class is not None:
        out["gen_class"] = str(gen_class)[:32]
    if source is not None:
        out["src_ref"] = str(source)[:120]
    if state is not None:
        out["state"] = str(state)[:4]
    return out


def run(work_dir: Path) -> SourceResult:
    log = logging.getLogger("etl.sgmc")
    log.info("starting USGS SGMC bedrock-geology download")
    started = time.monotonic()

    # Env overrides:
    item_id = os.environ.get("SUBTERRA_SGMC_ITEM_ID") or DEFAULT_ITEM_ID
    # Prefer the committed direct download (bypasses the flaky item-JSON
    # enumeration); env override wins over both.
    direct_url = os.environ.get("SUBTERRA_SGMC_DIRECT_URL") or DEFAULT_DIRECT_URL

    try:
        url = direct_url or _find_download_url(log, item_id)
    except Exception as err:  # noqa: BLE001
        log.warning("ScienceBase enumeration failed: %s", err)
        url = None

    if not url:
        empty = work_dir / "sgmc.geojson"
        empty.write_text('{"type":"FeatureCollection","features":[]}')
        log.warning("no SGMC download URL resolved — emitting empty layer")
        return SourceResult(layer_id="sgmc", geojson_path=empty, feature_count=0)

    try:
        dest = _download(url, work_dir, log)
    except Exception as err:  # noqa: BLE001
        log.warning("SGMC download failed: %s", err)
        empty = work_dir / "sgmc.geojson"
        empty.write_text('{"type":"FeatureCollection","features":[]}')
        return SourceResult(layer_id="sgmc", geojson_path=empty, feature_count=0)

    vsi_path = _resolve_vsi_path(dest, log)
    if not vsi_path:
        empty = work_dir / "sgmc.geojson"
        empty.write_text('{"type":"FeatureCollection","features":[]}')
        log.warning("no readable geology layer in %s", dest.name)
        return SourceResult(layer_id="sgmc", geojson_path=empty, feature_count=0)

    import geopandas as gpd
    log.info("reading %s with geopandas (this may take a few minutes)", vsi_path)
    try:
        gdf = gpd.read_file(vsi_path, bbox=WEST_BBOX)
    except Exception as err:  # noqa: BLE001
        log.warning("geopandas read failed with bbox; retrying full read: %s", err)
        gdf = gpd.read_file(vsi_path)

    log.info("read %d polygons × %d cols", len(gdf), len(gdf.columns))
    log.info("columns: %s", list(gdf.columns)[:20])

    if gdf.crs is not None and gdf.crs.to_epsg() != 4326:
        log.info("reprojecting from %s → EPSG:4326", gdf.crs)
        gdf = gdf.to_crs("EPSG:4326")

    # Filter to the western US bbox (defensive — the bbox= arg above
    # may or may not be honored depending on the driver).
    lng_min, lat_min, lng_max, lat_max = WEST_BBOX
    pre_count = len(gdf)
    gdf = gdf.cx[lng_min:lng_max, lat_min:lat_max]
    log.info("bbox-filtered %d → %d polygons (western US only)", pre_count, len(gdf))

    out_path = work_dir / "sgmc.geojson"
    count = 0
    first = True
    per_lithology: dict[str, int] = {}
    with out_path.open("w", encoding="utf-8") as out:
        out.write('{"type":"FeatureCollection","features":[')
        for _, row in gdf.iterrows():
            geom = row.geometry
            if geom is None or geom.is_empty:
                continue
            row_d = row.to_dict()
            row_d.pop("geometry", None)
            props = _normalize(row_d, state_hint=None)
            if not first:
                out.write(",")
            first = False
            geom_json = json.loads(gpd.GeoSeries([geom], crs="EPSG:4326").to_json())
            feat_geom = geom_json["features"][0]["geometry"] if geom_json.get("features") else None
            if not feat_geom:
                continue
            json.dump({"type": "Feature", "geometry": feat_geom, "properties": props}, out)
            count += 1
            lith = props.get("lithology", "unknown")
            per_lithology[lith] = per_lithology.get(lith, 0) + 1
        out.write("]}")

    elapsed = time.monotonic() - started
    log.info("wrote %d SGMC polygons in %.1fs", count, elapsed)
    top_lith = sorted(per_lithology.items(), key=lambda kv: -kv[1])[:10]
    log.info("top lithologies: %s", top_lith)
    return SourceResult(layer_id="sgmc", geojson_path=out_path, feature_count=count)
