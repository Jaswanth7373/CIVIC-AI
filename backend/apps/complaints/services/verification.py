"""Resolution evidence + AI-assisted verification (BUILD_SPEC sections 2.8 and 3.2).

Evidence
    Officers upload a *before* photo (optional - the citizen's original photo is the fallback) and an *after*
    photo of the repaired site. One ``ResolutionEvidence`` row holds a before/after pair; uploads fill the
    current row of this resolution cycle and a new row starts when a slot is already taken (so re-uploads keep
    the history and every verification points at the exact evidence it judged).

AI-assisted verification (engine: ``ai.verification.verify_resolution``)
    The engine aligns the after photo onto the before photo (ORB features + RANSAC homography), measures change
    with SSIM / histogram correlation / edge density - in particular *inside the originally detected defect
    boxes* - and re-runs issue detection on the after photo. It returns a 0-100 score and one of
    likely_resolved / partially_resolved / not_resolved / needs_manual_review, using the thresholds from
    ``AIConfiguration``. It is decision support, not proof: every result carries a disclaimer and humans
    (assigned officer / admin) can override it with a manual verification.

Consequences of the outcome
    likely_resolved + complaint resolved + auto-verify on -> status verified (system); the citizen is told and
                                                             asked for feedback; +15 civic points
    partially_resolved / not_resolved                     -> flagged for manual review; officer + admins told
    needs_manual_review                                   -> flagged for manual review; admins told
"""
from django.db import transaction
from django.db.models import Q
from rest_framework.exceptions import PermissionDenied

from apps.core.exceptions import ServiceError

from ..models import Complaint, ResolutionEvidence, ResolutionVerification, StatusHistory
from . import notify as notifications
from .context import engine_config
from .helpers import (
    compact_copy,
    error_text,
    log_failure,
    normalize_actor,
    run_side_effect,
    save_fields,
    stored_image_input,
    to_float,
    to_score,
)
from .status import (
    ADMIN,
    ASSIGNED_OFFICER,
    EVIDENCE_STATUSES,
    actor_role,
    add_event,
    change_status,
    last_reopened_at,
    officer_can_override_verification,
    status_phrase,
)

S = Complaint.Status
V = ResolutionVerification.Status

DEFAULT_DISCLAIMER = "AI-assisted verification - not a guarantee. Officers and admins can override the result."
MANUAL_MODEL_VERSION = "manual-review"
#: Outcomes that need a human to look at the evidence.
REVIEW_OUTCOMES = (V.PARTIALLY_RESOLVED, V.NOT_RESOLVED, V.NEEDS_MANUAL_REVIEW)


# ---------------------------------------------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------------------------------------------
def _ensure_resolution_actor(complaint, actor, action):
    """Only the assigned officer or an administrator may handle resolution evidence / verification."""
    role = actor_role(complaint, actor)
    if role not in (ADMIN, ASSIGNED_OFFICER):
        raise PermissionDenied(f"Only the officer assigned to this complaint or an administrator can {action}.")
    return role


def _has_file(field_name):
    return ~Q(**{f"{field_name}__isnull": True}) & ~Q(**{field_name: ""})


def _cycle_evidence(complaint):
    """Evidence rows of the current resolution cycle (uploaded after the last reopen), newest first."""
    queryset = ResolutionEvidence.objects.filter(complaint=complaint)
    since = last_reopened_at(complaint)
    if since is not None:
        queryset = queryset.filter(uploaded_at__gt=since)
    return queryset.order_by("-uploaded_at", "-id")


def current_after_evidence(complaint):
    """Latest evidence of the current cycle that has an after photo (None if there is none)."""
    return _cycle_evidence(complaint).filter(_has_file("after_image")).first()


def _before_image_for(complaint, evidence):
    """Before photo for a verification: the evidence's own, else the latest uploaded before photo, else the
    citizen's original complaint photo."""
    if evidence is not None and evidence.before_image:
        return evidence.before_image
    earlier = (
        ResolutionEvidence.objects.filter(complaint=complaint).filter(_has_file("before_image"))
        .order_by("-uploaded_at", "-id").first()
    )
    if earlier is not None:
        return earlier.before_image
    primary = complaint.primary_image
    return primary.image if primary is not None else None


