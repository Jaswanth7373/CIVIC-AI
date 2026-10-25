"""REST views for complaints (``/api/complaints/``) and duplicate review (``/api/duplicates/``).

The views are deliberately thin: they authenticate, scope and validate the request, call ONE function
of the service layer (``apps.complaints.services``) that holds the business rules, and serialize the
fresh database state. The HTTP request is handed to the services that accept it so their audit-log rows
record the client's IP address and user agent. Errors raised by the services (``ServiceError`` 400,
``TransitionNotAllowed`` 409, DRF validation / permission errors) pass straight through to the global
error handler.

Access control is described in ``apps.complaints.permissions``: queryset scoping turns out-of-scope
complaints into 404s, role permissions answer 403 for the wrong role, and object permissions make sure
only the assigned officer (or an admin) acts on a complaint.
"""
import logging
from contextlib import contextmanager

from django.core.files.storage import default_storage
from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from django_filters.rest_framework import DjangoFilterBackend
from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import APIException, NotFound, PermissionDenied, ValidationError
from rest_framework.filters import SearchFilter
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from ai.exceptions import ImageProcessingError, ModelUnavailableError
from apps.audit.services import log_action
from apps.core.exceptions import ServiceError
from apps.core.permissions import IsAdmin, IsCitizen, IsOfficerOrAdmin, is_citizen
from apps.core.throttles import ComplaintSubmissionBurstThrottle, ComplaintSubmissionDailyThrottle
from apps.core.utils import ID_PATTERN

from .filters import ComplaintFilter, DuplicateFilter, StableOrderingFilter
from .models import Complaint, DuplicateComplaint
from .permissions import (
    OFFICER_SCOPE_ASSIGNED,
    OFFICER_SCOPE_DEPARTMENT,
    OFFICER_SCOPES,
    IsAssignedOfficer,
    IsAssignedOfficerOrAdmin,
    IsComplaintOwnerOrAdmin,
    scope_complaints,
    scope_duplicate_pairs,
)
from .serializers import (
    ComplaintCreateSerializer,
    ComplaintDetailSerializer,
    ComplaintListSerializer,
    ComplaintMapSerializer,
    ComplaintUpdateSerializer,
    DuplicateLinkSerializer,
    DuplicatePairSerializer,
    DuplicateReviewSerializer,
    EvidenceSerializer,
    EvidenceUploadSerializer,
    ManualVerificationSerializer,
    OptionalRemarksSerializer,
    OverrideAISerializer,
    RemarkSerializer,
    ReopenSerializer,
    RequiredRemarksSerializer,
    ResolveSerializer,
    StatusUpdateSerializer,
    TimelineEventSerializer,
    VerificationSerializer,
    complaint_duplicate_links,
    optimize_complaint_detail_queryset,
    optimize_complaint_list_queryset,
    optimize_complaint_map_queryset,
    optimize_duplicate_pair_queryset,
    serialize_engine_payload,
)
from .services import duplicates as duplicate_service
from .services import overrides as override_service
from .services import pipeline as pipeline_service
from .services import priority as priority_service
from .services import status as lifecycle
from .services import submission as submission_service
from .services import verification as verification_service
from .services.helpers import SUBMISSION_POINTS, revoke_civic_points

logger = logging.getLogger("apps.complaints")

#: Upper bound of pins returned by ``GET /api/complaints/map/`` (newest first).
MAP_MAX_POINTS = 3000


class ServiceUnavailable(APIException):
    """HTTP 503 - a service or AI engine this request needs is not available on the server."""

    status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    default_detail = "This feature is temporarily unavailable."
    default_code = "service_unavailable"


@contextmanager
def unavailable_guard(label, *, image_field="image"):
    """Translate "capability missing" errors from services / AI engines into clean API errors.

    * ``NotImplementedError`` (a component that is not built yet), ``ai.exceptions.ModelUnavailableError``
      (model weights / package missing) and ``ImportError`` -> **503** ``{"detail": "<label> unavailable."}``;
    * ``ai.exceptions.ImageProcessingError`` (undecodable / corrupt photo) -> **400** on ``image_field``.

    The technical reason is logged for the developers but never echoed to API clients.
    """
    try:
        yield
    except ImageProcessingError as exc:
        raise ValidationError({image_field: [f"The image could not be processed: {exc}"]}) from exc
    except (NotImplementedError, ModelUnavailableError, ImportError) as exc:
        logger.error("%s unavailable: %s: %s", label, type(exc).__name__, exc)
        raise ServiceUnavailable(f"{label} unavailable.") from exc


