"""Audit-log row shape: ``{"id", "actor": UserMini|null, "action", "action_display", "entity_type",
"entity_id", "description", "changes", "ip_address", "created_at"}``."""
from rest_framework import serializers

from apps.complaints.serializers import UserMiniSerializer

from .models import AuditLog


class AuditLogSerializer(serializers.ModelSerializer):
    actor = UserMiniSerializer(read_only=True)
    action_display = serializers.CharField(source="get_action_display", read_only=True)

    class Meta:
        model = AuditLog
        fields = ["id", "actor", "action", "action_display", "entity_type", "entity_id", "description", "changes",
                  "ip_address", "created_at"]
        read_only_fields = fields
