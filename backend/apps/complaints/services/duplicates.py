"""Duplicate complaint detection: persistence + human review (BUILD_SPEC sections 2.6 and 3.1).

Scoring (engine side, ``ai.duplicate.find_duplicates``): every candidate gets
    text similarity       embedding cosine of the two complaint texts
    image similarity      perceptual hashes (pHash / dHash Hamming distance) + colour-histogram correlation
    location similarity   smooth distance decay: 1.0 at 0 m, ~0 at the search radius
combined into a weighted overall score (weights re-normalised when a photo is missing, a category-mismatch
penalty unless the texts are near-identical). A pair is a duplicate when overall >= threshold and the distance
is within the radius.

This module (Django side):
    * selects candidates - earlier complaints within ``duplicate_radius_m`` and ``duplicate_window_days``,
      excluding rejected complaints and complaints already merged into another one;
    * stores every detected pair as a ``DuplicateComplaint`` (status pending_review). The (newer, original)
      pair is unique: re-running detection refreshes a pending row and never touches a reviewed one;
    * keeps ``Complaint.duplicate_count`` equal to the number of linked pending/confirmed pairs. Counts are
      recomputed from the rows instead of blindly incremented, so repeated re-analysis can never drift;
    * recalculates the original's priority (more reports = higher priority), writes timeline events on both
      complaints and tells the citizen.
Reviews never delete anything: a confirmed duplicate is closed with the remark "Merged into <number>" and keeps
a pointer to its original (``duplicate_of``).
"""
from dataclasses import dataclass, field

from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone
from rest_framework.exceptions import PermissionDenied

from apps.core.exceptions import ServiceError
from apps.core.permissions import user_role

from ..models import Complaint, DuplicateComplaint, StatusHistory
from . import notify as notifications
from .context import complaint_engine_dict, engine_config, nearby_complaints
from .helpers import image_hashes, run_side_effect, save_fields, to_float, to_unit
from .priority import recalculate_priority
from .status import add_event, change_status, status_phrase

D = DuplicateComplaint.Status
LINKED_STATUSES = (D.PENDING_REVIEW, D.CONFIRMED_DUPLICATE)


@dataclass
class DuplicateScan:
    """Outcome of one duplicate scan of a complaint."""

    links: list = field(default_factory=list)  # pending DuplicateComplaint rows found (created or refreshed)
    created: list = field(default_factory=list)  # ... of which are new pairs
    candidates: int = 0  # earlier nearby complaints compared

    def describe(self, radius_m=None, window_days=None):
        """One-line summary for the pipeline step detail."""
        if not self.candidates:
            scope = f" within {radius_m} m in the last {window_days} days" if radius_m is not None else ""
            return f"No earlier complaints{scope} to compare with."
        if not self.links:
            return f"Compared with {self.candidates} nearby complaint(s); no duplicates found."
        best = max(self.links, key=lambda link: link.overall_similarity)
        return (f"{len(self.links)} potential duplicate(s) among {self.candidates} nearby complaint(s); best match "
                f"{best.similar_complaint.complaint_number} ({best.overall_similarity:.0%} similar, "
                f"{best.distance_m:.0f} m away). Pending review.")


def _engine_scores(match, fallback_distance):
    """DuplicateComplaint column values from one ``find_duplicates`` result."""
    image_similarity = match.get("image_similarity")
    return {
        "text_similarity": round(to_unit(match.get("text_similarity")), 4),
        "image_similarity": round(to_unit(image_similarity), 4) if image_similarity is not None else None,
        "location_similarity": round(to_unit(match.get("location_similarity")), 4),
        "overall_similarity": round(to_unit(match.get("overall_similarity")), 4),
        "distance_m": round(to_float(match.get("distance_m"), fallback_distance), 1),
        "category_match": bool(match.get("category_match")),
        "explanation": str(match.get("explanation") or "")[:255],
    }


def _refresh_duplicate_count(complaint):
    """duplicate_count = linked pending/confirmed pairs on either side (recounted - idempotent)."""
    count = DuplicateComplaint.objects.filter(
        Q(complaint=complaint) | Q(similar_complaint=complaint), status__in=LINKED_STATUSES
    ).count()
    Complaint.objects.filter(pk=complaint.pk).update(duplicate_count=count, updated_at=timezone.now())
    complaint.duplicate_count = count
    return count


