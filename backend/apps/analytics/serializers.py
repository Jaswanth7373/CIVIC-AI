"""Serializers, query-parameter validation and shared JSON shapes for the analytics API (owner B5).

Three groups live here:

1. **Query-parameter validation** - ``AnalyticsQuerySerializer`` (and the per-endpoint
   subclasses) turn ``?date_from=&date_to=&department=&category=&severity=&status=`` into an
   immutable :class:`AnalyticsFilters` object.  Invalid input raises a DRF ``ValidationError``,
   which the project-wide handler turns into HTTP 400 ``{"detail", "errors", "code"}``.
2. **Shared shapes** (BUILD_SPEC section 4.1) - CategoryMini, DepartmentMini, OfficerMini,
   ComplaintMini, ComplaintList, TimelineEvent, Feedback and Notification.  The owning apps
   provide the canonical serializers; :func:`serialize_shared` uses them when they are importable
   and otherwise falls back to local helpers that emit exactly the same dict shape, so the
   analytics endpoints never depend on unfinished code in a sibling app.
3. **Hotspot alerts** - :class:`HotspotAlertSerializer` / :class:`HotspotAlertUpdateSerializer`.
"""
import functools
import importlib
import logging
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from django.conf import settings
from django.db.models import Exists, OuterRef, Prefetch, Q, Subquery
from django.utils import timezone
from rest_framework import serializers

from apps.complaints.models import AIPrediction, Complaint, ComplaintImage, DuplicateComplaint, Level
from apps.core.filters import MAX_FILTER_DATE, MIN_FILTER_DATE
from apps.core.permissions import withholds_personal_data
from apps.core.utils import absolute_media_url, parse_id
from apps.departments.models import CivicCategory, Department

from .models import HotspotAlert

logger = logging.getLogger("apps.analytics")

LEVEL_LABELS = dict(Level.choices)
STATUS_LABELS = dict(Complaint.Status.choices)
PERIODS = ("day", "week", "month")
REPORT_TYPES = ("summary", "complaints", "departments", "officers", "feedback")
REPORT_FORMATS = ("json", "csv", "pdf")
# Parameters that may be repeated (?status=a&status=b) or comma separated (?status=a,b).
MULTI_VALUE_PARAMS = ("severity", "status")


# ---------------------------------------------------------------------------------------------
# Time helpers (all analytics work in the project time zone, settings.TIME_ZONE)
# ---------------------------------------------------------------------------------------------
def local_tz():
    """The project time zone as a ``zoneinfo`` object (Asia/Kolkata by default)."""
    return ZoneInfo(settings.TIME_ZONE)


def local_midnight(day):
    """Aware datetime for 00:00 local time on ``day`` - used as a date-range boundary."""
    return datetime.combine(day, time.min).replace(tzinfo=local_tz())


def local_today():
    """Today's calendar date in the project time zone."""
    return timezone.now().astimezone(local_tz()).date()


def iso(value):
    """ISO-8601 string in the project time zone (the format DRF uses for DateTimeField), or None."""
    if value is None:
        return None
    if isinstance(value, datetime):
        if timezone.is_naive(value):
            value = value.replace(tzinfo=local_tz())
        return value.astimezone(local_tz()).isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return str(value)