def with_disclaimer(explanation, disclaimer=None):
    """Explanation that always ends with the AI-assistance disclaimer (added once)."""
    text = (explanation or "").strip()
    disclaimer = (disclaimer or DEFAULT_DISCLAIMER).strip()
    if disclaimer.lower() not in text.lower():
        text = f"{text} {disclaimer}".strip()
    return text


def verification_review_pending(complaint):
    """True when a resolved complaint is waiting for a human verification decision."""
    if complaint.status != S.RESOLVED:
        return False
    latest = complaint.latest_verification
    return bool(latest is not None and (latest.manual_review_requested or latest.status in REVIEW_OUTCOMES))


def default_manual_score(status, verification_config=None):
    """Representative score for a manual decision given without a score, derived from the AI thresholds:
    likely -> midway between the resolved threshold and 100, partial -> midway between the two thresholds,
    not resolved -> half the partial threshold, needs review -> 0. Each score stays inside its outcome's band
    (partial: at least the partial threshold and below the resolved one, even when the thresholds are 1 apart)."""
    config = verification_config or engine_config()["verification"]
    resolved = int(config.get("resolved_threshold", 70))
    partial = int(config.get("partial_threshold", 45))
    return {
        V.LIKELY_RESOLVED: round((resolved + 100) / 2),
        V.PARTIALLY_RESOLVED: min(resolved - 1, round((partial + resolved) / 2)),
        V.NOT_RESOLVED: round(partial / 2),
        V.NEEDS_MANUAL_REVIEW: 0,
    }[status]


def _flag_for_review(complaint):
    if not complaint.needs_manual_review:
        complaint.needs_manual_review = True
        save_fields(complaint, "needs_manual_review")


# ---------------------------------------------------------------------------------------------------------------
# Evidence
# ---------------------------------------------------------------------------------------------------------------
def upload_evidence(complaint, *, actor, before_image=None, after_image=None, remarks="", request=None):
    """Create/update the current ResolutionEvidence for the complaint. Returns ResolutionEvidence.

    A photo fills the matching empty slot of the newest evidence row of this resolution cycle; when that slot
    is already taken (a re-upload) a new row is started, so earlier evidence and its verification stay intact.
    Allowed for the assigned officer while the complaint is accepted / in progress / resolved, and for an admin
    at any stage before it is closed or rejected. Adds an "evidence_uploaded" timeline event and an audit entry.
    """
    from apps.audit.services import log_action

    role = _ensure_resolution_actor(complaint, actor, "upload resolution evidence")
    if before_image is None and after_image is None:
        raise ServiceError("Attach a before photo, an after photo, or both.")
    if role == ADMIN and complaint.status in (S.CLOSED, S.REJECTED):
        raise ServiceError(f"Evidence cannot be added to a {status_phrase(complaint.status)} complaint; "
                           "reopen it first.")
    if role != ADMIN and complaint.status not in EVIDENCE_STATUSES:
        raise ServiceError("Resolution evidence can be uploaded once the complaint is accepted (current status: "
                           f"{status_phrase(complaint.status)}).")
    remarks = (remarks or "").strip()
    actor = normalize_actor(actor)
    with transaction.atomic():
        evidence = _cycle_evidence(complaint).first()
        slot_taken = evidence is not None and (
            (before_image is not None and evidence.before_image) or (after_image is not None and evidence.after_image)
        )
        created = evidence is None or bool(slot_taken)
        if created:
            evidence = ResolutionEvidence(complaint=complaint, uploaded_by=actor, remarks=remarks)
        else:
            if remarks:
                evidence.remarks = f"{evidence.remarks}\n{remarks}".strip()
            evidence.uploaded_by = evidence.uploaded_by or actor
        if before_image is not None:
            evidence.before_image = before_image
        if after_image is not None:
            evidence.after_image = after_image
        evidence.save()
        photos = [name for name, given in (("before", before_image), ("after", after_image)) if given is not None]
        add_event(
            complaint, StatusHistory.Event.EVIDENCE_UPLOADED, actor=actor,
            remarks=remarks or f"{' and '.join(photos).capitalize()} photo uploaded.",
            metadata={"evidence_id": evidence.pk, "before": bool(evidence.before_image),
                      "after": bool(evidence.after_image)},
        )
        run_side_effect(
            "Audit log of an evidence upload", log_action, actor, "update", entity=complaint,
            description=f"Resolution evidence ({' + '.join(photos)}) uploaded for {complaint.complaint_number}",
            changes={"evidence_id": evidence.pk, "photos": photos, "new_row": created}, request=request,
        )
    return evidence


