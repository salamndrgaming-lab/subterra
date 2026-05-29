"""
BLM Surface Management Agency — per-state datasets.

The national SMA dataset on BLM-EGIS Hub returns 500 consistently
(file too large for their on-demand generator). The same hub publishes
per-state SMA datasets which are smaller and pre-cached, so they
actually respond. Combining the 11 PLSS-state datasets gives the same
coverage as the national file for prospecting purposes.

For each state we try the slug-based legacy Hub Download URL — same
shape that the official BLM dataset cards link to. Per-state try/except
so a single missing state doesn't drop the whole layer.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import ijson
import requests
from tqdm import tqdm

USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0 "
    "(Subterra-ETL +https://github.com/salamndrgaming-lab/subterra)"
)
REQUEST_TIMEOUT = 600.0

# Per-state slug variants — BLM doesn't use a consistent naming scheme so
# we try each candidate slug for a state in order until one returns a
# real GeoJSON.
STATE_SLUGS: dict[str, list[str]] = {
    "AZ": ["blm-az-surface-management-agency-polygon"],
    "CA": [
        "blm-ca-land-status-surface-management-agency",
        "blm-ca-surface-management-agency-polygon",
    ],
    "CO": [
        "blm-co-land-status-surface-management-agency-polygon",
        "blm-co-surface-management-agency-polygon",
    ],
    "ID": ["blm-id-surface-management-agency-polygon"],
    "MT": [
        "blm-mt-sma-surface-ownership-polygon",
        "blm-mt-surface-management-agency-polygon",
    ],
    "NM": [
        "blm-nm-lands-surface-management-agency",
        "blm-nm-surface-management-agency-polygon",
    ],
    "NV": [
        "blm-nv-surface-management-agency-polygon",
        "blm-nevada-surface-management-agency",
    ],
    "OR": ["blm-or-surface-management-agency-polygon"],
    "UT": ["blm-ut-surface-management-agency-polygon"],
    "WA": ["blm-wa-surface-management-agency-polygon"],
    "WY": ["blm-wy-surface-management-agency"],
}

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
    "FWS": "FWS",
    "FISH AND WILDLIFE SERVICE": "FWS",
    "DOD": "DOD",
    "DEPARTMENT OF DEFENSE": "DOD",
    "BOR": "BOR",
    "BUREAU OF RECLAMATION": "BOR",
    "DOE": "DOE",
    "PRIVATE": "PRIVATE",
    "STATE": "STATE",
    "OTHER": "OTHER",
}


@dataclass
class SourceResult:
    layer_id: str
    geojson_path: Path
    feature_count: int


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
        "OWNERSHIP", "ownership",
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


def _try_download(slug: str, log: logging.Logger) -> requests.Response | None:
    """Hit the slug-based Hub download URL. Return streaming Response on
    success, None on any failure (caller tries the next slug variant)."""
    url = f"https://gbp-blm-egis.hub.arcgis.com/datasets/BLM-EGIS::{slug}.geojson?outSR=4326"
    try:
        resp = requests.get(
            url,
            headers={
                "User-Agent": USER_AGENT,
                "accept": "application/geo+json, application/json, */*",
            },
            stream=True,
            timeout=REQUEST_TIMEOUT,
            allow_redirects=True,
        )
        if resp.status_code != 200:
            log.info("    HTTP %d — skip", resp.status_code)
            resp.close()
            return None
        ct = resp.headers.get("content-type", "").lower()
        # Direct GeoJSON or JSON streaming — anything else (HTML error page
        # etc.) we treat as failure.
        if "json" not in ct and "geo+json" not in ct:
            log.info("    unexpected content-type %r — skip", ct)
            resp.close()
            return None
        return resp
    except Exception as err:  # noqa: BLE001
        log.info("    request error %s — skip", err)
        return None


def run(work_dir: Path) -> SourceResult:
    log = logging.getLogger("etl.federal_lands")
    log.info("starting per-state BLM SMA download (%d states)", len(STATE_SLUGS))

    out_path = work_dir / "federal_lands.geojson"
    total_count = 0
    per_state: dict[str, int] = {}
    per_agency: dict[str, int] = {}
    started = time.monotonic()
    first = [True]

    try:
        with out_path.open("w", encoding="utf-8") as out:
            out.write('{"type":"FeatureCollection","features":[')

            for state_code, slugs in STATE_SLUGS.items():
                log.info("%s: trying %d slug variants…", state_code, len(slugs))
                state_count = 0
                resp: requests.Response | None = None
                for slug in slugs:
                    log.info("  %s", slug)
                    resp = _try_download(slug, log)
                    if resp is not None:
                        break
                if resp is None:
                    log.warning("  %s: no slug variant succeeded", state_code)
                    continue

                pbar = tqdm(desc=f"federal_lands-{state_code}", unit="feat", smoothing=0.1)
                try:
                    with resp:
                        resp.raw.decode_content = True
                        for feat in ijson.items(resp.raw, "features.item", use_float=True):
                            geom = feat.get("geometry")
                            if not geom:
                                continue
                            raw_props = feat.get("properties") or {}
                            agency = _agency_from(raw_props) or "OTHER"
                            props = {
                                "agency": agency,
                                "name": _name_from(raw_props),
                                "state": state_code,
                            }
                            props = {k: v for k, v in props.items() if v is not None}
                            if not first[0]:
                                out.write(",")
                            first[0] = False
                            json.dump(
                                {"type": "Feature", "geometry": geom, "properties": props},
                                out,
                            )
                            state_count += 1
                            per_agency[agency] = per_agency.get(agency, 0) + 1
                            pbar.update(1)
                except Exception as err:  # noqa: BLE001
                    log.warning("  %s stream parse failed after %d feat: %s", state_code, state_count, err)
                finally:
                    pbar.close()

                if state_count > 0:
                    per_state[state_code] = state_count
                    total_count += state_count
                    log.info("  %s: %d polygons", state_code, state_count)

            out.write("]}")
    except Exception:
        if out_path.exists():
            out_path.unlink()
        raise

    elapsed = time.monotonic() - started
    log.info(
        "wrote %d federal polygons across %d states in %.1fs",
        total_count, len(per_state), elapsed,
    )
    log.info("per state: %s", per_state)
    log.info("per agency: %s", per_agency)
    return SourceResult(
        layer_id="federal_lands",
        geojson_path=out_path,
        feature_count=total_count,
    )
