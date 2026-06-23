"""
ETL diff producer — emits the "what changed since the last run" payload
the Worker's `/diff` route serves and the web app's sidebar pill reads.

Runs after etl/upload.py in the pipeline. Compares the current run's
BLM mining-claims serial set against the prior run's snapshot stored
in R2 and writes:

  - diffs/snapshot/blm_claims/<version>.json — this run's serial map.
  - diffs/snapshot/blm_claims/_latest.json   — pointer {version, key}.
  - diffs/latest.json                        — the diff payload itself.

A diff failure must never fail the ETL — every error path logs a
"::warning::" line and exits 0 so the rest of the pipeline (Worker
deploy, web build) keeps moving. The prior manifest stays live, the
prior diff stays live, the world keeps spinning.

Snapshot shape (compact JSON, ~16 MB raw / ~4 MB gzipped at 550k claims):
    {
      "version": 1716800000,
      "serials": {
        "NMC123456": [-116.12, 39.51, "NV"],
        ...
      }
    }

GC: keep the last 4 snapshots (~4 ETL runs ≈ 4 weeks of history), prune
the rest. The diff payload itself is single-key (`diffs/latest.json`)
and overwritten each run, so no GC needed there.
"""

from __future__ import annotations

import json
import os
import sys
import time
from collections import defaultdict
from pathlib import Path
from typing import Any

# boto3 is imported lazily inside main() via etl.upload so the pure-
# Python helpers (build_snapshot, _build_diff_payload, etc.) can be
# unit-tested in environments without the ETL deps installed.

ROOT = Path(__file__).resolve().parent
WORK = ROOT / "work"
OUT = ROOT / "out"

SOURCE_GEOJSON = WORK / "blm_claims.geojson"
MANIFEST_PATH = OUT / "manifest.json"

SNAPSHOT_PREFIX = "diffs/snapshot/blm_claims/"
SNAPSHOT_POINTER_KEY = f"{SNAPSHOT_PREFIX}_latest.json"
DIFF_KEY = "diffs/latest.json"

# How many historical snapshots to retain. 4 covers a month of weekly
# ETL runs, which is more than the web app's "since last visited"
# window needs.
GC_KEEP = 4


def _warn(msg: str) -> None:
    """Print a GitHub-Actions-flavored warning line. Diff failures don't
    fail the pipeline, but they should still surface in the run log."""
    print(f"::warning::diff: {msg}", file=sys.stderr)


def _polygon_centroid(coords: list) -> tuple[float, float] | None:
    """Cheap-and-cheerful centroid: arithmetic mean of the outer ring's
    vertices. Good enough for the diff payload (the web app only uses
    centroids for AOI-bbox filtering, not for actual rendering)."""
    if not coords:
        return None
    ring = coords[0] if coords and isinstance(coords[0][0], list) else coords
    if not ring:
        return None
    xs, ys = 0.0, 0.0
    n = 0
    for pt in ring:
        if isinstance(pt, list) and len(pt) >= 2:
            xs += pt[0]
            ys += pt[1]
            n += 1
    if n == 0:
        return None
    return (xs / n, ys / n)


def _geometry_centroid(geom: dict | None) -> tuple[float, float] | None:
    """Centroid for the geometry kinds BLM claims actually use (Polygon
    + MultiPolygon). Other shapes fall through to None — diff just
    excludes them, which is fine for a signaling pill."""
    if not geom:
        return None
    gtype = geom.get("type")
    coords = geom.get("coordinates")
    if not coords:
        return None
    if gtype == "Polygon":
        return _polygon_centroid(coords)
    if gtype == "MultiPolygon":
        # Average across the first ring of each polygon part.
        pts: list[tuple[float, float]] = []
        for poly in coords:
            c = _polygon_centroid(poly)
            if c is not None:
                pts.append(c)
        if not pts:
            return None
        return (
            sum(p[0] for p in pts) / len(pts),
            sum(p[1] for p in pts) / len(pts),
        )
    return None