# ---------------------------------------------------------------------------------------------------------------
# AI-assisted verification
# ---------------------------------------------------------------------------------------------------------------
def run_ai_verification(complaint, *, actor=None, evidence=None, request=None):
    """Run ai.verification on the latest evidence (before image falls back to the citizen's original photo).
    Stores ResolutionVerification; if likely_resolved and auto_verify is on -> status verified + citizen
    asked for feedback; not_resolved -> flagged for review. Returns ResolutionVerification.

    ``actor`` None means the automatic run after a resolution. Raises ServiceError when there is no after photo,
    no before photo at all, or the engine fails (nothing is stored in that case).
    """
    from ai.verification import verify_resolution
    from apps.audit.services import log_action

    if actor is not None:
        _ensure_resolution_actor(complaint, actor, "run the AI verification")
    evidence = evidence or current_after_evidence(complaint)
    if evidence is None or not evidence.after_image:
        raise ServiceError("Upload an after photo of the repaired site before running the AI verification.")
    before_file = _before_image_for(complaint, evidence)
    if not before_file:
        raise ServiceError("The AI verification needs a before photo: upload one, or verify the work manually.")
    before_input, after_input = stored_image_input(before_file), stored_image_input(evidence.after_image)
    if before_input is None or after_input is None:
        raise ServiceError("The evidence photos could not be read from storage; upload them again.")

    prediction = complaint.latest_prediction
    boxes = list(prediction.bounding_boxes or []) if prediction is not None else []
    category = complaint.category.slug if complaint.category_id else (
        prediction.final_category_slug if prediction is not None else None
    )
    config = engine_config()["verification"]
    try:
        result = verify_resolution(before_input, after_input, category=category, boxes=boxes or None,
                                   config=config) or {}
    except Exception as exc:  # noqa: BLE001 - reported to the caller as a clear business error
        log_failure(f"AI verification of {complaint.complaint_number}", exc)
        raise ServiceError(f"The AI verification could not be completed: {error_text(exc)}") from exc

    status = result.get("status") if result.get("status") in V.values else V.NEEDS_MANUAL_REVIEW
    score = to_score(result.get("score"))
    metrics = compact_copy(result.get("metrics") or {})
    if not isinstance(metrics, dict):
        metrics = {"engine": metrics}
    metrics.setdefault("processing_time_ms", int(to_float(result.get("processing_time_ms"))))
    actor = normalize_actor(actor)
    with transaction.atomic():
        verification = ResolutionVerification.objects.create(
            complaint=complaint,
            evidence=evidence,
            score=score,
            status=status,
            explanation=with_disclaimer(result.get("explanation"), result.get("disclaimer")),
            metrics=metrics,
            method=ResolutionVerification.Method.AI_ASSISTED,
            is_manual_override=False,
            manual_review_requested=False,
            verified_by=actor,
            model_version=str(result.get("model_version") or "")[:160],
            is_demo=bool(result.get("is_demo", result.get("mode", "demo") == "demo")),
        )
        add_event(
            complaint, StatusHistory.Event.VERIFICATION_RUN, actor=actor,
            remarks=(f"AI-assisted verification score {score}/100: {verification.get_status_display()}. "
                     f"{(result.get('explanation') or '').strip()}").strip(),
            metadata={"verification_id": verification.pk, "evidence_id": evidence.pk, "score": score,
                      "status": status, "is_demo": verification.is_demo,
                      "model_version": verification.model_version},
        )
        run_side_effect(
            "Audit log of an AI verification", log_action, actor, "verify", entity=complaint,
            description=f"AI verification of {complaint.complaint_number}: {verification.get_status_display()} "
                        f"({score}/100)",
            changes={"verification_id": verification.pk, "status": status, "score": score}, request=request,
        )
        _apply_ai_outcome(complaint, verification)
    return verification


