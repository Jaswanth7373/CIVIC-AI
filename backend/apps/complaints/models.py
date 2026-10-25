"""Complaint domain models for CivicAI.

Lifecycle (``Complaint.status``)::

    submitted -> analyzed -> assigned -> accepted -> in_progress -> resolved -> verified -> closed
                                 \\-> rejected                         \\-> reopened -> (accepted ...)

Every status change and lifecycle event is stored in ``StatusHistory`` (timeline).
AI outputs are stored verbatim in ``AIPrediction`` / ``PriorityScore`` /
``DuplicateComplaint`` / ``ResolutionVerification`` so they can be audited and
compared with human overrides.
"""
from datetime import timedelta

from django.conf import settings
from django.db import models
from django.utils import timezone


class Level(models.TextChoices):
    """Shared Low/Medium/High/Critical scale used for severity and priority."""

    LOW = "low", "Low"
    MEDIUM = "medium", "Medium"
    HIGH = "high", "High"
    CRITICAL = "critical", "Critical"


class Location(models.Model):
    latitude = models.DecimalField(max_digits=9, decimal_places=6, db_index=True)
    longitude = models.DecimalField(max_digits=9, decimal_places=6, db_index=True)
    address = models.CharField(max_length=255, blank=True)
    landmark = models.CharField(max_length=150, blank=True)
    area = models.CharField(max_length=120, blank=True, db_index=True)
    city = models.CharField(max_length=100, blank=True, db_index=True)
    pincode = models.CharField(max_length=10, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        indexes = [models.Index(fields=["latitude", "longitude"], name="location_lat_lng_idx")]

    def __str__(self):
        return self.address or f"{self.latitude}, {self.longitude}"

    @property
    def lat(self):
        return float(self.latitude)

    @property
    def lng(self):
        return float(self.longitude)


class Complaint(models.Model):
    class Status(models.TextChoices):
        SUBMITTED = "submitted", "Submitted"
        ANALYZED = "analyzed", "AI Analyzed"
        ASSIGNED = "assigned", "Assigned"
        ACCEPTED = "accepted", "Accepted"
        IN_PROGRESS = "in_progress", "In Progress"
        RESOLVED = "resolved", "Resolved"
        VERIFIED = "verified", "Verified"
        CLOSED = "closed", "Closed"
        REJECTED = "rejected", "Rejected"
        REOPENED = "reopened", "Reopened"

    # Status groups used by dashboards / analytics / workload calculations
    PENDING_STATUSES = [Status.SUBMITTED, Status.ANALYZED, Status.ASSIGNED, Status.REOPENED]
    IN_PROGRESS_STATUSES = [Status.ACCEPTED, Status.IN_PROGRESS]
    RESOLVED_STATUSES = [Status.RESOLVED, Status.VERIFIED, Status.CLOSED]
    OPEN_STATUSES = PENDING_STATUSES + IN_PROGRESS_STATUSES
    OPEN_ASSIGNED_STATUSES = [Status.ASSIGNED, Status.ACCEPTED, Status.IN_PROGRESS, Status.REOPENED]

    complaint_number = models.CharField(max_length=24, unique=True, null=True, blank=True, editable=False)
    citizen = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="complaints")
    title = models.CharField(max_length=160, blank=True)
    description = models.TextField()
    reported_category = models.ForeignKey(
        "departments.CivicCategory", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="reported_complaints", help_text="Category chosen by the citizen (optional hint)",
    )
    category = models.ForeignKey(
        "departments.CivicCategory", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="complaints", help_text="Final category (AI multimodal result or admin override)",
    )
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.SUBMITTED, db_index=True)
    severity = models.CharField(max_length=10, choices=Level.choices, blank=True, db_index=True)
    severity_score = models.PositiveSmallIntegerField(default=0)
    priority_score = models.PositiveSmallIntegerField(default=0, db_index=True)
    priority_level = models.CharField(max_length=10, choices=Level.choices, blank=True, db_index=True)
    department = models.ForeignKey(
        "departments.Department", on_delete=models.SET_NULL, null=True, blank=True, related_name="complaints"
    )
    assigned_officer = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="assigned_complaints"
    )
    location = models.OneToOneField(Location, on_delete=models.CASCADE, related_name="complaint")
    incident_at = models.DateTimeField(default=timezone.now, help_text="When the citizen observed the issue")

    duplicate_of = models.ForeignKey(
        "self", on_delete=models.SET_NULL, null=True, blank=True, related_name="confirmed_duplicates",
        help_text="Set when a reviewer confirms this complaint duplicates an earlier one",
    )
    duplicate_count = models.PositiveIntegerField(default=0, help_text="Linked duplicate complaints (pending + confirmed)")
    reopen_count = models.PositiveSmallIntegerField(default=0)
    is_ai_overridden = models.BooleanField(default=False)
    needs_manual_review = models.BooleanField(default=False)
    sla_due_at = models.DateTimeField(null=True, blank=True)

    # created_at uses a default (not auto_now_add) so demo data can be back-dated
    created_at = models.DateTimeField(default=timezone.now, db_index=True)
    updated_at = models.DateTimeField(auto_now=True)
    accepted_at = models.DateTimeField(null=True, blank=True)
    resolved_at = models.DateTimeField(null=True, blank=True)
    verified_at = models.DateTimeField(null=True, blank=True)
    closed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["status", "-priority_score"], name="complaint_status_prio_idx"),
            models.Index(fields=["department", "status"], name="complaint_dept_status_idx"),
            models.Index(fields=["category", "status"], name="complaint_cat_status_idx"),
            models.Index(fields=["assigned_officer", "status"], name="complaint_officer_status_idx"),
            models.Index(fields=["severity", "created_at"], name="complaint_sev_created_idx"),
            models.Index(fields=["priority_level", "created_at"], name="complaint_plevel_created_idx"),
        ]

    def __str__(self):
        return self.complaint_number or f"Complaint #{self.pk}"

    def save(self, *args, **kwargs):
        creating = self.pk is None
        super().save(*args, **kwargs)
        if creating and not self.complaint_number:
            year = (self.created_at or timezone.now()).year
            self.complaint_number = f"CIV-{year}-{self.pk:06d}"
            Complaint.objects.filter(pk=self.pk).update(complaint_number=self.complaint_number)

    # ----- convenience accessors -------------------------------------------------
    @property
    def latest_prediction(self):
        return self.predictions.order_by("-created_at", "-id").first()

    @property
    def latest_priority(self):
        return self.priority_scores.order_by("-created_at", "-id").first()

    @property
    def latest_verification(self):
        return self.verifications.order_by("-verified_at", "-id").first()

    @property
    def primary_image(self):
        return self.images.order_by("id").first()

    @property
    def is_open(self):
        return self.status in self.OPEN_STATUSES

    @property
    def is_overdue(self):
        return bool(self.sla_due_at and self.is_open and timezone.now() > self.sla_due_at)

    def compute_sla_due(self):
        hours = 72
        if self.category_id:
            hours = self.category.effective_sla_hours
        elif self.department_id:
            hours = self.department.sla_hours
        # Critical issues get half the normal SLA, high gets 75%
        if self.priority_level == Level.CRITICAL:
            hours = max(4, hours // 2)
        elif self.priority_level == Level.HIGH:
            hours = max(8, int(hours * 0.75))
        return (self.created_at or timezone.now()) + timedelta(hours=hours)


class ComplaintImage(models.Model):
    class Kind(models.TextChoices):
        ORIGINAL = "original", "Original"
        ADDITIONAL = "additional", "Additional"

    complaint = models.ForeignKey(Complaint, on_delete=models.CASCADE, related_name="images")
    image = models.ImageField(upload_to="complaints/%Y/%m/")
    kind = models.CharField(max_length=12, choices=Kind.choices, default=Kind.ORIGINAL)
    phash = models.CharField(max_length=32, blank=True, db_index=True, help_text="Perceptual hash (hex)")
    dhash = models.CharField(max_length=32, blank=True, help_text="Difference hash (hex)")
    width = models.PositiveIntegerField(default=0)
    height = models.PositiveIntegerField(default=0)
    file_size = models.PositiveIntegerField(default=0)
    uploaded_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ["id"]

    def __str__(self):
        return f"Image {self.pk} for {self.complaint_id}"


class AIPrediction(models.Model):
    complaint = models.ForeignKey(Complaint, on_delete=models.CASCADE, related_name="predictions")
    image_category = models.CharField(max_length=60, blank=True)
    image_confidence = models.FloatField(default=0)
    text_category = models.CharField(max_length=60, blank=True)
    text_confidence = models.FloatField(default=0)
    final_category = models.ForeignKey(
        "departments.CivicCategory", on_delete=models.SET_NULL, null=True, blank=True, related_name="ai_predictions"
    )
    final_category_slug = models.CharField(max_length=60, blank=True)
    multimodal_confidence = models.FloatField(default=0)
    severity = models.CharField(max_length=10, choices=Level.choices, blank=True)
    severity_score = models.PositiveSmallIntegerField(default=0)
    severity_reason = models.TextField(blank=True)
    severity_factors = models.JSONField(default=dict, blank=True)
    detected_objects = models.JSONField(default=list, blank=True)
    bounding_boxes = models.JSONField(default=list, blank=True)
    keywords = models.JSONField(default=list, blank=True)
    impacts = models.JSONField(default=list, blank=True)
    probabilities = models.JSONField(default=dict, blank=True, help_text='{"image": {...}, "text": {...}, "fused": {...}}')
    modality_weights = models.JSONField(default=dict, blank=True)
    location_risk = models.JSONField(default=dict, blank=True)
    explanation = models.TextField(blank=True)
    needs_review = models.BooleanField(default=False, help_text="Modalities disagree or confidence is low")
    model_mode = models.CharField(max_length=12, default="demo")
    is_demo = models.BooleanField(default=True)
    model_version = models.CharField(max_length=160, blank=True)
    processing_time_ms = models.PositiveIntegerField(default=0)
    raw_output = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(default=timezone.now, db_index=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        get_latest_by = "created_at"

    def __str__(self):
        return f"AIPrediction({self.complaint_id}: {self.final_category_slug} {self.multimodal_confidence:.2f})"


class PriorityScore(models.Model):
    complaint = models.ForeignKey(Complaint, on_delete=models.CASCADE, related_name="priority_scores")
    severity_component = models.FloatField(default=0)
    impact_component = models.FloatField(default=0)
    location_component = models.FloatField(default=0)
    frequency_component = models.FloatField(default=0)
    duplicate_component = models.FloatField(default=0)
    final_score = models.PositiveSmallIntegerField(default=0)
    priority_level = models.CharField(max_length=10, choices=Level.choices, default=Level.LOW)
    weights = models.JSONField(default=dict, blank=True)
    factors = models.JSONField(default=dict, blank=True, help_text="Normalised factor values and raw inputs")
    explanation = models.TextField(blank=True)
    trigger = models.CharField(max_length=30, default="initial")
    is_override = models.BooleanField(default=False)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ["-created_at", "-id"]
        get_latest_by = "created_at"

    def __str__(self):
        return f"Priority {self.final_score} ({self.priority_level}) for {self.complaint_id}"


class DuplicateComplaint(models.Model):
    class Status(models.TextChoices):
        PENDING_REVIEW = "pending_review", "Pending Review"
        CONFIRMED_DUPLICATE = "confirmed_duplicate", "Confirmed Duplicate"
        NOT_DUPLICATE = "not_duplicate", "Not Duplicate"

    complaint = models.ForeignKey(
        Complaint, on_delete=models.CASCADE, related_name="duplicate_candidates",
        help_text="The newer complaint that looks like a duplicate",
    )
    similar_complaint = models.ForeignKey(
        Complaint, on_delete=models.CASCADE, related_name="similar_to",
        help_text="The earlier (original) complaint",
    )
    text_similarity = models.FloatField(default=0)
    image_similarity = models.FloatField(null=True, blank=True)
    location_similarity = models.FloatField(default=0)
    overall_similarity = models.FloatField(default=0, db_index=True)
    distance_m = models.FloatField(default=0)
    category_match = models.BooleanField(default=False)
    status = models.CharField(max_length=24, choices=Status.choices, default=Status.PENDING_REVIEW, db_index=True)
    explanation = models.CharField(max_length=255, blank=True)
    reviewed_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True)
    reviewed_at = models.DateTimeField(null=True, blank=True)
    review_notes = models.CharField(max_length=255, blank=True)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ["-overall_similarity", "-created_at"]
        constraints = [
            models.UniqueConstraint(fields=["complaint", "similar_complaint"], name="uniq_duplicate_pair"),
        ]

    def __str__(self):
        return f"{self.complaint_id} ~ {self.similar_complaint_id} ({self.overall_similarity:.0%})"


class StatusHistory(models.Model):
    """Timeline entry: status changes AND lifecycle events (AI analysis, routing, feedback...)."""

    class Event(models.TextChoices):
        SUBMITTED = "submitted", "Complaint Submitted"
        AI_ANALYZED = "ai_analyzed", "AI Analysis Completed"
        PRIORITY_ASSIGNED = "priority_assigned", "Priority Assigned"
        DEPARTMENT_ASSIGNED = "department_assigned", "Department Assigned"
        OFFICER_ASSIGNED = "officer_assigned", "Officer Assigned"
        REASSIGNED = "reassigned", "Officer Reassigned"
        STATUS_CHANGED = "status_changed", "Status Changed"
        ACCEPTED = "accepted", "Accepted"
        IN_PROGRESS = "in_progress", "Work In Progress"
        EVIDENCE_UPLOADED = "evidence_uploaded", "Resolution Evidence Uploaded"
        RESOLVED = "resolved", "Resolved"
        VERIFICATION_RUN = "verification_run", "AI Verification Completed"
        MANUAL_REVIEW_REQUESTED = "manual_review_requested", "Manual Verification Requested"
        VERIFIED = "verified", "Resolution Verified"
        FEEDBACK = "feedback", "Citizen Feedback"
        CLOSED = "closed", "Closed"
        REJECTED = "rejected", "Rejected"
        REOPENED = "reopened", "Reopened"
        DUPLICATE_FLAGGED = "duplicate_flagged", "Potential Duplicate Detected"
        DUPLICATE_CONFIRMED = "duplicate_confirmed", "Duplicate Confirmed"
        AI_OVERRIDDEN = "ai_overridden", "AI Prediction Overridden"
        PRIORITY_UPDATED = "priority_updated", "Priority Recalculated"
        REMARK = "remark", "Remark Added"

    complaint = models.ForeignKey(Complaint, on_delete=models.CASCADE, related_name="status_history")
    event = models.CharField(max_length=30, choices=Event.choices, default=Event.STATUS_CHANGED, db_index=True)
    old_status = models.CharField(max_length=20, blank=True)
    new_status = models.CharField(max_length=20, blank=True)
    changed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="status_changes",
        help_text="Null means the change was made by the system / AI engine",
    )
    remarks = models.TextField(blank=True)
    metadata = models.JSONField(default=dict, blank=True)
    is_public = models.BooleanField(default=True, help_text="Visible to the citizen on their timeline")
    timestamp = models.DateTimeField(default=timezone.now, db_index=True)

    class Meta:
        ordering = ["timestamp", "id"]
        verbose_name_plural = "status history"

    def __str__(self):
        return f"{self.complaint_id}: {self.event} {self.old_status}->{self.new_status}"