def refresh_duplicate_counts(complaint_ids):
    """Recount ``duplicate_count`` (pending + confirmed links, both directions) for ``complaint_ids``.

    Used after a complaint is deleted: its duplicate pairs disappear with it (CASCADE), so the complaints
    on the other side of those pairs must not keep counting it.
    """
    active = [DuplicateComplaint.Status.PENDING_REVIEW, DuplicateComplaint.Status.CONFIRMED_DUPLICATE]
    for complaint_id in complaint_ids:
        count = DuplicateComplaint.objects.filter(
            Q(complaint_id=complaint_id) | Q(similar_complaint_id=complaint_id), status__in=active
        ).count()
        Complaint.objects.filter(pk=complaint_id).update(duplicate_count=count, updated_at=timezone.now())


def stored_file_names(complaint):
    """Storage names of every file attached to a complaint (photos + resolution evidence)."""
    names = [image.image.name for image in complaint.images.all() if image.image]
    for evidence in complaint.evidence.all():
        names.extend(f.name for f in (evidence.before_image, evidence.after_image) if f)
    return names


def delete_stored_files(storage, names):
    """Best-effort removal of uploaded files once the database rows are gone."""
    for name in names:
        try:
            storage.delete(name)
        except OSError:
            logger.warning("Could not delete stored file %s", name)


