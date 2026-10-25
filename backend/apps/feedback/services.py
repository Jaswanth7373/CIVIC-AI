"""Citizen feedback service (BUILD_SPEC section 3.5).

``submit_feedback`` runs in three stages:

1. **Eligibility** - the citizen owns the complaint, it is "resolved" or "verified", and no feedback was given
   in the current resolution cycle (i.e. since the complaint was last reopened).
2. **Sentiment analysis** of the text with ``ai.nlp.sentiment.analyze_sentiment(text, rating)`` (lexicon model in
   demo mode, a RoBERTa transformer in production). It runs *before* the database transaction so no row lock is
   held during model inference. If the AI module is unavailable the star rating decides the label and the
   feedback is stored with ``sentiment_model="rating-fallback"`` - clearly marked, never presented as AI output.
3. **One transaction** (complaint row locked and eligibility re-checked, which stops double submissions):
   store the Feedback, timeline event "feedback", status -> "closed" (a system transition), notifications
   (the officer always; admins for negative sentiment or a rating <= 2) and +5 civic points for the citizen.
"""
import logging
import re
from datetime import timedelta

from django.conf import settings
from django.db import transaction
from django.db.models import Exists, F, OuterRef
from django.utils import timezone

from apps.accounts.models import CitizenProfile
from apps.complaints.models import Complaint, StatusHistory
from apps.core.exceptions import ServiceError

from .models import Feedback

logger = logging.getLogger("apps.feedback")

#: Complaint statuses in which the citizen is asked for feedback.
ELIGIBLE_STATUSES = (Complaint.Status.RESOLVED, Complaint.Status.VERIFIED)
CIVIC_POINTS_FOR_FEEDBACK = 5
LOW_RATING_MAX = 2  # ratings <= 2 mean "dissatisfied": admins are alerted and a reopen is suggested
RATING_FALLBACK_MODEL = "rating-fallback"

_MODEL_NAME_MAX_LENGTH = Feedback._meta.get_field("sentiment_model").max_length
_NOTIFICATION_LEVELS = {
    Feedback.Sentiment.POSITIVE: "success",
    Feedback.Sentiment.NEUTRAL: "info",
    Feedback.Sentiment.NEGATIVE: "warning",
}


def submit_feedback(complaint, *, citizen, rating, text=""):
    """Validate eligibility, run sentiment analysis, store Feedback, close the complaint, notify the officer
    (and admins for negative feedback), award civic points. Returns Feedback.

    ``complaint`` is updated in place (status "closed"). Raises ServiceError when the citizen may not give
    feedback (not the owner, not resolved yet, already rated this resolution) or the rating is not 1-5.
    """
    from apps.complaints.services import status as status_service

    rating = _clean_rating(rating)
    text = (text or "").strip()
    reason = feedback_block_reason(complaint, citizen)
    if reason:
        raise ServiceError(reason)

    sentiment = _analyse_sentiment(text, rating)

    with transaction.atomic():
        complaint.status = (
            Complaint.objects.select_for_update().values_list("status", flat=True).get(pk=complaint.pk)
        )
        reason = feedback_block_reason(complaint, citizen)
        if reason:
            raise ServiceError(reason)

        feedback = Feedback.objects.create(complaint=complaint, citizen=citizen, rating=rating, text=text, **sentiment)
        status_service.add_event(
            complaint,
            StatusHistory.Event.FEEDBACK,
            actor=citizen,
            remarks=text or f"Rated the resolution {rating}/5.",
            metadata={
                "feedback_id": feedback.pk,
                "rating": rating,
                "sentiment": feedback.sentiment,
                "sentiment_score": feedback.sentiment_score,
                "sentiment_model": feedback.sentiment_model,
            },
        )
        status_service.change_status(
            complaint, Complaint.Status.CLOSED, actor=None, remarks="Closed after citizen feedback.", notify=False
        )
        _notify_feedback(feedback, complaint)
        _award_civic_points(citizen, CIVIC_POINTS_FOR_FEEDBACK)
    logger.info("Feedback %s stored for complaint %s (%s, %s/5)", feedback.pk, complaint.pk, feedback.sentiment, rating)
    return feedback


def pending_feedback_for(citizen):
    """QuerySet of the citizen's resolved/verified complaints that have no feedback for the current cycle.

    The cycle starts at the complaint's latest "reopened" timeline event (at the very beginning when it was never
    reopened). A feedback row belongs to the current cycle when no "reopened" event happened at or after it, which
    is the same rule as ``feedback_block_reason`` (``created_at > latest reopen``). The query is written with two
    nested NOT EXISTS sub-selects and no date literal: an earlier ``COALESCE(subquery, '1970-01-01')`` annotation
    came back from MySQL as a string and crashed Django's datetime converter. Newest resolutions first.
    """
    reopened_since_feedback = StatusHistory.objects.filter(
        complaint=OuterRef("complaint"),
        event=StatusHistory.Event.REOPENED,
        timestamp__gte=OuterRef("created_at"),
    )
    feedback_in_cycle = Feedback.objects.filter(complaint=OuterRef("pk")).filter(~Exists(reopened_since_feedback))
    return (
        Complaint.objects.filter(citizen=citizen, status__in=ELIGIBLE_STATUSES)
        .filter(~Exists(feedback_in_cycle))
        .select_related("category", "location", "department")
        .prefetch_related("images")
        .order_by(F("resolved_at").desc(nulls_last=True), "-id")
    )


def feedback_cycle_start(complaint):
    """Start of the complaint's current resolution cycle: its latest "reopened" event (None if never reopened)."""
    return (
        complaint.status_history.filter(event=StatusHistory.Event.REOPENED)
        .order_by("-timestamp")
        .values_list("timestamp", flat=True)
        .first()
    )


