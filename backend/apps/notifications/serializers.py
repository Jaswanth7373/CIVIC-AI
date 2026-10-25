"""Serializers for in-app notifications.

``NotificationSerializer`` renders the exact ``Notification`` JSON shape of BUILD_SPEC section 4.1::

    {"id", "title", "message", "notification_type", "type_display", "level", "complaint": id|null,
     "complaint_number": str|null, "link", "is_read", "read_at", "created_at"}

It is also imported by the analytics dashboard (owner B5). Querysets should ``select_related("complaint")`` so
``complaint_number`` does not cost one query per row.
"""
from rest_framework import serializers

from .models import Notification


class NotificationSerializer(serializers.ModelSerializer):
    type_display = serializers.CharField(source="get_notification_type_display", read_only=True)
    complaint_number = serializers.SerializerMethodField()

    class Meta:
        model = Notification
        fields = [
            "id", "title", "message", "notification_type", "type_display", "level", "complaint",
            "complaint_number", "link", "is_read", "read_at", "created_at",
        ]
        read_only_fields = fields

    def get_complaint_number(self, obj):
        if not obj.complaint_id:
            return None
        return obj.complaint.complaint_number
