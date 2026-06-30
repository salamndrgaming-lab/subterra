"""
BLM National MLRS Mining Claims — Not Closed (active).

Pulls every active mining-claim case in BLM's Mineral and Land Records
System (MLRS), nationwide. ~550k features as of 2026-06.

The canonical endpoint is the ArcGIS REST FeatureServer that backs
the BLM Hub item `abec5ef96dc8495d9c29a01b30cc04ee` — looked up via
https://www.arcgis.com/sharing/rest/content/items/<itemid>?f=json.
We paginate against it via the project's `_arcgis` helper, same as
withdrawals.py / wells.py / etc.

The previous implementation used BLM's Hub Downloads API (a bulk
GeoJSON dump). That endpoint silently regressed to returning ~552
features (vs the historical ~552,985) for at least 10 days in
June 2026 — the streamed file was a truncated cache that BLM's Hub
job never refreshed. Switching to the FeatureServer paginator bypasses
the broken cache entirely and uses the same underlying service the
Hub Downloads job was supposed to be exporting from. Slower
(paginated fetches instead of one big stream) but trustworthy.

Source URLs:
  - Hub item metadata:
    https://www.arcgis.com/sharing/rest/content/items/abec5ef96dc8495d9c29a01b30cc04ee?f=json
  - FeatureServer base (from the item's "url" field):
    https://gis.blm.gov/nlsdb/rest/services/HUB/BLM_Natl_MLRS_Mining_Claims_Not_Closed/FeatureServer
  - Discoverable at:
    https://catalog.data.gov/dataset/blm-natl-mlrs-mining-claims-not-closed-f621b
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass
from pathlib import Path

from sources._arcgis import iter_features_concurrent

DEFAULT_QUERY_URL = (
    "https://gis.blm.gov/nlsdb/rest/services/HUB/"
    "BLM_Natl_MLRS_Mining_Claims_Not_Closed/FeatureServer/0/query"
)


@dataclass
class SourceResult:
    layer_id: str
    geojson_path: Path
    feature_count: int


_PROP_KEYS = {
    "serial": ["case_record_serial_nr", "serial_nr", "case_nr", "serial", "serialnr"],
    "name": ["case_name", "claim_name", "name"],
    "claim_type": ["case_type", "claim_type", "claimtype"],
    "status": ["case_disp", "status", "disposition"],
    "claimant": ["claimant_name", "claimant", "owner"],
    "state": ["admin_state_code", "state", "admin_state"],
    "county": ["county", "county_name"],
    "acreage": ["acreage", "acres", "case_acres"],
    "located_at": ["location_dt", "loc_date", "located_dt"],
    "recorded_at": ["recordation_dt", "rec_date"],
    "last_assess_year": ["last_assess_yr", "assessment_yr"],
}


def _coalesce(props: dict, keys: list[str]) -> object:
    for k in keys:
        if k in props and props[k] not in (None, "", " "):
            return props[k]
        # ArcGIS often UPPERCASES; try both
        ku = k.upper()
        if ku in props and props[ku] not in (None, "", " "):
            return props[ku]
    return None


def _normalize(props: dict) -> dict:
    out: dict = {}
    for canon, candidates in _PROP_KEYS.items():
        v = _coalesce(props, candidates)
        if v is not None:
            out[canon] = v
    return out


def run(work_dir: Path) -> SourceResult:
    log = logging.getLogger("etl.blm_claims")
    log.info("starting BLM MLRS mining-claims download")

    # Endpoint is env-overridable in case BLM republishes the service
    # under a new slug. Both the canonical SUBTERRA_* name and the
    # legacy BLM_CLAIMS_URL are honored.
    url = (
        os.environ.get("SUBTERRA_BLM_CLAIMS_URL")
        or os.environ.get("BLM_CLAIMS_URL")
        or DEFAULT_QUERY_URL
    )
    log.info("source URL: %s", url)

    out_path = work_dir / "blm_claims.geojson"
    feature_count = 0
    skipped = 0
    empty_props = 0
    started = time.monotonic()
    first = [True]
    # Diagnostic: capture the first feature's RAW upstream property keys.
    # The claims diff recently found every feature writing properties={}
    # (keys:[]), which means BLM renamed its fields and _coalesce/_PROP_KEYS
    # match nothing — claims still tile (geometry is fine) but popups + the
    # diff go blank. We can't see BLM's current field names from a dev
    # sandbox, so surface them from the run itself: emit a ::warning:: with
    # the raw keys so _PROP_KEYS can be updated deterministically.
    raw_keys_sample: list[str] | None = None

    try:
        with out_path.open("w", encoding="utf-8") as out:
            out.write('{"type":"FeatureCollection","features":[')

            def on_feature(feat: dict) -> None:
                nonlocal feature_count, skipped, empty_props, raw_keys_sample
                geom = feat.get("geometry")
                if not geom:
                    skipped += 1
                    return
                raw = feat.get("properties") or {}
                if raw_keys_sample is None and raw:
                    raw_keys_sample = list(raw.keys())[:30]
                props = _normalize(raw)
                if not props:
                    empty_props += 1
                if not first[0]:
                    out.write(",")
                first[0] = False
                json.dump(
                    {"type": "Feature", "geometry": geom, "properties": props}, out
                )
                feature_count += 1

            iter_features_concurrent(
                url,
                on_feature=on_feature,
                # 8 workers @ 2000 features/page = 16k features in flight;
                # the BLM nlsdb host handles this comfortably in tests of
                # the same shape against withdrawals + federal_lands.
                workers=8,
                progress_label="blm_claims",
            )

            out.write("]}")
    except Exception:
        # Don't leave a half-written file lying around for tippecanoe.
        if out_path.exists():
            out_path.unlink()
        raise

    elapsed = time.monotonic() - started
    log.info(
        "wrote %d claims (skipped %d no-geometry, %d empty-props) in %.1fs → %s",
        feature_count, skipped, empty_props, elapsed, out_path.name,
    )
    # If a meaningful share of claims normalized to empty properties, the
    # canonical field mapping is stale. Surface the raw keys so the fix is
    # a one-line _PROP_KEYS update rather than another blind guess.
    if feature_count and empty_props > feature_count * 0.5:
        print(
            f"::warning::blm_claims wrote {empty_props:,}/{feature_count:,} claims with "
            f"EMPTY properties — _PROP_KEYS is stale vs upstream. First feature's raw "
            f"property keys: {raw_keys_sample}"
        )

    return SourceResult(
        layer_id="mining_claims",  # matches tilesetLayer in shared/layers.ts
        geojson_path=out_path,
        feature_count=feature_count,
    )
