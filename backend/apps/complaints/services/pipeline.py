"""AI pipeline orchestration for stored complaints (BUILD_SPEC section 3.1).

``process_new_complaint`` is the post-save half of the submission flow (``submission.submit_complaint`` saves the
complaint, then calls it); ``reanalyze_complaint`` re-runs the same flow for an existing complaint and
``analyze_preview`` runs it without touching the database.

Execution order - every step is timed with ``time.perf_counter()`` and reported to the UI::

    preprocess -> image_analysis -> text_analysis -> multimodal_fusion -> severity     ai.pipeline.run_analysis
    -> priority -> duplicate_detection -> department_routing -> officer_assignment      one database transaction
    -> database_save (commit) -> notification

The engine also reports a "location_risk" step; it is shown inside "severity" because location risk is one of
the severity factors and the public step list (API contract) has no separate entry for it.

Transactions and failure handling
    * The AI engine runs *outside* any transaction (pure CPU work - no locks held while it thinks).
    * All results are then written in ONE transaction. Each optional step (priority, duplicates, routing,
      auto-assignment) runs in its own savepoint: if one fails, only its writes are undone, the step is
      reported as "failed" and the remaining steps still run.
    * If the AI engine itself fails (or the transaction cannot be committed) the complaint stays "submitted",
      ``needs_manual_review`` is set, administrators are notified and the failed / skipped steps are reported -
      the citizen's submission still succeeds (HTTP 201).
"""
import os
import time

from django.db import transaction

from ai.config import DEMO_DISCLAIMER, get_model_mode, score_to_level

from ..models import AIPrediction, Complaint, Level, Location, StatusHistory
from . import notify as notifications
from .context import (
    active_category,
    analysis_text,
    engine_categories,
    engine_config,
    engine_risk_zones,
    nearby_complaints,
)
from .duplicates import DuplicateScan, preview_duplicates, save_duplicate_links, score_duplicates
from .helpers import (
    DONE,
    FAILED,
    SKIPPED,
    StepRecorder,
    address_text,
    build_title,
    category_mini,
    compact_copy,
    department_mini,
    elapsed_ms,
    error_text,
    is_automatic_title,
    json_safe,
    log_failure,
    quantize_coordinate,
    read_upload,
    run_side_effect,
    save_fields,
    stored_image_input,
    to_float,
    to_score,
    to_unit,
    user_mini,
)
from .priority import build_priority_inputs, public_impact_of, recalculate_priority
from .routing import route_department, routing_reason
from .status import add_event, change_status, status_phrase
from .verification import verification_review_pending

S = Complaint.Status

AI_STEP_KEYS = ["preprocess", "image_analysis", "text_analysis", "multimodal_fusion", "severity"]
POST_AI_STEP_KEYS = ["priority", "duplicate_detection", "department_routing", "officer_assignment"]
STEP_LABELS = {
    "validate": "Input validation",
    "upload": "Image upload",
    "save": "Complaint registration",
    "preprocess": "Data preprocessing",
    "image_analysis": "Image AI analysis",
    "text_analysis": "Text NLP analysis",
    "multimodal_fusion": "Multimodal classification",
    "location_risk": "Location risk assessment",
    "severity": "Severity assessment",
    "priority": "Priority scoring",
    "duplicate_detection": "Duplicate detection",
    "department_routing": "Department routing",
    "officer_assignment": "Officer assignment",
    "officer_recommendation": "Officer recommendation",
    "database_save": "Database save",
    "notification": "Notifications",
}
#: Engine output that proves an AI step ran when the engine did not report the step itself.
_STEP_OUTPUTS = {"preprocess": "text", "image_analysis": "vision", "text_analysis": "text",
                 "multimodal_fusion": "fusion", "severity": "severity"}
_VALID_STEP_STATUSES = (DONE, SKIPPED, FAILED)


# ---------------------------------------------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------------------------------------------
def process_new_complaint(complaint, *, actor=None, prior_steps=None, request=None):
    """Run AI analysis + priority + duplicates + routing + assignment + notifications for a saved complaint.

    Returns analysis dict {"steps": [...], "summary": {...}}. Never raises for AI failures: on error the
    complaint stays "submitted", needs_manual_review=True, admins are notified and a failed step is reported.

    ``prior_steps`` are the already-timed submission steps (validate, upload, save) placed in front of the
    pipeline steps; ``request`` only serves absolute avatar URLs in the summary.
    """
    return _analyze_and_persist(complaint, actor=actor, prior_steps=prior_steps, request=request, reanalysis=False)


