"""Audit trail of security-relevant and administrative actions."""
from django.conf import settings
from django.db import models
from django.utils import timezone


class AuditLog(models.Model):
    class Action(models.TextChoices):
        CREATE = "create", "Create"
        UPDATE = "update", "Update"
        DELETE = "delete", "Delete"
        REGISTER = "register", "Register"
        LOGIN = "login", "Login"
        LOGOUT = "logout", "Logout"
        PASSWORD_CHANGE = "password_change", "Password change"
        STATUS_CHANGE = "status_change", "Status change"
        ASSIGN = "assign", "Assign"
        REASSIGN = "reassign", "Reassign"
        AI_OVERRIDE = "ai_override", "AI override"
        VERIFY = "verify", "Verification"
        DUPLICATE_REVIEW = "duplicate_review", "Duplicate review"
        CONFIG_CHANGE = "config_change", "Configuration change"
        EXPORT = "export", "Report export"
        OTHER = "other", "Other"

    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="audit_logs"
    )
    action = models.CharField(max_length=30, choices=Action.choices, db_index=True)
    entity_type = models.CharField(max_length=60, blank=True, db_index=True)
    entity_id = models.CharField(max_length=64, blank=True)
    description = models.CharField(max_length=255)
    changes = models.JSONField(default=dict, blank=True)
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    user_agent = models.CharField(max_length=255, blank=True)
    created_at = models.DateTimeField(default=timezone.now, db_index=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        indexes = [models.Index(fields=["entity_type", "entity_id"], name="audit_entity_idx")]

    def __str__(self):
        return f"[{self.created_at:%Y-%m-%d %H:%M}] {self.action} {self.entity_type}#{self.entity_id}"