# ---------------------------------------------------------------------------------------------
# Validated filters
# ---------------------------------------------------------------------------------------------
@dataclass(frozen=True)
class AnalyticsFilters:
    """The common analytics filters after validation.

    Dates are *local calendar dates* and inclusive: ``date_from=2026-10-01&date_to=2026-10-31``
    selects ``local_midnight(Oct 1) <= created_at < local_midnight(Nov 1)``.  Building the bounds
    in Python (instead of ``created_at__date``) keeps the SQL portable to MySQL without
    time-zone tables.
    """

    date_from: date | None = None
    date_to: date | None = None
    department: Department | None = None
    category: CivicCategory | None = None
    severities: tuple = ()
    statuses: tuple = ()

    @property
    def start(self):
        """Inclusive lower bound (aware datetime) or None."""
        return local_midnight(self.date_from) if self.date_from else None

    @property
    def end(self):
        """Exclusive upper bound: local midnight after ``date_to`` (aware datetime) or None."""
        return local_midnight(self.date_to + timedelta(days=1)) if self.date_to else None

    @property
    def has_date_range(self):
        return bool(self.date_from or self.date_to)

    def date_q(self, field):
        """``Q`` restricting the timestamp ``field`` to the selected date range."""
        q = Q()
        if self.start is not None:
            q &= Q(**{f"{field}__gte": self.start})
        if self.end is not None:
            q &= Q(**{f"{field}__lt": self.end})
        return q

    def complaint_q(self, prefix="", *, dates=True, department=True, category=True, severity=True, status=True):
        """``Q`` for Complaint rows; ``prefix`` (e.g. ``"complaint__"``) applies it through a relation.

        The keyword switches let an endpoint skip filters that do not make sense for it (for
        example the officer table filters officers - not complaints - by department).
        """
        q = self.date_q(f"{prefix}created_at") if dates else Q()
        if department and self.department is not None:
            q &= Q(**{f"{prefix}department": self.department})
        if category and self.category is not None:
            q &= Q(**{f"{prefix}category": self.category})
        if severity and self.severities:
            q &= Q(**{f"{prefix}severity__in": list(self.severities)})
        if status and self.statuses:
            q &= Q(**{f"{prefix}status__in": list(self.statuses)})
        return q

    def as_dict(self):
        """JSON echo of the applied filters (ids / slugs / codes, never personal data)."""
        return {
            "date_from": self.date_from.isoformat() if self.date_from else None,
            "date_to": self.date_to.isoformat() if self.date_to else None,
            "department": self.department.id if self.department else None,
            "category": self.category.slug if self.category else None,
            "severity": list(self.severities),
            "status": list(self.statuses),
        }

    def describe(self):
        """Human-readable ``(label, value)`` pairs, used in report headers."""
        items = []
        if self.date_from:
            items.append(("Date from", self.date_from.isoformat()))
        if self.date_to:
            items.append(("Date to", self.date_to.isoformat()))
        if self.department:
            items.append(("Department", f"{self.department.name} ({self.department.code})"))
        if self.category:
            items.append(("Category", self.category.name))
        if self.severities:
            items.append(("Severity", ", ".join(LEVEL_LABELS[s] for s in self.severities)))
        if self.statuses:
            items.append(("Status", ", ".join(STATUS_LABELS[s] for s in self.statuses)))
        return items


def _split_csv(value):
    """'a, b,,a' -> ('a', 'b'): trimmed, de-duplicated, order preserved."""
    seen = []
    for item in str(value).split(","):
        item = item.strip().lower()
        if item and item not in seen:
            seen.append(item)
    return tuple(seen)


def validated_query(serializer_class, request):
    """Validate ``request.query_params`` with ``serializer_class`` (raises 400 on invalid input).

    Blank parameters (``?department=``) are treated as "not given", and repeated multi-value
    parameters are merged into one comma list.
    """
    params = request.query_params
    data = {}
    for key in params.keys():
        values = [value.strip() for value in params.getlist(key) if value and value.strip()]
        if not values:
            continue
        data[key] = ",".join(values) if key in MULTI_VALUE_PARAMS else values[-1]
    serializer = serializer_class(data=data)
    serializer.is_valid(raise_exception=True)
    return serializer


