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
    "wells",            # Phase 2 — multi-state ECMC/DMR/WOGCC wells (~1M points)
    "well_laterals",    # multi-state wellbore directional surveys (lines)
    "geochemistry",  # Phase 9 — USGS NGDB stream-sediment/soil samples (~1.5M points)
    "geophysics",    # Phase 9 — USGS Earth MRI airborne survey footprints
    "sgmc",          # USGS State Geologic Map Compilation v2 — surface bedrock polygons
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


# Per-source feature-count floor. A source that completes successfully
# but emits dramatically fewer features than this gets demoted from
# `ok` to `empty` in the manifest (with a diagnostic error message),
# which trips the >25%-broken threshold and fails the pipeline rather
# than uploading a half-blank tileset. Numbers are intentionally
# conservative — set to ~50% of the historical floor so normal
# week-to-week variation doesn't flap the alarm, but a 100x drop
# (e.g. truncated upstream stream) immediately surfaces.
#
# Add an entry here when a new source lands, OR adjust an existing
# value if upstream legitimately shrinks. Sources NOT in this dict are
# only checked for the "0 features" boundary case.
EXPECTED_MIN_FEATURES: dict[str, int] = {
    "mrds":              200_000,
    "blm_claims":        300_000,    # historical ~552k; floor at 300k
    "blm_leases":         50_000,
    "plss":            1_500_000,
    "federal_lands":      30_000,
    # 2026-06-16: wells covers CO + ND + WY only (TX excluded; HIFLD
    # mirror dropped). 167k features observed; floor set to 100k to
    # absorb week-to-week variance without flapping.
    "wells":             100_000,
    # 2026-06-16: well_laterals is brand new; 4 state services
    # (ND/CO/WY/NM). 36k features observed on first run; some state
    # endpoints likely still need URL verification. Conservative floor
    # until confidence builds.
    "well_laterals":      10_000,
    "pipelines_natgas":    5_000,
    "pipelines_crude":     2_000,
    "geochemistry":       50_000,
    "geophysics":            500,
    # SGMC western-US bbox-filtered: CONUS-wide polygon count is ~1M;
    # western-only is ~300k. Conservative floor at 50k absorbs partial
    # downloads / per-state ScienceBase enumeration variance.
    "sgmc":               50_000,
    "withdrawals":         1_000,
    "critical_habitat":   10_000,
    "indian_lands":          500,
    "water_rights":       10_000,
    "quaternary_faults":   5_000,
    "parcels":            50_000,
    "hotspots":              500,
}

# Sources known to be upstream-broken as of 2026-06-16. They still show
# as `failed`/`empty` in the manifest and the sidebar banner, but DON'T
# count toward the >25%-broken threshold check that would refuse to
# upload the tileset. The point of the threshold is to catch NEW
# breakage (a sudden cliff in data quality); known-broken state is
# explicit context the operator carries, not a surprise.
#
# Removing entries here as upstreams come back. Empty set is the goal.
ACCEPT_BROKEN: set[str] = {
    # withdrawals: REMOVED — multi-URL fallback added
    #              (CANDIDATE_URLS: HUB MLRS, HUB withdrawals, legacy
    #              lands MapServer). First one that returns features
    #              wins. If all three fail, the source surfaces as
    #              `failed` and the threshold check decides whether to
    #              upload.
    # geochemistry: REMOVED — 2-CSV join (main.csv coords +
    #               bestvalue.csv elements). Re-evaluating each run.
    # pipelines: REMOVED — multi-URL fallback (geo.dot.gov →
    #            maps.nccs.nasa.gov HIFLD mirror). Same shape as
    #            withdrawals; first non-empty wins.
    # parcels: REMOVED — switched to NDOT statewide-parcels endpoint
    #          (covers every NV county in one service). Replaces the
    #          per-county URLs that all 404'd.
    #
    # Empty set is the goal. Keep this dict here so future broken
    # upstreams can be added without re-deriving the threshold pattern.
    #
    # SGMC is new (first run on this branch); ScienceBase enumeration
    # may need URL tuning if the v2 item layout has shifted. Accept
    # broken until we've seen one good production run.
    "sgmc",
}


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


