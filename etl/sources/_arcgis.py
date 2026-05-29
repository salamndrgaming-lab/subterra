"""
Shared helpers for paginated ArcGIS REST queries.

The BLM CadNSDI PLSS service, the AGOL Surface Management Agency
FeatureServer, and the NASA NCCS HIFLD-mirror wells MapServer all
support the same pagination pattern (resultOffset / resultRecordCount
with orderByFields for stable ordering). We discover the total feature
count first, then dispatch page fetches to a worker pool — typical
speedup vs. sequential fetching is 5–8×.

Workers are kept modest (default 6) to stay well under any per-IP
rate-limit thresholds. A retry loop with exponential backoff handles
the occasional transient 5xx.
"""

from __future__ import annotations

import logging
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Callable, Iterator

import requests

DEFAULT_PAGE_SIZE = 2000
DEFAULT_WORKERS = 6
DEFAULT_TIMEOUT = 180.0
DEFAULT_RETRIES = 3
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0 "
    "(Subterra-ETL +https://github.com/salamndrgaming-lab/subterra)"
)


def fetch_count(query_url: str, *, timeout: float = 30.0) -> int | None:
    """Return total feature count, or None if the service doesn't report it.
    Using returnCountOnly avoids downloading any geometry just to size up
    the work."""
    try:
        resp = requests.get(
            query_url,
            params={"where": "1=1", "returnCountOnly": "true", "f": "json"},
            headers={"User-Agent": USER_AGENT},
            timeout=timeout,
        )
        resp.raise_for_status()
        body = resp.json()
        if isinstance(body, dict) and "count" in body:
            return int(body["count"])
    except Exception:  # noqa: BLE001
        return None
    return None


def _fetch_one_page(
    query_url: str,
    offset: int,
    *,
    page_size: int,
    extra_params: dict[str, str] | None = None,
    timeout: float,
) -> dict[str, Any]:
    params: dict[str, str] = {
        "where": "1=1",
        "outFields": "*",
        "returnGeometry": "true",
        "outSR": "4326",
        "f": "geojson",
        "resultRecordCount": str(page_size),
        "resultOffset": str(offset),
        "orderByFields": "OBJECTID ASC",
    }
    if extra_params:
        params.update(extra_params)
    resp = requests.get(
        query_url,
        params=params,
        headers={"User-Agent": USER_AGENT, "accept": "application/geo+json, application/json"},
        timeout=timeout,
    )
    resp.raise_for_status()
    body = resp.json()
    if isinstance(body, dict) and body.get("error"):
        raise RuntimeError(f"ArcGIS error from {query_url} (offset={offset}): {body['error']}")
    return body


def _fetch_with_retry(
    query_url: str,
    offset: int,
    *,
    page_size: int,
    extra_params: dict[str, str] | None,
    timeout: float,
    retries: int,
) -> dict[str, Any]:
    last_err: Exception | None = None
    for attempt in range(retries + 1):
        try:
            return _fetch_one_page(
                query_url, offset,
                page_size=page_size, extra_params=extra_params, timeout=timeout,
            )
        except Exception as err:  # noqa: BLE001
            last_err = err
            if attempt >= retries:
                break
            time.sleep(2 ** attempt)
    raise last_err if last_err else RuntimeError("retry budget exhausted")


