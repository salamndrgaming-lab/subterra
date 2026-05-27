"""
EIA U.S. Natural Gas Pipelines (interstate + intrastate trunk lines).

The legacy HIFLD pipeline datasets were deactivated August 2025; EIA
still publishes the same data on its Energy Atlas, which uses the same
ArcGIS Hub Downloads API pattern that the BLM-EGIS sources use.

Source: https://atlas.eia.gov/datasets/4a158d2113f145039f71b80d07e2c19c
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

ITEM_ID = "4a158d2113f145039f71b80d07e2c19c"
PRIMARY_URL = (
    f"https://atlas.eia.gov/api/download/v1/items/{ITEM_ID}/geojson?layers=0"
)
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0 "
    "(Subterra-ETL +https://github.com/salamndrgaming-lab/subterra)"
)
REQUEST_TIMEOUT = 300.0
POLL_INTERVAL = 5.0
POLL_TIMEOUT = 600.0


@dataclass
class SourceResult:
    layer_id: str
    geojson_path: Path
    feature_count: int


def _resolve(url: str, log: logging.Logger) -> requests.Response:
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
            raise RuntimeError(f"Unexpected EIA Atlas response: ct={ct} body[:200]={body[:200]!r}") from err
        next_url = status.get("url") or status.get("downloadUrl")
        if next_url and next_url != current:
            log.info("redirected to %s", next_url)
            current = next_url
            continue
        if time.monotonic() > deadline:
            raise RuntimeError(f"EIA Atlas timed out generating download for item {ITEM_ID}")
        log.info("job not ready, sleeping %.0fs (status=%s)", POLL_INTERVAL, status.get("status"))
        time.sleep(POLL_INTERVAL)


def _normalize_props(p: dict) -> dict:
    """Pipeline shape varies across EIA revisions; coalesce common fields."""
    def first(*keys: str) -> object:
        for k in keys:
            v = p.get(k) or p.get(k.upper()) or p.get(k.lower())
            if v not in (None, "", " "):
                return v
        return None

    out: dict = {}
    for label, candidates in [
        ("name", ["PipelineName", "PIPENAME", "Pipename", "PIPE_NAME"]),
        ("operator", ["Operator", "OPERATOR", "Owner", "OWNER_NAME"]),
        ("type", ["Type", "TYPE", "PipelineType"]),
        ("commodity", ["Commodity", "COMMODITY"]),
        ("status", ["Status", "STATUS"]),
        ("source", ["Source", "SOURCE"]),
        ("state", ["StateAbbr", "STATE", "state"]),
    ]:
        v = first(*candidates)
        if v is not None:
            out[label] = v
    return out


def run(work_dir: Path) -> SourceResult:
    log = logging.getLogger("etl.pipelines_natgas")
    log.info("starting EIA natural gas pipelines download")

    url = os.environ.get("PIPELINES_NATGAS_URL", PRIMARY_URL)
    resp = _resolve(url, log)

    out_path = work_dir / "pipelines_natgas.geojson"
    feature_count = 0
    skipped = 0
    started = time.monotonic()

    # Download to a temp file so we can both ijson-stream it AND retain
    # the raw bytes for diagnostics when the response shape is unexpected.
    raw_path = work_dir / "pipelines_natgas.raw.json"
    try:
        with raw_path.open("wb") as rawf, resp:
            resp.raw.decode_content = True
            for chunk in iter(lambda: resp.raw.read(1 << 16), b""):
                rawf.write(chunk)
        log.info("downloaded %d bytes → %s", raw_path.stat().st_size, raw_path.name)

        with out_path.open("w", encoding="utf-8") as out, raw_path.open("rb") as src:
            out.write('{"type":"FeatureCollection","features":[')
            first = True
            pbar = tqdm(desc="natgas pipelines", unit="feat", smoothing=0.1)
            for feat in ijson.items(src, "features.item", use_float=True):
                geom = feat.get("geometry")
                if not geom:
                    skipped += 1
                    continue
                props = _normalize_props(feat.get("properties") or {})
                if not first:
                    out.write(",")
                first = False
                json.dump({"type": "Feature", "geometry": geom, "properties": props}, out)
                feature_count += 1
                pbar.update(1)
            pbar.close()
            out.write("]}")

        if feature_count == 0:
            with raw_path.open("rb") as src:
                head = src.read(800)
            log.error(
                "ZERO features parsed from EIA response. First 800 bytes:\n%s",
                head.decode("utf-8", errors="replace"),
            )
    except Exception:
        if out_path.exists():
            out_path.unlink()
        raise

    elapsed = time.monotonic() - started
    log.info("wrote %d natgas pipelines in %.1fs → %s", feature_count, elapsed, out_path.name)
    return SourceResult(
        layer_id="pipelines_natgas",
        geojson_path=out_path,
        feature_count=feature_count,
    )
