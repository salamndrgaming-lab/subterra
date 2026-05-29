"""
Resource hotspot precomputation.

Runs LAST in SOURCES so it can read every other source's GeoJSON
output from work_dir. Bins the western US into 0.5° geographic cells
(~55 km × 55 km at mid-latitude) and scores each cell on prospecting
potential:

  + Density of past mineral occurrences (USGS MRDS hits)
  + Available open federal land (BLM polygon coverage)
  − Existing-claim competition (active claims compete for the same
    ground; reduces but doesn't kill the score)

Score is 0–100. Top-scored cells become the "Top Hotspots" sidebar
list; the layer itself is a heatmap-style choropleth painted by
score.

Cost + revenue heuristics per cell are intentionally rough:
  cost  = N lode claims × (BLM location fee + N × annual maintenance)
  revenue = Σ commodity_base_value × deposit_count

The revenue side is a public-data heuristic — MRDS lists historic
occurrences with no production guarantee, so the UI labels it "rough
revenue potential" rather than "expected revenue."

Binning by centroid (not polygon intersection) is intentional: with
~550k claims × ~1500 cells, polygon ops would take hours. Centroids
give the right answer to within a cell — accurate enough for an
overview-zoom heatmap.
"""

from __future__ import annotations

import json
import logging
import math
import time
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import ijson

# Western-US prospecting target. Stops at -100° lng (eastern edge of
# the high plains, near where federal land coverage drops to ~0).
WEST_BBOX = (-125.0, 31.0, -100.0, 49.5)

# Cell size in degrees. 0.5° ≈ 55 km at 40°N — coarse enough that even
# the densest commodity belts (Carlin trend, Bingham) fall into a few
# cells, fine enough that the top hotspots are actionable.
CELL_DEG = 0.5

# Cap the cell list at this many features per scoring run. Anything
# above is clipped at score=100. Keeps the score scale bounded.
DEPOSIT_SCORE_CAP = 50.0
BLM_SCORE_CAP = 30.0
CLAIM_PENALTY_CAP = 20.0

# Commodity → rough revenue-potential base ($USD per known deposit).
# These are heuristic ballpark numbers for "what could a small mine
# producing this commodity be worth over a 10-yr horizon", calibrated
# against typical small-mine output. Not financial advice — used only
# as a relative ranking signal between cells.
COMMODITY_BASE_VALUE = {
    "AU": 12_000_000,   # gold
    "AG": 2_500_000,    # silver
    "CU": 4_000_000,    # copper
    "MO": 1_500_000,    # molybdenum
    "ZN": 1_500_000,    # zinc
    "PB": 1_000_000,    # lead
    "LI": 8_000_000,    # lithium (energy-transition premium)
    "REE": 6_000_000,   # rare earths
    "U":  5_000_000,    # uranium
    "SN": 1_500_000,    # tin
    "W":  2_000_000,    # tungsten
    "SB": 800_000,      # antimony
    "FE": 600_000,      # iron
}
DEFAULT_BASE_VALUE = 500_000

# Cost model — staking a 100-acre prospect (5 lode claims × 20 acres).
# Numbers are current BLM fee schedule:
#   $212 one-time location fee per claim
#   $165/year maintenance per claim
# 5-year horizon assumed.
CLAIMS_PER_PROSPECT = 5
LOCATION_FEE_PER_CLAIM = 212
ANNUAL_MAINT_PER_CLAIM = 165
HORIZON_YEARS = 5


@dataclass
class SourceResult:
    layer_id: str
    geojson_path: Path
    feature_count: int


def _first_coord(geom: dict[str, Any]) -> tuple[float, float] | None:
    """Pick a representative coord from any GeoJSON geometry.

    For binning into 55 km cells, the exact centroid doesn't matter —
    the first vertex is within cell distance of the actual centroid
    for anything but continent-spanning multipolygons. Avoids the
    cost of shapely import + iteration for ~600k geometries."""
    if not geom:
        return None
    coords = geom.get("coordinates")
    while isinstance(coords, list) and coords and isinstance(coords[0], list):
        coords = coords[0]
    if isinstance(coords, list) and len(coords) >= 2:
        try:
            return float(coords[0]), float(coords[1])
        except (TypeError, ValueError):
            return None
    return None


def _cell_for(x: float, y: float) -> tuple[int, int]:
    return (int(math.floor(x / CELL_DEG)), int(math.floor(y / CELL_DEG)))


def _cell_polygon(col: int, row: int) -> dict[str, Any]:
    x0 = col * CELL_DEG
    y0 = row * CELL_DEG
    x1 = x0 + CELL_DEG
    y1 = y0 + CELL_DEG
    return {
        "type": "Polygon",
        "coordinates": [[
            [x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0],
        ]],
    }


def _in_bbox(x: float, y: float) -> bool:
    return WEST_BBOX[0] <= x <= WEST_BBOX[2] and WEST_BBOX[1] <= y <= WEST_BBOX[3]


def _bin_mrds(path: Path, cells: dict, log: logging.Logger) -> int:
    if not path.exists():
        log.warning("%s missing — hotspot deposit signal will be empty", path.name)
        return 0
    n = 0
    with path.open("rb") as f:
        for feat in ijson.items(f, "features.item", use_float=True):
            xy = _first_coord(feat.get("geometry") or {})
            if not xy or not _in_bbox(*xy):
                continue
            cell = _cell_for(*xy)
            bucket = cells[cell]
            bucket["deposits"] += 1
            commodity = (feat.get("properties") or {}).get("commodity") or ""
            for raw in str(commodity).split(","):
                c = raw.strip().upper()
                if c:
                    bucket["commodities"][c] += 1
            n += 1
    log.info("binned %d MRDS sites", n)
    return n


