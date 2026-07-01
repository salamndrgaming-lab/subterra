"""
features.db builder — queryable SQLite from the point-feature sources.

The vector tiles (PMTiles) are great for rendering but bad for querying:
MapLibre can only read features in the current viewport's tiles, tiles
drop properties to stay small, and you can't ask "every well operated
by EOG" or "all occurrences within 5 mi of here." The architecture
(docs/architecture.md) always called for a companion SQLite —
`features.db` — served from R2 and queried in-browser via sql.js over
HTTP range requests. This module builds it.

Scope (v1): the POINT sources, where per-feature detail + attribute
queries matter most — wells, mineral occurrences (MRDS/USMIN/CMMI),
drill holes, drilling permits, geochemistry, water rights, and the
midstream facilities. Polygon sources (claims, federal lands, etc.)
stay tile-only for now; a point-in-polygon path over their geometry is
a follow-up.

Output schema:
    features(id, layer, name, operator, lng, lat, props)   -- props = JSON
    features_rtree(id, minx, maxx, miny, maxy)              -- spatial index
    meta(key, value)                                        -- build info

The R-tree makes viewport + radius queries O(log n) from sql.js:
    SELECT f.* FROM features f
    JOIN features_rtree r ON f.id = r.id
    WHERE r.minx >= ? AND r.maxx <= ? AND r.miny >= ? AND r.maxy <= ?
      AND f.layer = 'wells';
Indexes on layer + operator power the sidebar filters and the
operator-intel panel.

Pure-stdlib (sqlite3 + json) so it unit-tests on a fixture without the
ETL's geo deps. Never fatal to the pipeline: refresh.py calls it in a
try/except — a features.db failure logs a warning and the tileset still
ships.
"""

from __future__ import annotations

import csv
import json
import sqlite3
import sys
import time
from pathlib import Path
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parent
WORK = ROOT / "work"
OUT = ROOT / "out"
DB_PATH = OUT / "subterra-features.db"
PRODUCTION_CSV = WORK / "production.csv"

# Point-geometry sources worth indexing for detail + attribute queries.
# Matches the geojson filenames (== layer_id). Polygon/line sources are
# intentionally excluded from v1.
POINT_LAYERS: tuple[str, ...] = (
    "wells",
    "mrds",
    "usmin",
    "cmmi",
    "drill_holes",
    "drilling_permits",
    "geochemistry",
    "water_rights",
    "compressor_stations",
    "processing_plants",
    "refineries",
)

# Best-effort display-field extraction. Sources normalize to slightly
# different key names; coalesce over the common ones. The full property
# bag is stored as JSON regardless, so nothing is lost.
_NAME_KEYS = ("name", "well_name", "site_name", "unit", "NAME", "Name")
_OPERATOR_KEYS = ("operator", "claimant", "owner", "company", "OPERATOR", "Operator")


def _first(props: dict, keys: Iterable[str]) -> str | None:
    for k in keys:
        v = props.get(k)
        if v not in (None, "", " "):
            return str(v)
    return None


def _point_coords(geom: dict | None) -> tuple[float, float] | None:
    """Return (lng, lat) for a GeoJSON Point, else None. Multi/other
    geometries are skipped in v1 (this builder indexes point sources)."""
    if not geom or geom.get("type") != "Point":
        return None
    coords = geom.get("coordinates") or []
    if len(coords) < 2:
        return None
    lng, lat = coords[0], coords[1]
    if not isinstance(lng, (int, float)) or not isinstance(lat, (int, float)):
        return None
    # Basic sanity: drop obviously bad coordinates (0,0 nulls, out of range).
    if not (-180.0 <= lng <= 180.0) or not (-90.0 <= lat <= 90.0):
        return None
    if lng == 0 and lat == 0:
        return None
    return (float(lng), float(lat))


