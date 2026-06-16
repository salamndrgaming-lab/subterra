"""
BLM National MLRS Mining Claims — Not Closed (active).

Bulk GeoJSON download from BLM's Geospatial Business Platform Hub. The
dataset item id (`abec5ef96dc8495d9c29a01b30cc04ee`) is the MLRS
Mining Claims feature service — every active mining claim recorded in
BLM's Mineral & Land Records System. ~350k features, ~250 MB GeoJSON.

Hub Downloads API v1 either streams the file directly or returns a
short job-status JSON that points at a CDN URL. We handle both cases.

Source URL:
  https://gbp-blm-egis.hub.arcgis.com/api/download/v1/items/abec5ef96dc8495d9c29a01b30cc04ee/geojson?layers=0
Discoverable at:
  https://catalog.data.gov/dataset/blm-natl-mlrs-mining-claims-not-closed-f621b
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass
from pathlib import Path

import ijson
import requests
from tqdm import tqdm

ITEM_ID = "abec5ef96dc8495d9c29a01b30cc04ee"
PRIMARY_URL = (
    f"https://gbp-blm-egis.hub.arcgis.com/api/download/v1/items/{ITEM_ID}/geojson?layers=0"
)
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0 "
    "(Subterra-ETL +https://github.com/salamndrgaming-lab/subterra)"
)
REQUEST_TIMEOUT = 600.0  # 10 min — large download under variable load
POLL_INTERVAL = 5.0
POLL_TIMEOUT = 600.0


@dataclass
class SourceResult:
    layer_id: str
    geojson_path: Path
    feature_count: int


def _resolve_data_url(url: str) -> tuple[str, requests.Response]:
    """The Hub download endpoint sometimes returns a JSON job status (with
    a `url` field pointing at the cached file) rather than streaming the
    file directly. Detect that and follow up. Returns the eventual data
    URL plus an open streaming Response on that URL."""
    log = logging.getLogger("etl.blm_claims")
    deadline = time.monotonic() + POLL_TIMEOUT

    def fetch(u: str) -> requests.Response:
        return requests.get(
            u,
            headers={
                "User-Agent": USER_AGENT,
                "accept": "application/geo+json, application/json, */*",
            },
            stream=True,
            timeout=REQUEST_TIMEOUT,
            allow_redirects=True,
        )

    current = url
    while True:
        resp = fetch(current)
        resp.raise_for_status()
        ct = resp.headers.get("content-type", "").lower()
        # Direct GeoJSON stream — done.
        if "geo+json" in ct or ("json" in ct and not _looks_like_status(resp)):
            log.info("download URL ready (content-type=%s)", ct)
            return current, resp
        # JSON status response — parse and either follow or poll.
        body = resp.text
        resp.close()
        try:
            status = json.loads(body)
        except Exception as err:
            raise RuntimeError(
                f"Unexpected response from BLM hub: ct={ct} body[:200]={body[:200]!r}"
            ) from err
        next_url = status.get("url") or status.get("downloadUrl")
        if next_url and next_url != current:
            log.info("hub redirected to %s", next_url)
            current = next_url
            continue
        # Still cooking — poll same URL.
        if time.monotonic() > deadline:
            raise RuntimeError(f"Timed out waiting for BLM hub to publish download for item {ITEM_ID}")
        log.info("hub job not ready, sleeping %.0fs (status=%s)", POLL_INTERVAL, status.get("status"))
        time.sleep(POLL_INTERVAL)


def _looks_like_status(resp: requests.Response) -> bool:
    """A short JSON body is likely a job-status envelope; a large body is
    likely the data itself. Used only when content-type doesn't disambiguate."""
    cl = resp.headers.get("content-length")
    if cl is not None:
        try:
            return int(cl) < 4096
        except ValueError:
            return False
    return False


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

    # The default `PRIMARY_URL` (BLM ArcGIS Hub Downloads API) has been
    # observed returning a truncated payload of ~552 features (vs the
    # historical ~552,985) for at least 10 days as of 2026-06-16 — root
    # cause unknown, likely a BLM-side dataset republish or
    # filter regression. Workarounds, in order of preference:
    #   1. Set SUBTERRA_BLM_CLAIMS_URL in repo Variables to a known-good
    #      bulk-download URL (e.g. the BLM EGIS direct ArcGIS service:
    #      https://gis.blm.gov/arcgis/rest/services/mlrs/... /MapServer/0/query
    #      — combined with iter_features_concurrent pagination via the
    #      `_arcgis` helper). Then re-run via workflow_dispatch.
    #   2. Wait for BLM to fix the Hub upstream.
    # The EXPECTED_MIN_FEATURES floor in refresh.py prevents a tileset
    # with the truncated count from shipping in the meantime.
    url = (
        os.environ.get("SUBTERRA_BLM_CLAIMS_URL")
        or os.environ.get("BLM_CLAIMS_URL")
        or PRIMARY_URL
    )
    log.info("source URL: %s", url)
    _, resp = _resolve_data_url(url)

    out_path = work_dir / "blm_claims.geojson"
    feature_count = 0
    skipped = 0
    started = time.monotonic()

    try:
        with out_path.open("w", encoding="utf-8") as out, resp:
            # urllib3 doesn't decode gzip/deflate on resp.raw by default;
            # the BLM hub serves Content-Encoding: gzip, so ijson would
            # otherwise see the gzip magic header (\x1f\x8b) as JSON.
            resp.raw.decode_content = True
            out.write('{"type":"FeatureCollection","features":[')
            first = True
            pbar = tqdm(desc="blm claims", unit="feat", smoothing=0.1)
            # use_float=True keeps coordinates as Python floats; otherwise
            # ijson hands back decimal.Decimal which json.dump refuses to
            # serialize without a custom default.
            for feat in ijson.items(resp.raw, "features.item", use_float=True):
                geom = feat.get("geometry")
                if not geom:
                    skipped += 1
                    continue
                props = _normalize(feat.get("properties") or {})
                if not first:
                    out.write(",")
                first = False
                json.dump({"type": "Feature", "geometry": geom, "properties": props}, out)
                feature_count += 1
                pbar.update(1)
            pbar.close()
            out.write("]}")
    except Exception:
        # Don't leave a half-written file lying around for tippecanoe.
        if out_path.exists():
            out_path.unlink()
        raise

    elapsed = time.monotonic() - started
    log.info(
        "wrote %d claims (skipped %d no-geometry) in %.1fs → %s",
        feature_count, skipped, elapsed, out_path.name,
    )

    return SourceResult(
        layer_id="mining_claims",  # matches tilesetLayer in shared/layers.ts
        geojson_path=out_path,
        feature_count=feature_count,
    )
