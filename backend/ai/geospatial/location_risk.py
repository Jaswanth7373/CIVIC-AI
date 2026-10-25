"""Location risk assessment (BUILD_SPEC section 2.7).

How dangerous is the *place* where the civic issue is? A pothole in a quiet lane matters less
than the same pothole at a school gate or on a highway. The 0..1 score combines three
independent sources of evidence:

1. **Mapped risk zones** (admin-defined schools, hospitals, junctions ... - ``RiskZone`` rows).
   A zone influences every point within ``radius_m + 100 m`` of its centre. Its contribution is
   ``risk_level / 5 x proximity`` where proximity is 1.0 at the centre, 0.7 at the zone edge and
   fades linearly to 0 across the extra 100 m buffer (so a point just outside a school zone
   still counts a little).
2. **Text cues** - high-traffic or sensitive words in the address or complaint text (main road,
   highway, junction, signal, flyover, bus stop, metro, market, school, hospital ...). Each cue has
   a weight. Words are weaker evidence than a mapped zone, so the text source is capped at 0.6, and a
   cue naming a place type that is already mapped nearby ("near the school" inside a mapped school
   zone) is not counted twice.
3. **Complaint density** - many complaints around the point indicate a busy or neglected area;
   it adds a small saturating bonus ``0.25 x (1 - exp(-n / 6))``.

Sources (and multiple zones / cues inside a source) are combined with a *probabilistic OR*,
``1 - prod(1 - s_i)``: each source can only raise the risk, two moderate sources count more than
either alone, and the result never exceeds 1. The level uses the shared 0-100 band mapping
(``score_to_level(score * 100)``), the same bands as severity and priority.
"""
import logging
import math
import re

from ..config import score_to_level
from .distance import format_distance, haversine_m, parse_coordinates

logger = logging.getLogger("ai.geospatial")

ZONE_BUFFER_M = 100.0  # zones also influence points up to 100 m beyond their radius
ZONE_EDGE_PROXIMITY = 0.7  # proximity value exactly at the zone boundary
DEFAULT_ZONE_RADIUS_M = 300.0
DEFAULT_ZONE_RISK_LEVEL = 3
KEYWORD_RISK_CAP = 0.6  # text cues alone can never make a location more than 0.6 risky
DENSITY_MAX_BONUS = 0.25
DENSITY_SATURATION = 6.0  # nearby complaints at which ~63 % of the density bonus is reached
HIGH_TRAFFIC_ZONE_TYPES = frozenset({"highway", "junction", "transit", "market"})

# (key, regex, phrase used in factors, weight, kind, matching RiskZone.zone_type). kind "traffic" marks
# high-traffic places, "sensitive" marks places with vulnerable people (children, patients). A cue
# is ignored when a mapped zone of its zone type already influences the point, so "near the school"
# plus a mapped school zone is not counted twice.
_CUE_DEFINITIONS = (
    ("highway", r"\bhighways?\b|\bnh[\s-]?\d+\b|\bexpressway\b", "a highway", 0.40, "traffic", "highway"),
    ("main_road", r"\bmain\s+(?:roads?|rd)\b", "a main road", 0.30, "traffic", "highway"),
    ("ring_road", r"\b(?:outer\s+|inner\s+)?ring\s+roads?\b", "a ring road", 0.35, "traffic", "highway"),
    ("junction", r"\bjunctions?\b|\bx\s*-?\s*roads?\b|\bcross\s*-?\s*roads?\b|\bchowrasta\b|\bcircle\b",
     "a junction", 0.30, "traffic", "junction"),
    ("signal", r"\b(?:traffic\s+)?signals?\b", "a traffic signal", 0.25, "traffic", "junction"),
    ("flyover", r"\bflyovers?\b|\boverbridge\b", "a flyover", 0.30, "traffic", "highway"),
    ("bus_stop", r"\bbus\s*(?:stops?|stands?|stations?|depot|bay)\b", "a bus stop", 0.25, "traffic", "transit"),
    ("metro", r"\bmetro\b", "a metro station", 0.25, "traffic", "transit"),
    ("railway", r"\brailway\b", "a railway station", 0.30, "traffic", "transit"),
    ("market", r"\bmarkets?\b|\bbazaa?rs?\b|\bmandi\b", "a market", 0.30, "traffic", "market"),
    ("school", r"\bschools?\b|\bcolleges?\b", "a school or college", 0.40, "sensitive", "school"),
    ("hospital", r"\bhospitals?\b|\bclinics?\b", "a hospital", 0.45, "sensitive", "hospital"),
)
LOCATION_CUES = tuple(
    {"key": key, "pattern": re.compile(rx, re.IGNORECASE), "phrase": phrase, "weight": weight, "kind": kind,
     "zone_type": zone_type}
    for key, rx, phrase, weight, kind, zone_type in _CUE_DEFINITIONS
)


def noisy_or(values):
    """Probabilistic OR of independent 0..1 risk sources: ``1 - prod(1 - v)``."""
    remaining = 1.0
    for value in values:
        remaining *= 1.0 - min(1.0, max(0.0, float(value)))
    return 1.0 - remaining


def zone_proximity(distance_m, radius_m):
    """Piecewise-linear proximity: 1.0 at the centre, 0.7 at the edge, 0 at edge + 100 m."""
    r = max(1.0, float(radius_m))
    d = max(0.0, float(distance_m))
    if d <= r:
        return 1.0 - (1.0 - ZONE_EDGE_PROXIMITY) * (d / r)
    if d <= r + ZONE_BUFFER_M:
        return ZONE_EDGE_PROXIMITY * (1.0 - (d - r) / ZONE_BUFFER_M)
    return 0.0


