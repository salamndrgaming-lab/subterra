"""
BLM National Surface Management Agency (SMA) polygons.

Single national dataset showing federal surface-managing-agency
boundaries — every BLM, USFS, NPS, BIA, FWS, DOD, etc. polygon in a
unified schema. We keep the four agencies most relevant to mineral
prospecting (BLM, FS, NPS, BIA) and tag each feature with a normalized
`agency` code so the web app can color-by-agency.

Source: https://gbp-blm-egis.hub.arcgis.com/datasets/BLM-EGIS::blm-national-sma-surface-management-agency-area-polygons
Item id: 6bf2e737c59d4111be92420ee5ab0b46

The dataset is large (~1-2 GB GeoJSON, ~1M polygons). We stream through
ijson and write a normalized output that tippecanoe simplifies hard at
low zooms — final pmtiles addition stays in the tens-of-MB range.
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

ITEM_ID = "6bf2e737c59d4111be92420ee5ab0b46"
PRIMARY_URL = (
    f"https://gbp-blm-egis.hub.arcgis.com/api/download/v1/items/{ITEM_ID}/geojson?layers=0"
)
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0 "
    "(Subterra-ETL +https://github.com/salamndrgaming-lab/subterra)"
)
REQUEST_TIMEOUT = 1800.0  # 30 min for the bulk download
POLL_INTERVAL = 10.0
POLL_TIMEOUT = 1200.0

# Agencies we surface as map layers. BLM-EGIS uses 2-3 letter codes;
# canonicalize aliases so the web app sees a stable vocabulary.
AGENCY_NORMALIZATION: dict[str, str] = {
    "BLM": "BLM",
    "BUREAU OF LAND MANAGEMENT": "BLM",
    "FS": "USFS",
    "USFS": "USFS",
    "FOREST SERVICE": "USFS",
    "NPS": "NPS",
    "NATIONAL PARK SERVICE": "NPS",
    "BIA": "BIA",
    "BUREAU OF INDIAN AFFAIRS": "BIA",
    "INDIAN": "BIA",
}
KEEP_AGENCIES = set(AGENCY_NORMALIZATION.values())


@dataclass
class SourceResult:
    layer_id: str
    geojson_path: Path
    feature_count: int


def _resolve_data_url(url: str) -> requests.Response:
    """Hub Download API: returns a streaming response on the GeoJSON, OR
    a short JSON job-status envelope to poll. Identical pattern to
    sources/blm_claims._resolve_data_url."""
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
        # Direct stream — big body OR explicit geo content type.
        if "geo+json" in ct or cl_n > 4096:
            log.info("download stream ready (ct=%s, content-length=%s)", ct, cl)
            return resp
        # Small JSON body: probably a status envelope.
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


def _agency_from(props: dict) -> str | None:
    for key in ("adm_manage", "ADM_MANAGE", "AGBUR", "agency", "AGENCY", "MANAGER", "manager"):
        v = props.get(key)
        if not v:
            continue
        norm = AGENCY_NORMALIZATION.get(str(v).strip().upper())
        if norm:
            return norm
    return None


def run(work_dir: Path) -> SourceResult:
    log = logging.getLogger("etl.federal_lands")
    log.info("starting BLM National SMA download")

    url = os.environ.get("FEDERAL_LANDS_URL", PRIMARY_URL)
    resp = _resolve_data_url(url)

    out_path = work_dir / "federal_lands.geojson"
    feature_count = 0
    skipped = 0
    per_agency: dict[str, int] = {}
    started = time.monotonic()

    try:
        with out_path.open("w", encoding="utf-8") as out, resp:
            resp.raw.decode_content = True  # decode Content-Encoding: gzip
            out.write('{"type":"FeatureCollection","features":[')
            first = True
            pbar = tqdm(desc="federal lands", unit="feat", smoothing=0.1)
            for feat in ijson.items(resp.raw, "features.item", use_float=True):
                geom = feat.get("geometry")
                if not geom:
                    skipped += 1
                    continue
                raw_props = feat.get("properties") or {}
                agency = _agency_from(raw_props)
                if agency is None:
                    skipped += 1
                    pbar.update(1)
                    continue
                # Keep a small, stable property set.
                props = {
                    "agency": agency,
                    "name": raw_props.get("UNIT_NAME") or raw_props.get("unit_name") or raw_props.get("NAME"),
                    "state": raw_props.get("STATE") or raw_props.get("ST_ABBREV") or raw_props.get("state"),
                }
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
        "wrote %d federal polygons (skipped %d) in %.1fs — by agency: %s",
        feature_count, skipped, elapsed, per_agency,
    )

    return SourceResult(
        layer_id="federal_lands",
        geojson_path=out_path,
        feature_count=feature_count,
    )
