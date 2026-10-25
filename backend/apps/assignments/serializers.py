"""Serializers for officer assignments (BUILD_SPEC sections 4.1 / 4.2 "Assignments").

The shared output shapes come from their canonical home, ``apps.complaints.serializers``, so an assignment or an
officer looks identical on every endpoint (complaint detail, assignment list, recommendations)::

    Assignment   {"id", "complaint": id, "officer": OfficerMini, "department": DepartmentMini|null,
                  "assigned_by": UserMini|null, "assignment_type", "assignment_type_display", "status",
                  "status_display", "is_active", "recommendation_score", "recommendation_reasons", "notes",
                  "assigned_at", "accepted_at", "completed_at"}
    OfficerMini  UserMini + {"employee_id", "designation", "zone", "department": DepartmentMini|null, "is_available"}

This module adds the request serializers of the assignment endpoints and the recommendation output shape.
"""
from django.contrib.auth import get_user_model
from rest_framework import serializers

from apps.complaints.models import Complaint
from apps.complaints.serializers import AssignmentSerializer, OfficerMiniSerializer

__all__ = [
    "AssignmentSerializer", "AssignmentCreateSerializer", "AssignmentReassignSerializer",
    "RecommendationQuerySerializer", "OfficerRecommendationSerializer",
]


def _officer_queryset():
    return get_user_model().objects.filter(role="officer").select_related("officer_profile")


class _OfficerChoiceSerializer(serializers.Serializer):
    """``officer`` (id of an active user with role officer) + optional ``notes``."""

    officer = serializers.PrimaryKeyRelatedField(
        queryset=_officer_queryset(),
        error_messages={"does_not_exist": "No officer exists with id {pk_value}."},
    )
    notes = serializers.CharField(allow_blank=True, max_length=2000, default="")

    def validate_officer(self, officer):
        if not officer.is_active:
            raise serializers.ValidationError("This officer account is deactivated.")
        return officer


class AssignmentCreateSerializer(_OfficerChoiceSerializer):
    """POST /assignments/ body: ``{complaint, officer, notes?}``."""

    complaint = serializers.PrimaryKeyRelatedField(
        queryset=Complaint.objects.select_related("location", "category", "department", "citizen"),
        error_messages={"does_not_exist": "No complaint exists with id {pk_value}."},
    )


class AssignmentReassignSerializer(_OfficerChoiceSerializer):
    """PUT/PATCH /assignments/{id}/ body: ``{officer, notes?}``."""


class RecommendationQuerySerializer(serializers.Serializer):
    """Query string of GET /assignments/recommend/: ``?complaint=<id>&limit=5`` (limit 1-50)."""

    complaint = serializers.PrimaryKeyRelatedField(
        queryset=Complaint.objects.select_related("location", "category", "category__secondary_department",
                                                  "department"),
        error_messages={"does_not_exist": "No complaint exists with id {pk_value}."},
    )
    limit = serializers.IntegerField(default=5, min_value=1, max_value=50)


class OfficerRecommendationSerializer(serializers.Serializer):
    """One ranked candidate from ``services.recommend_officers`` (contract shape of /assignments/recommend/)::

        {"officer": OfficerMini, "score", "workload", "capacity", "utilization", "overloaded", "distance_km",
         "is_available", "same_department", "reasons": [], "recommended": bool}

    ``workload`` / ``capacity`` / ``utilization`` (0..1) / ``overloaded`` follow
    ``apps.assignments.services.workload_figures`` - the same numbers as ``/officers/{id}/workload/``.
    """

    officer = OfficerMiniSerializer(read_only=True)
    score = serializers.FloatField(read_only=True)
    workload = serializers.IntegerField(read_only=True)
    capacity = serializers.IntegerField(read_only=True)
    utilization = serializers.FloatField(read_only=True)
    overloaded = serializers.BooleanField(read_only=True)
    distance_km = serializers.FloatField(read_only=True, allow_null=True)
    is_available = serializers.BooleanField(read_only=True)
    same_department = serializers.BooleanField(read_only=True)
    reasons = serializers.ListField(child=serializers.CharField(), read_only=True)
    recommended = serializers.BooleanField(read_only=True)
