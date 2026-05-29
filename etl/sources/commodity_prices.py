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
  2. static fallback (last-known reasonable values)

Sources:
  https://metals.dev/   https://www.goldapi.io/
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


def fetch_prices() -> dict[str, Any]:
    """Return {symbol: {usd, unit}} plus metadata. Never raises — falls
    back to the static table so the ETL is resilient to feed outages."""
    log = logging.getLogger("etl.commodity_prices")
    log.info("fetching live commodity spot prices")

    live = _try_metals_dev(log)
    if live:
        # Merge over the static table so symbols the live feed lacks
        # (e.g. uranium, molybdenum) still get a sane value.
        merged = dict(STATIC_FALLBACK)
        merged.update(live)
        log.info("got %d live prices (%d total with fallback)", len(live), len(merged))
        return {
            "source": "metals.dev",
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
