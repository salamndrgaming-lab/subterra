"""
Raster pre-tile pipeline.

USGS publishes most geophysics products (Bouguer gravity, aeromag,
radiometric) as downloadable GeoTIFFs + OGC WMS — NOT as the XYZ
tile services that MapLibre consumes natively. To put them on the
map we pre-tile the GeoTIFFs ourselves: download → reproject to
Web Mercator → apply a color ramp → generate a PNG tile pyramid
→ upload to R2 under `rasters/<dataset>/{z}/{x}/{y}.png`.

This is the gdal2tiles half of the architecture. The Worker route
in apps/api/src/index.ts serves the resulting tiles, and the
LayerDef registry entry's rasterTiles template (with the {base}
token) wires the layer into MapLibre.

One-shot scripts: tile.py is the shared workhorse; gravity.py +
(future) aeromag.py + radiometric.py are dataset-specific wrappers
that pass their own GeoTIFF URL + color ramp + R2 key prefix.

Triggered manually via .github/workflows/rasters.yml — never on
push, because GeoTIFF source URLs aren't reliably stable enough
to assume they'll keep working on every commit.
"""