def reanalyze_complaint(complaint, *, actor=None, request=None):
    """Re-run AI analysis for an existing complaint (admin action / after citizen edits).

    Updates prediction, category, severity, priority and duplicates. Does not reassign an officer
    that is already assigned. Returns analysis dict.

    Details: a new AIPrediction row is stored (history is kept); category and severity are only replaced when
    no administrator has overridden them (``is_ai_overridden``); the priority is recalculated with trigger
    "reanalysis" (a manual priority override is kept); duplicate pairs are refreshed in place (the unique pair
    constraint is respected and reviewed pairs are never reopened); the department is re-routed and an officer
    auto-assigned only while nobody is assigned yet. A complaint whose first analysis failed ("submitted")
    continues through the normal flow.
    """
    return _analyze_and_persist(complaint, actor=actor, prior_steps=None, request=request, reanalysis=True)


def analyze_preview(*, image_file=None, text="", latitude=None, longitude=None, address="", reported_category=None,
                    full=True):
    """Run the analysis WITHOUT writing to the database (used by /api/ai/analyze/ and /api/ai/classify/).

    ``image_file``: uploaded file or None; ``reported_category``: CivicCategory, slug or None. With
    ``full=False`` (classification only) the priority / duplicate / routing / officer parts are skipped.

    Returns a dict with plain JSON data except the ORM objects marked (*), which the view serializes::

        {"vision", "text", "fusion", "location_risk", "severity"   engine outputs (JSON-safe dicts; vision may be None)
         "category"*:        CivicCategory | None   (fused category, "other" fallback)
         "nearby_count", "frequency_count", "is_demo", "mode", "model_versions", "processing_time_ms",
         "steps":            [{key, label, status, duration_ms, detail}]
         # only with full=True:
         "priority":         PriorityEngine output | None
         "duplicates":       [{"complaint"*: Complaint, "text_similarity", "image_similarity", "location_similarity",
                               "overall_similarity", "distance_m", "category_match", "is_duplicate", "explanation"}]
         "department"*:      Department | None
         "recommended_officer"*: User | None   (the officer auto-assignment would pick)
         "recommendation":   {"score", "reasons", "workload", "capacity", "utilization", "overloaded",
                              "distance_km", "is_available", "same_department"} | None}

    Raises ServiceError when the AI engine fails.
    """
    from ai.pipeline import run_analysis
    from apps.core.exceptions import ServiceError

    config = engine_config()
    image_data = read_upload(image_file) if image_file is not None else None
    filename = os.path.basename(getattr(image_file, "name", "") or "") or None
    has_location = latitude is not None and longitude is not None
    lat = float(latitude) if has_location else None
    lng = float(longitude) if has_location else None
    nearby = nearby_complaints(
        lat, lng, radius_m=config["nearby_radius_m"], days=config["frequency_window_days"],
        exclude_statuses=[S.REJECTED], exclude_merged=True,
    ) if has_location else []
    try:
        analysis = run_analysis(
            text=text or "", latitude=lat, longitude=lng, image=image_data, filename=filename,
            address=address or "", reported_category=_slug_of(reported_category), categories=engine_categories(),
            risk_zones=engine_risk_zones(), nearby=nearby, config=config,
        ) or {}
    except Exception as exc:  # noqa: BLE001 - reported to the caller as a clear error
        log_failure("AI analysis preview", exc)
        raise ServiceError(f"The AI analysis could not be completed: {error_text(exc)}") from exc

    fusion = json_safe(analysis.get("fusion") or {})
    text_result = json_safe(analysis.get("text") or {})
    severity = json_safe(analysis.get("severity") or {})
    location_risk = json_safe(analysis.get("location_risk") or {})
    category = active_category(fusion.get("category") or text_result.get("category"))
    recorder = StepRecorder(json_safe(list(analysis.get("steps") or [])))
    result = {
        "vision": json_safe(analysis.get("vision")),
        "text": text_result,
        "fusion": fusion,
        "location_risk": location_risk,
        "severity": severity,
        "category": category,
        "nearby_count": int(to_float(analysis.get("nearby_count"), len(nearby))),
        "frequency_count": int(to_float(analysis.get("frequency_count"))),
        "is_demo": bool(analysis.get("is_demo", get_model_mode() == "demo")),
        "mode": analysis.get("mode") or get_model_mode(),
        "model_versions": json_safe(analysis.get("model_versions") or {}),
        "processing_time_ms": int(to_float(analysis.get("processing_time_ms"))),
        "steps": recorder.steps,
    }
    if not full:
        return result

    duplicates = []
    with recorder.step("duplicate_detection", STEP_LABELS["duplicate_detection"], capture=True) as step:
        if not has_location:
            step.skip("No location given - duplicates are searched around the reported location.")
        else:
            duplicates = preview_duplicates(text=text, latitude=lat, longitude=lng, image_data=image_data,
                                            filename=filename, category_slug=category.slug if category else None)
            likely = sum(1 for item in duplicates if item["is_duplicate"])
            step.detail = (f"{likely} likely duplicate(s) among {len(duplicates)} similar nearby complaint(s)."
                           if duplicates else "No similar complaints nearby.")

    priority = None
    with recorder.step("priority", STEP_LABELS["priority"], capture=True) as step:
        from ai.priority import calculate_priority

        inputs = build_priority_inputs(
            severity_score=severity.get("score"), public_impact=public_impact_of(analysis), category=category,
            location_risk=location_risk.get("score"), nearby_count=result["nearby_count"],
            frequency_count=result["frequency_count"],
            duplicate_count=sum(1 for item in duplicates if item["is_duplicate"]),
        )
        priority = json_safe(calculate_priority(inputs, config=config["priority"]))
        step.detail = f"Priority {to_score(priority.get('final_score'))}/100 ({priority.get('priority_level')})."

    with recorder.step("department_routing", STEP_LABELS["department_routing"]) as step:
        department = route_department(category)
        step.detail = routing_reason(category, department)
        if department is None:
            step.status = FAILED

    officer, recommendation = None, None
    with recorder.step("officer_recommendation", STEP_LABELS["officer_recommendation"], capture=True) as step:
        if department is None:
            step.skip("No department to recommend an officer from.")
        else:
            from apps.assignments.services import recommend_officers

            draft = _draft_complaint(category, department, priority, severity, lat, lng, address)
            ranked = recommend_officers(draft, limit=1)
            best = ranked[0] if ranked else None
            if best is not None and best.get("recommended"):
                officer = best["officer"]
                recommendation = {key: json_safe(best.get(key)) for key in (
                    "score", "reasons", "workload", "capacity", "utilization", "overloaded", "distance_km",
                    "is_available", "same_department")}
                step.detail = f"{officer.full_name} (score {to_float(best.get('score')):.2f})."
            else:
                step.skip("No available officer with spare capacity.")

    result.update(priority=priority, duplicates=duplicates, department=department, recommended_officer=officer,
                  recommendation=recommendation, steps=recorder.steps)
    return result


