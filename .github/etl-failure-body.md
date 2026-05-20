The weekly ETL refresh failed. See the run log linked from the latest
workflow execution. Common causes:

1. **An agency moved a bulk download URL.** Update the URL in the
   corresponding `etl/sources/*.py` module.
2. **tippecanoe install failed in CI.** Re-run; transient apt errors are
   common.
3. **R2 upload auth expired.** Rotate `CLOUDFLARE_API_TOKEN`.

The web app continues to serve the previously-published `subterra.pmtiles`
from R2 until this is resolved — users don't see broken tiles, just stale
ones.
