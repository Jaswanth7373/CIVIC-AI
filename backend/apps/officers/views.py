"""Officer management and workload endpoints.

    GET            /api/officers/                  officers + admins (paginated; filters in filters.py, ?search=)
    POST           /api/officers/                  admin - creates User(role=officer) + OfficerProfile atomically
    GET/PUT/PATCH  /api/officers/{id}/             id == user id; write = admin (password optional on update)
    DELETE         /api/officers/{id}/             admin - deactivates the account (history is kept)
    GET            /api/officers/{id}/workload/    {"active", "capacity", "utilization", "overloaded", "critical",
                                                    "by_status", "complaints": [ComplaintList]}
                                                    (officers: own workload only)

Workload numbers (``active_workload`` here, the workload endpoint, the recommender and the officer analytics)
all come from ``apps.assignments.services`` (``collect_officer_stats`` / ``officer_workload``); utilization is
active / capacity clamped to 0..1 and ``overloaded`` means active > capacity.

Sorting: ``?ordering=`` with ``user__first_name``, ``employee_id``, ``created_at``, ``max_active_complaints``,
``stat_active_workload``, ``stat_resolved_count`` or ``stat_avg_rating`` (prefix ``-`` for descending).
"""
from django.db.models import Avg, FloatField, OuterRef, Subquery
from rest_framework import exceptions, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.accounts.models import User
from apps.assignments.services import officer_workload
from apps.audit.models import AuditLog
from apps.audit.services import log_action
from apps.complaints.models import Complaint
from apps.complaints.serializers import optimize_complaint_list_queryset
from apps.core.permissions import IsAdmin, IsOfficerOrAdmin, is_admin
from apps.core.utils import ID_PATTERN
from apps.core.views import AnnotatedWriteMixin, diff_snapshots, snapshot, subquery_count
from apps.feedback.models import Feedback

from .filters import OfficerFilter
from .models import OfficerProfile
from .serializers import ComplaintListItemSerializer, OfficerSerializer, OfficerWriteSerializer

OFFICER_USER_AUDIT_FIELDS = ["email", "first_name", "last_name", "phone", "is_active"]
OFFICER_PROFILE_AUDIT_FIELDS = ["department", "employee_id", "designation", "zone", "base_latitude",
                                "base_longitude", "max_active_complaints", "is_available", "skills", "joined_on"]


def officer_queryset():
    """Officer profiles annotated with the sort keys of ``?ordering=`` (computed in the same SQL statement):

    * ``stat_active_workload`` - complaints assigned to the officer and still open
      (assigned / accepted / in_progress / reopened),
    * ``stat_resolved_count``  - complaints assigned to the officer that are resolved / verified / closed,
    * ``stat_avg_rating``      - mean citizen feedback rating on those complaints (NULL without feedback).

    They follow the definitions of ``apps.assignments.services.collect_officer_stats``, which provides the
    numbers the serializer renders.
    """
    ratings = (Feedback.objects.filter(complaint__assigned_officer_id=OuterRef("user_id")).order_by()
               .values("complaint__assigned_officer_id").annotate(mean=Avg("rating")).values("mean"))
    return (
        OfficerProfile.objects.filter(user__role=User.Role.OFFICER)
        .select_related("user", "department")
        .annotate(
            stat_active_workload=subquery_count(
                Complaint.objects.filter(assigned_officer_id=OuterRef("user_id"),
                                         status__in=Complaint.OPEN_ASSIGNED_STATUSES),
                "assigned_officer",
            ),
            stat_resolved_count=subquery_count(
                Complaint.objects.filter(assigned_officer_id=OuterRef("user_id"),
                                         status__in=Complaint.RESOLVED_STATUSES),
                "assigned_officer",
            ),
            stat_avg_rating=Subquery(ratings, output_field=FloatField()),
        )
    )


