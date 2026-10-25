"""Geospatial intelligence: distances, location risk, DBSCAN hotspots.

    haversine_m(lat1, lng1, lat2, lng2)                      great-circle distance in metres
    assess_location_risk(lat, lng, *, address, text, risk_zones, nearby_count)
    detect_hotspots(points, *, eps_m=400, min_samples=3)      DBSCAN (haversine) hotspot clusters
"""
from .distance import EARTH_RADIUS_M, format_distance, haversine_m, parse_coordinates  # noqa: F401
from .hotspots import detect_hotspots  # noqa: F401
from .location_risk import assess_location_risk  # noqa: F401