def _bin_polygons(
    path: Path,
    cells: dict,
    key: str,
    log: logging.Logger,
    filter_fn=None,
) -> int:
    if not path.exists():
        log.warning("%s missing — hotspot %s signal will be empty", path.name, key)
        return 0
    n = 0
    with path.open("rb") as f:
        for feat in ijson.items(f, "features.item", use_float=True):
            if filter_fn is not None and not filter_fn(feat):
                continue
            xy = _first_coord(feat.get("geometry") or {})
            if not xy or not _in_bbox(*xy):
                continue
            cell = _cell_for(*xy)
            cells[cell][key] += 1
            n += 1
    log.info("binned %d %s polygons", n, key)
    return n


def _score(deposits: int, blm: int, claims: int) -> float:
    """Composite score 0–100. Scaled per signal so each contributes
    proportionally — deposits + BLM area drive the score up, existing
    claims drive it down (competition signal)."""
    deposit_score = min(deposits * 5.0, DEPOSIT_SCORE_CAP)
    # BLM polygon count caps at ~60 polygons = full coverage; scale to 30.
    blm_score = min(blm * 0.5, BLM_SCORE_CAP)
    # Claim penalty saturates quickly — 20+ claims in a 55 km cell is "busy"
    claim_penalty = min(claims * 0.5, CLAIM_PENALTY_CAP)
    return max(0.0, min(100.0, deposit_score + blm_score - claim_penalty))


def _revenue_range(commodities: dict[str, int]) -> tuple[int, int]:
    base = 0
    for c, n in commodities.items():
        base += COMMODITY_BASE_VALUE.get(c, DEFAULT_BASE_VALUE) * n
    # ±factor reflects the wide uncertainty on speculative deposits.
    return int(base * 0.3), int(base * 1.5)


def _cost_estimate() -> int:
    return CLAIMS_PER_PROSPECT * (
        LOCATION_FEE_PER_CLAIM + HORIZON_YEARS * ANNUAL_MAINT_PER_CLAIM
    )


def run(work_dir: Path) -> SourceResult:
    log = logging.getLogger("etl.hotspots")
    log.info("starting hotspot precomputation")
    started = time.monotonic()

    cells: dict[tuple[int, int], dict] = defaultdict(
        lambda: {
            "deposits": 0,
            "claims": 0,
            "blm": 0,
            "commodities": defaultdict(int),
        }
    )

    # Filenames MUST match the out_path each source writes (verified
    # against mrds.py / blm_claims.py): mrds.geojson + blm_claims.geojson.
    # Earlier these read mineral_sites.geojson / claims.geojson, which
    # don't exist — so every cell scored deposits=0, blm=0 and got
    # dropped, producing an empty hotspots layer + empty topHotspots
    # (which in turn left the heatmap blank and the wizard disabled).
    _bin_mrds(work_dir / "mrds.geojson", cells, log)
    _bin_polygons(work_dir / "blm_claims.geojson", cells, "claims", log)
    _bin_polygons(
        work_dir / "federal_lands.geojson",
        cells,
        "blm",
        log,
        filter_fn=lambda f: ((f.get("properties") or {}).get("agency") == "BLM"),
    )

    cost_estimate = _cost_estimate()
    out_features: list[dict] = []
    for (col, row), data in cells.items():
        deposits = data["deposits"]
        claims = data["claims"]
        blm = data["blm"]
        # Drop cells with nothing actionable. A cell needs at least
        # some signal (deposits OR BLM coverage) to be worth showing.
        if deposits == 0 and blm == 0:
            continue
        score = _score(deposits, blm, claims)
        if score < 5:
            continue
        rev_lo, rev_hi = _revenue_range(data["commodities"])
        top_commodities = sorted(
            data["commodities"].items(),
            key=lambda kv: -kv[1],
        )[:3]
        out_features.append({
            "type": "Feature",
            "geometry": _cell_polygon(col, row),
            "properties": {
                "score": round(score, 1),
                "deposits": deposits,
                "claims": claims,
                "blm_polys": blm,
                "top_commodities": ",".join(f"{c}:{n}" for c, n in top_commodities),
                "cost_low": int(cost_estimate * 0.8),
                "cost_high": int(cost_estimate * 1.5),
                "revenue_low": rev_lo,
                "revenue_high": rev_hi,
                "lng": round((col + 0.5) * CELL_DEG, 4),
                "lat": round((row + 0.5) * CELL_DEG, 4),
            },
        })

    # Sort by score desc so the sidebar "Top Hotspots" list reads top-down.
    out_features.sort(key=lambda f: -f["properties"]["score"])

    out_path = work_dir / "hotspots.geojson"
    with out_path.open("w", encoding="utf-8") as f:
        json.dump({"type": "FeatureCollection", "features": out_features}, f)

    elapsed = time.monotonic() - started
    top_score = out_features[0]["properties"]["score"] if out_features else 0
    log.info(
        "wrote %d scored cells in %.1fs (top score=%s)",
        len(out_features), elapsed, top_score,
    )
    return SourceResult(
        layer_id="hotspots",
        geojson_path=out_path,
        feature_count=len(out_features),
    )