def build_snapshot(geojson_path: Path) -> dict[str, list[Any]]:
    """Read the current run's blm_claims.geojson and return the snapshot's
    `serials` map: {serial: [lng, lat, state]}. Skips features that
    can't yield a usable serial + centroid."""
    if not geojson_path.exists():
        _warn(f"missing source geojson at {geojson_path} — nothing to snapshot")
        return {}

    with geojson_path.open("r", encoding="utf-8") as f:
        data = json.load(f)

    features = data.get("features") or []
    serials: dict[str, list[Any]] = {}
    skipped = 0
    for feat in features:
        props = feat.get("properties") or {}
        serial = props.get("serial")
        if not serial or not isinstance(serial, str):
            skipped += 1
            continue
        centroid = _geometry_centroid(feat.get("geometry"))
        if centroid is None:
            skipped += 1
            continue
        state = props.get("state") or ""
        if isinstance(state, str):
            state = state.strip().upper()[:2]
        else:
            state = ""
        serials[serial] = [
            round(centroid[0], 5),
            round(centroid[1], 5),
            state,
        ]
    print(
        f"diff: built snapshot — {len(serials):,} serials "
        f"({skipped:,} features skipped for missing serial / centroid)"
    )
    return serials


def _read_current_version() -> int | None:
    """Pull `version` from out/manifest.json — the value `refresh.py`
    just stamped into the manifest. Falls back to int(time.time()) if
    the manifest can't be read, to keep the diff producer working
    in dev runs where the manifest path is somewhere else."""
    if not MANIFEST_PATH.exists():
        _warn(f"missing manifest at {MANIFEST_PATH} — using wall-clock version")
        return int(time.time())
    try:
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        v = manifest.get("version")
        if isinstance(v, int):
            return v
        _warn(f"manifest version not an int: {v!r}")
    except Exception as exc:  # noqa: BLE001
        _warn(f"failed to read manifest: {exc}")
    return int(time.time())


def _load_prior_snapshot(client, bucket: str) -> tuple[int, dict[str, list[Any]]] | None:
    """Fetch the prior snapshot via the pointer file. Returns
    (version, serials) or None if no prior snapshot exists (first run
    after this feature lands)."""
    try:
        pointer = client.get_object(Bucket=bucket, Key=SNAPSHOT_POINTER_KEY)
    except client.exceptions.NoSuchKey:
        print("diff: no prior snapshot pointer — first run, will only seed")
        return None
    except Exception as exc:  # noqa: BLE001
        _warn(f"failed to read pointer {SNAPSHOT_POINTER_KEY}: {exc}")
        return None
    try:
        body = json.loads(pointer["Body"].read().decode("utf-8"))
        prior_version = int(body.get("version", 0))
        prior_key = body.get("key", "")
        if not prior_key:
            _warn("pointer file missing 'key' field")
            return None
        prior_obj = client.get_object(Bucket=bucket, Key=prior_key)
        prior_snap = json.loads(prior_obj["Body"].read().decode("utf-8"))
        prior_serials = prior_snap.get("serials") or {}
        print(
            f"diff: prior snapshot v{prior_version} loaded — "
            f"{len(prior_serials):,} serials"
        )
        return prior_version, prior_serials
    except Exception as exc:  # noqa: BLE001
        _warn(f"failed to load prior snapshot: {exc}")
        return None


def _upload_json(client, bucket: str, key: str, payload: dict) -> None:
    """Inline JSON upload — for blobs small enough to round-trip via
    bytes rather than the multipart upload_file() path."""
    body = json.dumps(payload).encode("utf-8")
    client.put_object(
        Bucket=bucket,
        Key=key,
        Body=body,
        ContentType="application/json",
    )
    size_kb = len(body) / 1024
    print(f"diff: uploaded {key} ({size_kb:,.1f} KB)")


def _gc_old_snapshots(client, bucket: str) -> None:
    """List snapshot objects under the prefix, sort by parsed version
    in the filename, delete every one beyond the most recent GC_KEEP.
    Silently leaves the pointer file alone (it's under the prefix but
    doesn't parse as an int)."""
    try:
        resp = client.list_objects_v2(Bucket=bucket, Prefix=SNAPSHOT_PREFIX)
    except Exception as exc:  # noqa: BLE001
        _warn(f"gc: list_objects_v2 failed: {exc}")
        return
    objs = resp.get("Contents") or []
    versioned: list[tuple[int, str]] = []
    for o in objs:
        key = o["Key"]
        if key == SNAPSHOT_POINTER_KEY:
            continue
        stem = key.rsplit("/", 1)[-1].removesuffix(".json")
        try:
            versioned.append((int(stem), key))
        except ValueError:
            continue
    versioned.sort(reverse=True)
    to_delete = versioned[GC_KEEP:]
    if not to_delete:
        return
    print(f"diff: gc — deleting {len(to_delete)} snapshot(s) older than the most recent {GC_KEEP}")
    for _, key in to_delete:
        try:
            client.delete_object(Bucket=bucket, Key=key)
        except Exception as exc:  # noqa: BLE001
            _warn(f"gc: failed to delete {key}: {exc}")