def workload_complaints(officer_id):
    """The officer's open queue (highest priority first) prepared for the canonical ComplaintList serializer
    (``optimize_complaint_list_queryset``: related rows joined, thumbnail / duplicate / AI flags computed by
    sub-queries - no per-row queries)."""
    queryset = Complaint.objects.filter(assigned_officer_id=officer_id, status__in=Complaint.OPEN_ASSIGNED_STATUSES)
    return optimize_complaint_list_queryset(queryset).order_by("-priority_score", "created_at", "id")


def officer_snapshot(profile):
    return {**snapshot(profile.user, OFFICER_USER_AUDIT_FIELDS), **snapshot(profile, OFFICER_PROFILE_AUDIT_FIELDS)}


class OfficerViewSet(AnnotatedWriteMixin, viewsets.ModelViewSet):
    read_serializer_class = OfficerSerializer
    filterset_class = OfficerFilter
    search_fields = ["user__first_name", "user__last_name", "user__email", "employee_id", "zone", "designation"]
    ordering_fields = ["user__first_name", "user__last_name", "employee_id", "created_at", "max_active_complaints",
                       "stat_active_workload", "stat_resolved_count", "stat_avg_rating"]
    ordering = ["user__first_name", "user__last_name"]
    lookup_value_regex = ID_PATTERN

    def get_queryset(self):
        queryset = officer_queryset()
        if not is_admin(self.request.user):
            queryset = queryset.filter(user__is_active=True)  # officers see the active directory only
        return queryset

    def get_permissions(self):
        if self.action in ("list", "retrieve", "workload"):
            return [IsOfficerOrAdmin()]
        return [IsAdmin()]

    def get_serializer_class(self):
        if self.action in ("create", "update", "partial_update"):
            return OfficerWriteSerializer
        return OfficerSerializer

    def perform_create(self, serializer):
        profile = serializer.save()
        log_action(self.request.user, AuditLog.Action.CREATE, entity=profile.user,
                   description=f"Created officer {profile.user.email} ({profile.employee_id})",
                   changes=officer_snapshot(profile), request=self.request)
        return profile

    def perform_update(self, serializer):
        before = officer_snapshot(serializer.instance)
        profile = serializer.save()
        changes = diff_snapshots(before, officer_snapshot(profile))
        if serializer.validated_data.get("password"):
            changes["password"] = "changed"
        if changes:
            log_action(self.request.user, AuditLog.Action.UPDATE, entity=profile.user,
                       description=f"Updated officer {profile.user.email}", changes=changes, request=self.request)
        return profile

    def destroy(self, request, *args, **kwargs):
        """Soft delete: the account is deactivated and marked unavailable; assignments and history remain."""
        profile = self.get_object()
        user = profile.user
        open_count = Complaint.objects.filter(assigned_officer=user,
                                              status__in=Complaint.OPEN_ASSIGNED_STATUSES).count()
        if user.is_active or profile.is_available:
            user.is_active = False
            user.save(update_fields=["is_active", "updated_at"])
            profile.is_available = False
            profile.save(update_fields=["is_available", "updated_at"])
            log_action(request.user, AuditLog.Action.UPDATE, entity=user,
                       description=f"Deactivated officer {user.email}",
                       changes={"is_active": [True, False], "open_complaints": open_count}, request=request)
        detail = f"{user.full_name} has been deactivated."
        if open_count:
            detail += f" {open_count} open complaint(s) are still assigned to them; reassign them."
        return Response({"detail": detail, "deactivated": True, "open_complaints": open_count})

    @action(detail=True, methods=["get"])
    def workload(self, request, pk=None):
        """``apps.assignments.services.officer_workload`` + the open queue (highest priority first)."""
        profile = self.get_object()
        if not is_admin(request.user) and profile.user_id != request.user.pk:
            raise exceptions.PermissionDenied("Officers can only view their own workload.")
        complaints = workload_complaints(profile.user_id)
        return Response({
            **officer_workload(profile),
            "complaints": ComplaintListItemSerializer(complaints, many=True, context={"request": request}).data,
        })
