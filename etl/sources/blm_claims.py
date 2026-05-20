"""
BLM National Mining Claims — Active Polygons.

Downloads every active mining claim from the BLM-EGIS Hub feature
service via paginated ArcGIS REST queries, normalizes the attributes
into a stable schema, writes a single newline-delimited GeoJSON file.

The Hub endpoint URL is set in the BLM_CLAIMS_URL env var. The default
falls back through a small list of known service paths in case BLM has
rotated one — the first 200 response wins. If every candidate fails the
ETL job exits non-zero and opens a GitHub issue (see etl.yml).
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import requests
from tqdm import tqdm

# Known-good BLM-EGIS ArcGIS Online services for mining claims, in order
# of preference. New URLs go at the top. Any that 404 are skipped at
# runtime so a service move doesn't break the whole pipeline.
CANDIDATE_URLS: list[str] = [
    "https://services1.arcgis.com/IIRcvAtwIvuRgVF8/arcgis/rest/services/"
    "BLM_Natl_Mining_Claims_Polys/FeatureServer/0/query",
    "https://services1.arcgis.com/IIRcvAtwIvuRgVF8/arcgis/rest/services/"
    "BLM_National_Mining_Claims_Polys/FeatureServer/0/query",
    "https://gis.blm.gov/arcgis/rest/services/mining/"
    "BLM_Natl_Mining_Claims/MapServer/0/query",
]

PAGE_SIZE = 2000
REQUEST_TIMEOUT = 60.0
USER_AGENT = (
    "Subterra-ETL/0.1 (+https://github.com/salamndrgaming-lab/subterra)"
)


@dataclass
class SourceResult:
    layer_id: str
    geojson_path: Path
    feature_count: int


def _resolve_url() -> str:
    """Return the first URL whose `?f=json` info endpoint responds 200."""
    env_url = os.environ.get("BLM_CLAIMS_URL")
    if env_url:
        return env_url

    log = logging.getLogger("etl.blm_claims")
    for url in CANDIDATE_URLS:
        info_url = url.rsplit("/query", 1)[0]
        try:
            resp = requests.get(
                f"{info_url}?f=json",
                headers={"User-Agent": USER_AGENT},
                timeout=15,
            )
            if resp.status_code == 200 and resp.json().get("type"):
                log.info("resolved BLM claims service → %s", url)
                return url
        except Exception as err:  # noqa: BLE001 — we want to swallow + log
            log.debug("candidate failed %s: %s", url, err)
    raise RuntimeError(
        "No BLM mining-claims endpoint responded. Set BLM_CLAIMS_URL "
        "manually after browsing https://gbp-blm-egis.hub.arcgis.com/"
    )


def _fetch_chunk(url: str, offset: int) -> dict[str, Any]:
    params = {
        "where": "1=1",
        "outFields": "*",
        "returnGeometry": "true",
        "outSR": "4326",
        "f": "geojson",
        "resultRecordCount": str(PAGE_SIZE),
        "resultOffset": str(offset),
    }
    resp = requests.get(
        url,
        params=params,
        headers={"User-Agent": USER_AGENT, "accept": "application/json"},
        timeout=REQUEST_TIMEOUT,
    )
    if resp.status_code >= 400:
        # Some servers don't support geojson — retry with f=json.
        params["f"] = "json"
        resp = requests.get(
            url,
            params=params,
            headers={"User-Agent": USER_AGENT, "accept": "application/json"},
            timeout=REQUEST_TIMEOUT,
        )
    resp.raise_for_status()
    body = resp.json()
    if isinstance(body, dict) and body.get("error"):
        raise RuntimeError(f"ArcGIS error: {body['error']}")
    return body


def _normalize_props(raw: dict[str, Any]) -> dict[str, Any]:
    """Stable property shape regardless of which BLM service revision shipped
    these features. We pluck the fields we care about by name and ignore the
    rest — tippecanoe drops anything that's null at tile-encode time."""
    serial = (
        raw.get("CASE_RECORD_SERIAL_NR")
        or raw.get("SERIAL_NR")
        or raw.get("CASE_NR")
        or raw.get("SERIAL")
    )
    return {
        "serial": serial,
        "name": raw.get("CLAIM_NAME") or raw.get("CASE_NAME"),
        "claim_type": (raw.get("CLAIM_TYPE") or "").lower() or None,
        "status": (raw.get("CASE_DISP") or raw.get("STATUS") or "").lower() or None,
        "owner": raw.get("CLAIMANT_NAME") or raw.get("CASE_NAME"),
        "commodity": raw.get("COMMODITY"),
        "state": raw.get("STATE"),
        "county": raw.get("COUNTY"),
        "acreage": raw.get("ACREAGE"),
        "located_at": raw.get("LOCATION_DT"),
        "recorded_at": raw.get("RECORDATION_DT"),
        "last_assess_year": raw.get("LAST_ASSESS_YR"),
    }


def run(work_dir: Path) -> SourceResult:
    log = logging.getLogger("etl.blm_claims")
    log.info("starting BLM Mining Claims download")

    url = _resolve_url()
    out_path = work_dir / "blm_claims.geojson"

    offset = 0
    feature_count = 0
    started = time.monotonic()

    with out_path.open("w", encoding="utf-8") as f:
        f.write('{"type":"FeatureCollection","features":[')
        first = True

        pbar = tqdm(desc="claims", unit="feat", smoothing=0.1)
        while True:
            body = _fetch_chunk(url, offset)
            chunk = body.get("features", [])
            if not chunk:
                break
            for feat in chunk:
                geometry = feat.get("geometry")
                props_raw = feat.get("properties") or feat.get("attributes") or {}
                if not geometry:
                    continue
                feature_count += 1
                if not first:
                    f.write(",")
                first = False
                json.dump(
                    {
                        "type": "Feature",
                        "geometry": geometry,
                        "properties": _normalize_props(props_raw),
                    },
                    f,
                )
            pbar.update(len(chunk))
            if not body.get("exceededTransferLimit") and len(chunk) < PAGE_SIZE:
                break
            offset += len(chunk)
        pbar.close()

        f.write("]}")

    elapsed = time.monotonic() - started
    log.info("wrote %d features in %.1fs → %s", feature_count, elapsed, out_path.name)

    return SourceResult(
        layer_id="mining_claims",
        geojson_path=out_path,
        feature_count=feature_count,
    )
