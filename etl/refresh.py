#!/usr/bin/env python3
"""
Subterra ETL orchestrator.

Runs every source module (one per dataset), normalizes each output to
GeoJSON in `etl/work/`, then merges them into a single PMTiles file via
tippecanoe. Phase 0 ships the runner + one source stub (template). Real
sources land in Phase 1+.

Usage:
    python etl/refresh.py                # run every enabled source
    python etl/refresh.py --only blm_claims,mrds
    python etl/refresh.py --skip-tippecanoe   # for source-development loops
"""

from __future__ import annotations

import argparse
import hashlib
import importlib
import json
import logging
import os
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WORK = ROOT / "work"
OUT = ROOT / "out"
WORK.mkdir(parents=True, exist_ok=True)
OUT.mkdir(parents=True, exist_ok=True)

# Source modules to invoke. Each must export a `run(work_dir: Path) ->
# SourceResult` callable. New datasets get added here when their source
# module is ready.
SOURCES = [
    "mrds",          # Phase 1 — USGS Mineral Resources Data System (~310k points)
    "blm_claims",    # Phase 2 — BLM MLRS active mining claims (~550k polygons)
    "blm_leases",    # Phase 2 — BLM MLRS active oil & gas leases (~24k polygons)
    "plss",          # Phase 2 — BLM National PLSS township grid (~50k lines)
    "federal_lands", # Phase 2 — BLM National SMA (BLM/USFS/NPS/BIA polygons)
    "pipelines_natgas", # Phase 2 — EIA natural-gas trunk pipelines
    "pipelines_crude",  # Phase 2 — EIA crude-oil trunk pipelines
    "wells",            # Phase 2 — HIFLD wells via NASA NCCS mirror (~1M points)
    "geochemistry",  # Phase 9 — USGS NGDB stream-sediment/soil samples (~1.5M points)
    "geophysics",    # Phase 9 — USGS Earth MRI airborne survey footprints
    # Stake-ability constraint layers — needed for legally-correct
    # "open BLM land" identification and the eligibility check in the
    # detail drawer. Each is a polygon source consumed by both the
    # tile layer (visualization) and the features-db PIP path.
    "withdrawals",     # BLM National Withdrawn Lands (mineral entry blockers)
    "critical_habitat",# USFWS ESA designated critical habitat
    "indian_lands",    # Census TIGER AIANNH — tribal lands (hard exclusion)
    "water_rights",    # Per-state water rights (NV + UT + AZ — first cluster)
    "quaternary_faults", # USGS Quaternary Faults and Folds (seismic + cross-sect)
    "parcels",         # Per-county assessor parcels (NV: Washoe/Clark/Elko/Lyon)
    # hotspots reads other sources' GeoJSON from work_dir to score
    # cell-binned prospecting opportunity — MUST stay last so the
    # inputs are guaranteed to exist when it runs.
    "hotspots",
]


@dataclass
class SourceResult:
    """Return value from a source module's run() function."""
    layer_id: str          # matches packages/shared/src/layers.ts tilesetLayer
    geojson_path: Path     # absolute path to the normalized .geojson file
    feature_count: int     # number of features written


def configure_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s :: %(message)s",
        stream=sys.stdout,
    )


# Per-source status entry. Captured for the manifest so the web app can
# show "this layer failed in the last ETL run because X" without anyone
# needing to read Actions logs.
@dataclass
class SourceStatus:
    name: str
    status: str           # 'ok' | 'failed' | 'empty'
    feature_count: int
    elapsed_s: float
    error: str | None = None


# Mutable list collected by run_sources() and read by write_manifest().
SOURCE_STATUSES: list[SourceStatus] = []