# ---------------------------------------------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------------------------------------------
def _analyze_and_persist(complaint, *, actor, prior_steps, request, reanalysis):
    recorder = StepRecorder(prior_steps)
    config = engine_config()
    started = time.perf_counter()
    try:
        analysis = _run_engine(complaint, config)
    except Exception as exc:  # noqa: BLE001 - the submission must survive an AI failure
        log_failure(f"AI analysis of {complaint.complaint_number}", exc)
        return _handle_failure(complaint, recorder, exc, stage="analysis", reanalysis=reanalysis, request=request,
                               duration_ms=elapsed_ms(started))
    _merge_engine_steps(recorder, analysis)
    category = active_category(_fused_slug(analysis))
    early_scoring = _score_duplicates_early(complaint, category)

    was_submitted = complaint.status == S.SUBMITTED
    first_post_ai_step = len(recorder.steps)
    try:
        with transaction.atomic():
            persist_started = time.perf_counter()
            prediction = _persist_prediction(complaint, analysis, config, category=category, reanalysis=reanalysis)
            database_ms = elapsed_ms(persist_started)
            _priority_step(recorder, complaint, reanalysis=reanalysis)
            scan = _duplicates_step(recorder, complaint, config, early_scoring)
            department_changed = _routing_step(recorder, complaint)
            assigned_officer = _assignment_step(recorder, complaint)
            commit_started = time.perf_counter()
        database_ms += elapsed_ms(commit_started)
    except Exception as exc:  # noqa: BLE001 - everything above was rolled back; report it honestly
        log_failure(f"Saving the AI results of {complaint.complaint_number}", exc)
        del recorder.steps[first_post_ai_step:]
        complaint.refresh_from_db()
        return _handle_failure(complaint, recorder, exc, stage="database", reanalysis=reanalysis, request=request)

    recorder.add("database_save", STEP_LABELS["database_save"], DONE, database_ms,
                 f"AI prediction #{prediction.pk}, priority, duplicate links, routing and assignment committed in one "
                 "transaction.")
    _notification_step(recorder, complaint, analysis, reanalysis=reanalysis, was_submitted=was_submitted,
                       department_changed=department_changed, assigned_officer=assigned_officer)
    if reanalysis:
        from apps.audit.services import log_action

        run_side_effect(
            "Audit log of an AI re-analysis", log_action, actor, "update", entity=complaint,
            description=f"AI re-analysis of {complaint.complaint_number}",
            changes={"prediction_id": prediction.pk, "category": complaint.category.slug if complaint.category_id
                     else None, "priority_score": complaint.priority_score}, request=request,
        )
    return {"steps": recorder.steps,
            "summary": _summary(complaint, analysis, duplicates_found=len(scan.links) if scan else 0,
                                request=request)}