def _build_diff_payload(
    prior: tuple[int, dict[str, list[Any]]] | None,
    current_version: int,
    current_serials: dict[str, list[Any]],
) -> dict:
    """Set-difference current vs prior serials, project both sides into
    DiffClaim shape, roll per-state counts."""
    if prior is None:
        return {
            "fromVersion": current_version,
            "toVersion": current_version,
            "added": [],
            "dropped": [],
            "byState": {"added": {}, "dropped": {}},
        }
    prior_version, prior_serials = prior
    prior_keys = set(prior_serials.keys())
    current_keys = set(current_serials.keys())
    added_keys = current_keys - prior_keys
    dropped_keys = prior_keys - current_keys

    added = [
        {
            "serial": s,
            "lng": current_serials[s][0],
            "lat": current_serials[s][1],
            "state": current_serials[s][2],
        }
        for s in added_keys
    ]
    dropped = [
        {
            "serial": s,
            "lng": prior_serials[s][0],
            "lat": prior_serials[s][1],
            "state": prior_serials[s][2],
        }
        for s in dropped_keys
    ]

    by_state_added: dict[str, int] = defaultdict(int)
    by_state_dropped: dict[str, int] = defaultdict(int)
    for c in added:
        by_state_added[c["state"] or "??"] += 1
    for c in dropped:
        by_state_dropped[c["state"] or "??"] += 1

    return {
        "fromVersion": prior_version,
        "toVersion": current_version,
        "added": added,
        "dropped": dropped,
        "byState": {
            "added": dict(by_state_added),
            "dropped": dict(by_state_dropped),
        },
    }


def main() -> int:
    print("diff: producer starting")
    current_version = _read_current_version()
    if current_version is None:
        _warn("no current version — bailing without writing")
        return 0

    serials = build_snapshot(SOURCE_GEOJSON)
    if not serials:
        # Empty snapshot means BLM claims source ran empty or absent.
        # Skip the whole diff cycle — don't write a vacant snapshot
        # that would falsely "drop" every claim on the next run.
        _warn("no serials in current snapshot — skipping diff this run")
        return 0

    try:
        from etl.upload import BUCKET, make_client
    except ImportError as exc:
        _warn(f"etl.upload import failed (boto3 missing?): {exc}")
        return 0

    try:
        client = make_client()
    except SystemExit:
        # make_client() calls sys.exit(2) on missing creds — convert to
        # a warning so the rest of the pipeline isn't gated on diff.
        _warn("R2 credentials missing — skipping diff this run")
        return 0

    prior = _load_prior_snapshot(client, BUCKET)

    snapshot_key = f"{SNAPSHOT_PREFIX}{current_version}.json"
    _upload_json(
        client,
        BUCKET,
        snapshot_key,
        {"version": current_version, "serials": serials},
    )
    _upload_json(
        client,
        BUCKET,
        SNAPSHOT_POINTER_KEY,
        {"version": current_version, "key": snapshot_key},
    )

    diff = _build_diff_payload(prior, current_version, serials)
    _upload_json(client, BUCKET, DIFF_KEY, diff)
    print(
        "diff: payload — "
        f"+{len(diff['added']):,} added · "
        f"-{len(diff['dropped']):,} dropped · "
        f"from v{diff['fromVersion']} → v{diff['toVersion']}"
    )

    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        with open(summary_path, "a", encoding="utf-8") as fh:
            fh.write("\n### Diff producer\n\n")
            fh.write(f"- from v{diff['fromVersion']} → v{diff['toVersion']}\n")
            fh.write(f"- added: **{len(diff['added']):,}**\n")
            fh.write(f"- dropped: **{len(diff['dropped']):,}**\n")
            if diff.get("byState", {}).get("added"):
                top = sorted(
                    diff["byState"]["added"].items(),
                    key=lambda kv: kv[1],
                    reverse=True,
                )[:5]
                fh.write(f"- top states (added): {', '.join(f'{s} {n}' for s, n in top)}\n")

    _gc_old_snapshots(client, BUCKET)
    print("diff: complete")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001 — last-resort safety net
        _warn(f"unhandled exception: {type(exc).__name__}: {exc}")
        sys.exit(0)
