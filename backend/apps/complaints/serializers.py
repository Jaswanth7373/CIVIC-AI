"""Serializers of the complaints API - the CANONICAL home of CivicAI's shared JSON shapes.

Every output shape here matches docs/BUILD_SPEC.md section 4.1 exactly, and the other apps import these
classes (``CategoryMiniSerializer``, ``UserMiniSerializer``, ``ComplaintListSerializer``,
``FeedbackSerializer``, ``TimelineEventSerializer`` ...) so an object looks the same in every endpoint.
Media URLs are absolute, so pass ``context={"request": request}``.

Query-efficiency technique (viva note)
--------------------------------------
A naive list serializer runs extra queries *per row* (thumbnail, latest AI prediction, ...), the
classic "N+1 queries" problem. The ``optimize_*_queryset`` helpers prepare querysets so that
serialization needs no further queries:

* ``select_related`` joins the many-to-one relations (category, department, officer, citizen,
  location) into the main SQL statement;
* correlated sub-queries (``Subquery`` / ``Exists`` annotations) let the database compute per-row facts
  - the thumbnail path, the newest AI prediction's confidence and demo flag, whether a pending
  duplicate pair exists - inside that same statement;
* ``Prefetch`` objects load one-to-many relations (images, predictions, timeline, assignments, ...)
  for all rows with one extra query per relation (used by the detail view).

The serializer methods read those annotations / prefetch caches first and fall back to a query only
when a caller passes a plain queryset, so the classes stay correct wherever they are reused.
"""
import math
from datetime import timedelta
from decimal import Decimal
from pathlib import Path

from django.conf import settings
from django.db.models import Exists, Model, OuterRef, Prefetch, Q, Subquery
from django.utils import timezone
from rest_framework import serializers

from apps.accounts.models import User
from apps.assignments.models import ComplaintAssignment
from apps.core.models import AIConfiguration
from apps.core.permissions import user_role, withholds_personal_data
from apps.core.utils import absolute_media_url, parse_id
from apps.core.fields import SafeImageField
from apps.departments.models import CivicCategory, Department
from apps.feedback.models import Feedback
from apps.officers.models import OfficerProfile

from .models import (
    AIPrediction,
    Complaint,
    ComplaintImage,
    DuplicateComplaint,
    Level,
    Location,
    PriorityScore,
    ResolutionEvidence,
    ResolutionVerification,
    StatusHistory,
)

# ---------------------------------------------------------------------------------------------------
# Queryset preparation (annotations + prefetching)
# ---------------------------------------------------------------------------------------------------
#: Annotation holding the storage name of a complaint's first photo (its thumbnail).
THUMBNAIL_ANNOTATION = "thumbnail_name"
#: Annotations copied from the complaint's newest ``AIPrediction``.
AI_CONFIDENCE_ANNOTATION = "latest_ai_confidence"
AI_IS_DEMO_ANNOTATION = "latest_ai_is_demo"
#: Annotation: does a duplicate pair involving this complaint still wait for review?
PENDING_DUPLICATES_ANNOTATION = "pending_duplicates_exist"

LIST_SELECT_RELATED = ("category", "department", "assigned_officer", "citizen", "location")
MAP_FIELDS = (
    "id", "complaint_number", "title", "severity", "priority_level", "priority_score", "status", "created_at",
    "category__id", "category__name", "category__slug", "category__icon", "category__color",
    "location__latitude", "location__longitude", "location__area",
)

_MISSING = object()
_COMPLAINT_IMAGE_FIELD = ComplaintImage._meta.get_field("image")


def _images_by_id():
    return ComplaintImage.objects.order_by("id")


def thumbnail_subquery():
    """Storage name of the complaint's first image (lowest id), computed by the database."""
    return Subquery(_images_by_id().filter(complaint_id=OuterRef("pk")).values("image")[:1])


def latest_prediction_subquery(field):
    """One column of the complaint's newest AI prediction (``ORDER BY created_at DESC, id DESC LIMIT 1``)."""
    newest = AIPrediction.objects.filter(complaint_id=OuterRef("pk")).order_by("-created_at", "-id")
    return Subquery(newest.values(field)[:1])


def pending_duplicates_exists():
    """``EXISTS`` sub-query: a duplicate pair on either side of the complaint is still pending review."""
    return Exists(
        DuplicateComplaint.objects.filter(
            Q(complaint_id=OuterRef("pk")) | Q(similar_complaint_id=OuterRef("pk")),
            status=DuplicateComplaint.Status.PENDING_REVIEW,
        )
    )


def optimize_complaint_list_queryset(queryset):
    """Prepare a Complaint queryset for :class:`ComplaintListSerializer` (one SQL query per page)."""
    return queryset.select_related(*LIST_SELECT_RELATED).annotate(
        **{
            THUMBNAIL_ANNOTATION: thumbnail_subquery(),
            AI_CONFIDENCE_ANNOTATION: latest_prediction_subquery("multimodal_confidence"),
            AI_IS_DEMO_ANNOTATION: latest_prediction_subquery("is_demo"),
            PENDING_DUPLICATES_ANNOTATION: pending_duplicates_exists(),
        }
    )


def optimize_complaint_mini_queryset(queryset):
    """Prepare a Complaint queryset for :class:`ComplaintMiniSerializer`."""
    return queryset.select_related("category", "location").annotate(**{THUMBNAIL_ANNOTATION: thumbnail_subquery()})


def optimize_complaint_map_queryset(queryset):
    """Prepare a Complaint queryset for :class:`ComplaintMapSerializer`.

    The map can hold thousands of pins, so ``only()`` restricts the SELECT to the columns the pin
    needs (descriptions, JSON blobs etc. are never transferred) and the thumbnail is a sub-query.
    """
    return (
        queryset.select_related("category", "location")
        .only(*MAP_FIELDS)
        .annotate(**{THUMBNAIL_ANNOTATION: thumbnail_subquery()})
    )


def duplicate_link_queryset(other):
    """DuplicateComplaint rows with the *other* complaint (``"complaint"`` or ``"similar_complaint"``)
    pre-joined, plus its images prefetched for the ComplaintMini thumbnail."""
    return DuplicateComplaint.objects.select_related(f"{other}__category", f"{other}__location", "reviewed_by").prefetch_related(
        Prefetch(f"{other}__images", queryset=_images_by_id())
    )


