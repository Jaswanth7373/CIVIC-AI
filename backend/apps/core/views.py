"""System endpoints: public config, AI configuration, risk zones, contact form and the geocoding proxy.

    GET          /api/system/config/        public UI configuration (mode, map defaults, upload limits, choices)
    GET/PUT/PATCH /api/ai/config/           AIConfiguration singleton (read: officer/admin, write: admin)
    CRUD         /api/risk-zones/           sensitive places for the location-risk factor (non-paginated)
    POST         /api/contact/              public contact form (rate limited); GET/PATCH for admins
    GET          /api/geo/reverse/?lat=&lng=  Nominatim reverse geocoding proxy
    GET          /api/geo/search/?q=        Nominatim place search proxy

The module also holds small helpers shared by the B1 viewsets (accounts, departments, officers):
``subquery_count`` for N+1-free counters, ``snapshot`` / ``diff_snapshots`` for audit-log change sets, and
``AnnotatedWriteMixin`` so write responses have exactly the same shape as reads.
"""
import datetime
import logging
from decimal import Decimal

from django.conf import settings
from django.db import transaction
from django.db.models import Count, IntegerField, Subquery, Value
from django.db.models.fields.files import FieldFile
from django.db.models.functions import Coalesce
from rest_framework import mixins, status, viewsets
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

import ai
from ai.config import DEMO_BADGE, DEMO_DISCLAIMER, get_model_mode
from apps.audit.models import AuditLog
from apps.audit.services import log_action
from apps.complaints.models import Complaint, Level

from .geocoding import reverse_geocode, search_places
from .models import AIConfiguration, ContactMessage, RiskZone
from .permissions import IsAdmin, IsOfficerOrAdmin
from .serializers import (
    AIConfigurationSerializer,
    ContactMessageAdminSerializer,
    ContactMessageSerializer,
    PlaceSearchQuerySerializer,
    ReverseGeocodeQuerySerializer,
    RiskZoneSerializer,
)
from .throttles import CivicScopedRateThrottle
from .utils import ID_PATTERN

logger = logging.getLogger("apps.core")

TRUTHY = {"1", "true", "yes", "on"}


# ---------------------------------------------------------------------------------------------------------------
# Shared view helpers
# ---------------------------------------------------------------------------------------------------------------
def is_truthy(value):
    """Interpret query-string flags such as ``?include_inactive=true`` / ``?recalculate=1``."""
    return str(value).strip().lower() in TRUTHY


def subquery_count(queryset, group_by):
    """Correlated ``COUNT(*)`` sub-select for ``.annotate()``.

    ``queryset`` must be filtered against the outer row with ``OuterRef`` and ``group_by`` is the field
    that links them, e.g. ``subquery_count(Complaint.objects.filter(department=OuterRef("pk")), "department")``.
    Several ``Count()`` joins in one query multiply rows and inflate every counter; one sub-select per
    counter stays exact and still answers a whole page in a single SQL statement (no N+1 queries). Works
    the same on MySQL and SQLite. Rows without matches get 0 instead of NULL.
    """
    counts = queryset.order_by().values(group_by).annotate(total=Count("pk")).values("total")
    return Coalesce(Subquery(counts, output_field=IntegerField()), Value(0))


def json_safe(value):
    """Convert a model attribute to something ``AuditLog.changes`` (a JSONField) can store."""
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
        return value.isoformat()
    if isinstance(value, FieldFile):
        return value.name or None
    if isinstance(value, (set, tuple)):
        return [json_safe(item) for item in value]
    if isinstance(value, list):
        return [json_safe(item) for item in value]
    if isinstance(value, dict):
        return {str(key): json_safe(item) for key, item in value.items()}
    return value


def snapshot(instance, fields):
    """``{field: json-safe value}`` for audit logging; foreign keys are recorded by id."""
    data = {}
    for name in fields:
        field = instance._meta.get_field(name)
        attname = field.attname if getattr(field, "many_to_one", False) else name
        data[name] = json_safe(getattr(instance, attname))
    return data


