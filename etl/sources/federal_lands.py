"""
BLM National Surface Management Agency (SMA) — federal land ownership.

Paginated MapServer query against BLM's own pre-simplified national
SMA service. The layer that contains the combined SMA polygons varies
by service revision, so on startup we probe MapServer?f=json and pick
whichever layer name looks like the combined SMA dataset (falls back
to layer 0 if nothing matches).

Service: https://gis.blm.gov/arcgis/rest/services/lands/BLM_Natl_SMA_LimitedScale/MapServer
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

from sources._arcgis import iter_features_concurrent

SERVICE = "https://gis.blm.gov/arcgis/rest/services/lands/BLM_Natl_SMA_LimitedScale/MapServer"
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0 "
    "(Subterra-ETL +https://github.com/salamndrgaming-lab/subterra)"
)


def _discover_layer_id(base: str, log: logging.Logger) -> int:
    """Pick the combined SMA layer dynamically by inspecting the service
    metadata. Layer naming has varied across BLM revisions (sometimes
    layer 18 is combined, sometimes layer 0). Falls back to 0 if no
    obvious match is found."""
    try:
        r = requests.get(
            base, params={"f": "json"},
            headers={"User-Agent": USER_AGENT}, timeout=30,
        )
        r.raise_for_status()
        layers = r.json().get("layers") or []
        log.info("service has %d layers — probing for combined SMA", len(layers))
        # Score each layer: prefer ones named like the combined SMA dataset.
        scored: list[tuple[int, int]] = []
        for layer in layers:
            name = str(layer.get("name", "")).lower()
            score = 0
            if "surface management" in name and "agency" in name:
                score += 10
            if "all" in name or "combined" in name or "national" in name:
                score += 5
            if "agency" in name and "_state" not in name:
                score += 2
            if score > 0:
                scored.append((score, int(layer["id"])))
                log.info("  candidate: id=%s name=%r (score=%d)", layer["id"], name, score)
        if scored:
            scored.sort(reverse=True)
            chosen = scored[0][1]
            log.info("selected layer id %d", chosen)
            return chosen
    except Exception as err:  # noqa: BLE001
        log.warning("could not probe service: %s — falling back to layer 0", err)
    return 0

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
KEEP = set(AGENCY_NORMALIZATION.values())


@dataclass
class SourceResult:
    layer_id: str
    geojson_path: Path
    feature_count: int


_AGENCY_FIELD_CANDIDATES = (
    # BLM gis.blm.gov SMA schema
    "ADMIN_AGENCY_CODE", "admin_agency_code",
    "ADMIN_AGY_DESC", "admin_agy_desc",
    "AGY_NAME", "agy_name",
    # AGOL hosted variants
    "ADM_MANAGE", "adm_manage",
    "AGBUR", "agbur",
    "AGENCY", "agency",
    "MANAGER", "manager",
    "MGMT_AGENCY", "mgmt_agency",
    "OWNER_NAME", "owner_name",
    "AGENCY_CODE", "agency_code",
    "AGENCY_TYP", "agency_typ",
    "OWN_AGCY", "own_agcy",
)


def _agency_from(props: dict[str, Any]) -> str | None:
    for key in _AGENCY_FIELD_CANDIDATES:
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


def _raw_agency_value(props: dict[str, Any]) -> str | None:
    """Diagnostic: return the first non-empty value from any candidate
    agency field, without normalization. Used to discover what field
    names + values the actual service is returning so we can refine the
    AGENCY_NORMALIZATION table later."""
    for key in _AGENCY_FIELD_CANDIDATES:
        v = props.get(key)
        if v not in (None, "", " "):
            return str(v).strip()
    return None


def run(work_dir: Path) -> SourceResult:
    log = logging.getLogger("etl.federal_lands")
    log.info("starting BLM National SMA paginated download")

    base = os.environ.get("FEDERAL_LANDS_SERVICE_URL", SERVICE)
    # Allow overriding layer id via env (escape hatch), otherwise discover.
    env_layer = os.environ.get("FEDERAL_LANDS_LAYER_ID")
    layer_id = int(env_layer) if env_layer else _discover_layer_id(base, log)
    query_url = f"{base}/{layer_id}/query"

    out_path = work_dir / "federal_lands.geojson"
    feature_count = 0
    skipped_no_geom = 0
    per_agency: dict[str, int] = {}
    seen_raw_agency: dict[str, int] = {}  # diagnostic: count raw values seen
    started = time.monotonic()

    try:
        with out_path.open("w", encoding="utf-8") as out:
            out.write('{"type":"FeatureCollection","features":[')
            first = [True]

            def emit(feat: dict[str, Any]) -> None:
                nonlocal skipped_no_geom
                geom = feat.get("geometry")
                if not geom:
                    skipped_no_geom += 1
                    return
                raw_props = feat.get("properties") or feat.get("attributes") or {}

                # Try to normalize agency, fall back to raw value verbatim,
                # final fallback "OTHER". Either way we emit the polygon —
                # filtering at ETL time before we know the schema was a
                # mistake; the web layer can color-by-agency with a default
                # for unknown values.
                agency = _agency_from(raw_props)
                if agency is None:
                    raw_val = _raw_agency_value(raw_props)
                    agency = raw_val or "OTHER"
                    if raw_val:
                        seen_raw_agency[raw_val] = seen_raw_agency.get(raw_val, 0) + 1
                props = {
                    "agency": agency,
                    "name": _name_from(raw_props),
                    "state": _state_from(raw_props),
                }
                props = {k: v for k, v in props.items() if v is not None}
                if not first[0]:
                    out.write(",")
                first[0] = False
                json.dump({"type": "Feature", "geometry": geom, "properties": props}, out)
                per_agency[agency] = per_agency.get(agency, 0) + 1

            iter_features_concurrent(
                query_url,
                on_feature=emit,
                progress_label="federal lands",
            )
            out.write("]}")
            feature_count = sum(per_agency.values())
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
        # Print up to top 20 raw values so we can refine the normalization
        # table in a follow-up commit.
        top = sorted(seen_raw_agency.items(), key=lambda kv: kv[1], reverse=True)[:20]
        log.info("top unrecognized agency values (raw): %s", dict(top))
    return SourceResult(
        layer_id="federal_lands",
        geojson_path=out_path,
        feature_count=feature_count,
    )
    return SourceResult(
        layer_id="federal_lands",
        geojson_path=out_path,
        feature_count=feature_count,
    )