def _upsert_link(complaint, original, scores):
    """Create the pending pair, or refresh it while still pending. Returns (link | None, created).

    A pair a reviewer already decided (confirmed / not duplicate) is left untouched and None is returned - the
    human decision wins. An IntegrityError from the unique constraint (a concurrent scan inserted the same pair
    first) is absorbed by re-reading the row.
    """
    link = DuplicateComplaint.objects.filter(complaint=complaint, similar_complaint=original).first()
    if link is None:
        try:
            with transaction.atomic():
                return DuplicateComplaint.objects.create(
                    complaint=complaint, similar_complaint=original, status=D.PENDING_REVIEW, **scores
                ), True
        except IntegrityError:
            link = DuplicateComplaint.objects.get(complaint=complaint, similar_complaint=original)
    if link.status != D.PENDING_REVIEW:
        return None, False
    for name, value in scores.items():
        setattr(link, name, value)
    link.save(update_fields=list(scores))
    return link, False


@dataclass
class DuplicateScoring:
    """Read-only outcome of scoring a complaint against its candidates (nothing written yet)."""

    candidates: list = field(default_factory=list)  # engine dicts of the earlier nearby complaints
    matches: list = field(default_factory=list)  # engine results flagged is_duplicate


def score_duplicates(complaint, *, category_slug=None):
    """Find and score the duplicate candidates of ``complaint`` WITHOUT writing anything.

    This is the CPU-heavy half (text embeddings, image hashes / histograms), so callers run it *before*
    opening a write transaction. ``category_slug`` replaces the stored category in the comparison (the
    submission pipeline scores before the new AI category is saved).
    """
    from ai.duplicate import find_duplicates

    config = engine_config()["duplicate"]
    location = complaint.location
    candidates = nearby_complaints(
        location.latitude, location.longitude, radius_m=config["radius_m"], days=config["window_days"],
        exclude_id=complaint.pk, exclude_statuses=[Complaint.Status.REJECTED],
        created_before=complaint.created_at, exclude_merged=True,
    )
    if not candidates:
        return DuplicateScoring()
    target = complaint_engine_dict(complaint)
    if category_slug is not None:
        target["category"] = category_slug
    candidate_ids = {candidate["id"] for candidate in candidates}
    results = find_duplicates(target, candidates, config=config) or []
    matches = [result for result in results
               if result.get("is_duplicate") and result.get("complaint_id") in candidate_ids]
    return DuplicateScoring(candidates=candidates, matches=matches)


def scan_duplicates(complaint, *, notify=True):
    """Detect duplicates of ``complaint`` and persist the links. Returns a :class:`DuplicateScan`."""
    return save_duplicate_links(complaint, score_duplicates(complaint), notify=notify)


def save_duplicate_links(complaint, scoring, *, notify=True):
    """Persist the pairs found by :func:`score_duplicates` (fast: database writes only). Returns a
    :class:`DuplicateScan`. New pairs update both duplicate counts, write timeline events, recalculate the
    original's priority and notify the citizen (unless ``notify=False``)."""
    scan = DuplicateScan(candidates=len(scoring.candidates))
    if not scoring.matches:
        return scan
    by_id = {candidate["id"]: candidate for candidate in scoring.candidates}
    originals = Complaint.objects.select_related("location", "category", "citizen", "assigned_officer").in_bulk(
        [match["complaint_id"] for match in scoring.matches]
    )
    with transaction.atomic():
        for match in scoring.matches:
            original = originals.get(match["complaint_id"])
            if original is None:
                continue
            scores = _engine_scores(match, by_id[original.pk]["distance_m"])
            link, created = _upsert_link(complaint, original, scores)
            if link is None:
                continue
            scan.links.append(link)
            if created:
                scan.created.append(link)
        if scan.created:
            _refresh_duplicate_count(complaint)
            for link in scan.created:
                _refresh_duplicate_count(link.similar_complaint)
                _record_flag_events(complaint, link)

    for link in scan.created:
        run_side_effect(
            f"Priority update of {link.similar_complaint.complaint_number}", recalculate_priority,
            link.similar_complaint, trigger="duplicate_update",
        )
    if scan.created and notify:
        _notify_duplicate_found(complaint, scan.created)
    return scan


def detect_duplicates(complaint):
    """Find potential duplicates of ``complaint`` among earlier complaints, create DuplicateComplaint rows
    (status pending_review), update duplicate_count on both sides, recalculate the originals' priority,
    add timeline events and return the list of created/updated DuplicateComplaint objects."""
    return scan_duplicates(complaint).links


