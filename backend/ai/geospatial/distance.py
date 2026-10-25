"""Great-circle distance helpers shared by location risk, hotspots and duplicate detection.

Technique - the haversine formula::

    a = sin^2(dphi / 2) + cos(phi1) * cos(phi2) * sin^2(dlambda / 2)
    d = 2 * R * asin(sqrt(a))

with phi = latitude and lambda = longitude in radians and R = 6 371 km (mean Earth radius).
It models the Earth as a sphere; at city scale the error against the WGS84 ellipsoid is
well below 0.5 %, far smaller than the 5-20 m error of a phone GPS fix.
"""
import math

import numpy as np

EARTH_RADIUS_M = 6371000.0


def parse_coordinates(latitude, longitude):
    """Validate a WGS84 coordinate pair and return it as ``(lat, lng)`` floats.

    Accepts numbers, numeric strings and ``Decimal`` (the Django models store Decimal(9, 6)).
    Raises ``ValueError`` for missing, non-numeric, non-finite or out-of-range values.
    """
    try:
        lat = float(latitude)
        lng = float(longitude)
    except (TypeError, ValueError):
        raise ValueError(f"Invalid coordinates: latitude={latitude!r}, longitude={longitude!r}") from None
    if not (math.isfinite(lat) and math.isfinite(lng)) or not (-90.0 <= lat <= 90.0 and -180.0 <= lng <= 180.0):
        raise ValueError(f"Coordinates out of range: latitude={lat}, longitude={lng}")
    return lat, lng


def haversine_m(lat1, lng1, lat2, lng2):
    """Distance in metres between two WGS84 points."""
    p1, p2 = math.radians(float(lat1)), math.radians(float(lat2))
    dp = p2 - p1
    dl = math.radians(float(lng2) - float(lng1))
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(a)))


def haversine_m_array(lat, lng, lats, lngs):
    """Vectorised haversine: distances in metres from one point to many points.

    ``lats`` / ``lngs`` are sequences (or NumPy arrays) in degrees; returns a float NumPy array.
    """
    lat1 = math.radians(float(lat))
    lng1 = math.radians(float(lng))
    lat2 = np.radians(np.asarray(lats, dtype=float))
    lng2 = np.radians(np.asarray(lngs, dtype=float))
    a = np.sin((lat2 - lat1) / 2.0) ** 2 + math.cos(lat1) * np.cos(lat2) * np.sin((lng2 - lng1) / 2.0) ** 2
    return 2.0 * EARTH_RADIUS_M * np.arcsin(np.minimum(1.0, np.sqrt(a)))


def spherical_centroid(lats, lngs):
    """Geographic centre of a set of points (degrees) -> ``(lat, lng)``.

    Every point becomes a 3-D unit vector on the sphere, the vectors are averaged and the mean
    vector is converted back to latitude / longitude. Unlike averaging raw degrees this stays
    correct across the 180 degree meridian and near the poles.
    """
    phi = np.radians(np.asarray(lats, dtype=float))
    lam = np.radians(np.asarray(lngs, dtype=float))
    x = float(np.mean(np.cos(phi) * np.cos(lam)))
    y = float(np.mean(np.cos(phi) * np.sin(lam)))
    z = float(np.mean(np.sin(phi)))
    return math.degrees(math.atan2(z, math.hypot(x, y))), math.degrees(math.atan2(y, x))


def format_distance(distance_m):
    """Readable distance for explanations: ``"42 m"`` below one kilometre, ``"1.2 km"`` above."""
    d = max(0.0, float(distance_m))
    if d < 1000.0:
        return f"{d:.0f} m"
    return f"{d / 1000.0:.1f} km"