def _run_engine(complaint, config):
    """Gather the database context and call ``ai.pipeline.run_analysis`` for a stored complaint."""
    from ai.pipeline import run_analysis

    location = complaint.location
    primary = complaint.primary_image
    image_input = stored_image_input(primary.image) if primary is not None else None
    filename = os.path.basename(primary.image.name) if image_input is not None else None
    nearby = nearby_complaints(
        location.latitude, location.longitude, radius_m=config["nearby_radius_m"],
        days=config["frequency_window_days"], exclude_id=complaint.pk, exclude_statuses=[S.REJECTED],
        exclude_merged=True,
    )
    reported = complaint.reported_category.slug if complaint.reported_category_id else None
    return run_analysis(
        text=analysis_text(complaint), latitude=float(location.latitude), longitude=float(location.longitude),
        image=image_input, filename=filename, address=address_text(location), reported_category=reported,
        categories=engine_categories(), risk_zones=engine_risk_zones(), nearby=nearby, config=config,
    ) or {}


def _merge_engine_steps(recorder, analysis, *, missing_detail=""):
    """Copy the engine's timed steps in the documented order (location risk folded into severity). A step the
    engine did not report is "done" when its output exists, else "skipped" with ``missing_detail``."""
    reported = {step.get("key"): step for step in analysis.get("steps") or [] if isinstance(step, dict)}
    for key in AI_STEP_KEYS:
        step = reported.get(key)
        if step is not None:
            status = step.get("status") if step.get("status") in _VALID_STEP_STATUSES else DONE
            duration, detail = to_float(step.get("duration_ms")), str(step.get("detail") or "")
        else:
            status = DONE if analysis.get(_STEP_OUTPUTS[key]) else SKIPPED
            duration, detail = 0.0, "" if status == DONE else missing_detail
        if key == "severity" and "location_risk" in reported:
            risk = reported["location_risk"]
            duration += to_float(risk.get("duration_ms"))
            risk_detail = str(risk.get("detail") or "").strip()
            if risk.get("status") == FAILED:
                risk_detail = f"location risk unavailable ({risk_detail or 'failed'})"
            if risk_detail:
                detail = f"{detail} Location risk: {risk_detail}".strip()
        recorder.add(key, (step or {}).get("label") or STEP_LABELS[key], status, duration, detail)
    for key, step in reported.items():
        if key not in AI_STEP_KEYS and key != "location_risk":
            status = step.get("status") if step.get("status") in _VALID_STEP_STATUSES else DONE
            recorder.add(str(key), str(step.get("label") or key), status, to_float(step.get("duration_ms")),
                         str(step.get("detail") or ""))


def _with_demo_note(text, is_demo):
    text = (text or "").strip()
    if is_demo and "demo" not in text.lower():
        text = f"{text} {DEMO_DISCLAIMER}".strip()
    return text


def model_version_label(analysis):
    """'vision=<version>; text=<version>' (<= 160 chars) from the engine output."""
    versions = analysis.get("model_versions") or {}
    vision = versions.get("vision") or (analysis.get("vision") or {}).get("model_version") or "none"
    text = versions.get("text") or (analysis.get("text") or {}).get("model_version") or "none"
    return f"vision={vision}; text={text}"[:160]


def _fused_slug(analysis):
    """Category slug decided by the engine (fusion first, then the single modality that produced one)."""
    for part in ("fusion", "text", "vision"):
        slug = (analysis.get(part) or {}).get("category")
        if slug:
            return str(slug)
    return ""