class AnalyticsQuerySerializer(serializers.Serializer):
    """Common filters: ``date_from``/``date_to`` (YYYY-MM-DD, inclusive, on created_at),
    ``department`` (id or code), ``category`` (id or slug), ``severity`` and ``status``
    (comma lists)."""

    date_from = serializers.DateField(required=False, input_formats=["%Y-%m-%d"])
    date_to = serializers.DateField(required=False, input_formats=["%Y-%m-%d"])
    department = serializers.CharField(required=False, allow_blank=True, max_length=40)
    category = serializers.CharField(required=False, allow_blank=True, max_length=80)
    severity = serializers.CharField(required=False, allow_blank=True, max_length=80)
    status = serializers.CharField(required=False, allow_blank=True, max_length=250)

    @staticmethod
    def _check_date(value):
        if value is not None and not (MIN_FILTER_DATE <= value <= MAX_FILTER_DATE):
            raise serializers.ValidationError(
                f"Date must be between {MIN_FILTER_DATE.isoformat()} and {MAX_FILTER_DATE.isoformat()}."
            )
        return value

    def validate_date_from(self, value):
        return self._check_date(value)

    def validate_date_to(self, value):
        return self._check_date(value)

    def validate_department(self, value):
        value = value.strip()
        department_id = parse_id(value)
        department = Department.objects.filter(pk=department_id).first() if department_id is not None else None
        if department is None:
            department = Department.objects.filter(code__iexact=value).first()
        if department is None:
            raise serializers.ValidationError(f"Unknown department '{value}'. Use a department id or code.")
        return department

    def validate_category(self, value):
        value = value.strip()
        category_id = parse_id(value)
        category = CivicCategory.objects.filter(pk=category_id).first() if category_id is not None else None
        if category is None:
            category = CivicCategory.objects.filter(slug__iexact=value).first()
        if category is None:
            raise serializers.ValidationError(f"Unknown category '{value}'. Use a category id or slug.")
        return category

    def validate_severity(self, value):
        items = _split_csv(value)
        invalid = [item for item in items if item not in Level.values]
        if invalid:
            raise serializers.ValidationError(
                f"Invalid severity '{invalid[0]}'. Allowed values: {', '.join(Level.values)}."
            )
        return items

    def validate_status(self, value):
        items = _split_csv(value)
        invalid = [item for item in items if item not in Complaint.Status.values]
        if invalid:
            raise serializers.ValidationError(
                f"Invalid status '{invalid[0]}'. Allowed values: {', '.join(Complaint.Status.values)}."
            )
        return items

    def validate(self, attrs):
        date_from, date_to = attrs.get("date_from"), attrs.get("date_to")
        if date_from and date_to and date_from > date_to:
            raise serializers.ValidationError({"date_to": ["date_to must be on or after date_from."]})
        return attrs

    @property
    def filters(self):
        data = self.validated_data
        return AnalyticsFilters(
            date_from=data.get("date_from"),
            date_to=data.get("date_to"),
            department=data.get("department"),
            category=data.get("category"),
            severities=tuple(data.get("severity") or ()),
            statuses=tuple(data.get("status") or ()),
        )


class TrendQuerySerializer(AnalyticsQuerySerializer):
    """``trends/``: ``period`` (day | week | month) and ``days`` window (1-730, default 90)."""

    period = serializers.ChoiceField(choices=PERIODS, required=False, default="day")
    days = serializers.IntegerField(required=False, min_value=1, max_value=730, default=90)


class SentimentQuerySerializer(TrendQuerySerializer):
    """``sentiment/``: same window parameters; feedback is sparser, so weekly buckets by default."""

    period = serializers.ChoiceField(choices=PERIODS, required=False, default="week")


class HotspotQuerySerializer(AnalyticsQuerySerializer):
    """``hotspots/``: DBSCAN parameters override AIConfiguration within sane bounds."""

    eps_m = serializers.IntegerField(required=False, min_value=50, max_value=5000)
    min_samples = serializers.IntegerField(required=False, min_value=2, max_value=50)
    days = serializers.IntegerField(required=False, min_value=1, max_value=730, default=90)


class ReportQuerySerializer(AnalyticsQuerySerializer):
    """``reports/``: which dataset, which output format and (JSON preview only) how many rows."""

    report = serializers.ChoiceField(choices=REPORT_TYPES, required=False, default="summary")
    format = serializers.ChoiceField(choices=REPORT_FORMATS, required=False, default="json")
    limit = serializers.IntegerField(required=False, min_value=1, max_value=500, default=100)


class AlertQuerySerializer(serializers.Serializer):
    """``alerts/``: optional ``is_acknowledged=true|false`` filter."""

    is_acknowledged = serializers.BooleanField(required=False)