class ResolutionEvidence(models.Model):
    complaint = models.ForeignKey(Complaint, on_delete=models.CASCADE, related_name="evidence")
    before_image = models.ImageField(upload_to="evidence/before/%Y/%m/", null=True, blank=True)
    after_image = models.ImageField(upload_to="evidence/after/%Y/%m/", null=True, blank=True)
    uploaded_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="uploaded_evidence"
    )
    remarks = models.TextField(blank=True)
    uploaded_at = models.DateTimeField(default=timezone.now)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-uploaded_at", "-id"]
        verbose_name_plural = "resolution evidence"

    def __str__(self):
        return f"Evidence {self.pk} for {self.complaint_id}"


class ResolutionVerification(models.Model):
    class Status(models.TextChoices):
        LIKELY_RESOLVED = "likely_resolved", "Likely Resolved"
        PARTIALLY_RESOLVED = "partially_resolved", "Partially Resolved"
        NOT_RESOLVED = "not_resolved", "Not Resolved"
        NEEDS_MANUAL_REVIEW = "needs_manual_review", "Needs Manual Review"

    class Method(models.TextChoices):
        AI_ASSISTED = "ai_assisted", "AI-assisted"
        MANUAL = "manual", "Manual"

    complaint = models.ForeignKey(Complaint, on_delete=models.CASCADE, related_name="verifications")
    evidence = models.ForeignKey(
        ResolutionEvidence, on_delete=models.SET_NULL, null=True, blank=True, related_name="verifications"
    )
    score = models.PositiveSmallIntegerField(default=0)
    status = models.CharField(max_length=24, choices=Status.choices, db_index=True)
    explanation = models.TextField(blank=True)
    metrics = models.JSONField(default=dict, blank=True)
    method = models.CharField(max_length=12, choices=Method.choices, default=Method.AI_ASSISTED)
    is_manual_override = models.BooleanField(default=False)
    manual_review_requested = models.BooleanField(default=False)
    verified_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="verifications_done"
    )
    verified_at = models.DateTimeField(default=timezone.now)
    model_version = models.CharField(max_length=160, blank=True)
    is_demo = models.BooleanField(default=True)

    class Meta:
        ordering = ["-verified_at", "-id"]

    def __str__(self):
        return f"Verification {self.status} ({self.score}) for {self.complaint_id}"