def diff_snapshots(before, after):
    """Changed fields as ``{field: [old, new]}`` (the format stored in ``AuditLog.changes``)."""
    return {name: [before.get(name), value] for name, value in after.items() if before.get(name) != value}


class AnnotatedWriteMixin:
    """Return POST/PUT/PATCH responses in exactly the same shape as GET.

    Several list/detail querysets carry SQL annotations (counters, workload, ratings). ``serializer.save()``
    returns a plain model instance without them, so after a write the row is read again through
    ``get_queryset()`` and rendered with ``read_serializer_class`` (or the view's serializer). Subclasses
    implement ``perform_create`` / ``perform_update`` and return the saved instance (used for audit logs).
    """

    read_serializer_class = None

    def get_read_serializer(self, instance):
        serializer_class = self.read_serializer_class or self.get_serializer_class()
        return serializer_class(instance, context=self.get_serializer_context())

    def annotated_instance(self, instance):
        return self.get_queryset().get(pk=instance.pk)

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        instance = self.perform_create(serializer)
        data = self.get_read_serializer(self.annotated_instance(instance)).data
        return Response(data, status=status.HTTP_201_CREATED)

    def update(self, request, *args, **kwargs):
        partial = kwargs.pop("partial", False)
        serializer = self.get_serializer(self.get_object(), data=request.data, partial=partial)
        serializer.is_valid(raise_exception=True)
        instance = self.perform_update(serializer)
        return Response(self.get_read_serializer(self.annotated_instance(instance)).data)

    def perform_create(self, serializer):
        return serializer.save()

    def perform_update(self, serializer):
        return serializer.save()


# ---------------------------------------------------------------------------------------------------------------
# /api/system/config/
# ---------------------------------------------------------------------------------------------------------------
class SystemConfigView(APIView):
    """Public configuration the frontend needs before login (no secrets): AI mode for the
    "Demo AI Mode" badge, map defaults, upload limits, the reopen window and the status / level choices."""

    permission_classes = [AllowAny]

    def get(self, request):
        conf = getattr(settings, "CIVICAI", {})
        mode = get_model_mode()
        is_demo = mode != "production"
        return Response({
            "app_name": "CivicAI",
            "version": conf.get("VERSION", ai.__version__),
            "model_mode": mode,
            "is_demo": is_demo,
            "demo_badge": DEMO_BADGE if is_demo else None,
            "demo_disclaimer": DEMO_DISCLAIMER if is_demo else None,
            "map": {
                "center": [conf.get("DEFAULT_LAT", 17.385), conf.get("DEFAULT_LNG", 78.4867)],
                "zoom": 12,
                "city": conf.get("DEFAULT_CITY", "Hyderabad"),
            },
            "upload": {
                "max_image_mb": getattr(settings, "MAX_IMAGE_UPLOAD_MB", 8),
                "allowed_extensions": list(getattr(settings, "ALLOWED_IMAGE_EXTENSIONS", [])),
            },
            "geocoding_enabled": bool(conf.get("GEOCODING_ENABLED", True)),
            "reopen_window_days": conf.get("REOPEN_WINDOW_DAYS", 14),
            "statuses": [{"value": value, "label": label} for value, label in Complaint.Status.choices],
            "levels": [{"value": value, "label": label} for value, label in Level.choices],
        })