def _score_duplicates_early(complaint, category):
    """(scoring, error, duration_ms): the read-only, CPU-heavy duplicate scoring, run BEFORE the write
    transaction so no database lock is held while text embeddings / image features are computed. The category
    compared is the one the complaint will have: the new AI category, or the administrator's override."""
    started = time.perf_counter()
    if complaint.is_ai_overridden and complaint.category_id:
        slug = complaint.category.slug
    else:
        slug = category.slug if category is not None else None
    try:
        return score_duplicates(complaint, category_slug=slug), None, elapsed_ms(started)
    except Exception as exc:  # noqa: BLE001 - reported by the duplicate_detection step
        return None, exc, elapsed_ms(started)


def _persist_prediction(complaint, analysis, config, *, category, reanalysis):
    """Store the AIPrediction and apply it to the complaint (category, severity, title, status analyzed).
    ``category`` is the active CivicCategory for the engine's slug ("other" fallback)."""
    vision = analysis.get("vision") or {}
    text = analysis.get("text") or {}
    fusion = analysis.get("fusion") or {}
    severity = analysis.get("severity") or {}
    is_demo = bool(analysis.get("is_demo", get_model_mode() == "demo"))
    fused_slug = _fused_slug(analysis)
    severity_score = to_score(severity.get("score"))
    severity_level = severity.get("severity")
    if severity_level not in Level.values:
        severity_level = score_to_level(severity_score, config["severity"]["thresholds"])

    prediction = AIPrediction.objects.create(
        complaint=complaint,
        image_category=str(vision.get("category") or "")[:60],
        image_confidence=round(to_unit(vision.get("confidence")), 4),
        text_category=str(text.get("category") or "")[:60],
        text_confidence=round(to_unit(text.get("confidence")), 4),
        final_category=category,
        final_category_slug=(category.slug if category is not None else fused_slug)[:60],
        multimodal_confidence=round(to_unit(fusion.get("confidence")), 4),
        severity=severity_level,
        severity_score=severity_score,
        severity_reason=str(severity.get("reason") or ""),
        severity_factors=json_safe(severity.get("factors") or {}),
        detected_objects=json_safe(vision.get("detected_objects") or []),
        bounding_boxes=json_safe(vision.get("bounding_boxes") or []),
        keywords=json_safe(text.get("keywords") or []),
        impacts=json_safe(text.get("impacts") or []),
        probabilities=json_safe({"image": vision.get("probabilities") or {}, "text": text.get("probabilities") or {},
                                 "fused": fusion.get("probabilities") or {}}),
        modality_weights=json_safe(fusion.get("weights") or {}),
        location_risk=json_safe(analysis.get("location_risk") or {}),
        explanation=_with_demo_note(fusion.get("explanation"), is_demo),
        needs_review=bool(fusion.get("needs_review")),
        model_mode=str(analysis.get("mode") or get_model_mode())[:12],
        is_demo=is_demo,
        model_version=model_version_label(analysis),
        processing_time_ms=max(0, int(round(to_float(analysis.get("processing_time_ms"))))),
        raw_output=compact_copy(analysis),
    )

    changed = ["needs_manual_review"]
    if not complaint.is_ai_overridden:
        previous_category = complaint.category if complaint.category_id else None
        title_was_automatic = is_automatic_title(complaint.title, previous_category, complaint.location)
        complaint.category = category
        complaint.severity = severity_level
        complaint.severity_score = severity_score
        changed += ["category", "severity", "severity_score"]
        if not complaint.title.strip() or title_was_automatic:
            complaint.title = build_title(category, complaint.location)
            changed.append("title")
    complaint.needs_manual_review = (
        (prediction.needs_review and not complaint.is_ai_overridden) or verification_review_pending(complaint)
    )
    save_fields(complaint, *changed)

    category_name = category.name if category is not None else "an unknown category"
    remarks = (f"Classified as {category_name} ({prediction.multimodal_confidence:.0%} confidence) with "
               f"{severity_level} severity ({severity_score}/100). {prediction.explanation}").strip()
    metadata = {"prediction_id": prediction.pk, "category": category.slug if category is not None else None,
                "confidence": prediction.multimodal_confidence, "severity": severity_level,
                "severity_score": severity_score, "needs_review": prediction.needs_review, "is_demo": is_demo,
                "model_version": prediction.model_version, "reanalysis": reanalysis}
    if complaint.status == S.SUBMITTED:
        change_status(complaint, S.ANALYZED, actor=None, event=StatusHistory.Event.AI_ANALYZED, remarks=remarks,
                      metadata=metadata, notify=False)
    else:
        if complaint.is_ai_overridden:
            remarks += " Category and severity kept as set by an administrator."
        add_event(complaint, StatusHistory.Event.AI_ANALYZED, remarks=f"AI re-analysis: {remarks}", metadata=metadata)
    return prediction


