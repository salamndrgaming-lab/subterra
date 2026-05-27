"""
EIA U.S. Crude Oil Pipelines.

Sibling of sources/pipelines_natgas.py — same EIA Atlas Hub Downloads
API, different item id. Crude oil trunk lines (no gathering / lateral
detail).

Source: https://atlas.eia.gov/datasets/ae809a7e79354d31ab37da8df6352f84
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

ITEM_ID = "ae809a7e79354d31ab37da8df6352f84"
PRIMARY_URL = (
    f"https://atlas.eia.gov/api/download/v1/items/{ITEM_ID}/geojson?layers=0"
)
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0 "
    "(Subterra-ETL +https://github.com/salamndrgaming-lab/subterra)"
)
REQUEST_TIMEOUT = 120.0
POLL_INTERVAL = 5.0
POLL_TIMEOUT = 90.0  # If the hub hasn't published in 90s, give up and move on.


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
    log = logging.getLogger("etl.pipelines_crude")
    log.info("starting EIA crude oil pipelines download")

    url = os.environ.get("PIPELINES_CRUDE_URL", PRIMARY_URL)
    resp = _resolve(url, log)

    out_path = work_dir / "pipelines_crude.geojson"
    feature_count = 0
    skipped = 0
    started = time.monotonic()

    raw_path = work_dir / "pipelines_crude.raw.json"
    try:
        with raw_path.open("wb") as rawf, resp:
            resp.raw.decode_content = True
            for chunk in iter(lambda: resp.raw.read(1 << 16), b""):
                rawf.write(chunk)
        log.info("downloaded %d bytes → %s", raw_path.stat().st_size, raw_path.name)

        with out_path.open("w", encoding="utf-8") as out, raw_path.open("rb") as src:
            out.write('{"type":"FeatureCollection","features":[')
            first = True
            pbar = tqdm(desc="crude pipelines", unit="feat", smoothing=0.1)
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
    log.info("wrote %d crude pipelines in %.1fs → %s", feature_count, elapsed, out_path.name)
    return SourceResult(
        layer_id="pipelines_crude",
        geojson_path=out_path,
        feature_count=feature_count,
    )