# ---------------------------------------------------------------------------------------------------------------
# /api/ai/config/
# ---------------------------------------------------------------------------------------------------------------
def recalculate_open_priorities(actor):
    """Re-run the priority engine for every open complaint (after weights / thresholds changed).

    Each complaint is recalculated in its own transaction so one failure cannot leave half-written rows or
    stop the others. If the complaints service is not available yet, nothing is recalculated and the
    response says so instead of pretending.
    """
    try:
        from apps.complaints.services.priority import recalculate_priority
    except ImportError:
        return {"recalculated": 0, "recalculation_failed": 0,
                "recalculation_detail": "The priority recalculation service is not available."}

    done = failed = 0
    complaints = (Complaint.objects.filter(status__in=Complaint.OPEN_STATUSES)
                  .select_related("category", "department", "location").order_by("pk"))
    for complaint in complaints.iterator(chunk_size=200):
        try:
            with transaction.atomic():
                recalculate_priority(complaint, trigger="config_change", actor=actor)
            done += 1
        except NotImplementedError:
            return {"recalculated": done, "recalculation_failed": failed,
                    "recalculation_detail": "The priority recalculation service is not implemented yet."}
        except Exception:
            logger.exception("Priority recalculation failed for complaint %s", complaint.pk)
            failed += 1
    result = {"recalculated": done, "recalculation_failed": failed}
    if failed:
        result["recalculation_detail"] = f"{failed} complaint(s) could not be recalculated; see the server log."
    return result


class AIConfigView(APIView):
    """GET (officer/admin) / PUT / PATCH (admin) the AIConfiguration singleton.

    Every change is audit-logged with old and new values. ``?recalculate=true`` additionally recalculates
    the priority of all open complaints with the new weights and reports ``"recalculated": n``.
    """

    def get_permissions(self):
        if self.request.method in ("GET", "HEAD", "OPTIONS"):
            return [IsOfficerOrAdmin()]
        return [IsAdmin()]

    def get(self, request):
        config = AIConfiguration.load()
        return Response(AIConfigurationSerializer(config, context={"request": request}).data)

    def put(self, request):
        return self._update(request, partial=False)

    def patch(self, request):
        return self._update(request, partial=True)

    def _update(self, request, *, partial):
        config = AIConfiguration.load()
        editable = [name for name in AIConfigurationSerializer().fields
                    if name not in AIConfigurationSerializer.Meta.read_only_fields]
        before = snapshot(config, editable)
        serializer = AIConfigurationSerializer(config, data=request.data, partial=partial, context={"request": request})
        serializer.is_valid(raise_exception=True)
        config = serializer.save(updated_by=request.user)
        changes = diff_snapshots(before, snapshot(config, editable))
        if changes:
            log_action(request.user, AuditLog.Action.CONFIG_CHANGE, entity=config,
                       description=f"AI configuration updated ({', '.join(sorted(changes))})",
                       changes=changes, request=request)
        data = dict(AIConfigurationSerializer(config, context={"request": request}).data)
        if is_truthy(request.query_params.get("recalculate", "")):
            data.update(recalculate_open_priorities(request.user))
        return Response(data)


# ---------------------------------------------------------------------------------------------------------------
# /api/risk-zones/
# ---------------------------------------------------------------------------------------------------------------
RISK_ZONE_AUDIT_FIELDS = ["name", "zone_type", "latitude", "longitude", "radius_m", "risk_level", "description",
                          "is_active"]


class RiskZoneViewSet(viewsets.ModelViewSet):
    """Risk zones CRUD. Read: officers/admins; write: admins. Non-paginated (the admin map shows them all).

    Filters: ``?zone_type=school``, ``?is_active=true``, ``?search=``.
    """

    serializer_class = RiskZoneSerializer
    pagination_class = None
    filterset_fields = ["zone_type", "is_active"]
    search_fields = ["name", "description"]
    ordering_fields = ["name", "risk_level", "radius_m", "created_at"]
    ordering = ["name"]
    lookup_value_regex = ID_PATTERN

    def get_queryset(self):
        return RiskZone.objects.all()

    def get_permissions(self):
        if self.action in ("list", "retrieve"):
            return [IsOfficerOrAdmin()]
        return [IsAdmin()]

    def perform_create(self, serializer):
        zone = serializer.save()
        log_action(self.request.user, AuditLog.Action.CREATE, entity=zone, description=f"Created risk zone {zone.name}",
                   changes=snapshot(zone, RISK_ZONE_AUDIT_FIELDS), request=self.request)

    def perform_update(self, serializer):
        before = snapshot(serializer.instance, RISK_ZONE_AUDIT_FIELDS)
        zone = serializer.save()
        changes = diff_snapshots(before, snapshot(zone, RISK_ZONE_AUDIT_FIELDS))
        if changes:
            log_action(self.request.user, AuditLog.Action.UPDATE, entity=zone,
                       description=f"Updated risk zone {zone.name}", changes=changes, request=self.request)

    def perform_destroy(self, instance):
        log_action(self.request.user, AuditLog.Action.DELETE, entity=instance,
                   description=f"Deleted risk zone {instance.name}",
                   changes=snapshot(instance, RISK_ZONE_AUDIT_FIELDS), request=self.request)
        instance.delete()