class ComplaintViewSet(viewsets.ModelViewSet):
    """Complaints: CRUD, the map feed, the timeline and every lifecycle action.

    ======================================================  ====================================
    ``GET    /complaints/``                                  scoped, filtered, paginated list
    ``POST   /complaints/``                                  citizen submits (full AI pipeline)
    ``GET    /complaints/map/``                              scoped, filtered map pins (max 3000)
    ``GET    /complaints/{id}/``                             detail (object scoped)
    ``PUT/PATCH/DELETE /complaints/{id}/``                   citizen owner while editable / admin
    ``GET    /complaints/{id}/timeline/ | duplicates/``      timeline / duplicate links
    ``POST   /complaints/{id}/<action>/``                    accept, reject, start, update-status,
                                                             resolve, evidence, verify,
                                                             manual-verification,
                                                             request-manual-verification, reopen,
                                                             remarks, override-ai, reanalyze, close
    ======================================================  ====================================
    """

    lookup_value_regex = ID_PATTERN
    permission_classes = (IsAuthenticated,)
    parser_classes = (JSONParser, MultiPartParser, FormParser)
    serializer_class = ComplaintDetailSerializer
    filter_backends = (DjangoFilterBackend, SearchFilter, StableOrderingFilter)
    filterset_class = ComplaintFilter
    search_fields = ("complaint_number", "title", "description", "location__address", "location__area")
    ordering_fields = ("created_at", "priority_score", "severity_score", "updated_at")
    ordering = ("-created_at",)

    #: Role permissions of the CRUD actions (custom actions declare theirs on ``@action``).
    CRUD_PERMISSIONS = {
        "list": (IsAuthenticated,),
        "retrieve": (IsAuthenticated,),
        "create": (IsCitizen,),
        "update": (IsComplaintOwnerOrAdmin,),
        "partial_update": (IsComplaintOwnerOrAdmin,),
        "destroy": (IsComplaintOwnerOrAdmin,),
    }
    SERIALIZERS = {
        "list": ComplaintListSerializer,
        "retrieve": ComplaintDetailSerializer,
        "create": ComplaintCreateSerializer,
        "update": ComplaintUpdateSerializer,
        "partial_update": ComplaintUpdateSerializer,
        "map_points": ComplaintMapSerializer,
    }
    #: Actions whose results are filtered by the query string (filters, search, ordering).
    FILTERED_ACTIONS = ("list", "map_points")

    # --- plumbing ----------------------------------------------------------------------------------
    def get_permissions(self):
        if self.action in self.CRUD_PERMISSIONS:
            return [permission() for permission in self.CRUD_PERMISSIONS[self.action]]
        return super().get_permissions()

    def get_serializer_class(self):
        return self.SERIALIZERS.get(self.action) or super().get_serializer_class()

    def _officer_list_scope(self):
        scope = self.request.query_params.get("scope", OFFICER_SCOPE_ASSIGNED) or OFFICER_SCOPE_ASSIGNED
        if scope not in OFFICER_SCOPES:
            raise ValidationError({"scope": [f"Use one of: {', '.join(OFFICER_SCOPES)}."]})
        return scope

    def get_queryset(self):
        user = self.request.user
        if self.action in self.FILTERED_ACTIONS:
            scoped = scope_complaints(Complaint.objects.all(), user, officer_scope=self._officer_list_scope())
            if self.action == "map_points":
                return optimize_complaint_map_queryset(scoped)
            return optimize_complaint_list_queryset(scoped)
        scoped = scope_complaints(Complaint.objects.all(), user, officer_scope=OFFICER_SCOPE_DEPARTMENT)
        if self.action == "retrieve":
            return optimize_complaint_detail_queryset(scoped)
        return scoped.select_related("category", "department", "assigned_officer", "citizen", "location")

    def filter_queryset(self, queryset):
        # Query-string filters belong to the collection endpoints only; a detail URL is never
        # turned into a 404 because of an unrelated ``?status=`` parameter.
        if self.action in self.FILTERED_ACTIONS:
            return super().filter_queryset(queryset)
        return queryset

    def _validated(self, serializer_class):
        serializer = serializer_class(data=self.request.data, context=self.get_serializer_context())
        serializer.is_valid(raise_exception=True)
        return serializer.validated_data

    def _detail_data(self, complaint_id):
        complaint = optimize_complaint_detail_queryset(Complaint.objects.filter(pk=complaint_id)).first()
        if complaint is None:
            raise NotFound("Complaint not found.")
        return ComplaintDetailSerializer(complaint, context=self.get_serializer_context()).data

    def _detail_response(self, complaint, *, analysis=None, status_code=status.HTTP_200_OK):
        payload = self._detail_data(complaint.pk)
        if analysis is not None:
            payload["analysis"] = serialize_engine_payload(analysis, request=self.request)
        return Response(payload, status=status_code)

    def _require_allowed_action(self, complaint, action_key, message):
        """Citizens may edit / delete only while the lifecycle service lists the action as allowed."""
        with unavailable_guard("Complaint lifecycle service"):
            allowed = lifecycle.get_allowed_actions(complaint, self.request.user)
        if action_key not in (allowed or []):
            raise PermissionDenied(message)

    def get_throttles(self):
        """New complaints are additionally limited per citizen (``complaint_burst`` / ``complaint_daily``)."""
        throttles = super().get_throttles()
        if self.action == "create":
            throttles += [ComplaintSubmissionBurstThrottle(), ComplaintSubmissionDailyThrottle()]
        return throttles

    # --- CRUD --------------------------------------------------------------------------------------
    def create(self, request, *args, **kwargs):
        """Validate the multipart form, then run the full submission pipeline (AI analysis, priority,
        duplicates, routing, assignment, notifications) synchronously via ``submit_complaint``."""
        data = dict(self._validated(ComplaintCreateSerializer))
        image = data.pop("image", None)
        with unavailable_guard("Complaint submission service"):
            complaint, analysis = submission_service.submit_complaint(
                citizen=request.user, data=data, image=image, request=request
            )
        return self._detail_response(complaint, analysis=analysis, status_code=status.HTTP_201_CREATED)

    def update(self, request, *args, **kwargs):
        """Edit text/location fields (PUT and PATCH both accept any subset of them); a changed description
        is re-analysed by the AI pipeline in the same transaction (if re-analysis is unavailable the edit is
        rolled back, so a complaint never keeps a description its AI results do not describe)."""
        partial = kwargs.pop("partial", False)
        complaint = self.get_object()
        if is_citizen(request.user):
            self._require_allowed_action(
                complaint, "edit", "This complaint can no longer be edited because work on it has started."
            )
        serializer = ComplaintUpdateSerializer(
            complaint, data=request.data, partial=partial, context=self.get_serializer_context()
        )
        serializer.is_valid(raise_exception=True)
        analysis = None
        with transaction.atomic():
            serializer.save()
            if "description" in serializer.changes:
                with unavailable_guard("AI re-analysis service"):
                    analysis = pipeline_service.reanalyze_complaint(complaint, actor=request.user, request=request)
        if serializer.changes:
            log_action(
                request.user, "update", entity=complaint, request=request,
                description=f"Edited complaint {complaint.complaint_number}", changes=serializer.changes,
            )
        return self._detail_response(complaint, analysis=analysis)

    def destroy(self, request, *args, **kwargs):
        """Delete a complaint (citizen owner while deletable, or admin). Linked duplicate counts are
        recounted, the originals' priority is recalculated, the uploaded files are removed and the citizen's
        submission points are taken back (so creating and deleting reports cannot farm civic points)."""
        complaint = self.get_object()
        if is_citizen(request.user):
            self._require_allowed_action(
                complaint, "delete", "This complaint can no longer be deleted because work on it has started."
            )
        linked_ids = {
            pk
            for pair in DuplicateComplaint.objects.filter(Q(complaint=complaint) | Q(similar_complaint=complaint))
            for pk in (pair.complaint_id, pair.similar_complaint_id)
        } - {complaint.pk}
        file_names = stored_file_names(complaint)
        with transaction.atomic():
            log_action(
                request.user, "delete", entity=complaint, request=request,
                description=f"Deleted complaint {complaint.complaint_number}",
            )
            citizen = complaint.citizen
            complaint.delete()
            refresh_duplicate_counts(linked_ids)
            revoke_civic_points(citizen, SUBMISSION_POINTS)
            transaction.on_commit(lambda: delete_stored_files(default_storage, file_names))
        # The deletion is committed; a failing follow-up recalculation must not turn it into an error.
        for other in Complaint.objects.filter(pk__in=linked_ids):
            try:
                priority_service.recalculate_priority(other, trigger="duplicate_update", actor=None)
            except Exception:  # noqa: BLE001 - best-effort side effect, logged for the developers
                logger.exception("Could not recalculate the priority of complaint %s after a deletion", other.pk)
        return Response(status=status.HTTP_204_NO_CONTENT)

    # --- read-only sub-resources -------------------------------------------------------------------
    @action(detail=False, methods=["get"], url_path="map", url_name="map")
    def map_points(self, request):
        """Map pins: same scope and filters as the list, not paginated, newest ``MAP_MAX_POINTS``."""
        queryset = self.filter_queryset(self.get_queryset())[:MAP_MAX_POINTS]
        return Response(ComplaintMapSerializer(queryset, many=True, context=self.get_serializer_context()).data)

    @action(detail=True, methods=["get"])
    def timeline(self, request, pk=None):
        """Timeline events in chronological order (citizens see public events only)."""
        complaint = self.get_object()
        events = complaint.status_history.select_related("changed_by").order_by("timestamp", "id")
        if is_citizen(request.user):
            events = events.filter(is_public=True)
        return Response(TimelineEventSerializer(events, many=True, context=self.get_serializer_context()).data)

    @action(detail=True, methods=["get"])
    def duplicates(self, request, pk=None):
        """Duplicate links of the complaint in both directions (see ``DuplicateLinkSerializer``)."""
        complaint = self.get_object()
        context = {**self.get_serializer_context(), "viewed_complaint_id": complaint.pk}
        return Response(DuplicateLinkSerializer(complaint_duplicate_links(complaint), many=True, context=context).data)

    # --- officer lifecycle actions -----------------------------------------------------------------
    @action(detail=True, methods=["post"], permission_classes=[IsAssignedOfficer], serializer_class=OptionalRemarksSerializer)
    def accept(self, request, pk=None):
        complaint = self.get_object()
        data = self._validated(OptionalRemarksSerializer)
        with unavailable_guard("Complaint lifecycle service"):
            lifecycle.accept_complaint(complaint, actor=request.user, remarks=data["remarks"], request=request)
        return self._detail_response(complaint)

    @action(detail=True, methods=["post"], permission_classes=[IsAssignedOfficerOrAdmin], serializer_class=RequiredRemarksSerializer)
    def reject(self, request, pk=None):
        complaint = self.get_object()
        data = self._validated(RequiredRemarksSerializer)
        with unavailable_guard("Complaint lifecycle service"):
            lifecycle.reject_complaint(complaint, actor=request.user, remarks=data["remarks"], request=request)
        return self._detail_response(complaint)

    @action(detail=True, methods=["post"], permission_classes=[IsAssignedOfficer], serializer_class=OptionalRemarksSerializer)
    def start(self, request, pk=None):
        complaint = self.get_object()
        data = self._validated(OptionalRemarksSerializer)
        with unavailable_guard("Complaint lifecycle service"):
            lifecycle.start_work(complaint, actor=request.user, remarks=data["remarks"], request=request)
        return self._detail_response(complaint)

    @action(
        detail=True, methods=["post"], url_path="update-status",
        permission_classes=[IsAssignedOfficerOrAdmin], serializer_class=StatusUpdateSerializer,
    )
    def update_status(self, request, pk=None):
        """Generic transition; the lifecycle service validates it against the transition table."""
        complaint = self.get_object()
        data = self._validated(StatusUpdateSerializer)
        with unavailable_guard("Complaint lifecycle service"):
            lifecycle.change_status(
                complaint, data["status"], actor=request.user, remarks=data["remarks"], request=request
            )
        return self._detail_response(complaint)

    @action(detail=True, methods=["post"], permission_classes=[IsAssignedOfficerOrAdmin], serializer_class=ResolveSerializer)
    def resolve(self, request, pk=None):
        """Mark resolved; with an after photo the service also runs AI-assisted verification."""
        complaint = self.get_object()
        data = self._validated(ResolveSerializer)
        with unavailable_guard("Complaint lifecycle service", image_field="after_image"):
            lifecycle.resolve_complaint(
                complaint, actor=request.user, remarks=data["remarks"], after_image=data.get("after_image"),
                request=request,
            )
        return self._detail_response(complaint)

    @action(detail=True, methods=["post"], permission_classes=[IsAssignedOfficerOrAdmin], serializer_class=EvidenceUploadSerializer)
    def evidence(self, request, pk=None):
        complaint = self.get_object()
        data = self._validated(EvidenceUploadSerializer)
        with unavailable_guard("Resolution evidence service"):
            evidence = verification_service.upload_evidence(
                complaint, actor=request.user, before_image=data.get("before_image"),
                after_image=data.get("after_image"), remarks=data["remarks"], request=request,
            )
        return Response(
            EvidenceSerializer(evidence, context=self.get_serializer_context()).data, status=status.HTTP_201_CREATED
        )

    @action(detail=True, methods=["post"], permission_classes=[IsAssignedOfficerOrAdmin])
    def verify(self, request, pk=None):
        """Run AI-assisted before/after verification on the latest evidence."""
        complaint = self.get_object()
        with unavailable_guard("Resolution verification service"):
            verification = verification_service.run_ai_verification(complaint, actor=request.user, request=request)
        if verification is None:
            raise ServiceError("There is no resolution evidence to verify yet. Upload an after photo first.")
        return Response(VerificationSerializer(verification, context=self.get_serializer_context()).data)

    @action(
        detail=True, methods=["post"], url_path="manual-verification",
        permission_classes=[IsAssignedOfficerOrAdmin], serializer_class=ManualVerificationSerializer,
    )
    def manual_verification(self, request, pk=None):
        complaint = self.get_object()
        data = self._validated(ManualVerificationSerializer)
        with unavailable_guard("Resolution verification service"):
            verification = verification_service.manual_verification(
                complaint, actor=request.user, status=data["status"], score=data.get("score"),
                explanation=data["explanation"], request=request,
            )
        return Response(VerificationSerializer(verification, context=self.get_serializer_context()).data)

    @action(
        detail=True, methods=["post"], url_path="request-manual-verification",
        permission_classes=[IsAssignedOfficer], serializer_class=OptionalRemarksSerializer,
    )
    def request_manual_verification(self, request, pk=None):
        complaint = self.get_object()
        data = self._validated(OptionalRemarksSerializer)
        with unavailable_guard("Resolution verification service"):
            verification_service.request_manual_review(
                complaint, actor=request.user, remarks=data["remarks"], request=request
            )
        return self._detail_response(complaint)

    @action(detail=True, methods=["post"], permission_classes=[IsOfficerOrAdmin], serializer_class=RemarkSerializer)
    def remarks(self, request, pk=None):
        """Timeline remark by an officer who can see the complaint (assigned or same department) or an admin;
        the lifecycle service enforces who exactly may comment."""
        complaint = self.get_object()
        data = self._validated(RemarkSerializer)
        with unavailable_guard("Complaint lifecycle service"):
            event = lifecycle.add_remark(complaint, actor=request.user, remarks=data["remarks"],
                                         is_public=data["is_public"])
        return Response(
            TimelineEventSerializer(event, context=self.get_serializer_context()).data, status=status.HTTP_201_CREATED
        )

    # --- citizen / admin actions -------------------------------------------------------------------
    @action(detail=True, methods=["post"], permission_classes=[IsComplaintOwnerOrAdmin], serializer_class=ReopenSerializer)
    def reopen(self, request, pk=None):
        """Citizen owner (within the reopen window - checked by the service) or admin."""
        complaint = self.get_object()
        data = self._validated(ReopenSerializer)
        with unavailable_guard("Complaint lifecycle service"):
            lifecycle.reopen_complaint(complaint, actor=request.user, reason=data["reason"], request=request)
        return self._detail_response(complaint)

    @action(detail=True, methods=["post"], url_path="override-ai", permission_classes=[IsAdmin], serializer_class=OverrideAISerializer)
    def override_ai(self, request, pk=None):
        """Admin correction of the AI category / severity / priority (audited by the service)."""
        complaint = self.get_object()
        data = self._validated(OverrideAISerializer)
        with unavailable_guard("AI override service"):
            override_service.override_ai(
                complaint, actor=request.user, category=data.get("category"), severity=data.get("severity"),
                priority_score=data.get("priority_score"), reason=data["reason"], request=request,
            )
        return self._detail_response(complaint)

    @action(detail=True, methods=["post"], permission_classes=[IsAdmin])
    def reanalyze(self, request, pk=None):
        """Re-run the AI pipeline for a stored complaint; returns the detail plus ``analysis``."""
        complaint = self.get_object()
        with unavailable_guard("AI re-analysis service"):
            analysis = pipeline_service.reanalyze_complaint(complaint, actor=request.user, request=request)
        return self._detail_response(complaint, analysis=analysis)

    @action(detail=True, methods=["post"], permission_classes=[IsAdmin], serializer_class=OptionalRemarksSerializer)
    def close(self, request, pk=None):
        complaint = self.get_object()
        data = self._validated(OptionalRemarksSerializer)
        with unavailable_guard("Complaint lifecycle service"):
            lifecycle.close_complaint(complaint, actor=request.user, remarks=data["remarks"], request=request)
        return self._detail_response(complaint)


