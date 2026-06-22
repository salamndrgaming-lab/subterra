"""
USGS Bouguer gravity — CONUS continental compilation.

Downloads the Bouguer-anomaly GeoTIFF and runs it through the
shared tile.py pipeline. Output ends up at R2 under
`rasters/gravity/{z}/{x}/{y}.png`, served by the Worker's
`/rasters/gravity/...` route, displayed by the `gravity` layer
in the LayerDef registry.

Source URL is REQUIRED via the GRAVITY_GEOTIFF_URL env var — there
is no default, because USGS GeoTIFF download URLs aren't stable
enough that I'll commit a default that might 404 silently. The
maintainer triggering the workflow provides a verified URL via
the rasters.yml dispatch input.

Color ramp `colorramps/gravity.clr` is a typical gravity-anomaly
diverging cmap: deep blue for strongly negative (basins, sediment
fill), white near zero, deep red for strongly positive (basement
highs, dense intrusives). Values in mGal — adjust the .clr stops
if the source uses different units.

Zoom range 0-9 keeps the tile pyramid manageable (~300 MB on disk
for a CONUS raster at that range), enough for the use case (the
overlay is decorative beyond z9 anyway).
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from .tile import tile_geotiff

DATASET = "gravity"
DEFAULT_URL = None  # see module docstring — no default by design


def main() -> int:
    url = os.environ.get("GRAVITY_GEOTIFF_URL", "").strip()
    if not url:
        print(
            "::error::GRAVITY_GEOTIFF_URL env var is required — pass via the "
            "rasters.yml workflow dispatch input. No default URL is committed "
            "because USGS GeoTIFF endpoints aren't stable enough to assume.",
            file=sys.stderr,
        )
        return 2

    work_dir = Path(__file__).resolve().parent / "_work" / DATASET
    clr = Path(__file__).resolve().parent / "colorramps" / f"{DATASET}.clr"
    if not clr.exists():
        print(f"::error::color ramp missing: {clr}", file=sys.stderr)
        return 2

    count = tile_geotiff(
        dataset=DATASET,
        source_url=url,
        color_ramp_clr=clr,
        work_dir=work_dir,
        min_zoom=0,
        max_zoom=int(os.environ.get("GRAVITY_MAX_ZOOM", "9")),
        extra_resampling="cubic",  # smoother than 'near' for a continuous field
    )
    print(f"::notice::gravity raster pipeline complete — {count} tiles uploaded")
    return 0


if __name__ == "__main__":
    sys.exit(main())