def _zone_hits(lat, lng, risk_zones):
    """Zones influencing the point, strongest first, each with its contribution."""
    hits = []
    for zone in risk_zones or []:
        try:
            z_lat, z_lng = parse_coordinates(zone.get("latitude"), zone.get("longitude"))
        except (ValueError, AttributeError):
            logger.warning("Ignoring risk zone with invalid coordinates: %r", zone)
            continue
        radius = max(1.0, float(zone.get("radius_m") or DEFAULT_ZONE_RADIUS_M))
        distance = haversine_m(lat, lng, z_lat, z_lng)
        proximity = zone_proximity(distance, radius)
        if proximity <= 0.0:
            continue
        risk_level = int(min(5, max(1, int(zone.get("risk_level") or DEFAULT_ZONE_RISK_LEVEL))))
        hits.append({
            "name": str(zone.get("name") or "Unnamed zone"),
            "zone_type": str(zone.get("zone_type") or "other"),
            "distance_m": round(distance, 1),
            "risk_level": risk_level,
            "radius_m": round(radius, 1),
            "inside_zone": distance <= radius,
            "proximity": round(proximity, 3),
            "contribution": round(risk_level / 5.0 * proximity, 4),
        })
    hits.sort(key=lambda z: (-z["contribution"], z["distance_m"], z["name"]))
    return hits


def _cue_hits(address, text, covered_zone_types=frozenset()):
    """Location cues found in the address and/or the complaint text.

    Cues whose zone type is in ``covered_zone_types`` (a mapped zone of that type already counts) are skipped.
    """
    address = str(address or "")
    text = str(text or "")
    hits = []
    for cue in LOCATION_CUES:
        if cue["zone_type"] in covered_zone_types:
            continue
        sources = []
        if address and cue["pattern"].search(address):
            sources.append("address")
        if text and cue["pattern"].search(text):
            sources.append("description")
        if sources:
            hits.append({"key": cue["key"], "phrase": cue["phrase"], "weight": cue["weight"], "kind": cue["kind"],
                         "sources": sources})
    return hits


def _zone_factor(zone):
    if zone["inside_zone"]:
        return f"Within {format_distance(zone['distance_m'])} of {zone['name']} ({zone['zone_type']})"
    return (f"{format_distance(zone['distance_m'])} from {zone['name']} ({zone['zone_type']}), "
            f"just outside its zone")


def _cue_factors(cues):
    """One sentence per source combination: "Address mentions a main road and a bus stop"."""
    grouped = {}
    for cue in cues:
        grouped.setdefault(tuple(cue["sources"]), []).append(cue["phrase"])
    subjects = {("address",): "Address mentions", ("description",): "Description mentions",
                ("address", "description"): "Address and description mention"}
    factors = []
    for sources, phrases in grouped.items():
        listed = phrases[0] if len(phrases) == 1 else ", ".join(phrases[:-1]) + " and " + phrases[-1]
        factors.append(f"{subjects[sources]} {listed}")
    return factors


def assess_location_risk(latitude, longitude, *, address="", text="", risk_zones=None, nearby_count=0):
    """Estimate how risky the location is (traffic, schools, hospitals, markets, density of complaints).

    risk_zones: [{"name", "zone_type", "latitude", "longitude", "radius_m", "risk_level" (1-5)}]

    Returns (CONTRACT):
        {"score": 0.8, "level": "high",
         "zones": [{"name": "Govt. High School", "zone_type": "school", "distance_m": 85.0, "risk_level": 4}],
         "factors": ["Within 85 m of Govt. High School (school)", "Address mentions a main road"],
         "is_high_traffic": True, "explanation": "..."}
    Zones additionally carry ``radius_m``, ``inside_zone``, ``proximity`` and ``contribution``; the result
    also has ``components`` ({"zones", "keywords", "density"} sub-scores) and ``nearby_count``.

    Raises ValueError for invalid coordinates.
    """
    lat, lng = parse_coordinates(latitude, longitude)
    zones = _zone_hits(lat, lng, risk_zones)
    cues = _cue_hits(address, text, covered_zone_types=frozenset(z["zone_type"] for z in zones))
    try:
        nearby = max(0, int(nearby_count or 0))
    except (TypeError, ValueError):
        nearby = 0

    zone_score = noisy_or(z["contribution"] for z in zones)
    keyword_score = min(KEYWORD_RISK_CAP, noisy_or(c["weight"] for c in cues))
    density_score = DENSITY_MAX_BONUS * (1.0 - math.exp(-nearby / DENSITY_SATURATION))
    score = noisy_or((zone_score, keyword_score, density_score))
    level = score_to_level(score * 100.0)

    is_high_traffic = (any(c["kind"] == "traffic" for c in cues)
                       or any(z["zone_type"] in HIGH_TRAFFIC_ZONE_TYPES for z in zones))

    factors = [_zone_factor(z) for z in zones] + _cue_factors(cues)
    if nearby:
        factors.append(f"{nearby} other complaint{'s' if nearby != 1 else ''} reported nearby")

    if factors:
        details = "; ".join(f[0].lower() + f[1:] if f[0].isupper() else f for f in factors)
        explanation = f"{level.capitalize()} location risk ({score:.2f}): {details}."
    else:
        explanation = ("Low location risk: no mapped risk zones, high-traffic cues or complaint clusters "
                       "near this location.")

    return {
        "score": round(score, 3),
        "level": level,
        "zones": zones,
        "factors": factors,
        "is_high_traffic": bool(is_high_traffic),
        "explanation": explanation,
        "components": {
            "zones": round(zone_score, 3),
            "keywords": round(keyword_score, 3),
            "density": round(density_score, 3),
        },
        "nearby_count": nearby,
    }