# ---------------------------------------------------------------------------------------------
# Shared shapes: owner serializer when available, identical local fallback otherwise
# ---------------------------------------------------------------------------------------------
_SHARED_SERIALIZERS = {
    "category_mini": (("apps.complaints.serializers", "CategoryMiniSerializer"),),
    "department_mini": (("apps.complaints.serializers", "DepartmentMiniSerializer"),),
    "officer_mini": (("apps.complaints.serializers", "OfficerMiniSerializer"),),
    "complaint_mini": (("apps.complaints.serializers", "ComplaintMiniSerializer"),),
    "complaint_list": (("apps.complaints.serializers", "ComplaintListSerializer"),),
    "timeline_event": (("apps.complaints.serializers", "TimelineEventSerializer"),),
    "feedback": (
        ("apps.complaints.serializers", "FeedbackSerializer"),
        ("apps.feedback.serializers", "FeedbackSerializer"),
    ),
    "notification": (("apps.notifications.serializers", "NotificationSerializer"),),
}


@functools.lru_cache(maxsize=None)
def shared_serializer(kind):
    """The owning app's serializer class for ``kind``, or None while it does not exist yet."""
    for module_path, class_name in _SHARED_SERIALIZERS[kind]:
        try:
            module = importlib.import_module(module_path)
        except ImportError:
            continue
        serializer_class = getattr(module, class_name, None)
        if serializer_class is not None:
            return serializer_class
    return None


def _local_category_mini(category, request=None):
    if category is None:
        return None
    return {"id": category.id, "name": category.name, "slug": category.slug, "icon": category.icon,
            "color": category.color}


def _local_department_mini(department, request=None):
    if department is None:
        return None
    return {"id": department.id, "name": department.name, "code": department.code, "icon": department.icon,
            "color": department.color}


def _local_user_mini(user, request=None):
    if user is None:
        return None
    hidden = withholds_personal_data(getattr(request, "user", None), user.id)
    return {"id": user.id, "full_name": user.full_name, "email": None if hidden else user.email, "role": user.role,
            "avatar": absolute_media_url(request, user.avatar), "phone": None if hidden else user.phone}


def _local_officer_mini(user, request=None):
    if user is None:
        return None
    data = _local_user_mini(user, request)
    profile = getattr(user, "officer_profile", None)
    data.update({
        "employee_id": profile.employee_id if profile else "",
        "designation": profile.designation if profile else "",
        "zone": profile.zone if profile else "",
        "department": _local_department_mini(profile.department if profile else None),
        "is_available": bool(profile.is_available) if profile else False,
    })
    return data


def _local_location(location):
    if location is None:
        return None
    return {"latitude": float(location.latitude), "longitude": float(location.longitude),
            "address": location.address, "landmark": location.landmark, "area": location.area,
            "city": location.city, "pincode": location.pincode}


def _thumbnail(complaint, request):
    images = list(complaint.images.all())  # prefetched (ordered by id) by with_list_annotations
    return absolute_media_url(request, images[0].image) if images else None


def _local_complaint_mini(complaint, request=None):
    if complaint is None:
        return None
    return {
        "id": complaint.id,
        "complaint_number": complaint.complaint_number,
        "title": complaint.title,
        "description": complaint.description,
        "status": complaint.status,
        "status_display": complaint.get_status_display(),
        "category": _local_category_mini(complaint.category),
        "thumbnail": _thumbnail(complaint, request),
        "created_at": iso(complaint.created_at),
        "location": _local_location(complaint.location),
        "priority_score": complaint.priority_score,
        "priority_level": complaint.priority_level,
        "severity": complaint.severity,
    }


_MISSING = object()


