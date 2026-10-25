"""OpenStreetMap Nominatim geocoding proxy: reverse geocoding (lat/lng -> address) and place search.

Why the browser does not call Nominatim directly
    Nominatim's usage policy asks for an identifying ``User-Agent`` (browsers cannot set it), at most about
    one request per second, and caching of results. Proxying through the backend lets us satisfy all three:

    * ``User-Agent`` from ``settings.CIVICAI["NOMINATIM_USER_AGENT"]``;
    * a per-process minimum interval between upstream calls (``NOMINATIM_MIN_INTERVAL_SECONDS``, default 1 s);
    * Django-cache entries valid for 24 h. Reverse lookups are keyed by coordinates rounded to 4 decimals
      (about 11 m, so repeated clicks on the same spot are free); searches by the normalised query text.

Resilience
    Calls time out after 5 s. When geocoding is disabled, Nominatim is unreachable/erroring, or a point has no
    address (sea, desert), the functions return a clearly labelled fallback - ``"source": "fallback"`` with
    the coordinates as the address - and never raise, so the complaint form keeps working and the citizen
    can type the address manually. After a failure a 60 s "circuit breaker" skips upstream calls, so an
    offline server does not make every map click wait for the timeout.

Address parsing (Nominatim ``address`` object -> CivicAI ``Location`` fields)
    area    <- suburb / neighbourhood / quarter / city_district / residential / road
    city    <- city / town / village / municipality / county / state_district
    pincode <- postcode
    address <- "house_number road, neighbourhood, suburb" (or the first parts of ``display_name``)
"""
import hashlib
import logging
import threading
import time

import requests
from django.conf import settings
from django.core.cache import cache

logger = logging.getLogger("apps.core")

CACHE_TTL_SECONDS = 24 * 60 * 60
REQUEST_TIMEOUT_SECONDS = 5
OUTAGE_BACKOFF_SECONDS = 60
DEFAULT_MIN_INTERVAL_SECONDS = 1.0
SEARCH_LIMIT_DEFAULT = 5
SEARCH_LIMIT_MAX = 10
SEARCH_MIN_LENGTH = 3
SEARCH_MAX_LENGTH = 200
# Results near the configured city are preferred (not enforced): +/- 0.5 degrees is roughly 55 km.
SEARCH_BIAS_DEGREES = 0.5

OUTAGE_CACHE_KEY = "civicai:geo:nominatim-unavailable"
AREA_KEYS = ("suburb", "neighbourhood", "quarter", "city_district", "residential", "hamlet", "road")
CITY_KEYS = ("city", "town", "village", "municipality", "county", "state_district")

SOURCE_NOMINATIM = "nominatim"
SOURCE_FALLBACK = "fallback"
SOURCE_SKIPPED = "skipped"

_rate_lock = threading.Lock()
_last_request_at = 0.0


def _config():
    conf = getattr(settings, "CIVICAI", {}) or {}
    return {
        "enabled": bool(conf.get("GEOCODING_ENABLED", True)),
        "base_url": str(conf.get("NOMINATIM_URL") or "https://nominatim.openstreetmap.org").rstrip("/"),
        "user_agent": conf.get("NOMINATIM_USER_AGENT") or "CivicAI/1.0",
        "min_interval": float(conf.get("NOMINATIM_MIN_INTERVAL_SECONDS", DEFAULT_MIN_INTERVAL_SECONDS)),
        "default_lat": float(conf.get("DEFAULT_LAT", 17.385)),
        "default_lng": float(conf.get("DEFAULT_LNG", 78.4867)),
    }


def _wait_for_rate_limit(min_interval):
    """Space upstream calls at least ``min_interval`` seconds apart (per process, thread-safe)."""
    global _last_request_at
    if min_interval <= 0:
        return
    with _rate_lock:
        wait = _last_request_at + min_interval - time.monotonic()
        if wait > 0:
            time.sleep(min(wait, min_interval))
        _last_request_at = time.monotonic()