def _priority_step(recorder, complaint, *, reanalysis):
    with recorder.step("priority", STEP_LABELS["priority"], capture=True) as step, transaction.atomic():
        priority = recalculate_priority(complaint, trigger="reanalysis" if reanalysis else "initial", notify=False)
        if priority.is_override:
            step.detail = (f"Kept the administrator's priority: {priority.final_score}/100 "
                           f"({priority.get_priority_level_display()}).")
        else:
            step.detail = (f"Priority {priority.final_score}/100 ({priority.get_priority_level_display()}). "
                           f"{priority.explanation}").strip()
    if step.error is not None:
        complaint.refresh_from_db(fields=["priority_score", "priority_level", "sla_due_at"])


def _duplicates_step(recorder, complaint, config, early_scoring):
    """Persist the duplicate pairs scored before the transaction (the step's duration includes the scoring)."""
    scoring, scoring_error, scoring_ms = early_scoring
    duplicate_config = config["duplicate"]
    scan = DuplicateScan()
    with recorder.step("duplicate_detection", STEP_LABELS["duplicate_detection"], capture=True) as step, \
            transaction.atomic():
        step.extra_ms = scoring_ms
        if scoring_error is not None:
            raise scoring_error
        scan = save_duplicate_links(complaint, scoring)
        if scan.created:
            recalculate_priority(complaint, trigger="duplicate_update", notify=False)
        step.detail = scan.describe(duplicate_config["radius_m"], duplicate_config["window_days"])
    if step.error is not None:
        complaint.refresh_from_db(fields=["duplicate_count", "priority_score", "priority_level", "sla_due_at"])
        return DuplicateScan()
    return scan


def _routing_step(recorder, complaint):
    """Route to a department (unless an officer is already working on it). Returns True when it changed."""
    previous_department_id = complaint.department_id
    with recorder.step("department_routing", STEP_LABELS["department_routing"], capture=True) as step, \
            transaction.atomic():
        category = complaint.category if complaint.category_id else None
        department = route_department(category)
        if department is None:
            complaint.needs_manual_review = True
            save_fields(complaint, "needs_manual_review")
            step.fail(f"{routing_reason(category, None)} An administrator must route it.")
        elif department.pk == complaint.department_id:
            step.detail = f"Stays with the {department.name}."
        elif complaint.assigned_officer_id:
            current = complaint.department.name if complaint.department_id else "current department"
            step.skip(f"Kept the {current}: an officer is already working on this complaint "
                      f"(the AI now suggests the {department.name}).")
        else:
            complaint.department = department
            complaint.sla_due_at = complaint.compute_sla_due()
            save_fields(complaint, "department", "sla_due_at")
            add_event(complaint, StatusHistory.Event.DEPARTMENT_ASSIGNED, remarks=routing_reason(category, department),
                      metadata={"department_id": department.pk, "department_code": department.code,
                                "category": category.slug if category is not None else None,
                                "sla_due_at": complaint.sla_due_at})
            step.detail = routing_reason(category, department)
    if step.error is not None:
        complaint.refresh_from_db(fields=["department", "sla_due_at", "needs_manual_review"])
    return complaint.department_id != previous_department_id


def _assignment_step(recorder, complaint):
    """Automatic officer assignment. Returns the officer assigned in this run (None otherwise); the citizen's
    "Officer assigned" notice is left to the notification step so it follows the earlier lifecycle notices."""
    from apps.core.models import AIConfiguration

    assigned = None
    with recorder.step("officer_assignment", STEP_LABELS["officer_assignment"], capture=True) as step:
        if complaint.assigned_officer_id:
            step.skip(f"Already assigned to {complaint.assigned_officer.full_name}; reassignment is a manual decision.")
        elif not AIConfiguration.load().auto_assign_officer:
            step.skip("Automatic assignment is turned off in the AI settings; an administrator will assign an officer.")
        elif not complaint.department_id:
            step.skip("No department to assign an officer from.")
        elif complaint.status not in (S.ANALYZED, S.REOPENED):
            step.skip(f"Not assignable while the complaint is {status_phrase(complaint.status)}.")
        else:
            from apps.assignments.services import auto_assign

            with transaction.atomic():
                assignment = auto_assign(complaint, notify_citizen=False)
            if assignment is None:
                step.skip("No available officer with spare capacity was found; an administrator will assign one.")
            else:
                assigned = assignment.officer
                score = assignment.recommendation_score
                suffix = f" (recommendation score {score:.2f})" if score is not None else ""
                step.detail = f"Assigned to {assignment.officer.full_name}{suffix}."
    complaint.refresh_from_db(fields=["status", "assigned_officer", "department", "accepted_at"])
    return assigned


