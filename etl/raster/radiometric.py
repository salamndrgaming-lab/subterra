"""
USGS radiometric total-count — CONUS Earth MRI compilation.

Third sibling of the Earth MRI raster series after gravity.py and
aeromag.py. Same shared tile.py pipeline; only the URL, color ramp,
and R2 key prefix change.

Radiometric surveys measure natural gamma-ray emissions from K, Th,
U decay chains in surface rocks + regolith. Total-count (TC) is the
sum across all three channels — the most common single-band product
USGS publishes per survey area. Useful as a felsic-vs-mafic
discriminator (felsic K-feldspar / granitic terranes light up; mafic
+ ultramafic dark) and a direct first-pass uranium-exploration
filter.

Source URL is REQUIRED via the RADIOMETRIC_GEOTIFF_URL env var
(workflow dispatch input). No default — USGS radiometric GeoTIFFs
live at unstable ScienceBase item IDs that would silently 404 if
committed.

Color ramp `colorramps/radiometric.clr` is a sequential cmap
(not diverging — gamma counts can't be negative): transparent for
nodata, cool yellows for low counts, warm oranges + reds for high
counts. Stops are in counts-per-second (cps); adjust if the source
uses µR/h or a per-element concentration (eU, eTh, K%).

Zoom range 0-9 matches gravity + aeromag — CONUS radiometric maps
are decorative beyond z9 and the survey footprint resolution doesn't
support honest pixel rendering past there anyway.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from .tile import tile_geotiff

DATASET = "radiometric"


def main() -> int:
    url = os.environ.get("RADIOMETRIC_GEOTIFF_URL", "").strip()
    if not url:
        print(
            "::error::RADIOMETRIC_GEOTIFF_URL env var is required — pass via the "
            "rasters.yml workflow dispatch input. No default URL is committed "
            "because USGS radiometric GeoTIFF endpoints aren't stable enough to assume.",
            file=sys.stderr,
        )
        return 2

    work_dir = Path(__file__).resolve().parent / "_work" / DATASET
    # Color ramp is selectable by name via RASTER_COLOR_RAMP so the same
    # dataset script can tile a different physical quantity without a code
    # change — the NURE radiometric release ships per-element grids (K %,
    # eU ppm, eTh ppm) whose value ranges differ wildly, so each needs its
    # own ramp. e.g. RASTER_COLOR_RAMP=radiometric_eu → colorramps/
    # radiometric_eu.clr. Empty falls back to the dataset-default ramp.
    ramp_name = os.environ.get("RASTER_COLOR_RAMP", "").strip() or DATASET
    clr = Path(__file__).resolve().parent / "colorramps" / f"{ramp_name}.clr"
    if not clr.exists():
        print(f"::error::color ramp missing: {clr}", file=sys.stderr)
        return 2

    count = tile_geotiff(
        dataset=DATASET,
        source_url=url,
        color_ramp_clr=clr,
        work_dir=work_dir,
        min_zoom=0,
        max_zoom=int(os.environ.get("RADIOMETRIC_MAX_ZOOM", "9")),
        extra_resampling="cubic",
    )
    print(f"::notice::radiometric raster pipeline complete — {count} tiles uploaded")
    return 0


if __name__ == "__main__":
    sys.exit(main())