def _nominatim_get(endpoint, params):
    """GET ``<NOMINATIM_URL>/<endpoint>`` and return the decoded JSON, or None on any failure."""
    conf = _config()
    if cache.get(OUTAGE_CACHE_KEY):
        return None
    _wait_for_rate_limit(conf["min_interval"])
    try:
        response = requests.get(
            f"{conf['base_url']}/{endpoint}",
            params={**params, "format": "jsonv2", "addressdetails": 1},
            headers={"User-Agent": conf["user_agent"], "Accept-Language": "en"},
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        return response.json()
    except (requests.RequestException, ValueError) as exc:
        status_code = getattr(getattr(exc, "response", None), "status_code", None)
        hint = ""
        if status_code in (403, 429):
            # Nominatim blocks placeholder / generic User-Agents and clients that exceed ~1 request/second.
            hint = " - check that NOMINATIM_USER_AGENT identifies this deployment with a real contact address"
        logger.warning("Nominatim %s request failed (%s)%s; using the fallback for %ss", endpoint, exc, hint,
                       OUTAGE_BACKOFF_SECONDS)
        cache.set(OUTAGE_CACHE_KEY, True, OUTAGE_BACKOFF_SECONDS)
        return None


def _first(parts, keys):
    for key in keys:
        value = str(parts.get(key) or "").strip()
        if value:
            return value
    return ""


def parse_nominatim_address(payload):
    """Map one Nominatim result to ``{"address", "area", "city", "pincode", "display_name"}``.

    Values are truncated to the ``Location`` column sizes so the frontend can submit them unchanged.
    """
    parts = payload.get("address") or {}
    display_name = str(payload.get("display_name") or "").strip()
    street = " ".join(filter(None, [str(parts.get("house_number") or "").strip(),
                                    str(parts.get("road") or "").strip()]))
    pieces = []
    for value in (street, parts.get("neighbourhood"), parts.get("suburb")):
        value = str(value or "").strip()
        if value and value not in pieces:
            pieces.append(value)
    address = ", ".join(pieces) or ", ".join(display_name.split(", ")[:3])
    return {
        "address": address[:255],
        "area": _first(parts, AREA_KEYS)[:120],
        "city": _first(parts, CITY_KEYS)[:100],
        "pincode": str(parts.get("postcode") or "").replace(" ", "")[:10],
        "display_name": display_name,
    }


def reverse_fallback(latitude, longitude, reason):
    """Result used when no real address is available: the coordinates themselves, clearly labelled."""
    text = f"{latitude:.6f}, {longitude:.6f}"
    return {
        "address": text,
        "area": "",
        "city": "",
        "pincode": "",
        "display_name": text,
        "source": SOURCE_FALLBACK,
        "fallback_reason": reason,
    }


def reverse_geocode(latitude, longitude):
    """Address for a WGS84 point.

    Returns ``{"address", "area", "city", "pincode", "display_name", "source": "nominatim"|"fallback"}``
    (fallbacks add ``fallback_reason``: ``disabled`` | ``unavailable`` | ``no_result``). Never raises.
    """
    lat, lng = round(float(latitude), 6), round(float(longitude), 6)
    try:
        if not _config()["enabled"]:
            return reverse_fallback(lat, lng, "disabled")
        cache_key = f"civicai:geo:reverse:{lat:.4f}:{lng:.4f}"
        cached = cache.get(cache_key)
        if cached is not None:
            return cached
        payload = _nominatim_get("reverse", {"lat": f"{lat:.6f}", "lon": f"{lng:.6f}", "zoom": 18})
        if payload is None:
            return reverse_fallback(lat, lng, "unavailable")
        if not isinstance(payload, dict) or payload.get("error") or not payload.get("display_name"):
            return reverse_fallback(lat, lng, "no_result")
        result = {**parse_nominatim_address(payload), "source": SOURCE_NOMINATIM}
        cache.set(cache_key, result, CACHE_TTL_SECONDS)
        return result
    except Exception:  # defensive: a geocoding problem must never break the caller
        logger.exception("Reverse geocoding failed for %s, %s", lat, lng)
        return reverse_fallback(lat, lng, "unavailable")


def normalize_query(query):
    """Lower-case, collapse whitespace, cap the length (also the cache-key basis)."""
    return " ".join(str(query or "").split()).lower()[:SEARCH_MAX_LENGTH]


def search_places(query, *, limit=SEARCH_LIMIT_DEFAULT):
    """Forward geocoding. Returns ``(results, source)``.

    ``results`` = ``[{"display_name", "latitude", "longitude", "address", "area", "city", "pincode"}]``;
    ``source`` = ``"nominatim"``, ``"fallback"`` (disabled / unavailable -> empty list) or ``"skipped"``
    (queries shorter than 3 characters are not sent upstream). Never raises.
    """
    text = normalize_query(query)
    limit = max(1, min(int(limit or SEARCH_LIMIT_DEFAULT), SEARCH_LIMIT_MAX))
    if len(text) < SEARCH_MIN_LENGTH:
        return [], SOURCE_SKIPPED
    try:
        conf = _config()
        if not conf["enabled"]:
            return [], SOURCE_FALLBACK
        digest = hashlib.sha1(f"{text}|{limit}".encode("utf-8")).hexdigest()
        cache_key = f"civicai:geo:search:{digest}"
        cached = cache.get(cache_key)
        if cached is not None:
            return cached, SOURCE_NOMINATIM
        lat, lng, bias = conf["default_lat"], conf["default_lng"], SEARCH_BIAS_DEGREES
        payload = _nominatim_get("search", {
            "q": text,
            "limit": limit,
            # viewbox = left,top,right,bottom; bounded=0 -> prefer local results without excluding others
            "viewbox": f"{lng - bias:.4f},{lat + bias:.4f},{lng + bias:.4f},{lat - bias:.4f}",
            "bounded": 0,
        })
        if payload is None or not isinstance(payload, list):
            return [], SOURCE_FALLBACK
        results = []
        for item in payload[:limit]:
            try:
                latitude, longitude = float(item["lat"]), float(item["lon"])
            except (KeyError, TypeError, ValueError):
                continue
            results.append({
                "display_name": str(item.get("display_name") or ""),
                "latitude": round(latitude, 6),
                "longitude": round(longitude, 6),
                **{key: value for key, value in parse_nominatim_address(item).items() if key != "display_name"},
            })
        cache.set(cache_key, results, CACHE_TTL_SECONDS)
        return results, SOURCE_NOMINATIM
    except Exception:  # defensive: never break the caller
        logger.exception("Place search failed for %r", text)
        return [], SOURCE_FALLBACK