def optimize_duplicate_pair_queryset(queryset):
    """Prepare a DuplicateComplaint queryset for :class:`DuplicatePairSerializer`."""
    return queryset.select_related(
        "complaint__category", "complaint__location", "similar_complaint__category", "similar_complaint__location",
        "reviewed_by",
    ).prefetch_related(
        Prefetch("complaint__images", queryset=_images_by_id()),
        Prefetch("similar_complaint__images", queryset=_images_by_id()),
    )


def optimize_complaint_detail_queryset(queryset):
    """Prepare a Complaint queryset for :class:`ComplaintDetailSerializer` - a fixed number of queries
    (one per related collection) no matter how long the timeline or duplicate list is."""
    return queryset.select_related(
        *LIST_SELECT_RELATED, "reported_category", "duplicate_of__category", "duplicate_of__location",
    ).prefetch_related(
        Prefetch("images", queryset=_images_by_id()),
        Prefetch(
            "predictions",
            queryset=AIPrediction.objects.select_related("final_category").defer("raw_output").order_by("-created_at", "-id"),
        ),
        Prefetch("priority_scores", queryset=PriorityScore.objects.order_by("-created_at", "-id")),
        Prefetch(
            "assignments",
            queryset=ComplaintAssignment.objects.select_related(
                "officer__officer_profile__department", "department", "assigned_by"
            ).order_by("-assigned_at", "-id"),
        ),
        Prefetch("evidence", queryset=ResolutionEvidence.objects.select_related("uploaded_by").order_by("-uploaded_at", "-id")),
        Prefetch(
            "verifications",
            queryset=ResolutionVerification.objects.select_related("verified_by").order_by("-verified_at", "-id"),
        ),
        Prefetch("feedback", queryset=Feedback.objects.select_related("citizen").order_by("-created_at", "-id")),
        Prefetch("status_history", queryset=StatusHistory.objects.select_related("changed_by").order_by("timestamp", "id")),
        Prefetch("duplicate_candidates", queryset=duplicate_link_queryset("similar_complaint")),
        Prefetch("similar_to", queryset=duplicate_link_queryset("complaint")),
        Prefetch("duplicate_of__images", queryset=_images_by_id()),
    )


# ---------------------------------------------------------------------------------------------------
# Small helpers shared by the serializers
# ---------------------------------------------------------------------------------------------------
def _request(context):
    return (context or {}).get("request")


def _prefetched(instance, relation):
    """Rows of ``relation`` loaded by ``prefetch_related`` (``None`` when it was not prefetched)."""
    cache = getattr(instance, "_prefetched_objects_cache", None)
    if cache and relation in cache:
        return list(cache[relation])
    return None


def _rows(instance, relation):
    """Prefetched rows of a reverse relation, or a fresh query when the caller did not prefetch."""
    rows = _prefetched(instance, relation)
    return rows if rows is not None else list(getattr(instance, relation).all())


def _newest_first(rows, *attributes):
    return sorted(rows, key=lambda row: tuple(getattr(row, name) for name in attributes), reverse=True)


def stored_file_url(request, name, field=_COMPLAINT_IMAGE_FIELD):
    """Absolute URL of a stored file given its storage name (used with the thumbnail annotation)."""
    if not name:
        return None
    url = field.storage.url(name)
    return request.build_absolute_uri(url) if request is not None else url


def complaint_thumbnail_url(complaint, request):
    """Absolute URL of the complaint's first photo: annotation -> prefetched images -> query."""
    name = getattr(complaint, THUMBNAIL_ANNOTATION, _MISSING)
    if name is not _MISSING:
        return stored_file_url(request, name)
    images = _prefetched(complaint, "images")
    image = min(images, key=lambda img: img.pk, default=None) if images is not None else complaint.primary_image
    return absolute_media_url(request, image.image) if image is not None else None


def latest_prediction_of(complaint):
    """Newest AIPrediction of a complaint (prefetched rows first; one cached query otherwise)."""
    rows = _prefetched(complaint, "predictions")
    if rows is not None:
        newest = _newest_first(rows, "created_at", "id")
        return newest[0] if newest else None
    cached = getattr(complaint, "_latest_prediction_cache", _MISSING)
    if cached is _MISSING:
        cached = complaint.latest_prediction
        complaint._latest_prediction_cache = cached
    return cached


def complaint_has_pending_duplicates(complaint):
    """True when a duplicate pair involving the complaint (either side) is pending review."""
    flag = getattr(complaint, PENDING_DUPLICATES_ANNOTATION, _MISSING)
    if flag is not _MISSING:
        return bool(flag)
    newer, older = _prefetched(complaint, "duplicate_candidates"), _prefetched(complaint, "similar_to")
    if newer is not None and older is not None:
        return any(link.status == DuplicateComplaint.Status.PENDING_REVIEW for link in newer + older)
    return DuplicateComplaint.objects.filter(
        Q(complaint_id=complaint.pk) | Q(similar_complaint_id=complaint.pk),
        status=DuplicateComplaint.Status.PENDING_REVIEW,
    ).exists()


def sort_duplicate_links(links):
    """Most similar first, then newest."""
    return sorted(links, key=lambda link: (link.overall_similarity, link.created_at, link.pk), reverse=True)


def complaint_duplicate_links(complaint):
    """Every DuplicateComplaint row touching ``complaint`` - BOTH directions:

    * rows where ``complaint`` is the newer report (``complaint=this``) -> the other side is its original;
    * rows where ``complaint`` is the original (``similar_complaint=this``) -> the other side duplicates it.
    """
    newer = _prefetched(complaint, "duplicate_candidates")
    older = _prefetched(complaint, "similar_to")
    if newer is None:
        newer = list(duplicate_link_queryset("similar_complaint").filter(complaint_id=complaint.pk))
    if older is None:
        older = list(duplicate_link_queryset("complaint").filter(similar_complaint_id=complaint.pk))
    return sort_duplicate_links(newer + older)


def _viewer_role(context):
    request = _request(context)
    return user_role(getattr(request, "user", None))


def _role_label(role):
    return dict(User.Role.choices).get(role, (role or "").title())


def _officer_profile(user):
    return getattr(user, "officer_profile", None)  # missing reverse 1:1 raises an AttributeError subclass


# ---------------------------------------------------------------------------------------------------
# Shared "mini" shapes
# ---------------------------------------------------------------------------------------------------
class CategoryMiniSerializer(serializers.ModelSerializer):
    """``{"id", "name", "slug", "icon", "color"}``"""

    class Meta:
        model = CivicCategory
        fields = ("id", "name", "slug", "icon", "color")
        read_only_fields = fields


