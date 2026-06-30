"""
Live commodity spot prices for the cost/revenue model.

The hotspot revenue heuristic uses hardcoded per-commodity base values.
Those are fine for relative ranking, but an enterprise tool shows *live*
metal prices so the dollar figures track the real market. This module
fetches current spot prices and returns a dict the manifest carries to
the client.

Design constraints:
  - No API key required at ETL time (keys would need CI secrets +
    rotation). We use providers with a keyless/free JSON endpoint and
    fall back to a static table if every provider is unreachable, so the
    ETL never fails just because a price feed is down.
  - Prices are advisory. The UI labels them "spot price as of <date>".

Providers tried in order (all return JSON):
  1. metals.dev  free tier (gold/silver/platinum/palladium/copper)
  2. EIA API v2  energy benchmarks (WTI crude + Henry Hub gas) — needs
     EIA_API_KEY (already a CI secret); skipped cleanly if absent.
  3. static fallback (last-known reasonable values) for anything a live
     feed didn't cover.

The energy benchmarks (WTI $/bbl, Henry Hub $/MMBtu) are the two daily
signals every oil & gas operator watches — surfacing them next to the
metals turns the price strip into a real cross-commodity deck instead
of a mining-only ticker.

Sources:
  https://metals.dev/   https://www.goldapi.io/   https://api.eia.gov/
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any

import requests

USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0 "
    "(Subterra-ETL +https://github.com/salamndrgaming-lab/subterra)"
)

# Static fallback — order-of-magnitude correct spot prices (USD) so the
# model still produces sane figures when every live feed is unreachable.
# Per troy-ounce for precious; per-tonne for base/battery metals.
STATIC_FALLBACK: dict[str, dict[str, Any]] = {
    "AU": {"usd": 2350.0, "unit": "oz"},      # gold
    "AG": {"usd": 28.0, "unit": "oz"},        # silver
    "PT": {"usd": 950.0, "unit": "oz"},       # platinum
    "PD": {"usd": 1000.0, "unit": "oz"},      # palladium
    "CU": {"usd": 9200.0, "unit": "tonne"},   # copper
    "ZN": {"usd": 2800.0, "unit": "tonne"},   # zinc
    "PB": {"usd": 2100.0, "unit": "tonne"},   # lead
    "NI": {"usd": 17000.0, "unit": "tonne"},  # nickel
    "LI": {"usd": 14000.0, "unit": "tonne"},  # lithium carbonate
    "MO": {"usd": 40000.0, "unit": "tonne"},  # molybdenum
    "U": {"usd": 185000.0, "unit": "tonne"},  # uranium (~$85/lb U3O8)
    # Energy benchmarks — the O&G price deck. WTI per barrel, Henry Hub
    # per million BTU. Static values are order-of-magnitude anchors used
    # only when the live EIA feed is unreachable; the UI labels them
    # "est" in that case.
    "WTI": {"usd": 70.0, "unit": "bbl"},      # WTI crude (Cushing spot)
    "HH": {"usd": 3.0, "unit": "mmbtu"},      # Henry Hub natural gas spot
}

# EIA API v2 series for the energy benchmarks. (route, series_id, unit).
# WTI Cushing spot daily = RWTC in the petroleum spot-price dataset;
# Henry Hub spot daily = RNGWHHD in the natural-gas pricing dataset.
# If a route 404s, the per-benchmark try/except below logs it and the
# static fallback fills in — iterate the route via the ETL log without
# failing the run.
_EIA_BENCHMARKS: dict[str, tuple[str, str, str]] = {
    "WTI": ("petroleum/pri/spt", "RWTC", "bbl"),
    "HH": ("natural-gas/pri/fut", "RNGWHHD", "mmbtu"),
}


def _try_metals_dev(log: logging.Logger) -> dict[str, dict[str, Any]] | None:
    """metals.dev latest endpoint. Works keyless on the free 'demo' key
    for a limited symbol set; if an API key is present in env we use it."""
    api_key = os.environ.get("METALS_DEV_API_KEY", "")
    url = "https://api.metals.dev/v1/latest"
    params = {"currency": "USD", "unit": "toz"}
    if api_key:
        params["api_key"] = api_key
    try:
        resp = requests.get(
            url, params=params,
            headers={"User-Agent": USER_AGENT, "accept": "application/json"},
            timeout=20.0,
        )
        if resp.status_code != 200:
            log.info("  metals.dev HTTP %d — skip", resp.status_code)
            return None
        body = resp.json()
        metals = body.get("metals") or {}
        if not metals:
            return None
        out: dict[str, dict[str, Any]] = {}
        symbol_map = {
            "gold": ("AU", "oz"), "silver": ("AG", "oz"),
            "platinum": ("PT", "oz"), "palladium": ("PD", "oz"),
            "copper": ("CU", "tonne"), "zinc": ("ZN", "tonne"),
            "lead": ("PB", "tonne"), "nickel": ("NI", "tonne"),
            "lithium": ("LI", "tonne"), "aluminum": ("AL", "tonne"),
        }
        for name, (sym, unit) in symbol_map.items():
            v = metals.get(name)
            if isinstance(v, (int, float)) and v > 0:
                out[sym] = {"usd": float(v), "unit": unit}
        return out or None
    except Exception as err:  # noqa: BLE001
        log.info("  metals.dev error %s — skip", err)
        return None


def _try_eia(log: logging.Logger) -> dict[str, dict[str, Any]] | None:
    """Fetch WTI crude + Henry Hub gas spot from the EIA API v2. Needs
    EIA_API_KEY (already a CI secret). Each benchmark is fetched
    independently so one bad route doesn't drop the other; returns
    whatever it got (or None if the key is absent / everything failed)."""
    api_key = os.environ.get("EIA_API_KEY", "").strip()
    if not api_key:
        log.info("  no EIA_API_KEY — skip energy benchmarks")
        return None

    out: dict[str, dict[str, Any]] = {}
    for sym, (route, series, unit) in _EIA_BENCHMARKS.items():
        try:
            resp = requests.get(
                f"https://api.eia.gov/v2/{route}/data/",
                params={
                    "api_key": api_key,
                    "frequency": "daily",
                    "data[0]": "value",
                    "facets[series][]": series,
                    "sort[0][column]": "period",
                    "sort[0][direction]": "desc",
                    "length": "1",
                },
                headers={"User-Agent": USER_AGENT, "accept": "application/json"},
                timeout=20.0,
            )
            if resp.status_code != 200:
                log.info("  EIA %s HTTP %d — skip", sym, resp.status_code)
                continue
            rows = (resp.json().get("response") or {}).get("data") or []
            if rows and rows[0].get("value") is not None:
                out[sym] = {"usd": float(rows[0]["value"]), "unit": unit}
                log.info("  EIA %s = %.2f/%s (%s)", sym, out[sym]["usd"], unit, rows[0].get("period"))
            else:
                log.info("  EIA %s returned no rows — skip", sym)
        except Exception as err:  # noqa: BLE001
            log.info("  EIA %s error %s — skip", sym, err)
    return out or None


def fetch_prices() -> dict[str, Any]:
    """Return {symbol: {usd, unit}} plus metadata. Never raises — falls
    back to the static table so the ETL is resilient to feed outages.

    Two independent live feeds: metals.dev for the mining metals, EIA for
    the energy benchmarks. Either, both, or neither may succeed; whatever
    a live feed returns overrides the static anchor for that symbol, and
    `live` is True if *any* live feed came through."""
    log = logging.getLogger("etl.commodity_prices")
    log.info("fetching live commodity spot prices")

    merged = dict(STATIC_FALLBACK)
    live_sources: list[str] = []

    metals = _try_metals_dev(log)
    if metals:
        merged.update(metals)
        live_sources.append("metals.dev")

    energy = _try_eia(log)
    if energy:
        merged.update(energy)
        live_sources.append("EIA")

    if live_sources:
        log.info(
            "got live prices from %s (%d symbols total with fallback)",
            "+".join(live_sources), len(merged),
        )
        return {
            "source": "+".join(live_sources),
            "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "live": True,
            "prices": merged,
        }

    log.warning("no live price feed reachable — using static fallback table")
    return {
        "source": "static_fallback",
        "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "live": False,
        "prices": dict(STATIC_FALLBACK),
    }
