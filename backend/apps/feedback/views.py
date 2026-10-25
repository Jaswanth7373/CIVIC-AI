"""Feedback REST API (BUILD_SPEC section 4.2 "Feedback").

    POST /api/feedback/          citizen  {complaint, rating, text?} -> 201 Feedback + {"suggest_reopen": bool}
    GET  /api/feedback/          citizen: own, officer: on complaints assigned to them, admin: all.
                                 Filters: sentiment, rating (comma lists allowed), department (id or code),
                                 category (id or slug), complaint, date_from, date_to (YYYY-MM-DD). Paginated.
    GET  /api/feedback/pending/  citizen  [{"complaint": ComplaintMini, "resolved_at"}] (feedback requests)
"""
from datetime import datetime, time, timedelta

from django.utils import timezone
from django_filters import rest_framework as filters
from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.filters import OrderingFilter
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from apps.core.filters import BoundedDateFilter, IdFilter
from apps.core.permissions import IsCitizen, user_role
from apps.core.utils import parse_id

from . import services
from .models import Feedback
from .serializers import FeedbackCreateSerializer, FeedbackSerializer, PendingFeedbackSerializer


def _split(value):
    return [part.strip() for part in str(value).split(",") if part.strip()]


def _local_midnight(day):
    """Aware datetime of 00:00 on ``day`` in settings.TIME_ZONE (date filters are local calendar days)."""
    return timezone.make_aware(datetime.combine(day, time.min), timezone.get_default_timezone())


class FeedbackFilter(filters.FilterSet):
    """Date filters are converted to aware datetime ranges in Python (no DB date functions - MySQL safe)."""

    sentiment = filters.CharFilter(method="filter_sentiment")
    rating = filters.CharFilter(method="filter_rating")
    department = filters.CharFilter(method="filter_department")
    category = filters.CharFilter(method="filter_category")
    complaint = IdFilter(field_name="complaint_id")
    date_from = BoundedDateFilter(method="filter_date_from")
    date_to = BoundedDateFilter(method="filter_date_to")

    class Meta:
        model = Feedback
        fields = ["sentiment", "rating", "department", "category", "complaint", "date_from", "date_to"]

    def filter_sentiment(self, queryset, name, value):
        return queryset.filter(sentiment__in=[item.lower() for item in _split(value)])

    def filter_rating(self, queryset, name, value):
        ratings = [rating for rating in map(parse_id, _split(value)) if rating is not None]
        return queryset.filter(rating__in=ratings) if ratings else queryset.none()

    def filter_department(self, queryset, name, value):
        value = value.strip()
        department_id = parse_id(value)
        if department_id is not None:
            return queryset.filter(complaint__department_id=department_id)
        return queryset.filter(complaint__department__code__iexact=value)

    def filter_category(self, queryset, name, value):
        value = value.strip()
        category_id = parse_id(value)
        if category_id is not None:
            return queryset.filter(complaint__category_id=category_id)
        return queryset.filter(complaint__category__slug=value)

    def filter_date_from(self, queryset, name, value):
        return queryset.filter(created_at__gte=_local_midnight(value))

    def filter_date_to(self, queryset, name, value):
        return queryset.filter(created_at__lt=_local_midnight(value + timedelta(days=1)))


class FeedbackViewSet(mixins.ListModelMixin, viewsets.GenericViewSet):
    serializer_class = FeedbackSerializer
    filter_backends = [filters.DjangoFilterBackend, OrderingFilter]
    filterset_class = FeedbackFilter
    ordering_fields = ["created_at", "rating", "sentiment_score"]

    def get_permissions(self):
        if self.action in ("create", "pending"):
            return [IsCitizen()]
        return [IsAuthenticated()]

    def get_queryset(self):
        user = self.request.user
        queryset = Feedback.objects.select_related(
            "citizen", "complaint", "complaint__department", "complaint__category"
        )
        role = user_role(user)
        if role == "admin":
            return queryset
        if role == "officer":
            return queryset.filter(complaint__assigned_officer=user)
        return queryset.filter(citizen=user)

    def create(self, request, *args, **kwargs):
        payload = FeedbackCreateSerializer(data=request.data, context=self.get_serializer_context())
        payload.is_valid(raise_exception=True)
        feedback = services.submit_feedback(
            payload.validated_data["complaint"],
            citizen=request.user,
            rating=payload.validated_data["rating"],
            text=payload.validated_data["text"],
        )
        data = dict(self.get_serializer(feedback).data)
        data["suggest_reopen"] = services.should_suggest_reopen(feedback)
        return Response(data, status=status.HTTP_201_CREATED)

    @action(detail=False, methods=["get"])
    def pending(self, request):
        complaints = services.pending_feedback_for(request.user)
        return Response(PendingFeedbackSerializer(complaints, many=True, context=self.get_serializer_context()).data)