def _apply_ai_outcome(complaint, verification):
    """Consequences of an AI verdict - only for a complaint claimed as resolved (a run on work still in progress
    is informational and changes nothing)."""
    from apps.core.models import AIConfiguration

    if complaint.status != S.RESOLVED:
        return
    number = complaint.complaint_number
    label = verification.get_status_display()
    if verification.status == V.LIKELY_RESOLVED:
        if AIConfiguration.load().auto_verify_resolution:
            # change_status notifies the citizen (resolution_verified + feedback_requested) and awards points
            change_status(complaint, S.VERIFIED, actor=None, metadata={"verification_id": verification.pk},
                          remarks=f"Verified automatically: AI-assisted verification score {verification.score}/100 "
                                  "(likely resolved).")
        return
    _flag_for_review(complaint)
    message = (f"AI-assisted verification of {number} returned '{label}' ({verification.score}/100). "
               "Please review the before/after photos and verify manually.")
    if verification.status in (V.NOT_RESOLVED, V.PARTIALLY_RESOLVED):
        notifications.notify_assigned_officer(
            complaint, notification_type="manual_review_requested", title=f"Verification: {label} for {number}",
            message=f"{message} Upload a new after photo once the remaining work is done.", level="warning",
        )
    notifications.notify_admins(notification_type="manual_review_requested",
                                title=f"Manual verification needed: {number}", message=message,
                                complaint=complaint, level="warning")


def auto_verify_after_resolution(complaint):
    """Run the AI verification right after a resolution when auto-verification is enabled and an after photo
    exists for this cycle. Never raises: when the verification cannot run, the complaint is flagged for manual
    review (with a timeline note) and administrators are told. Returns the verification or None."""
    from apps.core.models import AIConfiguration

    if not AIConfiguration.load().auto_verify_resolution:
        return None
    evidence = current_after_evidence(complaint)
    if evidence is None:
        return None
    try:
        return run_ai_verification(complaint, actor=None, evidence=evidence)
    except Exception as exc:  # noqa: BLE001 - the resolution itself already succeeded
        log_failure(f"Automatic verification of {complaint.complaint_number}", exc)
        reason = error_text(exc)
        _flag_for_review(complaint)
        run_side_effect("Timeline note for a failed verification", add_event, complaint,
                        StatusHistory.Event.REMARK, is_public=False,
                        remarks=f"Automatic AI verification could not run: {reason}. Manual verification needed.")
        number = complaint.complaint_number
        notifications.notify_admins(
            notification_type="manual_review_requested", title=f"Manual verification needed: {number}",
            message=f"{number} was resolved but the automatic AI verification could not run ({reason}). Please "
                    "verify it manually.", complaint=complaint, level="warning",
        )
        return None


