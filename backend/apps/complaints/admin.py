from django.contrib import admin

from .models import (
    AIPrediction,
    Complaint,
    ComplaintImage,
    DuplicateComplaint,
    Location,
    PriorityScore,
    ResolutionEvidence,
    ResolutionVerification,
    StatusHistory,
)


class ComplaintImageInline(admin.TabularInline):
    model = ComplaintImage
    extra = 0


class StatusHistoryInline(admin.TabularInline):
    model = StatusHistory
    extra = 0
    readonly_fields = ("event", "old_status", "new_status", "changed_by", "remarks", "timestamp")


@admin.register(Complaint)
class ComplaintAdmin(admin.ModelAdmin):
    list_display = (
        "complaint_number", "title", "category", "status", "severity", "priority_score",
        "department", "assigned_officer", "created_at",
    )
    list_filter = ("status", "severity", "priority_level", "category", "department")
    search_fields = ("complaint_number", "title", "description", "location__address")
    raw_id_fields = ("citizen", "assigned_officer", "location", "duplicate_of")
    inlines = [ComplaintImageInline, StatusHistoryInline]
    date_hierarchy = "created_at"


@admin.register(Location)
class LocationAdmin(admin.ModelAdmin):
    list_display = ("id", "latitude", "longitude", "area", "city", "pincode")
    search_fields = ("address", "area", "city", "pincode")


@admin.register(AIPrediction)
class AIPredictionAdmin(admin.ModelAdmin):
    list_display = (
        "complaint", "image_category", "text_category", "final_category_slug",
        "multimodal_confidence", "severity", "model_mode", "created_at",
    )
    list_filter = ("model_mode", "is_demo", "needs_review")


@admin.register(PriorityScore)
class PriorityScoreAdmin(admin.ModelAdmin):
    list_display = ("complaint", "final_score", "priority_level", "trigger", "created_at")
    list_filter = ("priority_level", "trigger")


@admin.register(DuplicateComplaint)
class DuplicateComplaintAdmin(admin.ModelAdmin):
    list_display = (
        "complaint", "similar_complaint", "overall_similarity", "text_similarity",
        "image_similarity", "location_similarity", "status",
    )
    list_filter = ("status",)


@admin.register(StatusHistory)
class StatusHistoryAdmin(admin.ModelAdmin):
    list_display = ("complaint", "event", "old_status", "new_status", "changed_by", "timestamp")
    list_filter = ("event",)


@admin.register(ResolutionEvidence)
class ResolutionEvidenceAdmin(admin.ModelAdmin):
    list_display = ("complaint", "uploaded_by", "uploaded_at")


@admin.register(ResolutionVerification)
class ResolutionVerificationAdmin(admin.ModelAdmin):
    list_display = ("complaint", "status", "score", "method", "is_manual_override", "verified_by", "verified_at")
    list_filter = ("status", "method")
