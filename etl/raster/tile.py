"""
Shared workhorse for raster pre-tiling.

Pipeline per dataset:
  1. Download GeoTIFF from upstream URL → work_dir/source.tif
  2. Reproject to EPSG:3857 (Web Mercator) → work_dir/source_3857.tif
     Skipped if the source is already in Web Mercator.
  3. Apply color relief from .clr file → work_dir/source_rgb.tif
     RGBA output so transparent background lets the basemap show
     through where there's no data.
  4. Run gdal2tiles.py -p mercator → work_dir/tiles/{z}/{x}/{y}.png
  5. Upload tile pyramid to R2 under rasters/<dataset>/{z}/{x}/{y}.png
     using the same boto3 client + bucket as etl/upload.py.

All four GDAL stages shell out via subprocess — the python-gdal
bindings are heavyweight and we only need a handful of CLIs, all
of which ship with the standard `gdal-bin` apt package.

Color-ramp .clr files use gdaldem's text format:
    <value> <r> <g> <b> [<a>]
One line per stop; gdaldem linearly interpolates between them.
Use the special value `nv` for the no-data color (typically
transparent, e.g. "nv 0 0 0 0").

Output convention: tile keys in R2 are
  rasters/<dataset>/<z>/<x>/<y>.png
The Worker's raster route in apps/api/src/index.ts serves them
from this key pattern; the LayerDef.rasterTiles registry entry
uses the {base} token to point at the Worker origin.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time
import zipfile
from pathlib import Path

import boto3
import requests
from botocore.config import Config

BUCKET = "subterra-tiles"
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0 "
    "(Subterra-ETL +https://github.com/salamndrgaming-lab/subterra)"
)


def _env(name: str) -> str:
    v = os.environ.get(name, "").strip()
    if not v:
        print(f"::error::missing env var {name}", file=sys.stderr)
        sys.exit(2)
    return v


def _make_r2_client():
    account_id = _env("CLOUDFLARE_ACCOUNT_ID")
    return boto3.client(
        "s3",
        endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
        aws_access_key_id=_env("R2_ACCESS_KEY_ID"),
        aws_secret_access_key=_env("R2_SECRET_ACCESS_KEY"),
        region_name="auto",
        config=Config(
            retries={"max_attempts": 5, "mode": "adaptive"},
            connect_timeout=30,
            read_timeout=300,
        ),
    )


def _run(cmd: list[str]) -> None:
    """Run a GDAL CLI; stream stderr → our stderr; raise on non-zero."""
    print(f"$ {' '.join(cmd)}", flush=True)
    proc = subprocess.run(cmd, check=False)
    if proc.returncode != 0:
        raise RuntimeError(f"command failed (exit {proc.returncode}): {cmd[0]}")


def _download(url: str, dest: Path) -> None:
    if dest.exists() and dest.stat().st_size > 0:
        print(f"reusing cached {dest.name} ({dest.stat().st_size / 1e6:.1f} MB)")
        return
    print(f"downloading {url}", flush=True)
    resp = requests.get(
        url, headers={"User-Agent": USER_AGENT}, stream=True, timeout=600,
    )
    resp.raise_for_status()
    with dest.open("wb") as f:
        for chunk in resp.iter_content(chunk_size=1 << 20):
            if chunk:
                f.write(chunk)
    print(f"  → {dest.stat().st_size / 1e6:.1f} MB", flush=True)


def _looks_like_zip(path: Path) -> bool:
    """True if the file starts with the ZIP local-file-header magic.
    ScienceBase serves its GeoTIFF grids as .zip bundles and the upstream
    URL's extension isn't reliable (redirects, query strings), so we sniff
    the first bytes rather than trust the name."""
    try:
        with path.open("rb") as f:
            return f.read(4) == b"PK\x03\x04"
    except OSError:
        return False


def _extract_tif_from_zip(zip_path: Path, dest: Path) -> None:
    """Extract exactly one GeoTIFF member from a downloaded zip into `dest`.

    Member selection:
      - If RASTER_TIF_MEMBER is set, choose the .tif whose path contains
        that case-insensitive substring — lets you target one grid in a
        multi-grid bundle (e.g. pick the eU grid out of the radiometric
        K/eU/eTh release with RASTER_TIF_MEMBER=eU).
      - Otherwise choose the largest .tif by uncompressed size, which for
        these USGS bundles is the national grid rather than an ancillary
        hillshade / thumbnail / metadata raster.

    Raises RuntimeError if the zip has no .tif, or a hint matches none —
    the dataset script lets that propagate so the workflow fails loudly
    instead of uploading nothing.
    """
    with zipfile.ZipFile(zip_path) as zf:
        tifs = [
            i for i in zf.infolist()
            if not i.is_dir() and i.filename.lower().endswith((".tif", ".tiff"))
        ]
        if not tifs:
            sample = [i.filename for i in zf.infolist()][:20]
            raise RuntimeError(f"zip {zip_path.name} has no .tif member (saw: {sample})")
        hint = os.environ.get("RASTER_TIF_MEMBER", "").strip().lower()
        if hint:
            matches = [i for i in tifs if hint in i.filename.lower()]
            if not matches:
                raise RuntimeError(
                    f"RASTER_TIF_MEMBER='{hint}' matched no .tif in {zip_path.name} "
                    f"(available: {[i.filename for i in tifs]})"
                )
            chosen = max(matches, key=lambda i: i.file_size)
        else:
            chosen = max(tifs, key=lambda i: i.file_size)
        print(
            f"zip: extracting '{chosen.filename}' "
            f"({chosen.file_size / 1e6:.1f} MB) of {len(tifs)} .tif member(s)",
            flush=True,
        )
        with zf.open(chosen) as src, dest.open("wb") as out:
            shutil.copyfileobj(src, out)


def _upload_tile_pyramid(client, root: Path, key_prefix: str) -> int:
    """Walk root recursively, upload every .png under
    `<key_prefix>/<relative-path>`. Returns the upload count."""
    count = 0
    started = time.monotonic()
    for path in root.rglob("*.png"):
        rel = path.relative_to(root)
        key = f"{key_prefix.rstrip('/')}/{rel.as_posix()}"
        client.upload_file(
            str(path), BUCKET, key,
            ExtraArgs={
                "ContentType": "image/png",
                # Browsers + Cloudflare cache aggressively; raster tiles
                # are immutable per generation so a long max-age is safe.
                "CacheControl": "public, max-age=31536000, immutable",
            },
        )
        count += 1
        if count % 500 == 0:
            print(f"  uploaded {count} tiles ({count / (time.monotonic() - started):.0f}/s)", flush=True)
    print(f"uploaded {count} tiles in {time.monotonic() - started:.1f}s")
    return count


def tile_geotiff(
    *,
    dataset: str,
    source_url: str,
    color_ramp_clr: Path,
    work_dir: Path,
    min_zoom: int = 0,
    max_zoom: int = 9,
    extra_resampling: str = "near",
) -> int:
    """Full pipeline for one dataset. Returns the uploaded-tile count."""

    work_dir.mkdir(parents=True, exist_ok=True)
    src_tif = work_dir / "source.tif"
    src_3857 = work_dir / "source_3857.tif"
    src_rgb = work_dir / "source_rgb.tif"
    tile_root = work_dir / "tiles"
    if tile_root.exists():
        shutil.rmtree(tile_root)

    # 1) fetch — download whatever the URL hands us, then if it's a zip
    #    bundle (ScienceBase ships GeoTIFF grids zipped), extract the
    #    chosen .tif member. Lets source_url be a direct .tif OR a .zip
    #    with no change at dispatch time beyond the optional
    #    RASTER_TIF_MEMBER hint for multi-grid bundles.
    if src_tif.exists() and src_tif.stat().st_size > 0:
        print(f"reusing cached source.tif ({src_tif.stat().st_size / 1e6:.1f} MB)")
    else:
        raw = work_dir / "download.bin"
        _download(source_url, raw)
        if _looks_like_zip(raw):
            _extract_tif_from_zip(raw, src_tif)
        else:
            # Already a GeoTIFF (or at least not a zip) — promote to the
            # source.tif name gdalwarp expects. os.replace is an atomic
            # rename, no second copy of a multi-hundred-MB file.
            os.replace(raw, src_tif)

    # 2) reproject to Web Mercator — gdalwarp is a no-op if already 3857,
    #    but it's cheaper to just always run it than to inspect the SRS.
    _run([
        "gdalwarp", "-overwrite",
        "-t_srs", "EPSG:3857",
        "-r", extra_resampling,
        "-of", "GTiff",
        "-co", "TILED=YES",
        "-co", "COMPRESS=DEFLATE",
        str(src_tif), str(src_3857),
    ])

    # 3) apply color ramp; -alpha emits 4-band RGBA so nodata is transparent
    _run([
        "gdaldem", "color-relief",
        str(src_3857), str(color_ramp_clr), str(src_rgb),
        "-alpha",
        "-of", "GTiff",
        "-co", "TILED=YES",
        "-co", "COMPRESS=DEFLATE",
    ])

    # 4) generate XYZ tile pyramid. -p mercator emits {z}/{x}/{y}.png in
    #    Slippy/OSM convention (origin top-left), which is what MapLibre
    #    expects. --xyz is GDAL ≥ 3.1 — confirmed present on ubuntu-latest.
    _run([
        "gdal2tiles.py",
        "-p", "mercator",
        "-z", f"{min_zoom}-{max_zoom}",
        "--xyz",
        "--processes", "4",
        "-w", "none",  # don't generate the leaflet viewer HTML
        str(src_rgb), str(tile_root),
    ])

    # 5) upload
    client = _make_r2_client()
    count = _upload_tile_pyramid(client, tile_root, key_prefix=f"rasters/{dataset}")
    return count