def _local_complaint_list(complaint, request=None):
    if complaint is None:
        return None
    confidence = getattr(complaint, "analytics_ai_confidence", _MISSING)
    is_demo = getattr(complaint, "analytics_ai_is_demo", _MISSING)
    if confidence is _MISSING or is_demo is _MISSING:  # object not loaded through with_list_annotations
        prediction = complaint.latest_prediction
        confidence = prediction.multimodal_confidence if prediction else None
        is_demo = prediction.is_demo if prediction else False
    pending = getattr(complaint, "analytics_pending_duplicates", _MISSING)
    if pending is _MISSING:
        pending = DuplicateComplaint.objects.filter(
            Q(complaint=complaint) | Q(similar_complaint=complaint),
            status=DuplicateComplaint.Status.PENDING_REVIEW,
        ).exists()
    return {
        "id": complaint.id,
        "complaint_number": complaint.complaint_number,
        "title": complaint.title,
        "description": complaint.description,
        "category": _local_category_mini(complaint.category),
        "status": complaint.status,
        "status_display": complaint.get_status_display(),
        "severity": complaint.severity,
        "severity_score": complaint.severity_score,
        "priority_score": complaint.priority_score,
        "priority_level": complaint.priority_level,
        "department": _local_department_mini(complaint.department),
        "assigned_officer": _local_user_mini(complaint.assigned_officer, request),
        "citizen": _local_user_mini(complaint.citizen, request),
        "location": _local_location(complaint.location),
        "thumbnail": _thumbnail(complaint, request),
        "duplicate_count": complaint.duplicate_count,
        "has_pending_duplicates": bool(pending),
        "is_overdue": complaint.is_overdue,
        "sla_due_at": iso(complaint.sla_due_at),
        "ai_is_demo": bool(is_demo),
        "ai_confidence": float(confidence) if confidence is not None else None,
        "needs_manual_review": complaint.needs_manual_review,
        "created_at": iso(complaint.created_at),
        "updated_at": iso(complaint.updated_at),
        "resolved_at": iso(complaint.resolved_at),
    }


def _actor_label(user):
    if user is None:
        return "CivicAI Engine"
    return f"{user.full_name} ({user.get_role_display()})"


def _local_timeline_event(event, request=None):
    return {
        "id": event.id,
        "event": event.event,
        "event_display": event.get_event_display(),
        "old_status": event.old_status,
        "new_status": event.new_status,
        "changed_by": _local_user_mini(event.changed_by, request),
        "actor_label": _actor_label(event.changed_by),
        "remarks": event.remarks,
        "metadata": event.metadata,
        "is_public": event.is_public,
        "timestamp": iso(event.timestamp),
    }


def _local_feedback(feedback, request=None):
    complaint = feedback.complaint
    return {
        "id": feedback.id,
        "complaint": feedback.complaint_id,
        "complaint_number": complaint.complaint_number,
        "complaint_title": complaint.title,
        "citizen": _local_user_mini(feedback.citizen, request),
        "rating": feedback.rating,
        "text": feedback.text,
        "sentiment": feedback.sentiment,
        "sentiment_display": feedback.get_sentiment_display() if feedback.sentiment else "",
        "sentiment_score": feedback.sentiment_score,
        "sentiment_confidence": feedback.sentiment_confidence,
        "sentiment_model": feedback.sentiment_model,
        "is_demo": feedback.is_demo,
        "department": _local_department_mini(complaint.department),
        "category": _local_category_mini(complaint.category),
        "created_at": iso(feedback.created_at),
    }


def _local_notification(notification, request=None):
    return {
        "id": notification.id,
        "title": notification.title,
        "message": notification.message,
        "notification_type": notification.notification_type,
        "type_display": notification.get_notification_type_display(),
        "level": notification.level,
        "complaint": notification.complaint_id,
        "complaint_number": notification.complaint.complaint_number if notification.complaint_id else None,
        "link": notification.link,
        "is_read": notification.is_read,
        "read_at": iso(notification.read_at),
        "created_at": iso(notification.created_at),
    }


_LOCAL_SHAPES = {
    "category_mini": _local_category_mini,
    "department_mini": _local_department_mini,
    "officer_mini": _local_officer_mini,
    "complaint_mini": _local_complaint_mini,
    "complaint_list": _local_complaint_list,
    "timeline_event": _local_timeline_event,
    "feedback": _local_feedback,
    "notification": _local_notification,
}


