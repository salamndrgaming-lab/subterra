"""
USGS aeromagnetic total-field — CONUS Earth MRI compilation.

Same pipeline as gravity.py — download → reproject → color-relief →
gdal2tiles → R2 upload. Wired into the shared tile.py workhorse so
the only dataset-specific config is the URL, the color ramp, and
the R2 key prefix.

Source URL is REQUIRED via the AEROMAG_GEOTIFF_URL env var (workflow
dispatch input). No default — USGS aeromag GeoTIFFs live at
unstable ScienceBase item IDs that would silently 404 if committed.

Color ramp `colorramps/aeromag.clr` is a typical magnetic-anomaly
diverging cmap: cool blues for negative anomalies (basement
magnetite-poor zones, magnetic lows), white near zero, hot reds
for positive anomalies (magnetic-rich intrusives, mafic highs).
Values in nT — adjust stops if the source uses different units.

Zoom range 0-9 matches gravity; CONUS-scale magnetic-anomaly maps
are decorative beyond z9.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from .tile import tile_geotiff

DATASET = "aeromag"


def main() -> int:
    url = os.environ.get("AEROMAG_GEOTIFF_URL", "").strip()
    if not url:
        print(
            "::error::AEROMAG_GEOTIFF_URL env var is required — pass via the "
            "rasters.yml workflow dispatch input. No default URL is committed "
            "because USGS aeromag GeoTIFF endpoints aren't stable enough to assume.",
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
        max_zoom=int(os.environ.get("AEROMAG_MAX_ZOOM", "9")),
        extra_resampling="cubic",
    )
    print(f"::notice::aeromag raster pipeline complete — {count} tiles uploaded")
    return 0


if __name__ == "__main__":
    sys.exit(main())