class DepartmentMiniSerializer(serializers.ModelSerializer):
    """``{"id", "name", "code", "icon", "color"}``"""

    class Meta:
        model = Department
        fields = ("id", "name", "code", "icon", "color")
        read_only_fields = fields


class UserMiniSerializer(serializers.ModelSerializer):
    """``{"id", "full_name", "email", "role", "avatar" (absolute URL | null), "phone"}``"""

    full_name = serializers.CharField(read_only=True)
    role = serializers.SerializerMethodField()
    avatar = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = ("id", "full_name", "email", "role", "avatar", "phone")
        read_only_fields = fields

    def get_role(self, obj):
        return user_role(obj) or obj.role  # superusers are always reported as admins

    def get_avatar(self, obj):
        return absolute_media_url(_request(self.context), obj.avatar)

    def to_representation(self, instance):
        data = super().to_representation(instance)
        if withholds_personal_data(getattr(_request(self.context), "user", None), instance.pk):
            data.update(email=None, phone=None)  # a citizen never receives staff / other citizens' contacts
        return data


class OfficerMiniSerializer(UserMiniSerializer):
    """UserMini + ``{"employee_id", "designation", "zone", "department": DepartmentMini|null, "is_available"}``.

    Accepts a ``User`` (role officer) or an ``OfficerProfile``. For a user without an officer profile the
    profile fields are ``null`` (unknown) - the same convention as ``apps.officers.serializers``.
    """

    def to_representation(self, instance):
        if isinstance(instance, OfficerProfile):
            profile, user = instance, instance.user
        else:
            user, profile = instance, _officer_profile(instance)
        data = super().to_representation(user)
        if profile is None:
            data.update(dict.fromkeys(("employee_id", "designation", "zone", "department", "is_available")))
            return data
        department = profile.department if profile.department_id else None
        data.update(
            {
                "employee_id": profile.employee_id,
                "designation": profile.designation,
                "zone": profile.zone,
                "department": DepartmentMiniSerializer(department, context=self.context).data if department else None,
                "is_available": bool(profile.is_available),
            }
        )
        return data


class FiniteFloatField(serializers.FloatField):
    """FloatField that rejects NaN / Infinity (``float("nan")`` silently passes min/max validators)."""

    default_error_messages = {"not_finite": "A finite number is required."}

    def to_internal_value(self, data):
        value = super().to_internal_value(data)
        if not math.isfinite(value):
            self.fail("not_finite")
        return value


class LocationSerializer(serializers.ModelSerializer):
    """LocationOut: ``{"latitude", "longitude", "address", "landmark", "area", "city", "pincode"}``
    (coordinates as JSON numbers)."""

    latitude = FiniteFloatField(min_value=-90, max_value=90)
    longitude = FiniteFloatField(min_value=-180, max_value=180)

    class Meta:
        model = Location
        fields = ("latitude", "longitude", "address", "landmark", "area", "city", "pincode")


class ComplaintMiniSerializer(serializers.ModelSerializer):
    """ComplaintMini - compact complaint card used inside other objects (duplicates, feedback requests)."""

    status_display = serializers.CharField(source="get_status_display", read_only=True)
    category = CategoryMiniSerializer(read_only=True)
    thumbnail = serializers.SerializerMethodField()
    location = LocationSerializer(read_only=True)

    class Meta:
        model = Complaint
        fields = (
            "id", "complaint_number", "title", "description", "status", "status_display", "category", "thumbnail",
            "created_at", "location", "priority_score", "priority_level", "severity",
        )
        read_only_fields = fields

    def get_thumbnail(self, obj):
        return complaint_thumbnail_url(obj, _request(self.context))

    def to_representation(self, instance):
        data = super().to_representation(instance)
        if withholds_personal_data(getattr(_request(self.context), "user", None), instance.citizen_id):
            return redacted_complaint_mini(data, instance)
        return data


def redacted_complaint_mini(data, complaint):
    """ComplaintMini of *another* citizen's report, as a citizen may see it (e.g. a match of the "similar issues
    nearby" check or a duplicate link): what is needed to recognise the same problem - number, category, status,
    priority, date and the area - but not that citizen's own words, photo, title or exact address."""
    location = data.get("location") or {}
    area = (location.get("area") or "").strip()
    category = data.get("category") or {}
    name = category.get("name") or "Civic issue"
    return {
        **data,
        "title": f"{name} in {area}" if area else name,
        "description": "",
        "thumbnail": None,
        "location": {
            "latitude": None, "longitude": None, "address": "", "landmark": "", "area": area,
            "city": location.get("city") or "", "pincode": "",
        } if location else None,
    }


# ---------------------------------------------------------------------------------------------------
# Related objects shown on the complaint detail page
# ---------------------------------------------------------------------------------------------------
class ComplaintImageSerializer(serializers.ModelSerializer):
    """``{"id", "url", "kind", "width", "height", "phash", "uploaded_at"}``"""

    url = serializers.SerializerMethodField()

    class Meta:
        model = ComplaintImage
        fields = ("id", "url", "kind", "width", "height", "phash", "uploaded_at")
        read_only_fields = fields

    def get_url(self, obj):
        return absolute_media_url(_request(self.context), obj.image)


class AIPredictionSerializer(serializers.ModelSerializer):
    """Stored output of the multimodal AI analysis of one complaint."""

    final_category = CategoryMiniSerializer(read_only=True)
    probabilities = serializers.SerializerMethodField()

    class Meta:
        model = AIPrediction
        fields = (
            "id", "image_category", "image_confidence", "text_category", "text_confidence", "final_category",
            "final_category_slug", "multimodal_confidence", "severity", "severity_score", "severity_reason",
            "severity_factors", "detected_objects", "bounding_boxes", "keywords", "impacts", "probabilities",
            "modality_weights", "location_risk", "explanation", "needs_review", "model_mode", "is_demo",
            "model_version", "processing_time_ms", "created_at",
        )
        read_only_fields = fields

    def get_probabilities(self, obj):
        """Always ``{"image": {...}, "text": {...}, "fused": {...}}`` (a missing modality is ``{}``)."""
        stored = obj.probabilities if isinstance(obj.probabilities, dict) else {}
        return {key: stored.get(key) or {} for key in ("image", "text", "fused")}


