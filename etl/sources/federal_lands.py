"""
BLM National Surface Management Agency (SMA) — federal land ownership.

After multiple attempts against the BLM gis.blm.gov MapServer (paginated
queries returned 400 on layer 18, and other layer ids weren't queryable),
pivoting to the same Hub Downloads API pattern that works reliably for
sources/blm_claims.py and sources/blm_leases.py. The SMA dataset is
fronted on the same BLM-EGIS Hub.

Source: https://gbp-blm-egis.hub.arcgis.com/datasets/BLM-EGIS::blm-national-sma-surface-management-agency-area-polygons
Item id: 6bf2e737c59d4111be92420ee5ab0b46
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import ijson
import requests
from tqdm import tqdm

ITEM_ID = "6bf2e737c59d4111be92420ee5ab0b46"
PRIMARY_URL = (
    f"https://gbp-blm-egis.hub.arcgis.com/api/download/v1/items/{ITEM_ID}/geojson?layers=0"
)
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0 "
    "(Subterra-ETL +https://github.com/salamndrgaming-lab/subterra)"
)
REQUEST_TIMEOUT = 1800.0  # SMA file is ~1-2 GB GeoJSON, 30 min ceiling
POLL_INTERVAL = 10.0
POLL_TIMEOUT = 1200.0  # 20 min — Hub on-demand generation can take a while


AGENCY_NORMALIZATION: dict[str, str] = {
    "BLM": "BLM",
    "BUREAU OF LAND MANAGEMENT": "BLM",
    "FS": "USFS",
    "USFS": "USFS",
    "FOREST SERVICE": "USFS",
    "USDA FOREST SERVICE": "USFS",
    "NPS": "NPS",
    "NATIONAL PARK SERVICE": "NPS",
    "BIA": "BIA",
    "BUREAU OF INDIAN AFFAIRS": "BIA",
    "INDIAN": "BIA",
    "TRIBAL": "BIA",
}


@dataclass
class SourceResult:
    layer_id: str
    geojson_path: Path
    feature_count: int


def _resolve_data_url(url: str) -> requests.Response:
    """Identical pattern to sources/blm_claims._resolve_data_url. Returns
    a streaming response on the GeoJSON body, polling/redirecting through
    any job-status envelope the Hub returns."""
    log = logging.getLogger("etl.federal_lands")
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


def _agency_from(props: dict[str, Any]) -> str | None:
    for key in (
        "ADMIN_AGENCY_CODE", "admin_agency_code",
        "ADMIN_AGY_DESC", "admin_agy_desc",
        "AGY_NAME", "agy_name",
        "ADM_MANAGE", "adm_manage",
        "AGBUR", "agbur",
        "AGENCY", "agency",
        "MANAGER", "manager",
        "MGMT_AGENCY", "mgmt_agency",
        "OWNER_NAME", "owner_name",
    ):
        v = props.get(key)
        if not v:
            continue
        norm = AGENCY_NORMALIZATION.get(str(v).strip().upper())
        if norm:
            return norm
    return None


def _name_from(props: dict[str, Any]) -> str | None:
    for key in (
        "ADMIN_UNIT_NAME", "admin_unit_name",
        "ADMIN_BNDRY_NM", "admin_bndry_nm",
        "UNIT_NAME", "unit_name",
        "NAME", "name", "FEAT_NAME",
    ):
        v = props.get(key)
        if v not in (None, "", " "):
            return str(v)
    return None


def _state_from(props: dict[str, Any]) -> str | None:
    for key in (
        "ADMIN_ST", "admin_st",
        "STATE", "state",
        "ST_ABBREV", "ST", "STATE_NM",
    ):
        v = props.get(key)
        if v not in (None, "", " "):
            return str(v)
    return None


def run(work_dir: Path) -> SourceResult:
    log = logging.getLogger("etl.federal_lands")
    log.info("starting BLM National SMA download via Hub API")

    url = os.environ.get("FEDERAL_LANDS_URL", PRIMARY_URL)
    resp = _resolve_data_url(url)

    out_path = work_dir / "federal_lands.geojson"
    feature_count = 0
    skipped_no_geom = 0
    per_agency: dict[str, int] = {}
    seen_raw_agency: dict[str, int] = {}
    started = time.monotonic()

    try:
        with out_path.open("w", encoding="utf-8") as out, resp:
            resp.raw.decode_content = True
            out.write('{"type":"FeatureCollection","features":[')
            first = True
            pbar = tqdm(desc="federal lands", unit="feat", smoothing=0.1)
            for feat in ijson.items(resp.raw, "features.item", use_float=True):
                geom = feat.get("geometry")
                if not geom:
                    skipped_no_geom += 1
                    continue
                raw_props = feat.get("properties") or {}
                agency = _agency_from(raw_props)
                if agency is None:
                    raw_val = next(
                        (str(raw_props.get(k)).strip() for k in raw_props
                         if "agency" in k.lower() or "agbur" in k.lower() or "manage" in k.lower()
                         if raw_props.get(k) not in (None, "", " ")),
                        None,
                    )
                    agency = raw_val or "OTHER"
                    if raw_val:
                        seen_raw_agency[raw_val] = seen_raw_agency.get(raw_val, 0) + 1
                props = {
                    "agency": agency,
                    "name": _name_from(raw_props),
                    "state": _state_from(raw_props),
                }
                props = {k: v for k, v in props.items() if v is not None}
                if not first:
                    out.write(",")
                first = False
                json.dump({"type": "Feature", "geometry": geom, "properties": props}, out)
                feature_count += 1
                per_agency[agency] = per_agency.get(agency, 0) + 1
                pbar.update(1)
            pbar.close()
            out.write("]}")
    except Exception:
        if out_path.exists():
            out_path.unlink()
        raise

    elapsed = time.monotonic() - started
    log.info(
        "wrote %d federal polygons (skipped %d no-geom) in %.1fs",
        feature_count, skipped_no_geom, elapsed,
    )
    log.info("normalized agency breakdown: %s", per_agency)
    if seen_raw_agency:
        top = sorted(seen_raw_agency.items(), key=lambda kv: kv[1], reverse=True)[:20]
        log.info("top unrecognized agency values (raw): %s", dict(top))
    return SourceResult(
        layer_id="federal_lands",
        geojson_path=out_path,
        feature_count=feature_count,
    )
