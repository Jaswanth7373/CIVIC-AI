"""Small shared helpers."""
import ipaddress
import math
import re

#: Largest primary key the database can hold (signed 64-bit BigAutoField; also SQLite's INTEGER limit).
MAX_DB_ID = 2**63 - 1
#: URL pattern of a primary key (router ``lookup_value_regex`` / the ``<id:...>`` path converter): 1-18 ASCII
#: digits. Longer numbers cannot be ids; matching them would hand an out-of-range integer to the database
#: driver (OverflowError on SQLite, HTTP 500) instead of answering 404.
ID_PATTERN = r"[0-9]{1,18}"
_ASCII_DIGITS = re.compile(r"[0-9]+")


def parse_id(value):
    """The primary key a client typed (``"12"`` / ``12``), or None when ``value`` cannot be one.

    Only plain ASCII digits count. ``str.isdigit()`` is not enough: it also accepts characters such as
    ``"²"`` that ``int()`` cannot parse (an unhandled ValueError, HTTP 500), and a number beyond the 64-bit
    range makes SQLite raise OverflowError. Neither can match a row, so callers treat None as "not an id"
    (an id-or-slug lookup then tries the slug and finds nothing).
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        number = value
    else:
        text = str(value if value is not None else "").strip()
        if not _ASCII_DIGITS.fullmatch(text):
            return None
        number = int(text)
    return number if 0 < number <= MAX_DB_ID else None


def trusted_proxy_count():
    """Number of reverse proxies in front of the app (``REST_FRAMEWORK["NUM_PROXIES"]``, 0 when unset)."""
    from rest_framework.settings import api_settings

    try:
        return max(0, int(api_settings.NUM_PROXIES or 0))
    except (TypeError, ValueError):
        return 0


def get_client_ip(request):
    """The client's IP address as a normalised string, or None when it is not a valid address.

    The address is derived exactly like DRF's throttle identity (``SimpleRateThrottle.get_ident``) so the audit
    log and the rate limits agree on who a client is:

    * no trusted proxy (``NUM_PROXIES=0``, the default): ``REMOTE_ADDR``. ``X-Forwarded-For`` is ignored, because
      the client can put anything in it;
    * N trusted proxies: the N-th entry from the end of ``X-Forwarded-For`` - the address the outermost trusted
      proxy saw and appended. Entries further left were supplied by the client and are never used.

    The result is validated with :mod:`ipaddress` (an ``AuditLog.ip_address`` must be a real IP), so a forged
    value such as ``"not-an-ip <b>x</b>"`` is stored as NULL instead.
    """
    if request is None:
        return None
    meta = getattr(request, "META", None) or {}
    candidate = meta.get("REMOTE_ADDR")
    proxies = trusted_proxy_count()
    if proxies:
        forwarded = [part.strip() for part in (meta.get("HTTP_X_FORWARDED_FOR") or "").split(",")]
        forwarded = [part for part in forwarded if part]
        if forwarded:
            candidate = forwarded[-min(proxies, len(forwarded))]
    return normalize_ip(candidate)


def normalize_ip(value):
    """``"203.0.113.9"`` / ``"[2001:db8::1]:443"`` / ``"203.0.113.9:5120"`` -> canonical IP string, else None."""
    text = str(value or "").strip()
    if text.startswith("[") and "]" in text:  # bracketed IPv6, optionally with a port
        text = text[1:text.index("]")]
    elif text.count(":") == 1:  # IPv4 with a port
        text = text.split(":", 1)[0]
    text = text.split("%", 1)[0]  # drop an IPv6 zone id ("fe80::1%eth0")
    try:
        return str(ipaddress.ip_address(text))
    except ValueError:
        return None


def haversine_m(lat1, lng1, lat2, lng2):
    """Great-circle distance in metres between two WGS84 points."""
    r = 6371000.0
    p1, p2 = math.radians(float(lat1)), math.radians(float(lat2))
    dp = p2 - p1
    dl = math.radians(float(lng2) - float(lng1))
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def bounding_box(lat, lng, radius_m):
    """Approximate lat/lng bounding box (min_lat, max_lat, min_lng, max_lng) around a point.

    Use it to pre-filter DB queries before an exact haversine check.
    """
    lat = float(lat)
    lng = float(lng)
    dlat = radius_m / 111320.0
    dlng = radius_m / (111320.0 * max(0.01, math.cos(math.radians(lat))))
    return lat - dlat, lat + dlat, lng - dlng, lng + dlng


def absolute_media_url(request, file_field):
    """Absolute URL for an ImageField/FileField value (or None)."""
    if not file_field:
        return None
    try:
        url = file_field.url
    except ValueError:
        return None
    if request is not None:
        return request.build_absolute_uri(url)
    return url
