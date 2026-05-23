"""
BLM National MLRS Oil & Gas Leases — active polygons.

Same Hub Downloads API + ijson streaming pattern as sources/blm_claims.py.
Dataset is much smaller (~24k polygons vs 556k claims) so the download
typically finishes in under 30 seconds. Item id is the BLM-EGIS hosted
feature service for active federal oil and gas leases.

Source: https://gbp-blm-egis.hub.arcgis.com/datasets/BLM-EGIS::blm-natl-mlrs-oil-and-gas-leases
Item id: ce26353f9cf74439b3619b5b410505e2
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

ITEM_ID = "ce26353f9cf74439b3619b5b410505e2"
PRIMARY_URL = (
    f"https://gbp-blm-egis.hub.arcgis.com/api/download/v1/items/{ITEM_ID}/geojson?layers=0"
)
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0 "
    "(Subterra-ETL +https://github.com/salamndrgaming-lab/subterra)"
)
REQUEST_TIMEOUT = 600.0  # 10 min — small dataset, generous ceiling
POLL_INTERVAL = 5.0
POLL_TIMEOUT = 600.0


@dataclass
class SourceResult:
    layer_id: str
    geojson_path: Path
    feature_count: int


def _resolve_data_url(url: str) -> requests.Response:
    """Identical pattern to sources/blm_claims._resolve_data_url. Returns
    a streaming response on the GeoJSON body, polling/redirecting through
    any job-status envelope the Hub returns."""
    log = logging.getLogger("etl.blm_leases")
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
        cl = resp.headers.get("content-length", "0")
        try:
            cl_n = int(cl)
        except ValueError:
            cl_n = 0
        if "geo+json" in ct or cl_n > 4096:
            log.info("download stream ready (ct=%s, content-length=%s)", ct, cl)
            return resp
        body = resp.text
        resp.close()
        try:
            status = json.loads(body)
        except Exception as err:
            raise RuntimeError(f"Unexpected hub response: ct={ct} body[:200]={body[:200]!r}") from err
        next_url = status.get("url") or status.get("downloadUrl")
        if next_url and next_url != current:
            log.info("hub redirected to %s", next_url)
            current = next_url
            continue
        if time.monotonic() > deadline:
            raise RuntimeError(f"Hub timed out generating download for item {ITEM_ID}")
        log.info("hub job not ready, sleeping %.0fs (status=%s)", POLL_INTERVAL, status.get("status"))
        time.sleep(POLL_INTERVAL)


_PROP_KEYS = {
    "serial": ["case_record_serial_nr", "serial_nr", "case_nr", "serial", "lease_serial_nr"],
    "lessee": ["lessee_name", "company_name", "lessee", "case_name"],
    "commodity": ["commodity_code", "commodity", "product"],
    "acreage": ["acres_leased", "acreage", "acres", "case_acres"],
    "effective_at": ["lease_eff_date", "lease_effective_dt", "eff_date"],
    "expires_at": ["lease_exp_date", "lease_expiration_dt", "exp_date"],
    "state": ["admin_state_code", "state", "admin_state"],
    "status": ["case_disp", "status", "disposition", "lease_status"],
    "type": ["case_type", "lease_type"],
}


def _coalesce(props: dict, keys: list[str]) -> object:
    for k in keys:
        if k in props and props[k] not in (None, "", " "):
            return props[k]
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
    log = logging.getLogger("etl.blm_leases")
    log.info("starting BLM MLRS oil & gas leases download")

    url = os.environ.get("BLM_LEASES_URL", PRIMARY_URL)
    resp = _resolve_data_url(url)

    out_path = work_dir / "blm_leases.geojson"
    feature_count = 0
    skipped = 0
    started = time.monotonic()

    try:
        with out_path.open("w", encoding="utf-8") as out, resp:
            resp.raw.decode_content = True
            out.write('{"type":"FeatureCollection","features":[')
            first = True
            pbar = tqdm(desc="blm leases", unit="feat", smoothing=0.1)
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
        if out_path.exists():
            out_path.unlink()
        raise

    elapsed = time.monotonic() - started
    log.info(
        "wrote %d leases (skipped %d no-geometry) in %.1fs → %s",
        feature_count, skipped, elapsed, out_path.name,
    )

    return SourceResult(
        layer_id="leases",  # matches tilesetLayer in shared/layers.ts
        geojson_path=out_path,
        feature_count=feature_count,
    )
