"""Audit logging service.

    from apps.audit.services import log_action
    log_action(request.user, "status_change", entity=complaint, description="Status: assigned -> accepted",
               changes={"status": ["assigned", "accepted"]}, request=request)
"""
import logging

from apps.core.utils import get_client_ip

from .models import AuditLog

logger = logging.getLogger("apps.audit")


def log_action(actor, action, *, entity=None, entity_type="", entity_id="", description="", changes=None, request=None):
    """Create an AuditLog row. Never raises (audit failures must not break the request)."""
    try:
        if entity is not None:
            entity_type = entity_type or entity.__class__.__name__
            entity_id = entity_id or str(getattr(entity, "pk", "") or "")
        if actor is not None and not getattr(actor, "is_authenticated", False):
            actor = None
        user_agent = ""
        if request is not None:
            user_agent = (request.META.get("HTTP_USER_AGENT") or "")[:255]
        return AuditLog.objects.create(
            actor=actor,
            action=action,
            entity_type=entity_type or "",
            entity_id=str(entity_id or ""),
            description=(description or f"{action} {entity_type}")[:255],
            changes=changes or {},
            ip_address=get_client_ip(request),
            user_agent=user_agent,
        )
    except Exception:  # pragma: no cover - defensive
        logger.exception("Failed to write audit log")
        return None
