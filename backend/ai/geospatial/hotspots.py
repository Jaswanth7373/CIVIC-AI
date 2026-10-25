"""DBSCAN hotspot detection (BUILD_SPEC section 2.7).

Technique - DBSCAN (Density-Based Spatial Clustering of Applications with Noise, Ester et al. 1996):

* A point is a *core point* when at least ``min_samples`` points (itself included) lie within
  ``eps`` of it. Clusters grow by chaining core points that are within ``eps`` of each other;
  non-core points within ``eps`` of a core point join as border points; everything else is
  *noise* (label -1).
* Unlike k-means, DBSCAN needs no number of clusters, finds arbitrarily shaped clusters (a
  damaged stretch of road is long and thin, not round) and explicitly leaves isolated complaints
  out of every hotspot.
* Distances use ``metric="haversine"`` (great-circle distance on the unit sphere), so the
  coordinates are given in radians and ``eps`` is an angle: ``eps = eps_m / 6 371 000``.
  ``algorithm="ball_tree"`` indexes the points so each neighbourhood query is O(log n).

For every cluster we report the centroid (spherical mean), the member count, a radius (largest
haversine distance from the centroid, at least 50 m), the dominant category and the category
breakdown, severity / priority statistics, open complaints, the most common area name, the
bounding box and the density (complaints per km^2 of the circle with that radius).
"""
import logging
import math
from collections import Counter

import numpy as np

from ..config import CLASS_LABELS, LEVELS, score_to_level
from .distance import EARTH_RADIUS_M, haversine_m_array, parse_coordinates, spherical_centroid

logger = logging.getLogger("ai.geospatial")

ALGORITHM = "DBSCAN (haversine)"
HOTSPOT_ENGINE_VERSION = "dbscan-haversine-1.0"
MIN_CLUSTER_RADIUS_M = 50.0
OPEN_STATUSES = frozenset({"submitted", "analyzed", "assigned", "accepted", "in_progress", "reopened"})


def _validate_params(eps_m, min_samples):
    try:
        eps = float(eps_m)
        samples = int(min_samples)
    except (TypeError, ValueError):
        raise ValueError(f"Invalid DBSCAN parameters: eps_m={eps_m!r}, min_samples={min_samples!r}") from None
    if not math.isfinite(eps) or eps <= 0:
        raise ValueError("eps_m must be a positive number of metres")
    if samples < 1:
        raise ValueError("min_samples must be at least 1")
    return eps, samples