# ---------------------------------------------------------------------------------------------------------------
# /api/contact/
# ---------------------------------------------------------------------------------------------------------------
class ContactMessageViewSet(mixins.CreateModelMixin, mixins.ListModelMixin, mixins.RetrieveModelMixin,
                            mixins.UpdateModelMixin, viewsets.GenericViewSet):
    """POST (public, ``contact`` rate limit) - GET list / detail and PATCH ``{is_resolved}`` (admins)."""

    http_method_names = ["get", "post", "patch", "head", "options"]
    throttle_scope = "contact"
    filterset_fields = ["is_resolved"]
    search_fields = ["name", "email", "subject", "message"]
    ordering_fields = ["created_at", "is_resolved"]
    ordering = ["-created_at"]
    lookup_value_regex = ID_PATTERN

    def get_queryset(self):
        return ContactMessage.objects.all()

    def get_permissions(self):
        if self.action == "create":
            return [AllowAny()]
        return [IsAdmin()]

    def get_throttles(self):
        throttles = super().get_throttles()
        if self.action == "create":
            throttles.append(CivicScopedRateThrottle())
        return throttles

    def get_serializer_class(self):
        if self.action == "create":
            return ContactMessageSerializer
        return ContactMessageAdminSerializer

    def perform_update(self, serializer):
        before = snapshot(serializer.instance, ["is_resolved"])
        message = serializer.save()
        changes = diff_snapshots(before, snapshot(message, ["is_resolved"]))
        if changes:
            state = "resolved" if message.is_resolved else "open"
            log_action(self.request.user, AuditLog.Action.UPDATE, entity=message,
                       description=f"Contact message marked {state}: {message.subject}", changes=changes,
                       request=self.request)


# ---------------------------------------------------------------------------------------------------------------
# /api/geo/...
# ---------------------------------------------------------------------------------------------------------------
class GeoReverseView(APIView):
    """GET /api/geo/reverse/?lat=&lng= -> ``{"address", "area", "city", "pincode", "display_name", "source"}``.

    Invalid coordinates -> 400; geocoder problems -> ``"source": "fallback"`` (never a 500).
    """

    permission_classes = [AllowAny]

    def get(self, request):
        query = ReverseGeocodeQuerySerializer(data=request.query_params)
        query.is_valid(raise_exception=True)
        return Response(reverse_geocode(query.validated_data["lat"], query.validated_data["lng"]))


class GeoSearchView(APIView):
    """GET /api/geo/search/?q=&limit= -> ``[{"display_name", "latitude", "longitude", "address", "area", "city",
    "pincode"}]``. The ``X-Geocoding-Source`` header says whether Nominatim answered (``nominatim``), the
    geocoder was unavailable (``fallback``) or the query was too short to search (``skipped``)."""

    permission_classes = [AllowAny]

    def get(self, request):
        query = PlaceSearchQuerySerializer(data=request.query_params)
        query.is_valid(raise_exception=True)
        results, source = search_places(query.validated_data["q"], limit=query.validated_data["limit"])
        return Response(results, headers={"X-Geocoding-Source": source})