def feedback_block_reason(complaint, citizen):
    """Why ``citizen`` cannot give feedback on ``complaint`` now, or None when feedback is allowed."""
    if citizen is None or complaint.citizen_id != citizen.pk:
        return "You can only give feedback on your own complaints."
    if complaint.status not in ELIGIBLE_STATUSES:
        return (
            "Feedback can be given once the complaint is resolved "
            f"(current status: {complaint.get_status_display()})."
        )
    existing = complaint.feedback.all()
    cycle_start = feedback_cycle_start(complaint)
    if cycle_start is not None:
        existing = existing.filter(created_at__gt=cycle_start)
    if existing.exists():
        return "You have already given feedback for this resolution."
    return None


def reopen_window_open(complaint, *, now=None):
    """True while the citizen may still reopen: within ``REOPEN_WINDOW_DAYS`` of ``resolved_at``."""
    if not complaint.resolved_at:
        return False
    window = timedelta(days=settings.CIVICAI["REOPEN_WINDOW_DAYS"])
    return (now or timezone.now()) <= complaint.resolved_at + window


def should_suggest_reopen(feedback):
    """``suggest_reopen`` of the POST /feedback/ response: a low rating (<= 2) while reopening is still possible."""
    return feedback.rating <= LOW_RATING_MAX and reopen_window_open(feedback.complaint)


def rating_sentiment(rating):
    """Sentiment derived from the star rating alone: 1-2 negative, 3 neutral, 4-5 positive.

    score = (rating - 3) / 2 maps 1..5 onto -1..1; confidence 0.5 + 0.4*|score| (a rating is a strong but coarse
    signal, so it never reaches 1.0). Stored with ``sentiment_model="rating-fallback"``.
    """
    score = (rating - 3) / 2.0
    if rating <= LOW_RATING_MAX:
        label = Feedback.Sentiment.NEGATIVE
    elif rating == 3:
        label = Feedback.Sentiment.NEUTRAL
    else:
        label = Feedback.Sentiment.POSITIVE
    return {
        "sentiment": str(label),
        "sentiment_score": score,
        "sentiment_confidence": round(0.5 + 0.4 * abs(score), 2),
        "sentiment_model": RATING_FALLBACK_MODEL,
        "is_demo": True,
    }


def _analyse_sentiment(text, rating):
    """Feedback sentiment fields from the AI engine, or from the rating when the engine is unavailable."""
    try:
        from ai.nlp.sentiment import analyze_sentiment

        result = analyze_sentiment(text, rating)
        label = str(result.get("label", "")).lower()
        if label not in Feedback.Sentiment.values:
            raise ValueError(f"unexpected sentiment label {result.get('label')!r}")
        return {
            "sentiment": label,
            "sentiment_score": _clamp(float(result.get("score", 0.0)), -1.0, 1.0),
            "sentiment_confidence": _clamp(float(result.get("confidence", 0.0)), 0.0, 1.0),
            "sentiment_model": str(result.get("model_version") or result.get("method") or "unknown")[
                :_MODEL_NAME_MAX_LENGTH
            ],
            "is_demo": bool(result.get("is_demo", True)),
        }
    except NotImplementedError:
        logger.warning("ai.nlp.sentiment is not implemented yet; the star rating decides the sentiment label")
    except Exception:
        logger.exception("Sentiment analysis failed; the star rating decides the sentiment label")
    return rating_sentiment(rating)


def _clean_rating(rating):
    if isinstance(rating, str) and re.fullmatch(r"[0-9]+", rating.strip()):
        rating = int(rating)
    if isinstance(rating, bool) or not isinstance(rating, int) or not 1 <= rating <= 5:
        raise ServiceError("Rating must be a whole number from 1 to 5.")
    return rating


def _clamp(value, low, high):
    return max(low, min(high, value))


def _snippet(text, length=140):
    text = " ".join((text or "").split())
    return text if len(text) <= length else text[: length - 1].rstrip() + "…"


def _notify_feedback(feedback, complaint):
    """Officer: every feedback. Admins: negative sentiment or rating <= 2 (section 3.3 / 3.5)."""
    from apps.notifications.services import notify, notify_admins

    number = complaint.complaint_number or f"Complaint #{complaint.pk}"
    sentiment = feedback.get_sentiment_display().lower()
    snippet = _snippet(feedback.text)
    quote = f' "{snippet}"' if snippet else ""
    if complaint.assigned_officer_id:
        notify(
            complaint.assigned_officer,
            title=f"Citizen feedback on {number}",
            message=f"The citizen rated the resolution {feedback.rating}/5 ({sentiment}).{quote}",
            notification_type="feedback_received",
            complaint=complaint,
            level=_NOTIFICATION_LEVELS.get(feedback.sentiment, "info"),
        )
    if feedback.sentiment == Feedback.Sentiment.NEGATIVE or feedback.rating <= LOW_RATING_MAX:
        notify_admins(
            title=f"Negative feedback on {number}",
            message=f"Rated {feedback.rating}/5 ({sentiment}).{quote} Consider reviewing the resolution.",
            notification_type="feedback_received",
            complaint=complaint,
            level="warning",
        )


def _award_civic_points(citizen, points):
    """Atomic ``civic_points += points`` (F expression, safe under concurrent requests)."""
    profile, _ = CitizenProfile.objects.get_or_create(user=citizen)
    CitizenProfile.objects.filter(pk=profile.pk).update(civic_points=F("civic_points") + points)
