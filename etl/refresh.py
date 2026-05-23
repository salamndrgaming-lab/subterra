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
    "blm_claims",    # Phase 2 — BLM MLRS active mining claims (~350k polygons)
    "federal_lands", # Phase 2 — BLM National SMA (~1M polygons, 4 agencies)
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
    results: list[SourceResult] = []
    for name in SOURCES:
        if only is not None and name not in only:
            continue
        if name in skip_set:
            continue
        log = logging.getLogger(f"etl.{name}")
        log.info("starting source")
        t0 = time.monotonic()
        module = importlib.import_module(f"sources.{name}")
        result: SourceResult = module.run(WORK)
        elapsed = time.monotonic() - t0
        log.info(
            "done in %.1fs (%d features → %s)",
            elapsed, result.feature_count, result.geojson_path.name,
        )
        results.append(result)
    return results


def run_tippecanoe(results: list[SourceResult]) -> Path:
    """Merge per-source GeoJSON into a single subterra.pmtiles file."""
    if not results:
        raise RuntimeError("No source results to tile — nothing to do.")
    out = OUT / "subterra.pmtiles"
    if out.exists():
        out.unlink()
    args: list[str] = [
        "tippecanoe",
        "-o", str(out),
        "--force",
        "--no-feature-limit",
        "--no-tile-size-limit",
        "--minimum-zoom=0",
        "--maximum-zoom=12",
        "--drop-densest-as-needed",
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
