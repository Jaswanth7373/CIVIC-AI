"""Read-only audit-log API for administrators (GET /api/audit-logs/, GET /api/audit-logs/{id}/).

Rows are written by ``apps.audit.services.log_action`` from every app; this endpoint only reads them
(newest first, paginated, filterable - see filters.py). The log cannot be edited or deleted through the API.
"""
from rest_framework import viewsets

from apps.core.permissions import IsAdmin
from apps.core.utils import ID_PATTERN

from .filters import AuditLogFilter
from .models import AuditLog
from .serializers import AuditLogSerializer


class AuditLogViewSet(viewsets.ReadOnlyModelViewSet):
    serializer_class = AuditLogSerializer
    permission_classes = [IsAdmin]
    filterset_class = AuditLogFilter
    search_fields = ["description", "entity_id", "entity_type", "actor__email", "actor__first_name",
                     "actor__last_name"]
    ordering_fields = ["created_at", "action", "entity_type"]
    ordering = ["-created_at", "-id"]
    lookup_value_regex = ID_PATTERN

    def get_queryset(self):
        return AuditLog.objects.select_related("actor")
