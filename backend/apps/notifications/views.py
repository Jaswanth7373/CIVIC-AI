"""Notifications REST API (BUILD_SPEC section 4.2 "Notifications").

    GET    /api/notifications/                 own notifications, ?is_read=true|false, paginated
    GET    /api/notifications/unread-count/    {"count": n}
    PUT    /api/notifications/{id}/read/       (POST also accepted) -> Notification
    POST   /api/notifications/read-all/        {"updated": n}
    DELETE /api/notifications/{id}/            204

Every query is filtered by ``user=request.user``, so one user can never read, mark or delete another user's
notifications - such ids simply resolve to 404.
"""
from django_filters import rest_framework as filters
from rest_framework import mixins, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from apps.core.utils import ID_PATTERN

from . import services
from .models import Notification
from .serializers import NotificationSerializer


class NotificationFilter(filters.FilterSet):
    """``?is_read=true|false`` (also accepts 1/0)."""

    is_read = filters.BooleanFilter()

    class Meta:
        model = Notification
        fields = ["is_read"]


class NotificationViewSet(mixins.ListModelMixin, mixins.DestroyModelMixin, viewsets.GenericViewSet):
    serializer_class = NotificationSerializer
    permission_classes = [IsAuthenticated]
    filter_backends = [filters.DjangoFilterBackend]
    filterset_class = NotificationFilter
    lookup_value_regex = ID_PATTERN

    def get_queryset(self):
        return Notification.objects.filter(user=self.request.user).select_related("complaint")

    @action(detail=False, methods=["get"], url_path="unread-count")
    def unread_count(self, request):
        return Response({"count": services.unread_count(request.user)})

    @action(detail=True, methods=["put", "post"], url_path="read")
    def read(self, request, pk=None):
        notification = services.mark_read(self.get_object())
        return Response(self.get_serializer(notification).data)

    @action(detail=False, methods=["post"], url_path="read-all")
    def read_all(self, request):
        return Response({"updated": services.mark_all_read(request.user)})
