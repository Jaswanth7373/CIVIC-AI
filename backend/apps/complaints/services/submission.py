"""Complaint submission - the core integration flow of CivicAI (BUILD_SPEC section 3.1).

    validate -> upload (image facts: perceptual hashes, size, dimensions)
    -> save (Location + Complaint "submitted" + ComplaintImage + "submitted" timeline event, one transaction)
    -> pipeline.process_new_complaint: AI analysis -> prediction -> priority -> duplicates -> routing -> SLA
       -> auto-assignment -> database commit -> notifications -> hotspot check
    -> +10 civic points -> audit log

Every step is timed and returned in ``analysis["steps"]`` so the frontend can replay the real pipeline. Input
errors are rejected *before* anything is written (HTTP 400); once the complaint is saved, AI or side-effect
problems never fail the submission (they are reported as failed steps and the complaint is flagged for review).
"""
import logging
from datetime import timedelta

from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import transaction
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from apps.core.validators import validate_image_upload

from ..models import Complaint, ComplaintImage, Location, StatusHistory
from .helpers import (
    SUBMISSION_POINTS,
    StepRecorder,
    award_civic_points,
    image_hashes,
    image_size,
    quantize_coordinate,
    read_upload,
    run_side_effect,
    to_float,
)
from .pipeline import STEP_LABELS, process_new_complaint
from .status import add_event

logger = logging.getLogger("apps.complaints")

DESCRIPTION_MIN_LENGTH = 10
DESCRIPTION_MAX_LENGTH = 2000
#: Tolerated clock difference between the citizen's device and the server for ``incident_at``.
CLOCK_SKEW_SECONDS = 300
LOCATION_FIELDS = {"address": 255, "landmark": 150, "area": 120, "city": 100, "pincode": 10}


def submit_complaint(*, citizen, data, image=None, request=None):
    """Create a complaint and run the whole AI pipeline synchronously.

    data: validated serializer data - {"description", "title"?, "latitude", "longitude", "address"?, "landmark"?,
          "area"?, "city"?, "pincode"?, "category"? (CivicCategory | None), "incident_at"?}
    image: uploaded file (validated) or None.

    Steps (in order, each timed and reported): validate, upload, save, preprocess, image_analysis,
    text_analysis, multimodal_fusion, severity, priority, duplicate_detection, department_routing,
    officer_assignment, database_save, notification.

    Returns: (complaint, analysis) where analysis = {"steps": [...], "summary": {...}} (see API contract).
    """
    from apps.audit.services import log_action

    recorder = StepRecorder()
    with recorder.step("validate", STEP_LABELS["validate"]) as step:
        cleaned = _validate(citizen, data, image)
        step.detail = (f"Description ({len(cleaned['description'])} characters), location "
                       f"({cleaned['latitude']}, {cleaned['longitude']})"
                       + (" and photo checked." if image is not None else " checked; no photo attached."))

    image_facts = None
    with recorder.step("upload", STEP_LABELS["upload"]) as step:
        if image is None:
            step.skip("No photo attached - the description and location drive the analysis.")
        else:
            image_facts = _image_facts(image)
            hashed = ("perceptual hashes computed" if image_facts["phash"]
                      else "perceptual hashing unavailable - duplicates will use text and location")
            step.detail = (f"Photo received ({image_facts['width']}x{image_facts['height']} px, "
                           f"{image_facts['file_size'] / 1024:.0f} KB); {hashed}.")

    with recorder.step("save", STEP_LABELS["save"]) as step:
        complaint = _create_complaint(citizen, cleaned, image, image_facts)
        step.detail = f"Registered as {complaint.complaint_number}."

    analysis = process_new_complaint(complaint, actor=citizen, prior_steps=recorder.steps, request=request)

    run_side_effect("Civic points for a new complaint", award_civic_points, citizen, SUBMISSION_POINTS)
    summary = analysis["summary"]
    run_side_effect(
        "Audit log of a new complaint", log_action, citizen, "create", entity=complaint,
        description=f"Complaint {complaint.complaint_number} submitted",
        changes={
            "category": (summary.get("category") or {}).get("slug"),
            "priority_score": summary.get("priority_score"),
            "priority_level": summary.get("priority_level"),
            "department": (summary.get("department") or {}).get("code"),
            "has_image": image is not None,
        },
        request=request,
    )
    return complaint, analysis