def _number(value):
    """Float value or None for missing / non-numeric input."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _most_common(values):
    """Most frequent value (ties broken alphabetically for deterministic output) or None."""
    counts = Counter(values)
    if not counts:
        return None
    return sorted(counts.items(), key=lambda item: (-item[1], str(item[0])))[0][0]


def _category_name(members, slug):
    for point in members:
        if point.get("category") == slug and point.get("category_name"):
            return str(point["category_name"])
    return CLASS_LABELS.get(slug, str(slug).replace("_", " ").title())


def _summarise_cluster(members, lats, lngs, thresholds):
    """Statistics for one cluster (members = point dicts, lats/lngs = parsed coordinates)."""
    count = len(members)
    c_lat, c_lng = spherical_centroid(lats, lngs)
    radius_m = max(MIN_CLUSTER_RADIUS_M, float(np.max(haversine_m_array(c_lat, c_lng, lats, lngs))))
    area_km2 = math.pi * (radius_m / 1000.0) ** 2

    categories = [p.get("category") for p in members if p.get("category")]
    breakdown = dict(sorted(Counter(categories).items(), key=lambda item: (-item[1], str(item[0]))))
    dominant = _most_common(categories)

    severity_scores = [s for s in (_number(p.get("severity_score")) for p in members) if s is not None]
    priority_scores = [s for s in (_number(p.get("priority_score")) for p in members) if s is not None]
    severity_labels = [p.get("severity") for p in members if p.get("severity") in LEVELS]
    max_severity = max(severity_labels, key=LEVELS.index) if severity_labels else None
    avg_severity = round(sum(severity_scores) / len(severity_scores), 1) if severity_scores else 0.0
    if severity_scores:
        severity_level = score_to_level(avg_severity, thresholds)
    else:  # no numeric scores supplied: fall back to the worst recorded label
        severity_level = max_severity or "low"

    areas = [str(p.get("area")).strip() for p in members if p.get("area") and str(p.get("area")).strip()]
    return {
        "latitude": round(c_lat, 6),
        "longitude": round(c_lng, 6),
        "count": count,
        "radius_m": round(radius_m, 1),
        "dominant_category": dominant,
        "dominant_category_name": _category_name(members, dominant) if dominant else None,
        "category_breakdown": breakdown,
        "avg_severity_score": avg_severity,
        "max_severity": max_severity,
        "severity_level": severity_level,
        "avg_priority_score": round(sum(priority_scores) / len(priority_scores), 1) if priority_scores else 0.0,
        "open_count": sum(1 for p in members if p.get("status") in OPEN_STATUSES),
        "area_name": _most_common(areas) or "",
        "complaint_ids": [p["_id"] for p in members],
        "bounds": [[round(min(lats), 6), round(min(lngs), 6)], [round(max(lats), 6), round(max(lngs), 6)]],
        "density_per_km2": round(count / area_km2, 1),
    }


def detect_hotspots(points, *, eps_m=400, min_samples=3, thresholds=None):
    """Cluster complaint coordinates with DBSCAN (haversine metric).

    points: [{"id", "latitude", "longitude", "category", "category_name", "severity", "severity_score",
              "priority_score", "status", "area", "created_at"}]
    thresholds: optional level thresholds for ``severity_level`` (defaults 26 / 51 / 76).

    Returns (CONTRACT):
        {"clusters": [{"cluster_id": 0, "latitude": 17.41, "longitude": 78.47, "count": 12, "radius_m": 350.0,
                       "dominant_category": "pothole", "dominant_category_name": "Roads / Potholes",
                       "category_breakdown": {"pothole": 8, "road_crack": 4},
                       "avg_severity_score": 64.2, "max_severity": "critical", "severity_level": "high",
                       "avg_priority_score": 61.0, "open_count": 9, "area_name": "Banjara Hills",
                       "complaint_ids": [...], "bounds": [[min_lat, min_lng], [max_lat, max_lng]],
                       "density_per_km2": 31.2}],
         "noise_ids": [...], "labels": {complaint_id: cluster_id or -1},
         "params": {"eps_m": 400, "min_samples": 3}, "algorithm": "DBSCAN (haversine)", "total_points": 140}

    Clusters are ordered largest first (ties: higher average severity) and numbered 0..k-1 in that
    order. Points with missing / invalid coordinates are skipped and counted in ``skipped_points``.
    A point without an ``id`` is identified by its index in ``points``.
    Raises ValueError for a non-positive ``eps_m`` or ``min_samples < 1``.
    """
    eps, samples = _validate_params(eps_m, min_samples)
    result = {
        "clusters": [],
        "noise_ids": [],
        "labels": {},
        "params": {"eps_m": int(eps) if eps.is_integer() else eps, "min_samples": samples},
        "algorithm": ALGORITHM,
        "total_points": 0,
        "skipped_points": 0,
    }

    valid = []
    for index, point in enumerate(points or []):
        try:
            lat, lng = parse_coordinates(point.get("latitude"), point.get("longitude"))
        except (ValueError, AttributeError):
            result["skipped_points"] += 1
            continue
        valid.append(({**point, "_id": point.get("id") if point.get("id") is not None else index}, lat, lng))
    result["total_points"] = len(valid)
    if not valid:
        return result

    from sklearn.cluster import DBSCAN  # imported lazily: only analytics needs scikit-learn here

    coords = np.radians(np.array([[lat, lng] for _, lat, lng in valid], dtype=float))
    labels = DBSCAN(eps=eps / EARTH_RADIUS_M, min_samples=samples, metric="haversine",
                    algorithm="ball_tree").fit_predict(coords)

    members_by_label = {}
    for (point, lat, lng), label in zip(valid, labels):
        if label >= 0:
            members_by_label.setdefault(int(label), []).append((point, lat, lng))

    summaries = []
    for label, members in members_by_label.items():
        summary = _summarise_cluster([m[0] for m in members], [m[1] for m in members], [m[2] for m in members],
                                     thresholds)
        summaries.append((label, summary))
    summaries.sort(key=lambda item: (-item[1]["count"], -item[1]["avg_severity_score"],
                                     item[1]["latitude"], item[1]["longitude"]))

    new_label = {}
    for cluster_id, (old_label, summary) in enumerate(summaries):
        new_label[old_label] = cluster_id
        result["clusters"].append({"cluster_id": cluster_id, **summary})

    for (point, _, _), label in zip(valid, labels):
        cluster_id = new_label.get(int(label), -1)
        result["labels"][point["_id"]] = cluster_id
        if cluster_id == -1:
            result["noise_ids"].append(point["_id"])

    logger.debug("DBSCAN found %d hotspot(s) among %d points (eps=%sm, min_samples=%d)",
                 len(result["clusters"]), len(valid), eps_m, samples)
    return result