def _record_flag_events(complaint, link):
    original = link.similar_complaint
    metadata = {
        "duplicate_id": link.pk,
        "complaint_id": complaint.pk,
        "complaint_number": complaint.complaint_number,
        "original_id": original.pk,
        "original_number": original.complaint_number,
        "overall_similarity": link.overall_similarity,
        "distance_m": link.distance_m,
    }
    add_event(complaint, StatusHistory.Event.DUPLICATE_FLAGGED, metadata=metadata,
              remarks=f"Possible duplicate of {original.complaint_number}: {link.overall_similarity:.0%} similar, "
                      f"{link.distance_m:.0f} m away. Pending review.")
    add_event(original, StatusHistory.Event.DUPLICATE_FLAGGED, metadata=metadata,
              remarks=f"New report {complaint.complaint_number} ({link.distance_m:.0f} m away) looks like a "
                      f"duplicate of this complaint ({link.overall_similarity:.0%} similar).")


def _notify_duplicate_found(complaint, links):
    best = max(links, key=lambda link: link.overall_similarity)
    others = len(links) - 1
    extra = f" and {others} other report(s)" if others else ""
    notifications.notify_citizen(
        complaint, notification_type="duplicate_detected", title="Similar complaint already reported",
        message=(f"Your complaint {complaint.complaint_number} looks similar to "
                 f"{best.similar_complaint.complaint_number}{extra} reported nearby "
                 f"({best.overall_similarity:.0%} match). An officer will check whether it is the same issue."),
    )


# ---------------------------------------------------------------------------------------------------------------
# Preview (no database writes)
# ---------------------------------------------------------------------------------------------------------------
def preview_duplicates(*, text, latitude, longitude, image_data=None, filename=None, category_slug=None):
    """Score a report that is NOT saved yet against stored complaints (no database writes).

    Used by the analysis preview (/api/ai/analyze/) and the submit form's "similar issues nearby" check.
    ``image_data`` are the raw bytes of the photo (the engine decodes them directly, so ``filename`` - the
    upload's original name - is optional and only accepted so callers can pass the upload metadata as is).
    Returns ``[{"complaint": <Complaint>, "text_similarity", "image_similarity", "location_similarity",
    "overall_similarity", "distance_m", "category_match", "is_duplicate", "explanation"}]`` best match first.
    """
    from ai.duplicate import find_duplicates

    if latitude is None or longitude is None:
        return []
    config = engine_config()["duplicate"]
    candidates = nearby_complaints(
        latitude, longitude, radius_m=config["radius_m"], days=config["window_days"],
        exclude_statuses=[Complaint.Status.REJECTED], exclude_merged=True,
    )
    if not candidates:
        return []
    hashes = image_hashes(image_data) if image_data else {}
    by_id = {candidate["id"]: candidate for candidate in candidates}
    target = {
        "id": None, "text": text or "", "latitude": float(latitude), "longitude": float(longitude),
        "category": category_slug, "phash": hashes.get("phash"), "dhash": hashes.get("dhash"),
        "image": image_data or None,  # raw photo (the engine accepts it instead of an image_path)
        "image_path": None, "created_at": timezone.now().isoformat(),
    }
    results = find_duplicates(target, candidates, config=config) or []
    results = [result for result in results if result.get("complaint_id") in by_id]
    complaints = (
        Complaint.objects.select_related("location", "category").prefetch_related("images")
        .in_bulk([result["complaint_id"] for result in results])
    )
    matches = []
    for result in results:
        complaint = complaints.get(result["complaint_id"])
        if complaint is None:
            continue
        scores = _engine_scores(result, by_id[complaint.pk]["distance_m"])
        matches.append({"complaint": complaint, **scores, "is_duplicate": bool(result.get("is_duplicate"))})
    matches.sort(key=lambda item: item["overall_similarity"], reverse=True)
    return matches