def _init_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        PRAGMA journal_mode = OFF;
        PRAGMA synchronous = OFF;
        DROP TABLE IF EXISTS features;
        DROP TABLE IF EXISTS features_rtree;
        DROP TABLE IF EXISTS meta;
        CREATE TABLE features (
            id       INTEGER PRIMARY KEY,
            layer    TEXT NOT NULL,
            name     TEXT,
            operator TEXT,
            lng      REAL NOT NULL,
            lat      REAL NOT NULL,
            props    TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE features_rtree USING rtree(id, minx, maxx, miny, maxy);
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
        DROP TABLE IF EXISTS production;
        CREATE TABLE production (
            well_api  TEXT NOT NULL,
            period    TEXT NOT NULL,   -- YYYY-MM
            oil_bbl   REAL,
            gas_mcf   REAL,
            water_bbl REAL,
            days      INTEGER
        );
        """
    )


def _num(v: Any) -> float | None:
    """Coerce a CSV cell to float, or None for blanks/garbage."""
    if v in (None, "", " "):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def load_production(csv_path: Path, conn: sqlite3.Connection) -> int:
    """Load per-well monthly production from a CSV into the production
    table. Expected columns (header row, case-insensitive): well_api,
    period, oil_bbl, gas_mcf, water_bbl, days. Missing file → 0 rows
    (the table stays empty and the well drawer simply shows no
    sparkline). Returns row count. Creates the by-API index after load
    so the well-detail lookup is fast."""
    if not csv_path.exists():
        return 0
    n = 0
    cur = conn.cursor()
    batch: list[tuple] = []
    with csv_path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        # normalize header casing
        field_map = {name.lower().strip(): name for name in (reader.fieldnames or [])}

        def col(row: dict, key: str) -> Any:
            src = field_map.get(key)
            return row.get(src) if src else None

        for row in reader:
            api = col(row, "well_api")
            period = col(row, "period")
            if not api or not period:
                continue
            batch.append(
                (
                    str(api).strip(),
                    str(period).strip(),
                    _num(col(row, "oil_bbl")),
                    _num(col(row, "gas_mcf")),
                    _num(col(row, "water_bbl")),
                    int(_num(col(row, "days")) or 0) or None,
                )
            )
            n += 1
            if len(batch) >= 10_000:
                cur.executemany("INSERT INTO production VALUES (?,?,?,?,?,?)", batch)
                batch.clear()
    if batch:
        cur.executemany("INSERT INTO production VALUES (?,?,?,?,?,?)", batch)
    cur.execute("CREATE INDEX idx_production_api ON production(well_api)")
    conn.commit()
    return n


def _load_geojson_points(path: Path) -> Iterable[tuple[str | None, str | None, float, float, str]]:
    """Yield (name, operator, lng, lat, props_json) for each valid Point
    feature in a GeoJSON FeatureCollection. Skips non-point / bad-coord
    features silently (they're counted by the caller)."""
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    for feat in data.get("features") or []:
        coords = _point_coords(feat.get("geometry"))
        if coords is None:
            continue
        props = feat.get("properties") or {}
        lng, lat = coords
        yield (
            _first(props, _NAME_KEYS),
            _first(props, _OPERATOR_KEYS),
            lng,
            lat,
            json.dumps(props, separators=(",", ":")),
        )


def build_db(
    sources: list[tuple[str, Path]],
    conn: sqlite3.Connection,
    production_csv: Path | None = None,
) -> dict[str, int]:
    """Populate `conn` from (layer, geojson_path) pairs, plus optional
    per-well production from `production_csv`. Returns a {layer: row_count}
    dict (with a synthetic 'production' key for the time-series rows).
    Missing files are skipped (logged as 0)."""
    _init_schema(conn)
    counts: dict[str, int] = {}
    next_id = 1
    cur = conn.cursor()
    for layer, path in sources:
        if not path.exists():
            counts[layer] = 0
            continue
        n = 0
        feat_rows = []
        rtree_rows = []
        for name, operator, lng, lat, props_json in _load_geojson_points(path):
            fid = next_id
            next_id += 1
            feat_rows.append((fid, layer, name, operator, lng, lat, props_json))
            rtree_rows.append((fid, lng, lng, lat, lat))
            n += 1
            # Flush in batches to keep memory flat on large sources (wells
            # is ~1M rows).
            if len(feat_rows) >= 10_000:
                cur.executemany("INSERT INTO features VALUES (?,?,?,?,?,?,?)", feat_rows)
                cur.executemany("INSERT INTO features_rtree VALUES (?,?,?,?,?)", rtree_rows)
                feat_rows.clear()
                rtree_rows.clear()
        if feat_rows:
            cur.executemany("INSERT INTO features VALUES (?,?,?,?,?,?,?)", feat_rows)
            cur.executemany("INSERT INTO features_rtree VALUES (?,?,?,?,?)", rtree_rows)
        counts[layer] = n

    cur.executescript(
        "CREATE INDEX idx_features_layer ON features(layer);"
        "CREATE INDEX idx_features_operator ON features(operator);"
    )

    # Per-well production time-series (optional). Keyed by well API so the
    # well-detail drawer can render a sparkline + cumulative. Independent
    # of the point index above.
    prod_rows = load_production(production_csv, conn) if production_csv else 0
    if prod_rows:
        counts["production"] = prod_rows

    total = sum(v for k, v in counts.items() if k != "production")
    meta = {
        "schema_version": "1",
        "built_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "total": str(total),
        "counts": json.dumps(counts, separators=(",", ":")),
    }
    cur.executemany("INSERT INTO meta VALUES (?,?)", list(meta.items()))
    conn.commit()
    return counts


def build_features(results: Iterable[Any], out_path: Path = DB_PATH) -> int:
    """Pipeline entry point. `results` is the list of SourceResult objects
    from refresh.py (each has .layer_id + .geojson_path). Builds the DB at
    `out_path` from the point sources present in results. Returns total
    row count."""
    by_layer = {r.layer_id: r.geojson_path for r in results}
    sources = [(layer, by_layer[layer]) for layer in POINT_LAYERS if layer in by_layer]
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if out_path.exists():
        out_path.unlink()
    conn = sqlite3.connect(str(out_path))
    try:
        counts = build_db(sources, conn, production_csv=PRODUCTION_CSV)
    finally:
        conn.close()
    total = sum(v for k, v in counts.items() if k != "production")
    nonzero = {k: v for k, v in counts.items() if v}
    prod = counts.get("production", 0)
    print(
        f"features.db: {total:,} rows across "
        f"{len([k for k in nonzero if k != 'production'])} point layers"
        + (f" + {prod:,} production records" if prod else "")
        + f" → {nonzero}"
    )
    return total


def _main() -> int:
    """Standalone build from etl/work/*.geojson — for local dev without a
    full refresh run. Mirrors what refresh.py does with SourceResults."""
    sources = [(layer, WORK / f"{layer}.geojson") for layer in POINT_LAYERS]
    OUT.mkdir(parents=True, exist_ok=True)
    if DB_PATH.exists():
        DB_PATH.unlink()
    conn = sqlite3.connect(str(DB_PATH))
    try:
        counts = build_db(sources, conn, production_csv=PRODUCTION_CSV)
    finally:
        conn.close()
    print(f"features.db built at {DB_PATH} — {counts}")
    return 0


if __name__ == "__main__":
    sys.exit(_main())