def _notification_step(recorder, complaint, analysis, *, reanalysis, was_submitted, department_changed,
                       assigned_officer=None):
    """Citizen notices in lifecycle order - submitted, AI analysis completed, department assigned, officer
    assigned - then the critical alert and the hotspot check."""
    with recorder.step("notification", STEP_LABELS["notification"], capture=True) as step:
        number = complaint.complaint_number
        attempted = sent = 0
        messages = []
        if not reanalysis:
            messages.append(("complaint_submitted", "Complaint submitted",
                             f"We received your complaint {number}: {complaint.title}."))
        if not reanalysis or was_submitted:
            category = complaint.category.name if complaint.category_id else "an unknown category"
            demo = " (Demo AI Mode)" if analysis.get("is_demo") else ""
            messages.append(("ai_analysis_completed", "AI analysis completed",
                             f"{number} was classified as {category} with {complaint.severity or 'unknown'} severity "
                             f"and {complaint.priority_level or 'unknown'} priority "
                             f"({complaint.priority_score}/100){demo}."))
        if department_changed and complaint.department_id:
            messages.append(("department_assigned", "Department assigned",
                             f"{number} has been routed to the {complaint.department.name}."))
        for notification_type, title, message in messages:
            attempted += 1
            sent += notifications.notify_citizen(complaint, notification_type=notification_type, title=title,
                                                 message=message)
        if assigned_officer is not None and complaint.assigned_officer_id == assigned_officer.pk:
            attempted += 1
            sent += notifications.notify_officer_assigned(complaint, assigned_officer)
        if complaint.priority_level == Level.CRITICAL and complaint.is_open:
            sent += notifications.notify_critical(complaint)
        parts = [f"{sent} notification(s) sent"]
        if not reanalysis:
            parts.append(_hotspot_check(complaint))
        step.detail = "; ".join(parts) + "."
        if attempted and not sent:
            step.fail(f"Notifications could not be delivered; {parts[-1]}." if len(parts) > 1
                      else "Notifications could not be delivered.")


def _hotspot_check(complaint):
    """DBSCAN hotspot check around the new complaint (apps.analytics); never fails the submission."""

    def _check():
        from apps.analytics.services import check_hotspot_alert

        return check_hotspot_alert(complaint)

    effect = run_side_effect(f"Hotspot check for {complaint.complaint_number}", _check)
    if not effect.ok:
        return f"hotspot check unavailable ({effect.error})"
    alert = effect.result
    if alert is None:
        return "no new hotspot"
    area = getattr(alert, "area_name", "") or "this area"
    return f"hotspot alert raised for {area} ({getattr(alert, 'complaint_count', 0)} complaints)"


def _record_failed_analysis(recorder, exc, duration_ms):
    """AI steps of a failed analysis. When the engine attached its own step report to the error (``exc.steps``,
    e.g. ``ai.pipeline.AnalysisError``) that report is used - so the UI shows exactly which step failed and which
    never ran; otherwise every AI step is reported as failed."""
    reason = error_text(exc)
    engine_steps = getattr(exc, "steps", None)
    if not isinstance(engine_steps, list):
        engine_steps = []
    reported_keys = {step.get("key") for step in engine_steps if isinstance(step, dict)}
    if reported_keys & set(AI_STEP_KEYS):
        first = len(recorder.steps)
        _merge_engine_steps(recorder, {"steps": engine_steps},
                            missing_detail="Not run: the AI analysis stopped at an earlier step.")
        ai_steps = recorder.steps[first:first + len(AI_STEP_KEYS)]
        if not any(step["status"] == FAILED for step in ai_steps):
            culprit = next((step for step in ai_steps if step["status"] != DONE), ai_steps[-1])
            culprit.update(status=FAILED, detail=f"AI analysis failed: {reason}")
        return
    for index, key in enumerate(AI_STEP_KEYS):
        recorder.add(key, STEP_LABELS[key], FAILED, duration_ms if index == 0 else 0,
                     f"AI analysis failed: {reason}" if index == 0 else "Not completed because the AI analysis failed.")