# ---------------------------------------------------------------------------------------------------------------
# Review
# ---------------------------------------------------------------------------------------------------------------
def review_duplicate(duplicate, *, status, actor, notes="", request=None):
    """Confirm or reject a potential duplicate (officer/admin). Never deletes complaints.

    confirmed_duplicate -> complaint.duplicate_of = original, complaint closed with remark, citizen notified,
    original priority recalculated. not_duplicate -> counts decremented. Returns the DuplicateComplaint.

    Only pairs still pending review can be decided; the decision, reviewer, time and notes are stored on the
    pair and audit-logged ("duplicate_review"). Both complaints get timeline entries.

    A report cannot be merged into an original that is already resolved, verified or closed: nobody would then
    own the problem (the newer report would be closed, the original stays closed) and the citizen would be told
    it is "already being handled". Such a report is a recurrence - keep it open, or reopen the original first.
    """
    from apps.audit.services import log_action

    if user_role(actor) not in ("officer", "admin"):
        raise PermissionDenied("Only officers and administrators can review duplicate complaints.")
    if status not in (D.CONFIRMED_DUPLICATE, D.NOT_DUPLICATE):
        raise ServiceError("Choose 'confirmed_duplicate' or 'not_duplicate' as the review decision.")
    notes = (notes or "").strip()[:255]

    with transaction.atomic():
        link = (
            DuplicateComplaint.objects.select_for_update()
            .select_related("complaint__citizen", "complaint__location", "similar_complaint__location")
            .get(pk=duplicate.pk)
        )
        if link.status != D.PENDING_REVIEW:
            raise ServiceError(f"This pair was already reviewed as '{link.get_status_display()}'.")
        newer, original = link.complaint, link.similar_complaint
        if status == D.CONFIRMED_DUPLICATE and original.status in Complaint.RESOLVED_STATUSES:
            raise ServiceError(
                f"{original.complaint_number} is already {status_phrase(original.status)}, so "
                f"{newer.complaint_number} cannot be merged into it - the problem seems to have come back. Keep "
                f"{newer.complaint_number} open (mark the pair 'not a duplicate'), or reopen "
                f"{original.complaint_number} first and then confirm the duplicate."
            )
        link.status = status
        link.reviewed_by = actor
        link.reviewed_at = timezone.now()
        link.review_notes = notes
        link.save(update_fields=["status", "reviewed_by", "reviewed_at", "review_notes"])
        metadata = {"duplicate_id": link.pk, "original_id": original.pk, "original_number": original.complaint_number,
                    "complaint_id": newer.pk, "complaint_number": newer.complaint_number, "decision": status}
        suffix = f" Notes: {notes}" if notes else ""
        if status == D.CONFIRMED_DUPLICATE:
            _merge_into_original(newer, original, actor=actor, metadata=metadata, suffix=suffix, request=request)
        else:
            add_event(newer, StatusHistory.Event.REMARK, actor=actor, metadata=metadata,
                      remarks=f"Reviewed: not a duplicate of {original.complaint_number}.{suffix}")
        _refresh_duplicate_count(newer)
        _refresh_duplicate_count(original)
        run_side_effect(
            "Audit log of a duplicate review", log_action, actor, "duplicate_review", entity=link,
            description=f"{newer.complaint_number} vs {original.complaint_number}: {link.get_status_display()}",
            changes={"status": [D.PENDING_REVIEW, status], "notes": notes}, request=request,
        )

    affected = [original] if status == D.CONFIRMED_DUPLICATE else [newer, original]
    for complaint in affected:
        run_side_effect(f"Priority update of {complaint.complaint_number}", recalculate_priority, complaint,
                        trigger="duplicate_update")
    if status == D.CONFIRMED_DUPLICATE:
        notifications.notify_citizen(
            newer, notification_type="duplicate_detected", title=f"Complaint merged into {original.complaint_number}",
            message=(f"Your complaint {newer.complaint_number} was confirmed as the same issue as "
                     f"{original.complaint_number}, which is already being handled. It has been merged and closed - "
                     "the issue will be resolved as part of that complaint."),
            actor=actor,
        )
    if duplicate is not link:
        duplicate.refresh_from_db()
    return link


def _merge_into_original(newer, original, *, actor, metadata, suffix, request):
    """Confirmed duplicate: point to the original, cancel the newer complaint's work order, close it."""
    from apps.assignments.models import ComplaintAssignment

    if newer.duplicate_of_id and newer.duplicate_of_id != original.pk:
        raise ServiceError(f"{newer.complaint_number} is already merged into another complaint.")
    newer.duplicate_of = original
    save_fields(newer, "duplicate_of")
    add_event(newer, StatusHistory.Event.DUPLICATE_CONFIRMED, actor=actor, metadata=metadata,
              remarks=f"Confirmed as a duplicate of {original.complaint_number}.{suffix}")
    add_event(original, StatusHistory.Event.DUPLICATE_CONFIRMED, actor=actor, metadata=metadata,
              remarks=f"{newer.complaint_number} was confirmed as a duplicate of this complaint and merged into it.")
    if newer.status in (Complaint.Status.CLOSED, Complaint.Status.REJECTED):
        return
    if ComplaintAssignment.objects.filter(complaint=newer, is_active=True).exists():
        from apps.assignments.services import complete_active_assignment

        complete_active_assignment(newer, status="cancelled")
    change_status(newer, Complaint.Status.CLOSED, actor=actor, remarks=f"Merged into {original.complaint_number}",
                  metadata=metadata, notify=False, force=True, request=request)
