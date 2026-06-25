"""
ETL diff producer — emits "what changed since the last run" payloads
the Worker's `/diff` + `/diff/permits` routes serve and the web app's
sidebar pills read.

Runs after etl/upload.py in the pipeline. For each registered source
(BLM mining-claims, drilling permits, future wells / leases), compares
the current run's entity-id set against the prior run's snapshot
stored in R2 and writes:

  - diffs/snapshot/<source>/<version>.json  — this run's entity map.
  - diffs/snapshot/<source>/_latest.json    — pointer {version, key}.
  - <source.diff_key>                       — the diff payload itself.

Each source is independent — a permits-source crash never blocks the
claims diff from updating, and vice versa. A diff failure must never
fail the ETL: every error path logs a "::warning::" line and exits 0
so the rest of the pipeline (Worker deploy, web build) keeps moving.

Snapshot shape (compact JSON):
    {
      "version": 1716800000,
      "entities": {
        "NMC123456": {"lng": -116.12, "lat": 39.51, "state": "NV"},
        ...
      }
    }

Pre-PR-2b snapshots used `serials` as the outer key and stored the
value as a positional `[lng, lat, state]` list. _load_prior_snapshot
reads both shapes — refactored producer keeps loading them without
needing a one-time data migration.

GC: keep the last 4 snapshots per source (~4 ETL runs ≈ 4 weeks of
history), prune the rest. The diff payload itself is single-key per
source and overwritten each run, so no GC needed there.
"""

from __future__ import annotations

import json
import os
import sys
import time
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# boto3 is imported lazily inside main() via etl.upload so the pure-
# Python helpers (build_snapshot, _build_diff_payload, etc.) can be
# unit-tested in environments without the ETL deps installed.

ROOT = Path(__file__).resolve().parent
WORK = ROOT / "work"
OUT = ROOT / "out"

MANIFEST_PATH = OUT / "manifest.json"

# How many historical snapshots to retain per source. 4 covers a month
# of weekly ETL runs, which is more than the web app's "since last
# visited" window needs.
GC_KEEP = 4


@dataclass(frozen=True)
class DiffSource:
    """Per-source knobs that drive the otherwise-uniform diff pipeline.

    Adding a new diffable source (e.g. wells, leases) is a one-entry
    addition to SOURCES below — no producer code changes."""
    name: str                       # "claims" | "permits"
    geojson_path: Path              # source feature stream from this run
    id_field: str                   # GeoJSON property used as the entity key
    extra_attrs: tuple[str, ...]    # attrs to carry alongside lng/lat/state
    snapshot_prefix: str            # R2 key prefix for per-version snapshots
    diff_key: str                   # R2 key for the published diff payload
    entity_label: str               # singular noun for log lines


SOURCES: list[DiffSource] = [
    DiffSource(
        name="claims",
        geojson_path=WORK / "blm_claims.geojson",
        id_field="serial",
        extra_attrs=(),
        snapshot_prefix="diffs/snapshot/blm_claims/",
        diff_key="diffs/latest.json",
        entity_label="claim",
    ),
    DiffSource(
        name="permits",
        geojson_path=WORK / "drilling_permits.geojson",
        id_field="permit_no",
        extra_attrs=("operator", "well_name", "formation", "filed_at"),
        snapshot_prefix="diffs/snapshot/drilling_permits/",
        diff_key="diffs/permits.json",
        entity_label="permit",
    ),
]


# Mapping from GeoJSON property names (snake_case) to the camelCase
# wire keys used in the diff payload. Keeps the payload JSON-idiomatic
# (matches existing DiffClaim.serial / .toVersion casing) without
# forcing the ETL source modules to emit camelCase properties.
_WIRE_KEY: dict[str, str] = {
    "serial": "serial",
    "permit_no": "permitNo",
    "operator": "operator",
    "well_name": "wellName",
    "formation": "formation",
    "filed_at": "filedAt",
}


def _warn(msg: str) -> None:
    """Print a GitHub-Actions-flavored warning line. Diff failures don't
    fail the pipeline, but they should still surface in the run log."""
    print(f"::warning::diff: {msg}", file=sys.stderr)


def _pointer_key(src: DiffSource) -> str:
    return f"{src.snapshot_prefix}_latest.json"


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
    """Centroid that handles the kinds our sources actually emit:
    Polygon + MultiPolygon (claims, leases) and Point (permits, wells)."""
    if not geom:
        return None
    gtype = geom.get("type")
    coords = geom.get("coordinates")
    if coords is None:
        return None
    if gtype == "Point":
        if isinstance(coords, list) and len(coords) >= 2:
            return (float(coords[0]), float(coords[1]))
        return None
    if gtype == "Polygon":
        return _polygon_centroid(coords)
    if gtype == "MultiPolygon":
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