#: (key, label, PriorityScore column) for the five priority components, in display order.
PRIORITY_COMPONENTS = (
    ("severity", "Severity", "severity_component"),
    ("public_impact", "Public Impact", "impact_component"),
    ("location_risk", "Location Risk", "location_component"),
    ("frequency", "Frequency", "frequency_component"),
    ("duplicates", "Duplicates", "duplicate_component"),
)
PRIORITY_WEIGHT_KEYS = tuple(key for key, _, _ in PRIORITY_COMPONENTS)
#: Default weights (percent) = the AIConfiguration model defaults (40/25/15/10/10).
DEFAULT_PRIORITY_WEIGHTS = {
    key: float(AIConfiguration._meta.get_field(f"weight_{key}").default) for key in PRIORITY_WEIGHT_KEYS
}


def _as_float(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


class PriorityBreakdownSerializer(serializers.ModelSerializer):
    """One stored priority calculation with its five weighted components.

    The engine computes ``component = weight x factor`` (factor in 0..1, weights normalised to sum to
    100), so for each component ``max`` is its normalised weight and ``raw = score / max`` recovers the
    factor that produced the bar. Weights come from the row itself (the configuration in force at
    calculation time) and fall back to the default weights when a row did not store them.
    """

    components = serializers.SerializerMethodField()

    class Meta:
        model = PriorityScore
        fields = (
            "final_score", "priority_level", "components", "severity_component", "impact_component",
            "location_component", "frequency_component", "duplicate_component", "weights", "factors",
            "explanation", "trigger", "is_override", "created_at",
        )
        read_only_fields = fields

    def get_components(self, obj):
        stored = obj.weights if isinstance(obj.weights, dict) else {}
        weights = {}
        for key in PRIORITY_WEIGHT_KEYS:
            value = _as_float(stored.get(key))
            weights[key] = value if value is not None and value >= 0 else DEFAULT_PRIORITY_WEIGHTS[key]
        total = sum(weights.values())
        components = []
        for key, label, column in PRIORITY_COMPONENTS:
            score = _as_float(getattr(obj, column)) or 0.0
            maximum = weights[key] * 100.0 / total if total > 0 else 0.0
            raw = min(1.0, max(0.0, score / maximum)) if maximum > 0 else 0.0
            components.append(
                {"key": key, "label": label, "score": round(score, 2), "max": round(maximum, 2), "raw": round(raw, 4)}
            )
        return components


class DuplicateLinkSerializer(serializers.ModelSerializer):
    """A duplicate pair seen from one complaint (pass ``context["viewed_complaint_id"]``).

    ``direction: "original"`` - the viewed complaint is the newer report and ``other`` is the earlier
    original; ``direction: "duplicate"`` - the viewed complaint is the original and ``other`` is a newer
    report that looks like a duplicate of it.
    """

    direction = serializers.SerializerMethodField()
    other = serializers.SerializerMethodField()
    status_display = serializers.CharField(source="get_status_display", read_only=True)
    reviewed_by = UserMiniSerializer(read_only=True)

    class Meta:
        model = DuplicateComplaint
        fields = (
            "id", "direction", "other", "text_similarity", "image_similarity", "location_similarity",
            "overall_similarity", "distance_m", "category_match", "status", "status_display", "explanation",
            "reviewed_by", "reviewed_at", "created_at",
        )
        read_only_fields = fields

    def _viewing_newer_side(self, obj):
        viewed = self.context.get("viewed_complaint_id", obj.complaint_id)
        return obj.complaint_id == viewed

    def get_direction(self, obj):
        return "original" if self._viewing_newer_side(obj) else "duplicate"

    def get_other(self, obj):
        other = obj.similar_complaint if self._viewing_newer_side(obj) else obj.complaint
        return ComplaintMiniSerializer(other, context=self.context).data


class DuplicatePairSerializer(serializers.ModelSerializer):
    """A duplicate pair for the admin/officer review queue (``/api/duplicates/``)."""

    complaint = ComplaintMiniSerializer(read_only=True)
    similar_complaint = ComplaintMiniSerializer(read_only=True)
    status_display = serializers.CharField(source="get_status_display", read_only=True)
    reviewed_by = UserMiniSerializer(read_only=True)

    class Meta:
        model = DuplicateComplaint
        fields = (
            "id", "complaint", "similar_complaint", "text_similarity", "image_similarity", "location_similarity",
            "overall_similarity", "distance_m", "category_match", "status", "status_display", "explanation",
            "reviewed_by", "reviewed_at", "review_notes", "created_at",
        )
        read_only_fields = fields


class AssignmentSerializer(serializers.ModelSerializer):
    """Assignment of a complaint to an officer (one row per assignment / reassignment)."""

    complaint = serializers.IntegerField(source="complaint_id", read_only=True)
    officer = OfficerMiniSerializer(read_only=True)
    department = DepartmentMiniSerializer(read_only=True)
    assigned_by = UserMiniSerializer(read_only=True)
    assignment_type_display = serializers.CharField(source="get_assignment_type_display", read_only=True)
    status_display = serializers.CharField(source="get_status_display", read_only=True)

    class Meta:
        model = ComplaintAssignment
        fields = (
            "id", "complaint", "officer", "department", "assigned_by", "assignment_type", "assignment_type_display",
            "status", "status_display", "is_active", "recommendation_score", "recommendation_reasons", "notes",
            "assigned_at", "accepted_at", "completed_at",
        )
        read_only_fields = fields


class EvidenceSerializer(serializers.ModelSerializer):
    """Before / after resolution photos uploaded by the officer."""

    before_image = serializers.SerializerMethodField()
    after_image = serializers.SerializerMethodField()
    uploaded_by = UserMiniSerializer(read_only=True)

    class Meta:
        model = ResolutionEvidence
        fields = ("id", "before_image", "after_image", "uploaded_by", "remarks", "uploaded_at")
        read_only_fields = fields

    def get_before_image(self, obj):
        return absolute_media_url(_request(self.context), obj.before_image)

    def get_after_image(self, obj):
        return absolute_media_url(_request(self.context), obj.after_image)


class VerificationSerializer(serializers.ModelSerializer):
    """AI-assisted (or manual) resolution verification result."""

    evidence_id = serializers.IntegerField(read_only=True, allow_null=True)
    status_display = serializers.CharField(source="get_status_display", read_only=True)
    method_display = serializers.CharField(source="get_method_display", read_only=True)
    verified_by = UserMiniSerializer(read_only=True)

    class Meta:
        model = ResolutionVerification
        fields = (
            "id", "evidence_id", "score", "status", "status_display", "explanation", "metrics", "method",
            "method_display", "is_manual_override", "manual_review_requested", "verified_by", "verified_at",
            "model_version", "is_demo",
        )
        read_only_fields = fields


class FeedbackSerializer(serializers.ModelSerializer):
    """Citizen feedback with its NLP sentiment (department / category are the complaint's)."""

    complaint = serializers.IntegerField(source="complaint_id", read_only=True)
    complaint_number = serializers.CharField(source="complaint.complaint_number", read_only=True)
    complaint_title = serializers.CharField(source="complaint.title", read_only=True)
    citizen = UserMiniSerializer(read_only=True)
    sentiment_display = serializers.CharField(source="get_sentiment_display", read_only=True)
    department = DepartmentMiniSerializer(source="complaint.department", read_only=True)
    category = CategoryMiniSerializer(source="complaint.category", read_only=True)

    class Meta:
        model = Feedback
        fields = (
            "id", "complaint", "complaint_number", "complaint_title", "citizen", "rating", "text", "sentiment",
            "sentiment_display", "sentiment_score", "sentiment_confidence", "sentiment_model", "is_demo",
            "department", "category", "created_at",
        )
        read_only_fields = fields


class TimelineEventSerializer(serializers.ModelSerializer):
    """One timeline entry. ``actor_label`` is "CivicAI Engine" for system/AI events, else "Name (Role)"."""

    event_display = serializers.CharField(source="get_event_display", read_only=True)
    changed_by = UserMiniSerializer(read_only=True)
    actor_label = serializers.SerializerMethodField()

    class Meta:
        model = StatusHistory
        fields = (
            "id", "event", "event_display", "old_status", "new_status", "changed_by", "actor_label", "remarks",
            "metadata", "is_public", "timestamp",
        )
        read_only_fields = fields

    def get_actor_label(self, obj):
        actor = obj.changed_by
        if actor is None:
            return "CivicAI Engine"
        return f"{actor.full_name} ({_role_label(user_role(actor) or actor.role)})"


# ---------------------------------------------------------------------------------------------------
# Complaint list / detail / map
# ---------------------------------------------------------------------------------------------------
class ComplaintListSerializer(serializers.ModelSerializer):
    """ComplaintList - rows of every complaint list. Prepare querysets with
    :func:`optimize_complaint_list_queryset` (other apps should do the same) to avoid per-row queries."""

    category = CategoryMiniSerializer(read_only=True)
    status_display = serializers.CharField(source="get_status_display", read_only=True)
    department = DepartmentMiniSerializer(read_only=True)
    assigned_officer = UserMiniSerializer(read_only=True)
    citizen = UserMiniSerializer(read_only=True)
    location = LocationSerializer(read_only=True)
    thumbnail = serializers.SerializerMethodField()
    has_pending_duplicates = serializers.SerializerMethodField()
    is_overdue = serializers.BooleanField(read_only=True)
    ai_is_demo = serializers.SerializerMethodField()
    ai_confidence = serializers.SerializerMethodField()

    class Meta:
        model = Complaint
        fields = (
            "id", "complaint_number", "title", "description", "category", "status", "status_display", "severity",
            "severity_score", "priority_score", "priority_level", "department", "assigned_officer", "citizen",
            "location", "thumbnail", "duplicate_count", "has_pending_duplicates", "is_overdue", "sla_due_at",
            "ai_is_demo", "ai_confidence", "needs_manual_review", "created_at", "updated_at", "resolved_at",
        )
        read_only_fields = fields

    def get_thumbnail(self, obj):
        return complaint_thumbnail_url(obj, _request(self.context))

    def get_has_pending_duplicates(self, obj):
        return complaint_has_pending_duplicates(obj)

    def get_ai_is_demo(self, obj):
        flag = getattr(obj, AI_IS_DEMO_ANNOTATION, _MISSING)
        if flag is _MISSING:
            prediction = latest_prediction_of(obj)
            flag = prediction.is_demo if prediction else False
        return bool(flag)  # False when the complaint has not been analysed yet

    def get_ai_confidence(self, obj):
        value = getattr(obj, AI_CONFIDENCE_ANNOTATION, _MISSING)
        if value is _MISSING:
            prediction = latest_prediction_of(obj)
            value = prediction.multimodal_confidence if prediction else None
        return float(value) if value is not None else None


class ComplaintDetailSerializer(ComplaintListSerializer):
    """ComplaintDetail = ComplaintList + every related collection of the complaint page.

    Use with :func:`optimize_complaint_detail_queryset`. Citizens only receive public timeline events;
    ``allowed_actions`` comes from the lifecycle service and drives which buttons the frontend shows.
    """

    reported_category = CategoryMiniSerializer(read_only=True)
    images = serializers.SerializerMethodField()
    ai_prediction = serializers.SerializerMethodField()
    priority = serializers.SerializerMethodField()
    duplicates = serializers.SerializerMethodField()
    duplicate_of = ComplaintMiniSerializer(read_only=True)
    current_assignment = serializers.SerializerMethodField()
    assignments = serializers.SerializerMethodField()
    evidence = serializers.SerializerMethodField()
    latest_verification = serializers.SerializerMethodField()
    verifications = serializers.SerializerMethodField()
    feedback = serializers.SerializerMethodField()
    timeline = serializers.SerializerMethodField()
    allowed_actions = serializers.SerializerMethodField()
    can_reopen_until = serializers.SerializerMethodField()

    class Meta(ComplaintListSerializer.Meta):
        fields = ComplaintListSerializer.Meta.fields + (
            "incident_at", "reported_category", "images", "ai_prediction", "priority", "duplicates", "duplicate_of",
            "current_assignment", "assignments", "evidence", "latest_verification", "verifications", "feedback",
            "timeline", "allowed_actions", "is_ai_overridden", "reopen_count", "accepted_at", "verified_at",
            "closed_at", "can_reopen_until",
        )
        read_only_fields = fields

    # --- collections -------------------------------------------------------------------------------
    def get_images(self, obj):
        images = sorted(_rows(obj, "images"), key=lambda image: image.pk)
        return ComplaintImageSerializer(images, many=True, context=self.context).data

    def get_ai_prediction(self, obj):
        prediction = latest_prediction_of(obj)
        return AIPredictionSerializer(prediction, context=self.context).data if prediction else None

    def get_priority(self, obj):
        scores = _newest_first(_rows(obj, "priority_scores"), "created_at", "id")
        return PriorityBreakdownSerializer(scores[0], context=self.context).data if scores else None

    def get_duplicates(self, obj):
        context = {**self.context, "viewed_complaint_id": obj.pk}
        return DuplicateLinkSerializer(complaint_duplicate_links(obj), many=True, context=context).data

    def _assignments(self, obj):
        return _newest_first(_rows(obj, "assignments"), "assigned_at", "id")

    def get_current_assignment(self, obj):
        active = next((row for row in self._assignments(obj) if row.is_active), None)
        return AssignmentSerializer(active, context=self.context).data if active else None

    def get_assignments(self, obj):
        return AssignmentSerializer(self._assignments(obj), many=True, context=self.context).data

    def get_evidence(self, obj):
        rows = _newest_first(_rows(obj, "evidence"), "uploaded_at", "id")
        return EvidenceSerializer(rows, many=True, context=self.context).data

    def _verifications(self, obj):
        return _newest_first(_rows(obj, "verifications"), "verified_at", "id")

    def get_latest_verification(self, obj):
        rows = self._verifications(obj)
        return VerificationSerializer(rows[0], context=self.context).data if rows else None

    def get_verifications(self, obj):
        return VerificationSerializer(self._verifications(obj), many=True, context=self.context).data

    def get_feedback(self, obj):
        rows = _newest_first(_rows(obj, "feedback"), "created_at", "id")
        return FeedbackSerializer(rows, many=True, context=self.context).data

    def get_timeline(self, obj):
        events = sorted(_rows(obj, "status_history"), key=lambda event: (event.timestamp, event.pk))
        if _viewer_role(self.context) in ("citizen", None):  # citizens (or unknown viewers) see public events only
            events = [event for event in events if event.is_public]
        return TimelineEventSerializer(events, many=True, context=self.context).data

    # --- derived values ----------------------------------------------------------------------------
    def get_allowed_actions(self, obj):
        request = _request(self.context)
        user = getattr(request, "user", None)
        if user is None or not user.is_authenticated:
            return []
        from .services import status as lifecycle  # lazy: services may import these serializers

        try:
            actions = lifecycle.get_allowed_actions(obj, user)
        except NotImplementedError:
            return []
        return list(actions or [])

    def get_can_reopen_until(self, obj):
        """Deadline for a citizen reopen: ``resolved_at + REOPEN_WINDOW_DAYS`` once resolved/verified/closed."""
        if obj.status not in Complaint.RESOLVED_STATUSES or obj.resolved_at is None:
            return None
        deadline = obj.resolved_at + timedelta(days=settings.CIVICAI["REOPEN_WINDOW_DAYS"])
        return serializers.DateTimeField().to_representation(deadline)


class ComplaintMapSerializer(serializers.ModelSerializer):
    """One map pin. Prepare querysets with :func:`optimize_complaint_map_queryset`."""

    latitude = serializers.FloatField(source="location.latitude", read_only=True)
    longitude = serializers.FloatField(source="location.longitude", read_only=True)
    category = CategoryMiniSerializer(read_only=True)
    status_display = serializers.CharField(source="get_status_display", read_only=True)
    thumbnail = serializers.SerializerMethodField()
    area = serializers.CharField(source="location.area", read_only=True)

    class Meta:
        model = Complaint
        fields = (
            "id", "complaint_number", "title", "latitude", "longitude", "category", "severity", "priority_level",
            "priority_score", "status", "status_display", "created_at", "thumbnail", "area",
        )
        read_only_fields = fields

    def get_thumbnail(self, obj):
        return complaint_thumbnail_url(obj, _request(self.context))


class AIConfigSnapshotSerializer(serializers.ModelSerializer):
    """Read-only copy of every AIConfiguration field (embedded in ``/api/ai/model-info/``)."""

    updated_by = UserMiniSerializer(read_only=True)

    class Meta:
        model = AIConfiguration
        fields = "__all__"


# ---------------------------------------------------------------------------------------------------
# Request (input) serializers
# ---------------------------------------------------------------------------------------------------
#: Tolerated client clock skew when checking that an incident time is not in the future.
INCIDENT_CLOCK_SKEW = timedelta(minutes=5)
TEXT_MAX = 2000


def image_upload_field(**kwargs):
    """Photo upload field: the shared validator (extension, size, real format, dimension and pixel limits) runs
    before decoding, then the photo is replaced by its sanitised copy (downscaled, EXIF/GPS stripped, random name);
    see :class:`apps.core.fields.SafeImageField`."""
    return SafeImageField(**kwargs)


def validate_not_in_future(value):
    if value is not None and value > timezone.now() + INCIDENT_CLOCK_SKEW:
        raise serializers.ValidationError("The incident time cannot be in the future.")
    return value


class CategoryReferenceField(serializers.Field):
    """Accepts a category id (``3`` / ``"3"``) or slug (``"pothole"``) and returns the CivicCategory.

    A blank value means "no category". Only active categories are accepted unless ``active_only=False``.
    """

    default_error_messages = {
        "invalid": "Send a category id or slug.",
        "not_found": "Unknown category '{value}'. Send the id or slug of an active category.",
    }

    def __init__(self, *, active_only=True, **kwargs):
        self.active_only = active_only
        super().__init__(**kwargs)

    def to_internal_value(self, data):
        if isinstance(data, CivicCategory):
            return data
        if isinstance(data, bool) or not isinstance(data, (str, int)):
            self.fail("invalid")
        value = str(data).strip()
        if not value:
            return None
        queryset = CivicCategory.objects.filter(is_active=True) if self.active_only else CivicCategory.objects.all()
        category_id = parse_id(value)
        lookup = {"pk": category_id} if category_id is not None else {"slug": value}
        category = queryset.filter(**lookup).first()
        if category is None:
            self.fail("not_found", value=value)
        return category

    def to_representation(self, value):
        return CategoryMiniSerializer(value, context=self.context).data if value else None


def _round_coordinate(value):
    return round(value, 6)  # the database stores 6 decimal places (~0.1 m)


class ComplaintCreateSerializer(serializers.Serializer):
    """Validates ``POST /api/complaints/`` (multipart) before ``submission.submit_complaint`` runs."""

    description = serializers.CharField(min_length=10, max_length=TEXT_MAX)
    image = image_upload_field(required=False, allow_null=True)
    latitude = FiniteFloatField(min_value=-90, max_value=90)
    longitude = FiniteFloatField(min_value=-180, max_value=180)
    address = serializers.CharField(max_length=255, allow_blank=True, default="")
    landmark = serializers.CharField(max_length=150, allow_blank=True, default="")
    area = serializers.CharField(max_length=120, allow_blank=True, default="")
    city = serializers.CharField(max_length=100, allow_blank=True, default="")
    pincode = serializers.CharField(max_length=10, allow_blank=True, default="")
    category = CategoryReferenceField(default=None, allow_null=True)
    title = serializers.CharField(max_length=160, allow_blank=True, default="")
    incident_at = serializers.DateTimeField(required=False)

    def validate_latitude(self, value):
        return _round_coordinate(value)

    def validate_longitude(self, value):
        return _round_coordinate(value)

    def validate_incident_at(self, value):
        return validate_not_in_future(value)


class ComplaintUpdateSerializer(serializers.Serializer):
    """Validates and applies ``PUT/PATCH /api/complaints/{id}/`` (citizen owner while editable, or admin).

    After ``save()``, ``self.changes`` maps every changed field to ``[old, new]`` (JSON-safe) so the view
    can audit-log the edit and trigger AI re-analysis when the description changed.
    """

    COMPLAINT_FIELDS = ("title", "description", "incident_at")
    LOCATION_FIELDS = ("address", "landmark", "area", "city", "pincode")

    description = serializers.CharField(min_length=10, max_length=TEXT_MAX, required=False)
    title = serializers.CharField(max_length=160, allow_blank=True, required=False)
    address = serializers.CharField(max_length=255, allow_blank=True, required=False)
    landmark = serializers.CharField(max_length=150, allow_blank=True, required=False)
    area = serializers.CharField(max_length=120, allow_blank=True, required=False)
    city = serializers.CharField(max_length=100, allow_blank=True, required=False)
    pincode = serializers.CharField(max_length=10, allow_blank=True, required=False)
    incident_at = serializers.DateTimeField(required=False)

    def validate_incident_at(self, value):
        return validate_not_in_future(value)

    @staticmethod
    def _json_value(value):
        return value.isoformat() if hasattr(value, "isoformat") else value

    def _apply(self, target, fields, validated_data, changes):
        updated = []
        for field in fields:
            if field in validated_data and getattr(target, field) != validated_data[field]:
                changes[field] = [self._json_value(getattr(target, field)), self._json_value(validated_data[field])]
                setattr(target, field, validated_data[field])
                updated.append(field)
        return updated

    def update(self, instance, validated_data):
        changes = {}
        complaint_fields = self._apply(instance, self.COMPLAINT_FIELDS, validated_data, changes)
        location_fields = self._apply(instance.location, self.LOCATION_FIELDS, validated_data, changes)
        if location_fields:
            instance.location.save(update_fields=location_fields)
        if complaint_fields or location_fields:
            instance.save(update_fields=[*complaint_fields, "updated_at"])
        self.changes = changes
        return instance


class OptionalRemarksSerializer(serializers.Serializer):
    remarks = serializers.CharField(max_length=TEXT_MAX, allow_blank=True, default="")


class RequiredRemarksSerializer(serializers.Serializer):
    remarks = serializers.CharField(max_length=TEXT_MAX)


class RemarkSerializer(RequiredRemarksSerializer):
    """A timeline remark; ``is_public: false`` keeps it as an internal note hidden from the citizen."""

    is_public = serializers.BooleanField(default=True)


class StatusUpdateSerializer(serializers.Serializer):
    status = serializers.ChoiceField(choices=Complaint.Status.choices)
    remarks = serializers.CharField(max_length=TEXT_MAX, allow_blank=True, default="")


class ResolveSerializer(serializers.Serializer):
    remarks = serializers.CharField(max_length=TEXT_MAX)
    after_image = image_upload_field(required=False, allow_null=True)


class EvidenceUploadSerializer(serializers.Serializer):
    before_image = image_upload_field(required=False, allow_null=True)
    after_image = image_upload_field(required=False, allow_null=True)
    remarks = serializers.CharField(max_length=TEXT_MAX, allow_blank=True, default="")

    def validate(self, attrs):
        if not attrs.get("before_image") and not attrs.get("after_image"):
            raise serializers.ValidationError("Upload a before image, an after image, or both.")
        return attrs


class ManualVerificationSerializer(serializers.Serializer):
    status = serializers.ChoiceField(choices=ResolutionVerification.Status.choices)
    score = serializers.IntegerField(min_value=0, max_value=100, required=False, allow_null=True)
    explanation = serializers.CharField(max_length=TEXT_MAX)


class ReopenSerializer(serializers.Serializer):
    reason = serializers.CharField(max_length=TEXT_MAX)


class OverrideAISerializer(serializers.Serializer):
    category = CategoryReferenceField(required=False, allow_null=True)
    severity = serializers.ChoiceField(choices=Level.choices, required=False, allow_null=True)
    priority_score = serializers.IntegerField(min_value=0, max_value=100, required=False, allow_null=True)
    reason = serializers.CharField(max_length=TEXT_MAX)

    def validate(self, attrs):
        if all(attrs.get(field) is None for field in ("category", "severity", "priority_score")):
            raise serializers.ValidationError("Provide a new category, severity or priority score to override.")
        return attrs


class DuplicateReviewSerializer(serializers.Serializer):
    status = serializers.ChoiceField(
        choices=[
            (DuplicateComplaint.Status.CONFIRMED_DUPLICATE.value, DuplicateComplaint.Status.CONFIRMED_DUPLICATE.label),
            (DuplicateComplaint.Status.NOT_DUPLICATE.value, DuplicateComplaint.Status.NOT_DUPLICATE.label),
        ]
    )
    notes = serializers.CharField(max_length=255, allow_blank=True, default="")


def _validate_coordinate_pair(attrs):
    if (attrs.get("latitude") is None) != (attrs.get("longitude") is None):
        raise serializers.ValidationError({"longitude": ["Send both latitude and longitude, or neither."]})


class AnalyzeRequestSerializer(serializers.Serializer):
    """``POST /api/ai/analyze/`` - full analysis preview (nothing is stored)."""

    image = image_upload_field(required=False, allow_null=True)
    description = serializers.CharField(min_length=3, max_length=TEXT_MAX)
    latitude = FiniteFloatField(min_value=-90, max_value=90, required=False, allow_null=True)
    longitude = FiniteFloatField(min_value=-180, max_value=180, required=False, allow_null=True)
    address = serializers.CharField(max_length=255, allow_blank=True, default="")
    category = CategoryReferenceField(default=None, allow_null=True)

    def validate(self, attrs):
        _validate_coordinate_pair(attrs)
        return attrs


class ClassifyRequestSerializer(serializers.Serializer):
    """``POST /api/ai/classify/`` - at least one of image / description."""

    image = image_upload_field(required=False, allow_null=True)
    description = serializers.CharField(max_length=TEXT_MAX, allow_blank=True, default="")

    def validate(self, attrs):
        if not attrs.get("image") and not attrs.get("description"):
            raise serializers.ValidationError("Send an image, a description, or both.")
        return attrs


#: Longest description accepted by the public landing-page demo.
DEMO_TEXT_MAX = 1000


class DemoAnalysisRequestSerializer(serializers.Serializer):
    """``POST /api/ai/demo/`` (public) - a photo and/or a short description (at least one)."""

    image = image_upload_field(required=False, allow_null=True)
    description = serializers.CharField(max_length=DEMO_TEXT_MAX, allow_blank=True, default="")

    def validate(self, attrs):
        if not attrs.get("image") and not attrs.get("description"):
            raise serializers.ValidationError("Send a photo, a description, or both.")
        return attrs


class ComplaintReferenceSerializer(serializers.Serializer):
    complaint_id = serializers.IntegerField(min_value=1)


class PrioritySimulationSerializer(serializers.Serializer):
    """What-if inputs for the priority engine (``POST /api/ai/priority/`` without ``complaint_id``)."""

    severity_score = FiniteFloatField(min_value=0, max_value=100)
    public_impact = FiniteFloatField(min_value=0, max_value=1, default=0.0)
    location_risk = FiniteFloatField(min_value=0, max_value=1, default=0.0)
    nearby_count = serializers.IntegerField(min_value=0, max_value=10000, default=0)
    frequency_count = serializers.IntegerField(min_value=0, max_value=10000, default=0)
    duplicate_count = serializers.IntegerField(min_value=0, max_value=10000, default=0)
    category = CategoryReferenceField(default=None, allow_null=True, active_only=False)
    is_reopened = serializers.BooleanField(default=False)
    weights = serializers.DictField(child=FiniteFloatField(min_value=0), required=False)

    def validate_weights(self, value):
        unknown = sorted(set(value) - set(PRIORITY_WEIGHT_KEYS))
        if unknown:
            raise serializers.ValidationError(
                f"Unknown weight(s): {', '.join(unknown)}. Allowed: {', '.join(PRIORITY_WEIGHT_KEYS)}."
            )
        return value

    def validate(self, attrs):
        if attrs["frequency_count"] > attrs["nearby_count"]:
            raise serializers.ValidationError(
                {"frequency_count": ["Same-category nearby complaints cannot exceed all nearby complaints."]}
            )
        return attrs


class DuplicateCheckSerializer(serializers.Serializer):
    """``POST /api/ai/duplicates/`` without ``complaint_id``: "similar issues nearby" check (no DB writes)."""

    description = serializers.CharField(min_length=3, max_length=TEXT_MAX)
    latitude = FiniteFloatField(min_value=-90, max_value=90)
    longitude = FiniteFloatField(min_value=-180, max_value=180)
    image = image_upload_field(required=False, allow_null=True)
    category = CategoryReferenceField(default=None, allow_null=True)


class VerifyResolutionRequestSerializer(serializers.Serializer):
    """``POST /api/ai/verify-resolution/`` with two images (engine playground, nothing stored)."""

    before_image = image_upload_field()
    after_image = image_upload_field()
    category = CategoryReferenceField(default=None, allow_null=True, active_only=False)


class SentimentRequestSerializer(serializers.Serializer):
    """``POST /api/ai/sentiment/`` - feedback text and/or a 1-5 rating."""

    text = serializers.CharField(max_length=5000, allow_blank=True, default="")
    rating = serializers.IntegerField(min_value=1, max_value=5, required=False, allow_null=True)

    def validate(self, attrs):
        if not attrs.get("text") and attrs.get("rating") is None:
            raise serializers.ValidationError({"text": ["Enter some feedback text (or at least a rating)."]})
        return attrs


# ---------------------------------------------------------------------------------------------------
# Service / engine results -> JSON
# ---------------------------------------------------------------------------------------------------
#: Payload keys whose User values are rendered as OfficerMini (all other users as UserMini).
OFFICER_PAYLOAD_KEYS = frozenset({"recommended_officer", "recommended_officers"})

_MODEL_SERIALIZERS = (
    (CivicCategory, CategoryMiniSerializer),
    (Department, DepartmentMiniSerializer),
    (Complaint, ComplaintMiniSerializer),
    (OfficerProfile, OfficerMiniSerializer),
    (Location, LocationSerializer),
    (DuplicateComplaint, DuplicatePairSerializer),
    (AIPrediction, AIPredictionSerializer),
    (PriorityScore, PriorityBreakdownSerializer),
)


def _json_key(key):
    if key is None or isinstance(key, (str, int, float, bool)):
        return key
    tolist = getattr(key, "tolist", None)
    return tolist() if callable(tolist) else str(key)


def serialize_engine_payload(value, *, request=None, key=None):
    """Convert a service / AI-engine result into JSON-safe data.

    Engine outputs are plain dicts by contract, but service results may embed ORM objects (the analysis
    summary's category / department / officer, the complaints of duplicate candidates). Those are
    rendered with the canonical mini serializers, so every response uses the same shapes; numpy
    scalars/arrays (``.tolist()``), Decimals and paths become plain JSON values, and NaN / Infinity (which
    strict JSON cannot represent) become ``null``.
    """
    if isinstance(value, Model):
        context = {"request": request}
        if isinstance(value, User):
            serializer_class = OfficerMiniSerializer if key in OFFICER_PAYLOAD_KEYS else UserMiniSerializer
            return serializer_class(value, context=context).data
        for model_class, serializer_class in _MODEL_SERIALIZERS:
            if isinstance(value, model_class):
                return serializer_class(value, context=context).data
        return value.pk
    if isinstance(value, dict):
        return {_json_key(k): serialize_engine_payload(v, request=request, key=k) for k, v in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [serialize_engine_payload(item, request=request, key=key) for item in value]
    if isinstance(value, (float, Decimal)):
        number = float(value)
        return number if math.isfinite(number) else None
    if isinstance(value, Path):
        return str(value)
    if value is None or isinstance(value, (str, bytes, bool, int)):
        return value
    tolist = getattr(value, "tolist", None)  # numpy arrays and numpy scalar types
    if callable(tolist):
        return serialize_engine_payload(tolist(), request=request, key=key)
    return value
