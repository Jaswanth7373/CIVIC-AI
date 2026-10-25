"""Serializers for citizen feedback (BUILD_SPEC sections 4.1 / 4.2 "Feedback").

The shared output shapes come from their canonical home, ``apps.complaints.serializers`` (the complaint detail
embeds the same Feedback JSON)::

    Feedback      {"id", "complaint": id, "complaint_number", "complaint_title", "citizen": UserMini, "rating",
                   "text", "sentiment", "sentiment_display", "sentiment_score", "sentiment_confidence",
                   "sentiment_model", "is_demo", "department": DepartmentMini|null, "category": CategoryMini|null,
                   "created_at"}
    ComplaintMini {"id", "complaint_number", "title", "description", "status", "status_display",
                   "category": CategoryMini|null, "thumbnail": url|null, "created_at", "location": LocationOut,
                   "priority_score", "priority_level", "severity"}

This module adds the POST body serializer and the feedback-request ("pending") shape.
"""
from rest_framework import serializers

from apps.complaints.models import Complaint
from apps.complaints.serializers import ComplaintMiniSerializer, FeedbackSerializer

__all__ = ["FeedbackSerializer", "FeedbackCreateSerializer", "PendingFeedbackSerializer"]


class FeedbackCreateSerializer(serializers.Serializer):
    """POST /feedback/ body ``{complaint, rating, text?}``; only the requesting citizen's complaints are valid,
    so another citizen's complaint id is indistinguishable from a missing one."""

    complaint = serializers.PrimaryKeyRelatedField(
        queryset=Complaint.objects.none(),
        error_messages={"does_not_exist": "Complaint {pk_value} was not found among your complaints."},
    )
    rating = serializers.IntegerField(min_value=1, max_value=5)
    text = serializers.CharField(allow_blank=True, max_length=2000, default="")

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        request = self.context.get("request")
        if request is not None and request.user.is_authenticated:
            self.fields["complaint"].queryset = Complaint.objects.filter(citizen=request.user).select_related(
                "category", "department", "assigned_officer", "citizen"
            )


class PendingFeedbackSerializer(serializers.Serializer):
    """One feedback request: ``{"complaint": ComplaintMini, "resolved_at"}`` (rows of ``pending_feedback_for``)."""

    complaint = serializers.SerializerMethodField()
    resolved_at = serializers.DateTimeField(read_only=True)

    def get_complaint(self, complaint):
        return ComplaintMiniSerializer(complaint, context=self.context).data