class DuplicateComplaintViewSet(mixins.ListModelMixin, viewsets.GenericViewSet):
    """Duplicate review queue for officers and admins.

    ``GET /duplicates/`` lists pairs in the user's scope (filters ``status``, ``complaint``; ordering
    ``overall_similarity`` / ``created_at``); ``PATCH /duplicates/{id}/`` with
    ``{"status": "confirmed_duplicate" | "not_duplicate", "notes"?}`` records the human decision through
    ``services.duplicates.review_duplicate`` (complaints are never deleted).
    """

    lookup_value_regex = ID_PATTERN
    http_method_names = ["get", "patch", "head", "options"]
    permission_classes = (IsOfficerOrAdmin,)
    serializer_class = DuplicatePairSerializer
    filter_backends = (DjangoFilterBackend, StableOrderingFilter)
    filterset_class = DuplicateFilter
    ordering_fields = ("overall_similarity", "created_at")
    ordering = ("-overall_similarity", "-created_at")

    def get_queryset(self):
        return scope_duplicate_pairs(optimize_duplicate_pair_queryset(DuplicateComplaint.objects.all()), self.request.user)

    def filter_queryset(self, queryset):
        if self.action == "list":
            return super().filter_queryset(queryset)
        return queryset

    def get_serializer_class(self):
        return DuplicateReviewSerializer if self.action == "partial_update" else DuplicatePairSerializer

    def partial_update(self, request, *args, **kwargs):
        duplicate = self.get_object()
        serializer = DuplicateReviewSerializer(data=request.data, context=self.get_serializer_context())
        serializer.is_valid(raise_exception=True)
        with unavailable_guard("Duplicate review service"):
            duplicate_service.review_duplicate(
                duplicate, status=serializer.validated_data["status"], actor=request.user,
                notes=serializer.validated_data["notes"], request=request,
            )
        refreshed = optimize_duplicate_pair_queryset(DuplicateComplaint.objects.filter(pk=duplicate.pk)).get()
        return Response(DuplicatePairSerializer(refreshed, context=self.get_serializer_context()).data)