def iter_features_concurrent(
    query_url: str,
    *,
    on_feature: Callable[[dict[str, Any]], None],
    page_size: int = DEFAULT_PAGE_SIZE,
    workers: int = DEFAULT_WORKERS,
    timeout: float = DEFAULT_TIMEOUT,
    retries: int = DEFAULT_RETRIES,
    extra_params: dict[str, str] | None = None,
    progress_label: str = "features",
) -> int:
    """Fetch the entire feature set from a paginated ArcGIS query
    endpoint concurrently. For each feature retrieved, calls on_feature.
    Order is NOT preserved — tippecanoe doesn't care about input order
    anyway. Returns the total number of features processed.

    Falls back to sequential pagination if the count endpoint isn't
    available (some services don't support returnCountOnly).
    """
    from tqdm import tqdm  # local import keeps this module dep-light

    log = logging.getLogger(f"etl.{progress_label}")
    total = fetch_count(query_url)
    if total is None:
        log.info("count endpoint unavailable, falling back to sequential pagination")
        return _iter_sequential(
            query_url, on_feature=on_feature,
            page_size=page_size, timeout=timeout, retries=retries,
            extra_params=extra_params, progress_label=progress_label,
        )

    log.info("total features: %d (page_size=%d, workers=%d)", total, page_size, workers)
    if total == 0:
        return 0

    # Wall-clock cap per source so a single hung future can't block the
    # entire ETL run. 15 min is well above the expected 2-5 min for
    # every paginated source at typical worker counts.
    WALL_CLOCK_CAP = 900.0
    HEARTBEAT_INTERVAL = 30.0

    offsets = list(range(0, total, page_size))
    feature_count = 0
    pbar = tqdm(total=total, desc=progress_label, unit="feat", smoothing=0.1)
    started = time.monotonic()
    last_heartbeat = started
    try:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futs = [
                pool.submit(
                    _fetch_with_retry, query_url, off,
                    page_size=page_size, extra_params=extra_params,
                    timeout=timeout, retries=retries,
                )
                for off in offsets
            ]
            for fut in as_completed(futs):
                now = time.monotonic()
                if now - started > WALL_CLOCK_CAP:
                    log.warning(
                        "%s: hit %.0fs wall-clock cap at %d/%d features — "
                        "cancelling remaining pages and continuing with what we have",
                        progress_label, WALL_CLOCK_CAP, feature_count, total,
                    )
                    for f in futs:
                        f.cancel()
                    break
                if now - last_heartbeat > HEARTBEAT_INTERVAL:
                    log.info(
                        "%s heartbeat: %d/%d features (%.0fs elapsed)",
                        progress_label, feature_count, total, now - started,
                    )
                    last_heartbeat = now
                try:
                    body = fut.result()
                except Exception as err:  # noqa: BLE001
                    log.warning("%s: page failed after retries — %s", progress_label, err)
                    continue
                features = body.get("features", []) or []
                if not features and feature_count == 0 and total > 0:
                    # First few pages came back empty despite count metadata
                    # claiming features exist — log raw body so the broken
                    # service is debuggable from the workflow log alone.
                    sample = str(body)[:600]
                    log.warning(
                        "%s: page returned 0 features (count=%d). body[:600]=%s",
                        progress_label, total, sample,
                    )
                for feat in features:
                    on_feature(feat)
                    feature_count += 1
                pbar.update(len(features))
    finally:
        pbar.close()
    return feature_count


def _iter_sequential(
    query_url: str,
    *,
    on_feature: Callable[[dict[str, Any]], None],
    page_size: int,
    timeout: float,
    retries: int,
    extra_params: dict[str, str] | None,
    progress_label: str,
) -> int:
    from tqdm import tqdm

    log = logging.getLogger(f"etl.{progress_label}")
    pbar = tqdm(desc=progress_label, unit="feat", smoothing=0.1)
    feature_count = 0
    offset = 0
    no_progress = 0
    try:
        while True:
            body = _fetch_with_retry(
                query_url, offset,
                page_size=page_size, extra_params=extra_params,
                timeout=timeout, retries=retries,
            )
            features = body.get("features", []) or []
            if not features:
                break
            for feat in features:
                on_feature(feat)
                feature_count += 1
            pbar.update(len(features))
            exceeded = body.get("exceededTransferLimit", False)
            if not exceeded and len(features) < page_size:
                break
            offset += len(features)
            if len(features) == 0:
                no_progress += 1
                if no_progress >= 3:
                    log.warning("no progress for 3 pages, stopping")
                    break
            else:
                no_progress = 0
    finally:
        pbar.close()
    return feature_count