# ---------------------------------------------------------------------------------------------------------------
# Human decisions
# ---------------------------------------------------------------------------------------------------------------
def manual_verification(complaint, *, actor, status, score=None, explanation="", request=None):
    """Officer/admin manual override of the verification outcome. Returns ResolutionVerification.

    Stores a ``method="manual"`` row (``is_manual_override=True``, ``verified_by=actor``) next to the AI rows and
    applies the decision: likely_resolved -> verified; partially / not resolved -> back to in progress (the work
    is sent back with the explanation as remark); needs_manual_review -> escalated to administrators. The
    assigned officer may decide on resolved complaints and override an AI-assisted verification of a verified one
    (``officer_can_override_verification``); administrators decide on resolved and verified complaints. ``score``
    defaults to a value representative of the chosen outcome (see ``default_manual_score``).
    """
    from apps.audit.services import log_action

    role = _ensure_resolution_actor(complaint, actor, "verify the resolution")
    if status not in V.values:
        raise ServiceError(f"Unknown verification status '{status}'.")
    explanation = (explanation or "").strip()
    if not explanation:
        raise ServiceError("Explain the manual verification decision.")
    if role == ADMIN:
        allowed = complaint.status in (S.RESOLVED, S.VERIFIED)
    else:
        allowed = officer_can_override_verification(complaint)
    if not allowed:
        if complaint.status == S.VERIFIED:
            raise ServiceError("This resolution was verified by an administrator; only an administrator can change "
                               "that decision.")
        raise ServiceError(f"Manual verification is only possible for a resolved complaint (current status: "
                           f"{status_phrase(complaint.status)}).")
    score = to_score(score) if score is not None else default_manual_score(status)
    previous = complaint.latest_verification
    evidence = current_after_evidence(complaint) or _cycle_evidence(complaint).first()
    label = ResolutionVerification.Status(status).label

    with transaction.atomic():
        verification = ResolutionVerification.objects.create(
            complaint=complaint,
            evidence=evidence,
            score=score,
            status=status,
            explanation=explanation,
            metrics={
                "previous_status": previous.status if previous is not None else None,
                "previous_score": previous.score if previous is not None else None,
                "previous_method": previous.method if previous is not None else None,
            },
            method=ResolutionVerification.Method.MANUAL,
            is_manual_override=True,
            manual_review_requested=False,
            verified_by=actor,
            model_version=MANUAL_MODEL_VERSION,
            is_demo=False,
        )
        metadata = {"verification_id": verification.pk, "status": status, "score": score, "manual": True}
        add_event(complaint, StatusHistory.Event.VERIFICATION_RUN, actor=actor, metadata=metadata,
                  remarks=f"Manual verification by {actor.full_name}: {label} ({score}/100). {explanation}")
        complaint.needs_manual_review = status == V.NEEDS_MANUAL_REVIEW
        save_fields(complaint, "needs_manual_review")
        if status == V.LIKELY_RESOLVED:
            if complaint.status == S.RESOLVED:
                change_status(complaint, S.VERIFIED, actor=actor, remarks=explanation, metadata=metadata,
                              request=request)
        elif status in (V.NOT_RESOLVED, V.PARTIALLY_RESOLVED):
            change_status(complaint, S.IN_PROGRESS, actor=actor, metadata=metadata, force=True, request=request,
                          remarks=f"Manual verification: {label.lower()}. {explanation}")
            number = complaint.complaint_number
            notifications.notify_assigned_officer(
                complaint, notification_type="status_changed", title=f"Resolution sent back: {number}",
                message=f"The resolution of {number} was reviewed as '{label}': {explanation}",
                actor=actor, level="warning",
            )
        run_side_effect(
            "Audit log of a manual verification", log_action, actor, "verify", entity=complaint,
            description=f"Manual verification of {complaint.complaint_number}: {label} ({score}/100)",
            changes={"verification_id": verification.pk, "status": status, "score": score,
                     "previous_status": previous.status if previous is not None else None},
            request=request,
        )
    if status == V.NEEDS_MANUAL_REVIEW:
        number = complaint.complaint_number
        notifications.notify_admins(
            notification_type="manual_review_requested", title=f"Manual verification requested: {number}",
            message=f"{actor.full_name} escalated the verification of {number}: {explanation}",
            complaint=complaint, level="warning",
        )
    return verification


def request_manual_review(complaint, *, actor, remarks="", request=None):
    """Flag the complaint for manual verification and notify admins. Returns ResolutionVerification | None.

    Typically the assigned officer disputing an AI verification result. Sets ``needs_manual_review`` and the
    latest verification's ``manual_review_requested`` flag (returned; None when nothing was verified yet),
    adds a "manual_review_requested" timeline event.
    """
    from apps.audit.services import log_action

    _ensure_resolution_actor(complaint, actor, "request a manual verification")
    if complaint.status != S.RESOLVED:
        raise ServiceError(f"A manual verification can be requested once the complaint is resolved (current status: "
                           f"{status_phrase(complaint.status)}).")
    remarks = (remarks or "").strip()
    with transaction.atomic():
        latest = complaint.latest_verification
        if latest is not None and not latest.manual_review_requested:
            latest.manual_review_requested = True
            latest.save(update_fields=["manual_review_requested"])
        _flag_for_review(complaint)
        add_event(complaint, StatusHistory.Event.MANUAL_REVIEW_REQUESTED, actor=actor,
                  remarks=remarks or "Manual verification requested.",
                  metadata={"verification_id": latest.pk if latest is not None else None})
        run_side_effect(
            "Audit log of a manual review request", log_action, actor, "verify", entity=complaint,
            description=f"Manual verification requested for {complaint.complaint_number}",
            changes={"verification_id": latest.pk if latest is not None else None, "remarks": remarks},
            request=request,
        )
    reason = f" Reason: {remarks}" if remarks else ""
    number = complaint.complaint_number
    notifications.notify_admins(
        notification_type="manual_review_requested", title=f"Manual verification requested: {number}",
        message=f"{actor.full_name} asked for a manual verification of {number}.{reason}",
        complaint=complaint, level="warning",
    )
    return latest