def run_sources(only: set[str] | None, skip_set: set[str]) -> list[SourceResult]:
    """Run every enabled source module. A failure in one source is logged
    but doesn't abort the run — tippecanoe builds tiles from whatever
    succeeded so a single broken upstream doesn't blank the production
    map. Per-source status is recorded in SOURCE_STATUSES for the
    manifest, which is how the web UI learns *why* a layer is empty."""
    results: list[SourceResult] = []
    failures: list[tuple[str, str]] = []
    SOURCE_STATUSES.clear()
    for name in SOURCES:
        if only is not None and name not in only:
            continue
        if name in skip_set:
            continue
        log = logging.getLogger(f"etl.{name}")
        log.info("starting source")
        t0 = time.monotonic()
        try:
            module = importlib.import_module(f"sources.{name}")
            result: SourceResult = module.run(WORK)
            elapsed = time.monotonic() - t0
            log.info(
                "done in %.1fs (%d features → %s)",
                elapsed, result.feature_count, result.geojson_path.name,
            )
            results.append(result)
            SOURCE_STATUSES.append(SourceStatus(
                name=name,
                status="ok" if result.feature_count > 0 else "empty",
                feature_count=result.feature_count,
                elapsed_s=round(elapsed, 1),
            ))
        except Exception as exc:  # noqa: BLE001
            elapsed = time.monotonic() - t0
            log.error("FAILED after %.1fs — %s: %s", elapsed, type(exc).__name__, exc)
            failures.append((name, f"{type(exc).__name__}: {exc}"))
            SOURCE_STATUSES.append(SourceStatus(
                name=name,
                status="failed",
                feature_count=0,
                elapsed_s=round(elapsed, 1),
                # Truncate to keep the manifest under reasonable size.
                error=f"{type(exc).__name__}: {str(exc)[:500]}",
            ))
    if failures:
        logging.getLogger("etl").warning(
            "%d source(s) failed: %s",
            len(failures),
            ", ".join(n for n, _ in failures),
        )
    return results


