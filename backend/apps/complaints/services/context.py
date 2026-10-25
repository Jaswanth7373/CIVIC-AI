"""Plain-dict context for the framework-independent ``ai`` package.

The AI engine never touches the database (there are no Django imports inside ``backend/ai``). This module is
the adapter between the two worlds: it reads rows and hands the engine plain dicts - the AI configuration,
the admin-defined categories and risk zones, and the complaints around a location.

Nearby-complaint search (used for frequency, location priors, priority and duplicate candidates)
    1. **Bounding-box pre-filter in SQL.** ``apps.core.utils.bounding_box`` turns the radius into a
       latitude/longitude rectangle (1 degree of latitude = 111.32 km; a degree of longitude shrinks with
       cos(latitude)). A plain range query on the indexed ``Location.latitude/longitude`` columns works on
       SQLite and MySQL alike - no GIS extension needed.
    2. **Exact great-circle distance in Python.** The rectangle's corners are farther than the radius, so each
       remaining row is checked with the haversine formula
       ``d = 2R * asin(sqrt(sin^2(dlat/2) + cos(lat1) cos(lat2) sin^2(dlng/2)))`` (R = 6 371 km) and kept only
       when ``d <= radius``.
"""
from datetime import timedelta
from decimal import ROUND_CEILING, ROUND_FLOOR, Decimal

from django.db.models import Prefetch
from django.utils import timezone

from apps.core.utils import bounding_box, haversine_m

from ..models import Complaint, ComplaintImage
from .helpers import field_file_path, is_automatic_title

FALLBACK_CATEGORY_SLUG = "other"
_COORDINATE_STEP = Decimal("0.000001")


def engine_config(*, create=True):
    """AIConfiguration.load().to_engine_config()

    ``create=False`` never writes to the database: when the singleton row does not exist yet the model
    defaults are used without saving them (read-only callers such as the public AI demo).
    """
    from apps.core.models import AIConfiguration

    if create:
        return AIConfiguration.load().to_engine_config()
    return (AIConfiguration.objects.filter(pk=1).first() or AIConfiguration(pk=1)).to_engine_config()


def engine_categories(include_inactive=False):
    """[CivicCategory.to_engine_dict(), ...] for active categories (all of them with ``include_inactive``)."""
    from apps.departments.models import CivicCategory

    queryset = CivicCategory.objects.all() if include_inactive else CivicCategory.objects.filter(is_active=True)
    return [category.to_engine_dict() for category in queryset.order_by("sort_order", "name")]


def engine_risk_zones():
    """[RiskZone.to_engine_dict(), ...] for active zones."""
    from apps.core.models import RiskZone

    return [zone.to_engine_dict() for zone in RiskZone.objects.filter(is_active=True).order_by("name")]


def active_category(slug, *, fallback=FALLBACK_CATEGORY_SLUG):
    """Active CivicCategory with this slug, else the active fallback category ("other"), else None."""
    from apps.departments.models import CivicCategory

    queryset = CivicCategory.objects.filter(is_active=True).select_related("department", "secondary_department")
    category = queryset.filter(slug=slug).first() if slug else None
    if category is None and fallback:
        category = queryset.filter(slug=fallback).first()
    return category


def analysis_text(complaint):
    """The text the AI reads for a complaint: the description, prefixed with the title only when a person wrote
    it. Automatically generated titles ("Roads / Potholes near ...") are left out because they merely repeat an
    earlier AI decision - feeding them back would bias re-analysis and inflate text similarity."""
    description = (complaint.description or "").strip()
    title = (complaint.title or "").strip()
    category = complaint.category if complaint.category_id else None
    if not title or is_automatic_title(title, category, complaint.location):
        return description
    if not description:
        return title
    return f"{title.rstrip('.!? ')}. {description}"


def complaint_engine_dict(complaint, *, image=None, use_primary_image=True):
    """Engine representation of a stored complaint (duplicate target / candidate, nearby item)."""
    if image is None and use_primary_image:
        image = complaint.primary_image
    location = complaint.location
    return {
        "id": complaint.pk,
        "complaint_number": complaint.complaint_number,
        "text": analysis_text(complaint),
        "category": complaint.category.slug if complaint.category_id else None,
        "latitude": float(location.latitude),
        "longitude": float(location.longitude),
        "status": complaint.status,
        "created_at": complaint.created_at.isoformat() if complaint.created_at else None,
        "phash": (image.phash or None) if image is not None else None,
        "dhash": (image.dhash or None) if image is not None else None,
        "image_path": field_file_path(image.image) if image is not None else None,
    }


def _coordinate(value, rounding):
    return Decimal(str(value)).quantize(_COORDINATE_STEP, rounding=rounding)


def nearby_complaints(latitude, longitude, *, radius_m, days, exclude_id=None, statuses=None,
                      exclude_statuses=None, created_before=None, exclude_merged=False):
    """Complaints within ``radius_m`` (exact haversine after a bounding-box DB pre-filter) created in the last
    ``days`` days. Returns list of dicts: {"id", "category", "latitude", "longitude", "status", "created_at",
    "text", "phash", "dhash", "image_path", "distance_m"}.

    Optional filters: ``statuses`` (keep only these), ``exclude_statuses``, ``created_before`` (only complaints
    created before this moment; the ``days`` window is then counted back from it instead of from now) and
    ``exclude_merged`` (drop complaints already confirmed as duplicates of another one). ``days=None`` disables
    the time window. Results are sorted nearest first; ``category`` is the slug and ``text`` is the
    title + description used for similarity (see ``analysis_text``).
    """
    if latitude is None or longitude is None or radius_m is None:
        return []
    lat, lng, radius = float(latitude), float(longitude), max(0.0, float(radius_m))
    min_lat, max_lat, min_lng, max_lng = bounding_box(lat, lng, radius)
    queryset = Complaint.objects.filter(
        location__latitude__gte=_coordinate(min_lat, ROUND_FLOOR),
        location__latitude__lte=_coordinate(max_lat, ROUND_CEILING),
        location__longitude__gte=_coordinate(min_lng, ROUND_FLOOR),
        location__longitude__lte=_coordinate(max_lng, ROUND_CEILING),
    )
    reference = created_before or timezone.now()
    if days is not None:
        queryset = queryset.filter(created_at__gte=reference - timedelta(days=float(days)))
    if created_before is not None:
        queryset = queryset.filter(created_at__lt=created_before)
    if exclude_id is not None:
        queryset = queryset.exclude(pk=exclude_id)
    if statuses:
        queryset = queryset.filter(status__in=list(statuses))
    if exclude_statuses:
        queryset = queryset.exclude(status__in=list(exclude_statuses))
    if exclude_merged:
        queryset = queryset.filter(duplicate_of__isnull=True)
    queryset = queryset.select_related("location", "category").prefetch_related(
        Prefetch("images", queryset=ComplaintImage.objects.order_by("id"), to_attr="ordered_images")
    )

    results = []
    for complaint in queryset:
        distance = haversine_m(lat, lng, complaint.location.latitude, complaint.location.longitude)
        if distance > radius:
            continue
        image = complaint.ordered_images[0] if complaint.ordered_images else None
        item = complaint_engine_dict(complaint, image=image, use_primary_image=False)
        item["distance_m"] = round(distance, 1)
        results.append(item)
    results.sort(key=lambda item: (item["distance_m"], item["id"]))
    return results