def serialize_shared(kind, value, *, request=None, many=False):
    """Serialize ``value`` in the shared API shape ``kind`` (see ``_SHARED_SERIALIZERS``).

    Uses the owning app's serializer when it is importable; otherwise (or if it fails at
    runtime, which is logged) the local helper with the identical shape is used.
    """
    if value is None and not many:
        return None
    items = list(value) if many else value
    serializer_class = shared_serializer(kind)
    if serializer_class is not None:
        try:
            data = serializer_class(items, many=many, context={"request": request}).data
            return [dict(item) for item in data] if many else dict(data)
        except Exception:  # a sibling app's serializer must never take the analytics API down
            logger.warning("Shared %s serializer failed; using the analytics fallback shape.", kind, exc_info=True)
    local = _LOCAL_SHAPES[kind]
    if many:
        return [local(item, request) for item in items]
    return local(items, request)


@functools.lru_cache(maxsize=None)
def _shared_list_optimiser():
    """``apps.complaints.serializers.optimize_complaint_list_queryset`` when that module exists."""
    try:
        module = importlib.import_module("apps.complaints.serializers")
    except ImportError:
        return None
    return getattr(module, "optimize_complaint_list_queryset", None)


def with_list_annotations(queryset):
    """Prepare a Complaint queryset for the ComplaintList shape without N+1 queries.

    When the complaints app's ComplaintListSerializer is used, its own queryset optimiser is
    applied (the annotations that serializer reads); otherwise :func:`local_list_queryset`.
    """
    optimiser = _shared_list_optimiser()
    if optimiser is not None and shared_serializer("complaint_list") is not None:
        try:
            return optimiser(queryset)
        except Exception:
            logger.warning("Shared complaint list optimiser failed; using the analytics one.", exc_info=True)
    return local_list_queryset(queryset)


def local_list_queryset(queryset):
    """Prepare a Complaint queryset for the local ComplaintList fallback without N+1 queries.

    ``select_related`` loads the foreign keys in the same SQL query, images are prefetched in one
    extra query, and the latest AI prediction values plus the pending-duplicate flag are computed
    by correlated subqueries (``Subquery`` / ``Exists``).
    """
    latest_prediction = AIPrediction.objects.filter(complaint=OuterRef("pk")).order_by("-created_at", "-id")
    pending_duplicates = DuplicateComplaint.objects.filter(
        Q(complaint=OuterRef("pk")) | Q(similar_complaint=OuterRef("pk")),
        status=DuplicateComplaint.Status.PENDING_REVIEW,
    )
    return (
        queryset.select_related(
            "category", "department", "assigned_officer", "citizen", "location"
        )
        .prefetch_related(Prefetch("images", queryset=ComplaintImage.objects.order_by("id")))
        .annotate(
            analytics_ai_confidence=Subquery(latest_prediction.values("multimodal_confidence")[:1]),
            analytics_ai_is_demo=Subquery(latest_prediction.values("is_demo")[:1]),
            analytics_pending_duplicates=Exists(pending_duplicates),
        )
    )


# ---------------------------------------------------------------------------------------------
# Hotspot alerts
# ---------------------------------------------------------------------------------------------
class HotspotAlertSerializer(serializers.ModelSerializer):
    """HotspotAlert: ``{"id", "cluster_key", "latitude", "longitude", "radius_m", "complaint_count",
    "dominant_category": CategoryMini|null, "severity", "area_name", "complaint_ids",
    "is_acknowledged", "created_at"}``."""

    latitude = serializers.FloatField(read_only=True)
    longitude = serializers.FloatField(read_only=True)
    dominant_category = serializers.SerializerMethodField()

    class Meta:
        model = HotspotAlert
        fields = [
            "id", "cluster_key", "latitude", "longitude", "radius_m", "complaint_count", "dominant_category",
            "severity", "area_name", "complaint_ids", "is_acknowledged", "created_at",
        ]
        read_only_fields = fields

    def get_dominant_category(self, obj):
        return serialize_shared("category_mini", obj.dominant_category, request=self.context.get("request"))


class HotspotAlertUpdateSerializer(serializers.Serializer):
    """PATCH ``alerts/{id}/`` body: ``{"is_acknowledged": true|false}``."""

    is_acknowledged = serializers.BooleanField(required=True)