def _print_source_summary() -> None:
    """Print a per-source status table to stdout and (when running in
    GitHub Actions) also append it to $GITHUB_STEP_SUMMARY so the run
    page shows the full picture at the top without anyone log-diving.

    Silent partial failures (source returns 0 features, source crashes
    after writing partial GeoJSON, upstream slug-shuffled, etc.) used
    to be invisible unless you grep'd the 25k-line Actions log. Now
    they land in a 1-screen table and exit-1 if anything looks broken
    enough to matter."""
    if not SOURCE_STATUSES:
        return
    by_status: dict[str, int] = {}
    for s in SOURCE_STATUSES:
        by_status[s.status] = by_status.get(s.status, 0) + 1

    lines = [
        "",
        "================ ETL source summary ================",
        f"  {len(SOURCE_STATUSES)} source(s) total · "
        + " · ".join(f"{n} {st}" for st, n in sorted(by_status.items())),
        "",
        f"  {'source':<22} {'status':<8} {'features':>10}  {'time':>7}  error",
        f"  {'-'*22} {'-'*8} {'-'*10}  {'-'*7}  {'-'*30}",
    ]
    for s in SOURCE_STATUSES:
        err = (s.error or "").splitlines()[0][:60] if s.error else ""
        lines.append(
            f"  {s.name:<22} {s.status:<8} {s.feature_count:>10,}  "
            f"{s.elapsed_s:>5.1f}s  {err}"
        )
    lines.append("=" * 52)
    lines.append("")
    print("\n".join(lines))

    # Append the table to GitHub Actions' job summary so it's visible
    # without expanding the log. Markdown formatting because the
    # summary file is rendered as Markdown.
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        md_lines = [
            "## ETL source summary",
            "",
            f"_{len(SOURCE_STATUSES)} source(s) total · "
            + " · ".join(f"**{n}** {st}" for st, n in sorted(by_status.items()))
            + "_",
            "",
            "| Source | Status | Features | Time | Error |",
            "| --- | --- | ---: | ---: | --- |",
        ]
        for s in SOURCE_STATUSES:
            err = (s.error or "").replace("|", "\\|")[:120] if s.error else ""
            icon = "✅" if s.status == "ok" else ("⚠️" if s.status == "empty" else "❌")
            md_lines.append(
                f"| `{s.name}` | {icon} {s.status} | {s.feature_count:,} | "
                f"{s.elapsed_s:.1f}s | {err} |"
            )
        try:
            with open(summary_path, "a", encoding="utf-8") as fh:
                fh.write("\n".join(md_lines) + "\n")
        except OSError as err:
            print(f"::warning::failed to write step summary: {err}")

    # Hard-fail the workflow if too many sources broke. Two thresholds:
    #   1) any critical source (federal_lands / blm_claims / mrds)
    #      failed OR came back empty — these are the core map data,
    #      shipping without them is worse than serving the prior tileset
    #   2) > 25% of attempted sources are failed OR empty — partial
    #      tilesets that look "successful" but render blank for half
    #      the layers cause the user-visible "tiles aren't loading"
    #      complaint; refuse the upload instead.
    # Triggers `peter-evans/create-issue-from-file` in the pipeline's
    # failure step so the broken state becomes a GitHub issue rather
    # than a silent shrug.
    broken = [s for s in SOURCE_STATUSES if s.status in ("failed", "empty")]
    critical = {"federal_lands", "blm_claims", "mrds"}
    critical_broken = [s.name for s in broken if s.name in critical]
    if critical_broken:
        raise SystemExit(
            f"::error::critical source(s) failed or returned empty: "
            f"{', '.join(critical_broken)} — refusing to upload partial tileset"
        )
    # Subtract known-broken sources before applying the >25% threshold.
    # The threshold is meant to catch NEW breakage (a sudden quality
    # cliff), not punish the build for upstreams we already know are
    # down. Known-broken sources still surface in the manifest and the
    # sidebar banner — they're explicit, not hidden.
    unexpected_broken = [s for s in broken if s.name not in ACCEPT_BROKEN]
    accepted_broken = [s for s in broken if s.name in ACCEPT_BROKEN]
    if accepted_broken:
        names = ", ".join(f"{s.name}({s.status})" for s in accepted_broken)
        print(f"::warning::known-broken sources skipped from threshold: {names}")
    if len(unexpected_broken) > max(1, len(SOURCE_STATUSES) // 4):
        broken_names = ", ".join(f"{s.name}({s.status})" for s in unexpected_broken)
        raise SystemExit(
            f"::error::{len(unexpected_broken)}/{len(SOURCE_STATUSES)} sources "
            f"UNEXPECTEDLY broken — more than 25% threshold, refusing to upload. "
            f"Broken: {broken_names}"
        )


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
            # Health check: a source that returned dramatically fewer
            # features than expected is treated as `empty` (with a
            # diagnostic message) rather than `ok`. Catches silent-fail
            # cases where the endpoint returns a small valid-but-broken
            # subset (e.g. blm_claims went 552k → 552 features when the
            # upstream Hub download truncated mid-stream).
            expected = EXPECTED_MIN_FEATURES.get(name)
            status: str
            error_msg: str | None
            if result.feature_count == 0:
                status, error_msg = "empty", None
            elif expected is not None and result.feature_count < expected:
                status = "empty"
                error_msg = (
                    f"below expected minimum: got {result.feature_count:,}, "
                    f"expected ≥{expected:,} — likely an upstream truncation "
                    f"or schema change"
                )
                log.warning("FEATURE-COUNT FLOOR — %s", error_msg)
            else:
                status, error_msg = "ok", None
            SOURCE_STATUSES.append(SourceStatus(
                name=name,
                status=status,
                feature_count=result.feature_count,
                elapsed_s=round(elapsed, 1),
                error=error_msg,
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

    # Per-source status table — printed unconditionally + appended to
    # the GitHub Actions step summary when running in CI. Makes silent
    # partial failures (the kind that used to look like "ETL succeeded"
    # while half the layers came back empty) impossible to miss.
    _print_source_summary()

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
