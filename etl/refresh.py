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


def run_sources(only: set[str] | None, skip_set: set[str]) -> list[SourceResult]:
    """Run every enabled source module. A failure in one source is logged
    but doesn't abort the run — tippecanoe builds tiles from whatever
    succeeded so a single broken upstream doesn't blank the production
    map. Failures are summarized at the end."""
    results: list[SourceResult] = []
    failures: list[tuple[str, str]] = []
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
        except Exception as exc:  # noqa: BLE001
            elapsed = time.monotonic() - t0
            log.error("FAILED after %.1fs — %s: %s", elapsed, type(exc).__name__, exc)
            failures.append((name, f"{type(exc).__name__}: {exc}"))
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
        "--minimum-zoom=0",
        "--maximum-zoom=12",
        "--maximum-tile-bytes=400000",       # 400 KB per-tile budget
        "--drop-densest-as-needed",          # drop densest features when over budget
        "--coalesce-densest-as-needed",      # merge dense polygons before dropping
        "--drop-fraction-as-needed",         # random-sample if still over
        "--simplification=10",               # aggressive geometry simplification
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