def _handle_failure(complaint, recorder, exc, *, stage, reanalysis, request, duration_ms=0.0):
    """Record the failed / skipped steps, flag the complaint for manual review and alert administrators."""
    reason = error_text(exc)
    number = complaint.complaint_number
    if stage == "analysis":
        _record_failed_analysis(recorder, exc, duration_ms)
        post_status, post_detail = SKIPPED, "Skipped: this step needs the AI analysis result."
    else:
        post_status, post_detail = FAILED, f"Rolled back: {reason}"
    for key in POST_AI_STEP_KEYS:
        recorder.add(key, STEP_LABELS[key], post_status, 0, post_detail)

    with recorder.step("database_save", STEP_LABELS["database_save"]) as step:
        complaint.needs_manual_review = True
        save_fields(complaint, "needs_manual_review")
        kept = f"{number} kept as '{status_phrase(complaint.status)}' and flagged for manual review."
        if stage == "analysis":
            step.detail = kept
        else:
            step.fail(f"The AI results could not be saved ({reason}). {kept}")

    with recorder.step("notification", STEP_LABELS["notification"], capture=True) as step:
        sent = 0
        if not reanalysis:
            sent += notifications.notify_citizen(
                complaint, notification_type="complaint_submitted", title="Complaint submitted",
                message=f"We received your complaint {number}. It will be reviewed by our team shortly.",
            )
        sent += notifications.notify_admins(
            notification_type="system", title=f"AI analysis failed for {number}", complaint=complaint,
            message=f"The AI pipeline could not process {number} ({reason}). Please review, categorise and route it "
                    "manually, or re-run the analysis.", level="warning",
        )
        step.detail = f"{sent} notification(s) sent (citizen confirmation and administrator alert)."

    mode = get_model_mode()
    summary = _summary(complaint, None, request=request)
    summary.update(
        is_demo=mode == "demo", mode=mode, needs_review=True,
        explanation=f"The AI analysis could not be completed ({reason}). The complaint is registered and an "
                    "administrator will review it manually.",
    )
    return {"steps": recorder.steps, "summary": summary}


def _summary(complaint, analysis, *, duplicates_found=0, request=None):
    """The ``analysis.summary`` block of the API contract (plain JSON)."""
    analysis = analysis or {}
    fusion = analysis.get("fusion") or {}
    severity = analysis.get("severity") or {}
    mode = analysis.get("mode") or get_model_mode()
    is_demo = bool(analysis.get("is_demo", mode == "demo"))
    priority = complaint.latest_priority
    parts = [fusion.get("explanation"), severity.get("reason"), priority.explanation if priority else None]
    explanation = " ".join(str(part).strip() for part in parts if part and str(part).strip())
    return {
        "category": category_mini(complaint.category if complaint.category_id else None),
        "confidence": round(to_unit(fusion.get("confidence")), 4) if fusion else None,
        "severity": complaint.severity or None,
        "severity_score": complaint.severity_score,
        "priority_score": complaint.priority_score,
        "priority_level": complaint.priority_level or None,
        "department": department_mini(complaint.department if complaint.department_id else None),
        "officer": user_mini(complaint.assigned_officer if complaint.assigned_officer_id else None, request),
        "duplicates_found": int(duplicates_found),
        "is_demo": is_demo,
        "mode": mode,
        "explanation": _with_demo_note(explanation, is_demo),
        "needs_review": bool(complaint.needs_manual_review),
    }


# ---------------------------------------------------------------------------------------------------------------
# Preview helpers
# ---------------------------------------------------------------------------------------------------------------
def _slug_of(category):
    if category is None:
        return None
    return getattr(category, "slug", None) or str(category)


def _draft_complaint(category, department, priority, severity, latitude, longitude, address):
    """Unsaved Complaint carrying what the officer recommender needs (department, category, priority, place)."""
    draft = Complaint(
        category=category, department=department,
        priority_score=to_score((priority or {}).get("final_score")),
        priority_level=(priority or {}).get("priority_level") or "",
        severity=(severity or {}).get("severity") or "", severity_score=to_score((severity or {}).get("score")),
    )
    if latitude is not None and longitude is not None:
        draft.location = Location(latitude=quantize_coordinate(latitude), longitude=quantize_coordinate(longitude),
                                  address=(address or "")[:255])
    return draft
