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

    # 1) download
    _download(source_url, src_tif)

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