def build_snapshot(src: DiffSource) -> dict[str, dict[str, Any]]:
    """Read the current run's GeoJSON for `src` and return the snapshot's
    entity map: {<id>: {lng, lat, state, ...extra_attrs}}. Skips
    features that can't yield a usable id + centroid."""
    if not src.geojson_path.exists():
        _warn(f"{src.name}: missing source geojson at {src.geojson_path} — nothing to snapshot")
        return {}

    with src.geojson_path.open("r", encoding="utf-8") as f:
        data = json.load(f)

    features = data.get("features") or []
    entities: dict[str, dict[str, Any]] = {}
    skipped = 0
    for feat in features:
        props = feat.get("properties") or {}
        raw_id = props.get(src.id_field)
        if raw_id is None:
            skipped += 1
            continue
        entity_id = str(raw_id).strip()
        if not entity_id:
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
        entity: dict[str, Any] = {
            "lng": round(centroid[0], 5),
            "lat": round(centroid[1], 5),
            "state": state,
        }
        for attr in src.extra_attrs:
            v = props.get(attr)
            if v in (None, "", " "):
                continue
            # Coerce non-string attrs (numbers, ints from ArcGIS) to
            # strings — the diff payload is for display, not analysis.
            entity[attr] = v if isinstance(v, str) else str(v)
        entities[entity_id] = entity
    print(
        f"diff[{src.name}]: built snapshot — {len(entities):,} {src.entity_label}s "
        f"({skipped:,} features skipped for missing id / centroid)"
    )
    return entities


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


def _coerce_entity_value(v: Any) -> dict[str, Any] | None:
    """Adapt a stored snapshot value to the current dict shape.

    Pre-PR-2b claims snapshots stored values as positional lists
    `[lng, lat, state]`. Refactored producer writes dicts. Reading the
    pre-refactor snapshot needs to fall back to the list shape so the
    first post-deploy run still produces a meaningful diff."""
    if isinstance(v, dict):
        return v
    if isinstance(v, list) and len(v) >= 2:
        return {
            "lng": v[0],
            "lat": v[1],
            "state": v[2] if len(v) > 2 and isinstance(v[2], str) else "",
        }
    return None


def _load_prior_snapshot(
    src: DiffSource, client, bucket: str,
) -> tuple[int, dict[str, dict[str, Any]]] | None:
    """Fetch the prior snapshot via the pointer file. Returns
    (version, entities) or None if no prior snapshot exists (first run
    after this feature lands)."""
    pointer_key = _pointer_key(src)
    try:
        pointer = client.get_object(Bucket=bucket, Key=pointer_key)
    except client.exceptions.NoSuchKey:
        print(f"diff[{src.name}]: no prior snapshot pointer — first run, will only seed")
        return None
    except Exception as exc:  # noqa: BLE001
        _warn(f"{src.name}: failed to read pointer {pointer_key}: {exc}")
        return None
    try:
        body = json.loads(pointer["Body"].read().decode("utf-8"))
        prior_version = int(body.get("version", 0))
        prior_key = body.get("key", "")
        if not prior_key:
            _warn(f"{src.name}: pointer file missing 'key' field")
            return None
        prior_obj = client.get_object(Bucket=bucket, Key=prior_key)
        prior_snap = json.loads(prior_obj["Body"].read().decode("utf-8"))
        # Dual-read: "entities" (new) wins; "serials" (legacy claims
        # only) is the fallback so a pre-refactor snapshot still loads.
        raw = prior_snap.get("entities") or prior_snap.get("serials") or {}
        prior_entities: dict[str, dict[str, Any]] = {}
        for k, v in raw.items():
            adapted = _coerce_entity_value(v)
            if adapted is not None:
                prior_entities[k] = adapted
        print(
            f"diff[{src.name}]: prior snapshot v{prior_version} loaded — "
            f"{len(prior_entities):,} {src.entity_label}s"
        )
        return prior_version, prior_entities
    except Exception as exc:  # noqa: BLE001
        _warn(f"{src.name}: failed to load prior snapshot: {exc}")
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


def _gc_old_snapshots(src: DiffSource, client, bucket: str) -> None:
    """List snapshot objects under the source's prefix, sort by parsed
    version in the filename, delete every one beyond the most recent
    GC_KEEP. Silently leaves the pointer file alone (it's under the
    prefix but doesn't parse as an int)."""
    pointer_key = _pointer_key(src)
    try:
        resp = client.list_objects_v2(Bucket=bucket, Prefix=src.snapshot_prefix)
    except Exception as exc:  # noqa: BLE001
        _warn(f"{src.name}: gc list_objects_v2 failed: {exc}")
        return
    objs = resp.get("Contents") or []
    versioned: list[tuple[int, str]] = []
    for o in objs:
        key = o["Key"]
        if key == pointer_key:
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
    print(
        f"diff[{src.name}]: gc — deleting {len(to_delete)} snapshot(s) "
        f"older than the most recent {GC_KEEP}"
    )
    for _, key in to_delete:
        try:
            client.delete_object(Bucket=bucket, Key=key)
        except Exception as exc:  # noqa: BLE001
            _warn(f"{src.name}: gc failed to delete {key}: {exc}")