# ---------------------------------------------------------------------------------------------------------------
# Steps
# ---------------------------------------------------------------------------------------------------------------
def _validate(citizen, data, image):
    """Business validation (defence in depth behind the serializer). Raises DRF ValidationError (HTTP 400)."""
    if citizen is None or not getattr(citizen, "is_authenticated", False) or not citizen.is_active:
        raise ValidationError({"citizen": ["A signed-in, active citizen account is required to report an issue."]})
    errors = {}
    description = str(data.get("description") or "").strip()
    if len(description) < DESCRIPTION_MIN_LENGTH:
        errors["description"] = [f"Describe the issue in at least {DESCRIPTION_MIN_LENGTH} characters."]
    elif len(description) > DESCRIPTION_MAX_LENGTH:
        errors["description"] = [f"Keep the description under {DESCRIPTION_MAX_LENGTH} characters."]

    latitude, longitude = data.get("latitude"), data.get("longitude")
    if latitude is None or not -90 <= to_float(latitude, 999) <= 90:
        errors["latitude"] = ["A latitude between -90 and 90 is required."]
    if longitude is None or not -180 <= to_float(longitude, 999) <= 180:
        errors["longitude"] = ["A longitude between -180 and 180 is required."]

    incident_at = data.get("incident_at") or timezone.now()
    if incident_at > timezone.now() + timedelta(seconds=CLOCK_SKEW_SECONDS):
        errors["incident_at"] = ["The incident time cannot be in the future."]

    if image is not None:
        try:
            validate_image_upload(image)
        except DjangoValidationError as exc:
            errors["image"] = list(exc.messages)
    if errors:
        raise ValidationError(errors)

    cleaned = {
        "description": description,
        "title": str(data.get("title") or "").strip()[:160],
        "latitude": quantize_coordinate(latitude),
        "longitude": quantize_coordinate(longitude),
        "category": data.get("category"),
        "incident_at": incident_at,
    }
    for name, max_length in LOCATION_FIELDS.items():
        cleaned[name] = str(data.get(name) or "").strip()[:max_length]
    return cleaned


def _image_facts(image):
    """Size, dimensions and perceptual hashes of the uploaded photo (stored on ComplaintImage)."""
    data = read_upload(image)
    hashes = image_hashes(data)
    width, height = int(hashes.get("width") or 0), int(hashes.get("height") or 0)
    if not width or not height:
        width, height = image_size(data)
    return {
        "file_size": int(getattr(image, "size", 0) or len(data)),
        "width": width,
        "height": height,
        "phash": str(hashes.get("phash") or "")[:32],
        "dhash": str(hashes.get("dhash") or "")[:32],
    }


def _create_complaint(citizen, cleaned, image, image_facts):
    """Location + Complaint + ComplaintImage + "submitted" event in one transaction (file removed on failure)."""
    stored_names = []
    try:
        with transaction.atomic():
            location = Location.objects.create(
                latitude=cleaned["latitude"], longitude=cleaned["longitude"],
                **{name: cleaned[name] for name in LOCATION_FIELDS},
            )
            complaint = Complaint.objects.create(
                citizen=citizen,
                title=cleaned["title"],
                description=cleaned["description"],
                reported_category=cleaned["category"],
                status=Complaint.Status.SUBMITTED,
                location=location,
                incident_at=cleaned["incident_at"],
            )
            if image is not None:
                photo = ComplaintImage(complaint=complaint, kind=ComplaintImage.Kind.ORIGINAL, **image_facts)
                photo.image.save(image.name, image, save=False)
                stored_names.append(photo.image.name)
                photo.save()
            reported = cleaned["category"]
            add_event(
                complaint, StatusHistory.Event.SUBMITTED, actor=citizen, new_status=Complaint.Status.SUBMITTED,
                remarks="Complaint submitted by the citizen.",
                metadata={"has_image": image is not None,
                          "reported_category": reported.slug if reported is not None else None},
            )
    except Exception:
        for name in stored_names:
            _delete_stored_file(name)
        raise
    return complaint


def _delete_stored_file(name):
    from django.core.files.storage import default_storage

    try:
        default_storage.delete(name)
    except OSError:
        logger.warning("Could not remove orphaned upload %s", name)