def run_tippecanoe(results: list[SourceResult]) -> Path:
    """Merge per-source GeoJSON into a single subterra.pmtiles file.

    Tile-size flags tuned for the full layer set (mrds + claims + leases +
    federal_lands + plss sections + wells + pipelines, ~3M features
    total). Without --maximum-tile-bytes the combined output ran over
    700 MiB which exceeds wrangler's single-shot upload cap and bogs
    down client bandwidth. We give tippecanoe a per-tile budget and let
    it coalesce/drop densest features at low zooms to honor it."""
    if not results:
        raise RuntimeError("No source results to tile — nothing to do.")
    out = OUT / "subterra.pmtiles"
    if out.exists():
        out.unlink()
    args: list[str] = [
        "tippecanoe",
        "-o", str(out),
        "--force",
        # Start at zoom 4: the lowest minZoom in shared/layers.ts is 4, so
        # nothing renders below that. Skipping z0-z3 avoids the degenerate
        # "tile 0/0/0 can't fit" loop when continent-scale federal-land
        # polygons land in the single world tile.
        "--minimum-zoom=4",
        "--maximum-zoom=12",
        # Default 500 KB per-tile size cap is enough headroom.
        "--maximum-tile-bytes=500000",
        # Use ONE reduction strategy — multiple at once thrashes.
        "--drop-densest-as-needed",
        # Aggressive geometry simplification at every zoom (15 = drop
        # vertices within 15 pixel-tolerance of the line).
        "--simplification=15",
        # Detect shared polygon borders + dedupe — huge win for adjacent
        # federal-land + PLSS-section polygons that share edges.
        "--detect-shared-borders",
        "--read-parallel",
    ]
    for r in results:
        args.extend(["--named-layer", f"{r.layer_id}:{r.geojson_path}"])
    logging.info("tippecanoe: %s", " ".join(args))
    subprocess.run(args, check=True)
    return out


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def write_manifest(results: list[SourceResult], pmtiles_path: Path) -> Path:
    """Emit out/manifest.json — what the Worker serves at /manifest.

    Public URLs are computed from TILES_BASE_URL (set in GitHub Actions
    env, defaults to the published R2 public-bucket URL). The web app
    fetches /manifest, then uses these URLs directly — no signed URLs,
    no auth, just public read-only R2."""
    tiles_base = os.environ.get(
        "TILES_BASE_URL", "https://tiles.subterra.app",
    ).rstrip("/")

    pmtiles_hash = sha256(pmtiles_path) if pmtiles_path.exists() else ""
    features_db = OUT / "subterra-features.db"
    features_hash = sha256(features_db) if features_db.exists() else ""

    # Hotspots: ship the top-20 directly in the manifest so the sidebar
    # widget renders without an extra fetch. The PMTiles layer can't be
    # queried globally (only per-tile), so embedding the ranked list
    # here is the cleanest way to make "Top Hotspots" discoverable.
    top_hotspots: list[dict] = []
    for r in results:
        if r.layer_id != "hotspots" or not r.geojson_path.exists():
            continue
        try:
            with r.geojson_path.open("r", encoding="utf-8") as f:
                data = json.load(f)
            for feat in (data.get("features") or [])[:100]:
                props = feat.get("properties") or {}
                top_hotspots.append({
                    "score": props.get("score"),
                    "deposits": props.get("deposits"),
                    "claims": props.get("claims"),
                    "blmPolys": props.get("blm_polys"),
                    "geochemAnom": props.get("geochem_anom"),
                    "topCommodities": props.get("top_commodities"),
                    "costLow": props.get("cost_low"),
                    "costHigh": props.get("cost_high"),
                    "revenueLow": props.get("revenue_low"),
                    "revenueHigh": props.get("revenue_high"),
                    "lng": props.get("lng"),
                    "lat": props.get("lat"),
                })
        except Exception:  # noqa: BLE001 — manifest must never fail to write
            pass

    # Live commodity spot prices — advisory figures the client uses to
    # show market-tracking dollar values. Never fails the manifest: the
    # fetcher returns a static fallback table if every feed is down.
    try:
        from sources.commodity_prices import fetch_prices
        commodity_prices = fetch_prices()
    except Exception as exc:  # noqa: BLE001
        logging.getLogger("etl").warning("commodity price fetch failed: %s", exc)
        commodity_prices = None

    manifest = {
        "version": int(time.time()),
        "publishedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "pmtilesUrl": f"{tiles_base}/tiles/subterra.pmtiles",
        "featuresDbUrl": f"{tiles_base}/features/subterra-features.db",
        "checksums": {
            "pmtiles": pmtiles_hash,
            "featuresDb": features_hash,
        },
        "counts": {r.layer_id: r.feature_count for r in results},
        "topHotspots": top_hotspots,
        "commodityPrices": commodity_prices,
        # Per-source ETL outcome. Turns silent "layer renders empty"
        # failures into a visible signal the UI can surface.
        "sources": [
            {
                "name": s.name,
                "status": s.status,
                "featureCount": s.feature_count,
                "elapsedS": s.elapsed_s,
                **({"error": s.error} if s.error else {}),
            }
            for s in SOURCE_STATUSES
        ],
    }
    path = OUT / "manifest.json"
    path.write_text(json.dumps(manifest, indent=2))
    return path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", help="comma-separated source names to include")
    parser.add_argument("--skip", help="comma-separated source names to skip")
    parser.add_argument("--skip-tippecanoe", action="store_true",
                        help="run sources only, don't tile")
    args = parser.parse_args()

    configure_logging()
    log = logging.getLogger("etl")
    log.info("subterra etl starting")

    only = {s.strip() for s in args.only.split(",")} if args.only else None
    skip = {s.strip() for s in args.skip.split(",")} if args.skip else set()

    sys.path.insert(0, str(ROOT))   # so sources.* imports work
    results = run_sources(only, skip)

    if not args.skip_tippecanoe:
        pmtiles = run_tippecanoe(results)
        manifest = write_manifest(results, pmtiles)
        log.info("wrote %s and %s", pmtiles.name, manifest.name)
    else:
        log.info("skipped tippecanoe step")

    log.info("etl complete")
    return 0


if __name__ == "__main__":
    os.chdir(ROOT)
    sys.exit(main())
