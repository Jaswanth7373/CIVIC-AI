"""Assignments REST API (BUILD_SPEC section 4.2 "Assignments").

    GET       /api/assignments/                    admin: all, officer: own; ?complaint=&officer=&is_active=
    POST      /api/assignments/                    admin  {complaint, officer, notes?} -> 201 Assignment
    GET       /api/assignments/{id}/               admin: any, officer: own
    PUT/PATCH /api/assignments/{id}/               admin  {officer, notes?} -> reassign -> new Assignment
    GET       /api/assignments/recommend/          admin  ?complaint=<id>&limit=5 -> ranked officers

Views stay thin: validation in serializers, business rules in ``apps.assignments.services``.
"""
from django_filters import rest_framework as filters
from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.filters import OrderingFilter
from rest_framework.response import Response

from apps.core.exceptions import ServiceError
from apps.core.filters import IdFilter
from apps.core.permissions import IsAdmin, IsOfficerOrAdmin, is_admin
from apps.core.utils import ID_PATTERN

from . import services
from .models import ComplaintAssignment
from .serializers import (
    AssignmentCreateSerializer,
    AssignmentReassignSerializer,
    AssignmentSerializer,
    OfficerRecommendationSerializer,
    RecommendationQuerySerializer,
)


class AssignmentFilter(filters.FilterSet):
    """``?complaint=<id>&officer=<user id>&is_active=true|false``."""

    complaint = IdFilter(field_name="complaint_id")
    officer = IdFilter(field_name="officer_id")
    is_active = filters.BooleanFilter()

    class Meta:
        model = ComplaintAssignment
        fields = ["complaint", "officer", "is_active"]


class AssignmentViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, viewsets.GenericViewSet):
    serializer_class = AssignmentSerializer
    filter_backends = [filters.DjangoFilterBackend, OrderingFilter]
    filterset_class = AssignmentFilter
    ordering_fields = ["assigned_at", "completed_at", "recommendation_score"]
    lookup_value_regex = ID_PATTERN

    def get_permissions(self):
        if self.action in ("list", "retrieve"):
            return [IsOfficerOrAdmin()]
        return [IsAdmin()]

    def get_queryset(self):
        queryset = ComplaintAssignment.objects.select_related(
            "complaint", "officer", "officer__officer_profile", "officer__officer_profile__department",
            "department", "assigned_by",
        )
        if not is_admin(self.request.user):
            queryset = queryset.filter(officer=self.request.user)
        return queryset

    def create(self, request, *args, **kwargs):
        payload = AssignmentCreateSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        assignment = services.assign_officer(
            payload.validated_data["complaint"],
            payload.validated_data["officer"],
            assigned_by=request.user,
            assignment_type=ComplaintAssignment.Type.MANUAL,
            notes=payload.validated_data["notes"],
            request=request,
        )
        return Response(self._render(assignment), status=status.HTTP_201_CREATED)

    def update(self, request, *args, **kwargs):
        current = self.get_object()
        if not current.is_active:
            raise ServiceError(
                f"Only the active assignment can be reassigned; this one is {current.get_status_display().lower()}."
            )
        payload = AssignmentReassignSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        assignment = services.assign_officer(
            current.complaint,
            payload.validated_data["officer"],
            assigned_by=request.user,
            assignment_type=ComplaintAssignment.Type.REASSIGNMENT,
            notes=payload.validated_data["notes"],
            request=request,
        )
        return Response(self._render(assignment))

    def partial_update(self, request, *args, **kwargs):
        return self.update(request, *args, **kwargs)

    @action(detail=False, methods=["get"])
    def recommend(self, request):
        query = RecommendationQuerySerializer(data=request.query_params)
        query.is_valid(raise_exception=True)
        candidates = services.recommend_officers(query.validated_data["complaint"], limit=query.validated_data["limit"])
        return Response(OfficerRecommendationSerializer(candidates, many=True, context={"request": request}).data)

    def _render(self, assignment):
        fresh = self.get_queryset().get(pk=assignment.pk)
        return self.get_serializer(fresh).data