def _build_diff_payload(
    src: DiffSource,
    prior: tuple[int, dict[str, dict[str, Any]]] | None,
    current_version: int,
    current_entities: dict[str, dict[str, Any]],
) -> dict:
    """Set-difference current vs prior entities, project both sides into
    the wire-format DiffPermit / DiffClaim shape, roll per-state counts."""
    wire_id = _WIRE_KEY.get(src.id_field, src.id_field)

    def project(entity_id: str, attrs: dict[str, Any]) -> dict[str, Any]:
        out: dict[str, Any] = {
            wire_id: entity_id,
            "lng": attrs.get("lng"),
            "lat": attrs.get("lat"),
            "state": attrs.get("state") or "",
        }
        for k in src.extra_attrs:
            v = attrs.get(k)
            if v not in (None, "", " "):
                out[_WIRE_KEY.get(k, k)] = v
        return out

    if prior is None:
        return {
            "fromVersion": current_version,
            "toVersion": current_version,
            "added": [],
            "dropped": [],
            "byState": {"added": {}, "dropped": {}},
        }
    prior_version, prior_entities = prior
    prior_keys = set(prior_entities.keys())
    current_keys = set(current_entities.keys())
    added_keys = current_keys - prior_keys
    dropped_keys = prior_keys - current_keys

    added = [project(k, current_entities[k]) for k in added_keys]
    dropped = [project(k, prior_entities[k]) for k in dropped_keys]

    by_state_added: dict[str, int] = defaultdict(int)
    by_state_dropped: dict[str, int] = defaultdict(int)
    for e in added:
        by_state_added[str(e.get("state") or "??")] += 1
    for e in dropped:
        by_state_dropped[str(e.get("state") or "??")] += 1

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


def _produce_for(
    src: DiffSource, current_version: int, client, bucket: str,
) -> dict | None:
    """Run the full snapshot + diff + upload + GC cycle for one source.
    Returns the diff payload (for log + summary) or None when the cycle
    was skipped (empty source, etc.)."""
    entities = build_snapshot(src)
    if not entities:
        _warn(f"{src.name}: empty snapshot — skipping diff this run")
        return None

    prior = _load_prior_snapshot(src, client, bucket)
    snapshot_key = f"{src.snapshot_prefix}{current_version}.json"
    _upload_json(
        client, bucket, snapshot_key,
        {"version": current_version, "entities": entities},
    )
    _upload_json(
        client, bucket, _pointer_key(src),
        {"version": current_version, "key": snapshot_key},
    )

    diff = _build_diff_payload(src, prior, current_version, entities)
    _upload_json(client, bucket, src.diff_key, diff)
    print(
        f"diff[{src.name}]: payload — "
        f"+{len(diff['added']):,} added · "
        f"-{len(diff['dropped']):,} dropped · "
        f"from v{diff['fromVersion']} → v{diff['toVersion']}"
    )

    _gc_old_snapshots(src, client, bucket)
    return diff


def _append_summary(name: str, label_plural: str, diff: dict) -> None:
    """Per-source GitHub Actions step-summary section."""
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not summary_path:
        return
    with open(summary_path, "a", encoding="utf-8") as fh:
        fh.write(f"\n### Diff producer — {name}\n\n")
        fh.write(f"- from v{diff['fromVersion']} → v{diff['toVersion']}\n")
        fh.write(f"- added: **{len(diff['added']):,}** {label_plural}\n")
        fh.write(f"- dropped: **{len(diff['dropped']):,}** {label_plural}\n")
        by_added = (diff.get("byState") or {}).get("added") or {}
        if by_added:
            top = sorted(by_added.items(), key=lambda kv: kv[1], reverse=True)[:5]
            fh.write(f"- top states (added): {', '.join(f'{s} {n}' for s, n in top)}\n")


def main() -> int:
    print("diff: producer starting")
    current_version = _read_current_version()
    if current_version is None:
        _warn("no current version — bailing without writing")
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

    for src in SOURCES:
        try:
            diff = _produce_for(src, current_version, client, BUCKET)
            if diff is not None:
                _append_summary(src.name, f"{src.entity_label}s", diff)
        except Exception as exc:  # noqa: BLE001 — per-source isolation
            _warn(f"{src.name}: producer crashed: {type(exc).__name__}: {exc}")
            continue

    print("diff: complete")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001 — last-resort safety net
        _warn(f"unhandled exception: {type(exc).__name__}: {exc}")
        sys.exit(0)
