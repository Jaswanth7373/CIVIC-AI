"""Tests for the complaint service layer (owner B3).

The AI engine and the collaborating services of other apps (assignments, notifications, analytics) are replaced
by realistic test doubles that follow the contracts in docs/BUILD_SPEC.md - including numpy values in the AI
outputs - so orchestration, persistence, lifecycle rules and notifications are verified independently of those
modules. ``EndToEndDemoTest`` runs the whole lifecycle with the real modules in demo mode; it is skipped only
while one of them still raises NotImplementedError.

Run:  venv/Scripts/python.exe manage.py test apps.complaints.test_services -v 2
"""
import io
import json
import math
import os
import shutil
import tempfile
from datetime import timedelta
from decimal import Decimal
from unittest import mock

import numpy as np
from django.core.management import call_command
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, override_settings
from django.utils import timezone
from PIL import Image, ImageDraw
from rest_framework.exceptions import PermissionDenied, ValidationError

from ai.config import score_to_level
from apps.accounts.models import CitizenProfile, User
from apps.assignments.models import ComplaintAssignment
from apps.audit.models import AuditLog
from apps.core.exceptions import ServiceError, TransitionNotAllowed
from apps.core.models import AIConfiguration, RiskZone
from apps.departments.models import CivicCategory, Department
from apps.feedback.models import Feedback
from apps.notifications.models import Notification
from apps.officers.models import OfficerProfile

from . import tasks
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
from .services import (
    context,
    duplicates,
    helpers,
    overrides,
    pipeline,
    priority,
    routing,
    sla,
    status,
    submission,
    verification,
)
from .services.helpers import StepRecorder, build_title, compact_copy, json_safe

# Uploaded test files go to a per-process temporary folder (created by the storage on first save, removed by
# tearDownModule) - never into backend/media.
TEST_MEDIA_ROOT = os.path.join(tempfile.gettempdir(), f"civicai-test-media-{os.getpid()}")

S = Complaint.Status
BASE_LAT, BASE_LNG = 17.412600, 78.448200
METRES_PER_DEGREE_LAT = 111320.0
EXPECTED_SUBMISSION_STEPS = [
    "validate", "upload", "save", "preprocess", "image_analysis", "text_analysis", "multimodal_fusion", "severity",
    "priority", "duplicate_detection", "department_routing", "officer_assignment", "database_save", "notification",
]


def tearDownModule():
    shutil.rmtree(TEST_MEDIA_ROOT, ignore_errors=True)


def north_of(metres, lat=BASE_LAT):
    """Latitude ``metres`` north of ``lat`` (same longitude)."""
    return round(lat + metres / METRES_PER_DEGREE_LAT, 6)


def image_bytes(*, size=(64, 48), background=(96, 96, 96), defect=True, fmt="JPEG"):
    """Small synthetic road photo: grey asphalt with (optionally) a dark elliptical pothole."""
    img = Image.new("RGB", size, background)
    if defect:
        ImageDraw.Draw(img).ellipse((size[0] // 4, size[1] // 3, size[0] * 3 // 4, size[1] * 2 // 3), fill=(20, 18, 16))
    buffer = io.BytesIO()
    img.save(buffer, format=fmt)
    return buffer.getvalue()


def upload(name="pothole_01.jpg", **kwargs):
    return SimpleUploadedFile(name, image_bytes(**kwargs), content_type="image/jpeg")


# ---------------------------------------------------------------------------------------------------------------
# Contract-following test doubles
# ---------------------------------------------------------------------------------------------------------------
LABELS = {"severity": "Severity", "public_impact": "Public Impact", "location_risk": "Location Risk",
          "frequency": "Frequency", "duplicates": "Duplicates"}
DEFAULT_WEIGHTS = {"severity": 40, "public_impact": 25, "location_risk": 15, "frequency": 10, "duplicates": 10}


def fake_calculate_priority(inputs, config=None):
    """Weighted-sum priority following the PriorityEngine contract (BUILD_SPEC 2.5)."""
    config = config or {}
    weights = dict(config.get("weights") or DEFAULT_WEIGHTS)
    total = sum(weights.values())
    weights = {key: value * 100.0 / total for key, value in weights.items()}
    impact_evidence = [value for value in (inputs["public_impact"], inputs["category_safety_weight"])
                       if value is not None]
    factors = {
        "severity": inputs["severity_score"] / 100.0,
        "public_impact": max(impact_evidence) if impact_evidence else 0.0,
        "location_risk": inputs["location_risk"],
        "frequency": 1 - math.exp(-0.5 * inputs["frequency_count"]),
        "duplicates": 1 - math.exp(-0.7 * inputs["duplicate_count"]),
    }
    components = {key: {"score": np.float64(round(weights[key] * factors[key], 2)), "max": weights[key],
                        "raw": round(factors[key], 4), "label": LABELS[key]} for key in weights}
    bump = 5 if inputs["is_reopened"] else 0
    raw_total = sum(float(component["score"]) for component in components.values()) + bump
    final = int(round(min(100.0, raw_total)))
    level = score_to_level(final, config.get("thresholds"))
    return {"final_score": np.int64(final), "priority_level": level, "components": components, "weights": weights,
            "factors": factors, "explanation": f"{level.capitalize()} priority because the issue has high severity.",
            "summary": f"Priority Score: {final}/100"}


def fake_public_impact_from_text(text_result):
    """max(text safety score, strongest impact) - the ai.priority.public_impact_from_text contract."""
    if not isinstance(text_result, dict):
        return None
    scores = [float(i.get("score") or 0) for i in text_result.get("impacts") or []]
    return max([float(text_result.get("safety_score") or 0)] + scores)


def fake_compute_hashes(image):
    return {"phash": "8f373714acfcf4d0", "dhash": "0f1e2d3c4b5a6978", "ahash": "ffff0000ffff0000",
            "width": np.int64(64), "height": np.int64(48)}


def fake_find_duplicates(target, candidates, *, config=None):
    """Same category within the radius -> duplicate (0.88); different category -> weak match (0.5)."""
    results = []
    for candidate in candidates:
        same = candidate["category"] == target["category"]
        distance = float(candidate.get("distance_m") or 0.0)
        overall = 0.88 if same else 0.5
        results.append({
            "complaint_id": candidate["id"],
            "text_similarity": np.float64(0.86 if same else 0.41),
            "image_similarity": np.float32(0.91) if target.get("phash") and candidate.get("phash") else None,
            "location_similarity": np.float64(max(0.0, 1 - distance / config["radius_m"])),
            "distance_m": distance,
            "category_match": same,
            "overall_similarity": overall,
            "is_duplicate": bool(same and distance <= config["radius_m"] and overall >= config["threshold"]),
            "explanation": f"Text {0.86 if same else 0.41:.0%} similar, {distance:.0f} m apart.",
        })
    return sorted((r for r in results if r["overall_similarity"] >= 0.45), key=lambda r: -r["overall_similarity"])


def fake_location_risk(latitude, longitude, *, address="", text="", risk_zones=None, nearby_count=0):
    return {"score": np.float64(0.55), "level": "medium", "zones": [], "factors": ["Address mentions a main road"],
            "is_high_traffic": True, "explanation": "Moderate traffic location."}


def fake_notify(user, *, title, message, notification_type, complaint=None, link="", level=None):
    """Mirrors apps.notifications.services.notify: one row, inactive users skipped."""
    if user is None or not user.is_active:
        return None
    if not link and complaint is not None:
        link = f"/{user.role}/complaints/{complaint.pk}"
    return Notification.objects.create(user=user, title=title[:160], message=message,
                                       notification_type=notification_type, level=level or "info",
                                       complaint=complaint, link=link)


def fake_notify_admins(**kwargs):
    admins = User.objects.filter(is_active=True, role="admin").order_by("pk")
    return sum(1 for admin in admins if fake_notify(admin, **kwargs) is not None)


def fake_complete_active_assignment(complaint, *, status="completed"):
    closed = list(ComplaintAssignment.objects.filter(complaint=complaint, is_active=True))
    for assignment in closed:
        assignment.status, assignment.is_active, assignment.completed_at = status, False, timezone.now()
        assignment.save(update_fields=["status", "is_active", "completed_at"])
    return closed[0] if closed else None


# ---------------------------------------------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------------------------------------------
class FixtureMixin:
    """Reference data mirroring init_civicai (subset) + users of every role."""

    @classmethod
    def setUpTestData(cls):
        cls.roads = Department.objects.create(name="Roads Department", code="ROADS", sla_hours=72,
                                              icon="traffic-cone", color="#D9480F")
        cls.waste = Department.objects.create(name="Waste Management", code="WASTE", sla_hours=48, icon="recycle")
        cls.drain = Department.objects.create(name="Drainage Department", code="DRAIN", sla_hours=48, icon="waves")
        cls.general = Department.objects.create(name="General Civic Department", code="GEN", sla_hours=96)
        cls.pothole = CivicCategory.objects.create(
            name="Roads / Potholes", slug="pothole", department=cls.roads, base_severity=60,
            public_safety_weight=0.75, keywords=["pothole", "pit", "gaddha"], vision_labels=["pothole", "road_hole"],
            icon="construction", color="#D9480F", sort_order=1,
        )
        cls.garbage = CivicCategory.objects.create(
            name="Garbage / Waste", slug="garbage", department=cls.waste, base_severity=40,
            public_safety_weight=0.45, keywords=["garbage", "kachra"], icon="trash-2", sort_order=2,
        )
        cls.manhole = CivicCategory.objects.create(
            name="Open Manhole", slug="open_manhole", department=cls.roads, secondary_department=cls.drain,
            base_severity=85, public_safety_weight=0.95, sla_hours=12, sort_order=6,
        )
        cls.other = CivicCategory.objects.create(name="Other", slug="other", department=cls.general, base_severity=30,
                                                 public_safety_weight=0.30, sort_order=99)
        cls.citizen = User.objects.create_user("asha@test.local", "Str0ng-pass!", first_name="Asha", last_name="Rao")
        cls.citizen2 = User.objects.create_user("vikram@test.local", "Str0ng-pass!", first_name="Vikram")
        cls.officer = User.objects.create_user("ravi@test.local", "Str0ng-pass!", first_name="Ravi",
                                               last_name="Kumar", role="officer")
        OfficerProfile.objects.create(user=cls.officer, department=cls.roads, employee_id="RD-1001",
                                      base_latitude=Decimal("17.410000"), base_longitude=Decimal("78.440000"))
        cls.officer2 = User.objects.create_user("lakshmi@test.local", "Str0ng-pass!", first_name="Lakshmi",
                                                role="officer")
        OfficerProfile.objects.create(user=cls.officer2, department=cls.roads, employee_id="RD-1002")
        cls.waste_officer = User.objects.create_user("imran@test.local", "Str0ng-pass!", first_name="Imran",
                                                     role="officer")
        OfficerProfile.objects.create(user=cls.waste_officer, department=cls.waste, employee_id="WM-2001")
        cls.admin = User.objects.create_user("meera@test.local", "Str0ng-pass!", first_name="Meera",
                                             last_name="Iyer", role="admin")
        config = AIConfiguration.load()
        config.auto_assign_officer = False
        config.save()

    # -- helpers -------------------------------------------------------------------------------------------
    def make_complaint(self, *, category=None, status_value=S.ANALYZED, lat=BASE_LAT, lng=BASE_LNG, citizen=None,
                       officer=None, created_at=None, description="Large pothole near the school entrance.",
                       with_image=False, **fields):
        location = Location.objects.create(
            latitude=Decimal(str(lat)), longitude=Decimal(str(lng)), address="Road No. 12, Banjara Hills",
            landmark="Govt. High School", area="Banjara Hills", city="Hyderabad",
        )
        if category is not None:
            fields.setdefault("department", category.department)
        complaint = Complaint.objects.create(
            citizen=citizen or self.citizen, description=description, category=category, status=status_value,
            location=location, assigned_officer=officer, created_at=created_at or timezone.now(), **fields,
        )
        if with_image:
            ComplaintImage.objects.create(complaint=complaint, image=upload("existing.jpg"), phash="8f373714acfcf4d0",
                                          dhash="0f1e2d3c4b5a6978", width=64, height=48, file_size=900)
        return complaint

    def add_prediction(self, complaint, **fields):
        values = {
            "final_category": complaint.category, "final_category_slug": complaint.category.slug,
            "multimodal_confidence": 0.9, "severity": "high", "severity_score": 72,
            "impacts": [{"type": "public_safety", "label": "Public Safety", "score": 0.6, "evidence": ["school"]}],
            "location_risk": {"score": 0.7, "level": "high"}, "bounding_boxes": [[0.2, 0.3, 0.6, 0.7]],
            "raw_output": {"text": {"safety_score": 0.8}},
        }
        values.update(fields)
        return AIPrediction.objects.create(complaint=complaint, **values)

    def events(self, complaint):
        return list(complaint.status_history.order_by("timestamp", "id").values_list("event", flat=True))

    def notification_types(self, user, complaint=None):
        queryset = Notification.objects.filter(user=user)
        if complaint is not None:
            queryset = queryset.filter(complaint=complaint)
        return list(queryset.order_by("id").values_list("notification_type", flat=True))

    def configure(self, **values):
        config = AIConfiguration.load()
        for name, value in values.items():
            setattr(config, name, value)
        config.save()


@override_settings(MEDIA_ROOT=TEST_MEDIA_ROOT)
class ServiceTestCase(FixtureMixin, TestCase):
    """Installs the test doubles; ``self.scenario`` steers the fake AI analysis."""

    def setUp(self):
        self.scenario = {"category": None, "confidence": 0.93, "severity": "high", "severity_score": 72,
                         "needs_review": False, "location_risk": 0.8, "verification_status": "likely_resolved"}
        self.mocks = {}
        for target, side_effect in {
            "ai.pipeline.run_analysis": self.fake_run_analysis,
            "ai.priority.calculate_priority": fake_calculate_priority,
            "ai.priority.public_impact_from_text": fake_public_impact_from_text,
            "ai.duplicate.find_duplicates": fake_find_duplicates,
            "ai.duplicate.compute_hashes": fake_compute_hashes,
            "ai.geospatial.assess_location_risk": fake_location_risk,
            "ai.verification.verify_resolution": self.fake_verify_resolution,
            "apps.notifications.services.notify": fake_notify,
            "apps.notifications.services.notify_admins": fake_notify_admins,
            "apps.assignments.services.auto_assign": self.fake_auto_assign,
            "apps.assignments.services.complete_active_assignment": fake_complete_active_assignment,
            "apps.assignments.services.recommend_officers": self.fake_recommend_officers,
            "apps.analytics.services.check_hotspot_alert": lambda complaint: None,
        }.items():
            # create=True only for the analytics hook, whose module (owner B5) may be mid-rewrite
            patcher = mock.patch(target, side_effect=side_effect, create=target.startswith("apps.analytics"))
            self.mocks[target.rsplit(".", 1)[1]] = patcher.start()
            self.addCleanup(patcher.stop)

    # -- fake AI pipeline (ai.pipeline.run_analysis contract) ---------------------------------------------
    def fake_run_analysis(self, *, text, latitude, longitude, image=None, filename=None, address="",
                          reported_category=None, categories=None, risk_zones=None, nearby=None, config=None):
        lowered = (text or "").lower()
        category = self.scenario["category"] or (
            "garbage" if "garbage" in lowered else "open_manhole" if "manhole" in lowered else "pothole"
        )
        nearby = nearby or []
        vision = None
        if image is not None:
            vision = {
                "category": category, "confidence": np.float32(0.88),
                "probabilities": {category: np.float64(0.88), "other": np.float64(0.12)},
                "detected_objects": [{"label": category, "confidence": np.float32(0.86),
                                      "box": np.array([0.2, 0.3, 0.6, 0.7]), "area_ratio": 0.16}],
                "bounding_boxes": [np.array([0.2, 0.3, 0.6, 0.7])], "visual_severity": np.float64(0.74),
                "quality": {"width": 64, "height": 48, "blur_score": 210.5, "brightness": 0.46,
                            "is_blurry": np.bool_(False), "is_dark": False},
                "model_version": "demo-opencv-heuristic-1.0", "mode": "demo", "is_demo": True,
                "fallback_reason": None, "explanation": "Demo heuristic: dark elliptical region on grey ground.",
                "processing_time_ms": 41,
            }
        text_result = {
            "category": category, "confidence": np.float64(0.91),
            "probabilities": {category: 0.91, "other": 0.09}, "keywords": ["pothole", "school", "traffic"],
            "impacts": [{"type": "public_safety", "label": "Public Safety", "score": np.float64(0.9),
                         "evidence": ["school"]},
                        {"type": "traffic", "label": "Traffic", "score": 0.7, "evidence": ["traffic"]}],
            "primary_impact": "Public Safety", "safety_score": 0.8, "urgency_score": 0.6, "severity_hint": "high",
            "severity_hint_score": 0.72, "location_mentions": ["school entrance"], "clean_text": lowered,
            "language": "en", "model_version": "demo-tfidf-logreg-1.0", "mode": "demo", "is_demo": True,
            "explanation": "Demo TF-IDF classifier.", "processing_time_ms": 12,
        }
        fusion = {
            "category": category, "confidence": np.float64(self.scenario["confidence"]),
            "probabilities": {category: self.scenario["confidence"]}, "image_category": category,
            "image_confidence": 0.88, "text_category": category, "text_confidence": 0.91,
            "weights": {"image": 0.52, "text": 0.38, "reported": 0.06, "location": 0.04},
            "agreement": "agree", "needs_review": self.scenario["needs_review"],
            "explanation": f"Image model detected {category} (88%) and the text classifier agreed (91%).",
        }
        steps = [
            {"key": "preprocess", "label": "Data preprocessing", "status": "done", "duration_ms": 3,
             "detail": "Text normalised"},
            {"key": "image_analysis", "label": "Image AI analysis",
             "status": "done" if image is not None else "skipped",
             "duration_ms": 41 if image is not None else 0, "detail": "" if image is not None else "No image"},
            {"key": "text_analysis", "label": "Text NLP analysis", "status": "done", "duration_ms": 12, "detail": ""},
            {"key": "multimodal_fusion", "label": "Multimodal classification", "status": "done", "duration_ms": 1,
             "detail": "agree"},
            {"key": "location_risk", "label": "Location risk assessment", "status": "done", "duration_ms": 2,
             "detail": "near a school"},
            {"key": "severity", "label": "Severity assessment", "status": "done", "duration_ms": 1,
             "detail": "high"},
        ]
        return {
            "vision": vision, "text": text_result, "fusion": fusion,
            "location_risk": {"score": np.float64(self.scenario["location_risk"]), "level": "high", "zones": [],
                              "factors": ["Within 85 m of Govt. High School (school)"], "is_high_traffic": True,
                              "explanation": "Near a school."},
            "severity": {"severity": self.scenario["severity"], "score": np.int64(self.scenario["severity_score"]),
                         "reason": "Large road damage detected near a high-traffic area.",
                         "factors": {"visual": {"value": np.float64(0.8), "weight": 0.25, "contribution": 20.0,
                                                "label": "Visual severity"}}},
            "nearby_count": len(nearby), "frequency_count": sum(1 for item in nearby if item["category"] == category),
            "public_impact": np.float64(0.9), "mode": "demo", "is_demo": True,
            "model_versions": {"vision": vision["model_version"] if vision else None, "text": "demo-tfidf-logreg-1.0"},
            "steps": steps, "processing_time_ms": 60,
        }

    def fake_verify_resolution(self, before_image, after_image, *, category=None, boxes=None, config=None):
        status_value = self.scenario["verification_status"]
        score = {"likely_resolved": 91, "partially_resolved": 55, "not_resolved": 18, "needs_manual_review": 30}
        return {
            "score": np.int64(score[status_value]), "status": status_value,
            "status_label": status_value.replace("_", " ").title(),
            "explanation": "The after-image shows substantial visual change in the previously detected damaged area.",
            "metrics": {"ssim": np.float64(0.41), "region_change": 0.71, "issue_still_detected": np.bool_(False)},
            "model_version": "demo-opencv-verification-1.0", "mode": "demo", "is_demo": True,
            "disclaimer": "AI-assisted verification - not a guarantee. Officers and admins can override the result.",
            "processing_time_ms": 85,
        }

    # -- fake assignment services (apps.assignments contract) ---------------------------------------------
    def fake_auto_assign(self, complaint, *, notify_citizen=True):
        """Mirrors apps.assignments.services.auto_assign (its own notifications are not part of the double)."""
        assignment = ComplaintAssignment.objects.create(
            complaint=complaint, officer=self.officer, department=complaint.department, assignment_type="auto",
            recommendation_score=0.83, recommendation_reasons=["Roads Department officer"],
        )
        complaint.assigned_officer = self.officer
        complaint.save(update_fields=["assigned_officer", "updated_at"])
        status.change_status(complaint, S.ASSIGNED, actor=None, event=StatusHistory.Event.OFFICER_ASSIGNED,
                             remarks="Automatically assigned to Ravi Kumar.", notify=False)
        return assignment

    def fake_recommend_officers(self, complaint, *, limit=5):
        return [{"officer": self.officer, "profile": self.officer.officer_profile, "score": 0.83, "workload": 1,
                 "capacity": 10, "utilization": 0.1, "distance_km": 1.2, "is_available": True,
                 "same_department": True, "reasons": ["Roads Department officer", "1/10 active complaints"],
                 "recommended": True}][:limit]

    def assign(self, complaint, officer=None, accepted=False):
        officer = officer or self.officer
        complaint.assigned_officer = officer
        complaint.save(update_fields=["assigned_officer"])
        return ComplaintAssignment.objects.create(complaint=complaint, officer=officer, department=complaint.department,
                                                  accepted_at=timezone.now() if accepted else None)


# ---------------------------------------------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------------------------------------------
class HelperTests(ServiceTestCase):
    def test_json_safe_converts_numpy_tuples_nan_and_bytes(self):
        value = {"a": np.float32(0.5), "b": np.array([1, 2]), "c": float("nan"), "d": (1, 2), np.int64(3): "x",
                 "e": b"raw", "f": np.bool_(True), "g": Decimal("1.25")}
        converted = json_safe(value)
        self.assertEqual(converted, {"a": 0.5, "b": [1, 2], "c": None, "d": [1, 2], "3": "x", "e": None, "f": True,
                                     "g": 1.25})
        json.dumps(converted, allow_nan=False)  # strict JSON, as MySQL's JSON column requires

    def test_compact_copy_rounds_floats_and_truncates_lists(self):
        compact = compact_copy({"x": 0.123456789, "items": list(range(80))}, float_digits=3, max_list=5)
        self.assertEqual(compact, {"x": 0.123, "items": [0, 1, 2, 3, 4]})

    def test_step_recorder_captures_failures_and_reports_them(self):
        recorder = StepRecorder()
        with recorder.step("ok", "Works") as step:
            step.detail = "fine"
        with self.assertLogs("apps.complaints", level="ERROR") as logs:
            with recorder.step("broken", "Breaks", capture=True):
                raise RuntimeError("engine exploded")
        self.assertIn("Breaks failed: engine exploded", logs.output[0])
        with self.assertRaises(ValueError):
            with recorder.step("strict", "Propagates"):
                raise ValueError("bad input")
        self.assertEqual([(s["key"], s["status"]) for s in recorder.steps],
                         [("ok", "done"), ("broken", "failed"), ("strict", "failed")])
        self.assertIn("engine exploded", recorder.steps[1]["detail"])
        self.assertTrue(all(isinstance(s["duration_ms"], int) for s in recorder.steps))

    def test_build_title_uses_landmark_area_address_and_truncates(self):
        complaint = self.make_complaint(category=self.pothole)
        self.assertEqual(build_title(self.pothole, complaint.location),
                         "Roads / Potholes near Govt. High School, Banjara Hills")
        location = Location(latitude=Decimal("17.4"), longitude=Decimal("78.4"),
                            address="Road No. 12, Banjara Hills, Hyderabad, Telangana")
        self.assertEqual(build_title(None, location), "Civic issue near Road No. 12, Banjara Hills")
        long_location = Location(latitude=Decimal("17.4"), longitude=Decimal("78.4"), landmark="x" * 300)
        self.assertEqual(len(build_title(self.pothole, long_location)), 160)

    def test_title_keeps_a_landmark_that_starts_with_a_preposition(self):
        def place(landmark):
            return Location(latitude=Decimal("17.4"), longitude=Decimal("78.4"), landmark=landmark, area="Kacheguda")

        self.assertEqual(build_title(self.pothole, place("Opposite the bus stop")),
                         "Roads / Potholes opposite the bus stop, Kacheguda")
        self.assertEqual(build_title(self.pothole, place("Near Railway Station")),
                         "Roads / Potholes near Railway Station, Kacheguda")
        self.assertEqual(build_title(self.pothole, place("In front of City College")),
                         "Roads / Potholes in front of City College, Kacheguda")
        # Only whole words: "Inorbit Mall" does not start with "in", "Ongole Road" not with "on".
        self.assertEqual(build_title(self.pothole, place("Inorbit Mall")),
                         "Roads / Potholes near Inorbit Mall, Kacheguda")
        self.assertEqual(build_title(self.pothole, place("Ongole Road")),
                         "Roads / Potholes near Ongole Road, Kacheguda")
        # Titles written before keep counting as automatic (re-analysis may still refresh them).
        self.assertTrue(helpers.is_automatic_title("Roads / Potholes near Opposite the bus stop, Kacheguda",
                                                   self.pothole, place("Opposite the bus stop")))
        self.assertFalse(helpers.is_automatic_title("Deep pothole at the bus stop", self.pothole,
                                                    place("Opposite the bus stop")))

    def test_notification_subject_names_the_place_once(self):
        location = Location.objects.create(latitude=Decimal("17.44"), longitude=Decimal("78.50"),
                                           landmark="Clock Tower", area="Secunderabad")
        complaint = Complaint(title="Garbage / Waste near Clock Tower, Secunderabad", location=location,
                              category=self.garbage)
        self.assertEqual(helpers.complaint_subject(complaint), "Garbage / Waste near Clock Tower, Secunderabad")
        complaint.title = "Overflowing bins"
        self.assertEqual(helpers.complaint_subject(complaint), "Overflowing bins near Clock Tower, Secunderabad")
        complaint.title = "Bins overflowing at the Clock Tower bus stop"  # a citizen's title that names the landmark
        self.assertEqual(helpers.complaint_subject(complaint), "Bins overflowing at the Clock Tower bus stop")
        complaint.title = ""
        self.assertEqual(helpers.complaint_subject(complaint), "Garbage / Waste near Clock Tower, Secunderabad")

    def test_format_duration(self):
        self.assertEqual([helpers.format_duration(hours) for hours in (0, 0.5, 1, 5.4, 24, 49, 520.2)],
                         ["0 min", "30 min", "1 h", "5 h", "1 d", "2 d 1 h", "21 d 16 h"])


# ---------------------------------------------------------------------------------------------------------------
# context + routing
# ---------------------------------------------------------------------------------------------------------------
class ContextTests(ServiceTestCase):
    def test_engine_context_comes_from_the_database(self):
        CivicCategory.objects.create(name="Graffiti", slug="graffiti", is_active=False)
        RiskZone.objects.create(name="Govt. High School", zone_type="school", latitude=Decimal("17.4127"),
                                longitude=Decimal("78.4483"), risk_level=4)
        RiskZone.objects.create(name="Old market", zone_type="market", latitude=Decimal("17.4"),
                                longitude=Decimal("78.4"), is_active=False)
        self.assertEqual(context.engine_config(), AIConfiguration.load().to_engine_config())
        slugs = [item["slug"] for item in context.engine_categories()]
        self.assertEqual(slugs, ["pothole", "garbage", "open_manhole", "other"])
        self.assertIn("graffiti", [item["slug"] for item in context.engine_categories(include_inactive=True)])
        self.assertEqual([zone["name"] for zone in context.engine_risk_zones()], ["Govt. High School"])

    def test_nearby_complaints_radius_window_and_filters(self):
        here = self.make_complaint(category=self.pothole, with_image=True)
        near = self.make_complaint(category=self.garbage, lat=north_of(120))
        far = self.make_complaint(category=self.pothole, lat=north_of(420))
        old = self.make_complaint(category=self.pothole, lat=north_of(30),
                                  created_at=timezone.now() - timedelta(days=40))
        rejected = self.make_complaint(category=self.pothole, lat=north_of(10), status_value=S.REJECTED)
        merged = self.make_complaint(category=self.pothole, lat=north_of(15), duplicate_of=here)

        found = context.nearby_complaints(BASE_LAT, BASE_LNG, radius_m=300, days=30)
        ids = [item["id"] for item in found]
        self.assertEqual(ids, [here.pk, rejected.pk, merged.pk, near.pk])  # nearest first, far + old excluded
        self.assertNotIn(far.pk, ids)
        self.assertNotIn(old.pk, ids)
        first = found[0]
        self.assertEqual(set(first), {"id", "complaint_number", "category", "latitude", "longitude", "status",
                                      "created_at", "text", "phash", "dhash", "image_path", "distance_m"})
        self.assertEqual((first["category"], first["phash"], first["distance_m"]), ("pothole", "8f373714acfcf4d0", 0.0))
        self.assertTrue(first["image_path"].endswith(".jpg"))
        self.assertAlmostEqual(found[-1]["distance_m"], 120, delta=1)

        filtered = context.nearby_complaints(BASE_LAT, BASE_LNG, radius_m=300, days=30, exclude_id=here.pk,
                                             exclude_statuses=[S.REJECTED], exclude_merged=True)
        self.assertEqual([item["id"] for item in filtered], [near.pk])
        only_rejected = context.nearby_complaints(BASE_LAT, BASE_LNG, radius_m=300, days=30, statuses=[S.REJECTED])
        self.assertEqual([item["id"] for item in only_rejected], [rejected.pk])
        # created_before also anchors the time window: the 40-day-old complaint is inside [ref - 30 d, ref)
        anchored = context.nearby_complaints(BASE_LAT, BASE_LNG, radius_m=300, days=30,
                                             created_before=timezone.now() - timedelta(days=20))
        self.assertEqual([item["id"] for item in anchored], [old.pk])
        self.assertIn(old.pk, [i["id"] for i in context.nearby_complaints(BASE_LAT, BASE_LNG, radius_m=300, days=None)])

    def test_analysis_text_skips_generated_titles(self):
        complaint = self.make_complaint(category=self.pothole, description="Deep pit on the road.")
        complaint.title = build_title(self.pothole, complaint.location)
        self.assertEqual(context.analysis_text(complaint), "Deep pit on the road.")
        complaint.title = "Dangerous pit!"
        self.assertEqual(context.analysis_text(complaint), "Dangerous pit. Deep pit on the road.")


class RoutingTests(ServiceTestCase):
    def test_routing_chain_primary_secondary_general(self):
        self.assertEqual(routing.route_department(self.manhole), self.roads)
        Department.objects.filter(pk=self.roads.pk).update(is_active=False)
        self.manhole.refresh_from_db()
        self.assertEqual(routing.route_department(self.manhole), self.drain)
        Department.objects.filter(pk=self.drain.pk).update(is_active=False)
        self.manhole.refresh_from_db()
        self.assertEqual(routing.route_department(self.manhole), self.general)
        self.assertEqual(routing.route_department(None), self.general)
        Department.objects.filter(pk=self.general.pk).update(is_active=False)
        self.assertIsNone(routing.route_department(None))
        self.assertIn("No active department", routing.routing_reason(self.manhole, None))


# ---------------------------------------------------------------------------------------------------------------
# lifecycle
# ---------------------------------------------------------------------------------------------------------------
class StatusTransitionTests(ServiceTestCase):
    def test_role_table(self):
        complaint = self.make_complaint(category=self.pothole, status_value=S.ASSIGNED, officer=self.officer)
        self.assertTrue(status.can_change_status(complaint, S.ACCEPTED, self.officer))
        self.assertFalse(status.can_change_status(complaint, S.ACCEPTED, self.officer2))
        self.assertFalse(status.can_change_status(complaint, S.ACCEPTED, self.citizen))
        self.assertFalse(status.can_change_status(complaint, S.ACCEPTED, None))
        self.assertTrue(status.can_change_status(complaint, S.ASSIGNED, None))  # reassignment keeps "assigned"
        self.assertTrue(status.can_change_status(complaint, S.CLOSED, self.admin))  # admins: any transition
        self.assertFalse(status.can_change_status(complaint, "flying", self.admin))
        submitted = self.make_complaint(status_value=S.SUBMITTED)
        self.assertTrue(status.can_change_status(submitted, S.ANALYZED, None))
        self.assertFalse(status.can_change_status(submitted, S.ANALYZED, self.citizen))
        self.assertIn("the system", status.transition_error(submitted, S.ANALYZED, self.citizen))

    def test_officer_lifecycle_sets_timestamps_history_and_assignment_bookkeeping(self):
        complaint = self.make_complaint(category=self.pothole, status_value=S.ASSIGNED, officer=self.officer)
        assignment = ComplaintAssignment.objects.create(complaint=complaint, officer=self.officer)
        history = status.accept_complaint(complaint, actor=self.officer, remarks="On my way")
        self.assertEqual((history.event, history.old_status, history.new_status), ("accepted", "assigned", "accepted"))
        self.assertEqual(history.changed_by, self.officer)
        assignment.refresh_from_db()
        complaint.refresh_from_db()
        self.assertIsNotNone(complaint.accepted_at)
        self.assertEqual(assignment.accepted_at.replace(microsecond=0), complaint.accepted_at.replace(microsecond=0))
        status.start_work(complaint, actor=self.officer)
        status.resolve_complaint(complaint, actor=self.officer, remarks="Pothole filled with asphalt")
        complaint.refresh_from_db()
        assignment.refresh_from_db()
        self.assertEqual(complaint.status, S.RESOLVED)
        self.assertIsNotNone(complaint.resolved_at)
        self.assertEqual((assignment.status, assignment.is_active), ("completed", False))
        self.assertEqual(self.events(complaint), ["accepted", "in_progress", "resolved"])
        self.assertEqual(self.notification_types(self.citizen, complaint),
                         ["status_changed", "status_changed", "complaint_resolved"])
        self.assertEqual(AuditLog.objects.filter(action="status_change", entity_id=str(complaint.pk)).count(), 3)
        self.mocks["verify_resolution"].assert_not_called()  # no after photo -> nothing to verify

    def test_remarks_required_and_rejection_closes_assignment(self):
        complaint = self.make_complaint(category=self.pothole, status_value=S.ASSIGNED, officer=self.officer)
        ComplaintAssignment.objects.create(complaint=complaint, officer=self.officer)
        with self.assertRaisesMessage(ServiceError, "Remarks are required when rejecting"):
            status.reject_complaint(complaint, actor=self.officer, remarks="  ")
        status.reject_complaint(complaint, actor=self.officer, remarks="Private property, not municipal")
        self.assertEqual(Complaint.objects.get(pk=complaint.pk).status, S.REJECTED)
        self.mocks["complete_active_assignment"].assert_called_once_with(complaint, status="rejected")

    def test_illegal_transition_has_a_clear_message(self):
        complaint = self.make_complaint(category=self.pothole, status_value=S.ASSIGNED, officer=self.officer)
        with self.assertRaisesMessage(TransitionNotAllowed, "cannot move from assigned to resolved"):
            status.resolve_complaint(complaint, actor=self.officer, remarks="done")
        with self.assertRaisesMessage(TransitionNotAllowed, "Only the assigned officer"):
            status.accept_complaint(complaint, actor=self.officer2)

    def test_stale_instance_is_validated_against_the_database(self):
        complaint = self.make_complaint(category=self.pothole, status_value=S.ASSIGNED, officer=self.officer)
        Complaint.objects.filter(pk=complaint.pk).update(status=S.REJECTED)
        with self.assertRaises(TransitionNotAllowed):
            status.accept_complaint(complaint, actor=self.officer)
        self.assertEqual(complaint.status, S.REJECTED)

    def test_citizen_reopen_within_window(self):
        complaint = self.make_complaint(category=self.pothole, status_value=S.VERIFIED, officer=self.officer,
                                        resolved_at=timezone.now() - timedelta(days=2),
                                        verified_at=timezone.now() - timedelta(days=1), severity_score=60)
        status.reopen_complaint(complaint, actor=self.citizen, reason="The pothole is back after the rain")
        complaint.refresh_from_db()
        self.assertEqual((complaint.status, complaint.reopen_count), (S.REOPENED, 1))
        self.assertIsNone(complaint.resolved_at)
        self.assertIsNone(complaint.verified_at)
        inputs = self.mocks["calculate_priority"].call_args.args[0]
        self.assertTrue(inputs["is_reopened"])
        self.assertEqual(complaint.latest_priority.trigger, "reopened")
        self.assertEqual(self.notification_types(self.officer, complaint), ["complaint_reopened"])
        self.assertEqual(self.notification_types(self.admin, complaint), ["complaint_reopened"])
        self.assertEqual(self.notification_types(self.citizen, complaint), [])  # the citizen did it themselves
        self.assertIn("reopened", self.events(complaint))

    def test_reopen_count_is_read_under_the_row_lock(self):
        complaint = self.make_complaint(category=self.pothole, status_value=S.RESOLVED, resolved_at=timezone.now())
        Complaint.objects.filter(pk=complaint.pk).update(reopen_count=2)  # reopened twice by other requests
        status.reopen_complaint(complaint, actor=self.citizen, reason="Still broken")
        self.assertEqual(Complaint.objects.get(pk=complaint.pk).reopen_count, 3)
        self.assertEqual(self.mocks["calculate_priority"].call_args.args[0]["reopen_count"], 3)

    def test_reopen_window_closed_for_citizen_but_not_for_admin(self):
        complaint = self.make_complaint(category=self.pothole, status_value=S.RESOLVED,
                                        resolved_at=timezone.now() - timedelta(days=20))
        with self.assertRaisesMessage(TransitionNotAllowed, "within 14 days"):
            status.reopen_complaint(complaint, actor=self.citizen, reason="still broken")
        with self.assertRaisesMessage(ServiceError, "Remarks are required when reopening"):
            status.reopen_complaint(complaint, actor=self.admin, reason="")
        status.reopen_complaint(complaint, actor=self.admin, reason="Inspection found the repair failed")
        self.assertEqual(Complaint.objects.get(pk=complaint.pk).status, S.REOPENED)
        self.assertEqual(self.notification_types(self.citizen, complaint), ["status_changed"])

    def test_verified_awards_points_and_asks_for_feedback(self):
        complaint = self.make_complaint(category=self.pothole, status_value=S.RESOLVED,
                                        resolved_at=timezone.now(), needs_manual_review=True)
        status.change_status(complaint, S.VERIFIED, actor=None, remarks="AI verified")
        complaint.refresh_from_db()
        self.assertIsNotNone(complaint.verified_at)
        self.assertFalse(complaint.needs_manual_review)
        self.assertEqual(CitizenProfile.objects.get(user=self.citizen).civic_points, 15)
        self.assertEqual(self.notification_types(self.citizen, complaint),
                         ["resolution_verified", "feedback_requested"])

    def test_close_needs_admin_and_remarks_events(self):
        complaint = self.make_complaint(category=self.pothole, status_value=S.VERIFIED, officer=self.officer)
        with self.assertRaises(TransitionNotAllowed):
            status.close_complaint(complaint, actor=self.officer)
        status.close_complaint(complaint, actor=self.admin, remarks="Confirmed on site")
        complaint.refresh_from_db()
        self.assertEqual(complaint.status, S.CLOSED)
        self.assertIsNotNone(complaint.closed_at)

    def test_add_event_and_remarks_permissions(self):
        complaint = self.make_complaint(category=self.pothole, status_value=S.ASSIGNED, officer=self.officer)
        with self.assertRaises(ValueError):
            status.add_event(complaint, "not_an_event")
        event = status.add_event(complaint, StatusHistory.Event.REMARK, remarks=" note ", metadata={"x": np.int64(1)})
        self.assertEqual((event.remarks, event.metadata, event.old_status, event.changed_by),
                         ("note", {"x": 1}, "", None))
        self.assertEqual(status.add_remark(complaint, actor=self.officer2, remarks="Colleague here").event, "remark")
        with self.assertRaises(PermissionDenied):
            status.add_remark(complaint, actor=self.waste_officer, remarks="Not my department")
        with self.assertRaises(PermissionDenied):
            status.add_remark(complaint, actor=self.citizen, remarks="Hello")
        with self.assertRaises(ServiceError):
            status.add_remark(complaint, actor=self.admin, remarks="")


class AllowedActionsTests(ServiceTestCase):
    def test_citizen_actions(self):
        complaint = self.make_complaint(category=self.pothole, status_value=S.ANALYZED)
        self.assertEqual(status.get_allowed_actions(complaint, self.citizen), ["edit", "delete"])
        self.assertEqual(status.get_allowed_actions(complaint, self.citizen2), [])
        complaint.status, complaint.accepted_at = S.ASSIGNED, timezone.now()
        self.assertEqual(status.get_allowed_actions(complaint, self.citizen), [])
        complaint.status, complaint.resolved_at = S.RESOLVED, timezone.now()
        self.assertEqual(status.get_allowed_actions(complaint, self.citizen), ["reopen", "feedback"])
        Feedback.objects.create(complaint=complaint, citizen=self.citizen, rating=4)
        self.assertEqual(status.get_allowed_actions(complaint, self.citizen), ["reopen"])
        complaint.resolved_at = timezone.now() - timedelta(days=30)
        self.assertEqual(status.get_allowed_actions(complaint, self.citizen), [])

    def test_officer_actions_follow_the_state_machine(self):
        complaint = self.make_complaint(category=self.pothole, status_value=S.ASSIGNED, officer=self.officer)
        self.assertEqual(status.get_allowed_actions(complaint, self.officer), ["accept", "reject", "add_remark"])
        complaint.status = S.ACCEPTED
        self.assertEqual(status.get_allowed_actions(complaint, self.officer),
                         ["reject", "start_work", "upload_evidence", "resolve", "add_remark"])
        complaint.status = S.RESOLVED
        self.assertEqual(status.get_allowed_actions(complaint, self.officer),
                         ["upload_evidence", "manual_verify", "request_manual_review", "add_remark"])
        ResolutionEvidence.objects.create(complaint=complaint, after_image=upload("after.jpg"))
        self.assertIn("verify", status.get_allowed_actions(complaint, self.officer))
        self.assertEqual(status.get_allowed_actions(complaint, self.officer2), ["add_remark"])  # same department
        self.assertEqual(status.get_allowed_actions(complaint, self.waste_officer), [])

    def test_admin_actions(self):
        complaint = self.make_complaint(category=self.pothole, status_value=S.ANALYZED)
        self.assertEqual(status.get_allowed_actions(complaint, self.admin),
                         ["edit", "delete", "reject", "assign", "override_ai", "reanalyze", "add_remark"])
        complaint.status, complaint.assigned_officer = S.RESOLVED, self.officer
        actions = status.get_allowed_actions(complaint, self.admin)
        self.assertTrue({"manual_verify", "close", "reopen", "upload_evidence"} <= set(actions))
        self.assertNotIn("assign", actions)
        original = self.make_complaint(category=self.pothole, created_at=timezone.now() - timedelta(days=1))
        DuplicateComplaint.objects.create(complaint=complaint, similar_complaint=original, overall_similarity=0.9)
        self.assertIn("review_duplicates", status.get_allowed_actions(complaint, self.admin))
        self.assertIn("review_duplicates", status.get_allowed_actions(original, self.admin))
        self.assertEqual(status.get_allowed_actions(complaint, None), [])


# ---------------------------------------------------------------------------------------------------------------
# priority
# ---------------------------------------------------------------------------------------------------------------
class PriorityTests(ServiceTestCase):
    def test_recalculation_gathers_facts_from_the_database(self):
        complaint = self.make_complaint(category=self.pothole, severity_score=72, duplicate_count=1)
        self.add_prediction(complaint)
        self.make_complaint(category=self.pothole, lat=north_of(100))
        self.make_complaint(category=self.pothole, lat=north_of(200))
        self.make_complaint(category=self.garbage, lat=north_of(300))
        self.make_complaint(category=self.pothole, lat=north_of(150), status_value=S.REJECTED)  # ignored
        self.make_complaint(category=self.pothole, lat=north_of(900))  # outside 500 m

        result = priority.recalculate_priority(complaint, trigger="recalculated", actor=self.admin)
        inputs = self.mocks["calculate_priority"].call_args.args[0]
        self.assertEqual(inputs, {"severity_score": 72, "public_impact": 0.8, "location_risk": 0.7, "nearby_count": 3,
                                  "frequency_count": 2, "duplicate_count": 1, "category_safety_weight": 0.75,
                                  "is_reopened": False, "reopen_count": 0, "category": "pothole"})
        self.mocks["public_impact_from_text"].assert_called_once_with({"safety_score": 0.8})
        self.assertEqual(self.mocks["calculate_priority"].call_args.kwargs["config"],
                         AIConfiguration.load().to_engine_config()["priority"])
        self.mocks["assess_location_risk"].assert_not_called()
        complaint.refresh_from_db()
        self.assertEqual((complaint.priority_score, complaint.priority_level),
                         (result.final_score, result.priority_level))
        self.assertEqual(complaint.sla_due_at, complaint.compute_sla_due())
        self.assertEqual(result.severity_component, 28.8)
        self.assertEqual(result.created_by, self.admin)
        self.assertEqual(result.factors["inputs"], inputs)
        self.assertEqual(set(result.factors["components"]), set(LABELS))
        self.assertEqual(result.factors["sources"]["location_risk"], "ai_prediction")
        self.assertEqual(self.events(complaint), ["priority_assigned"])

    def test_location_risk_is_assessed_when_no_prediction_exists(self):
        complaint = self.make_complaint(category=self.pothole, severity_score=50)
        self.add_prediction(complaint, location_risk={"score": 0.0, "assessed": False})  # engine placeholder
        priority.recalculate_priority(complaint)
        self.assertEqual(self.mocks["calculate_priority"].call_args.args[0]["location_risk"], 0.55)
        self.assertEqual(complaint.latest_priority.factors["sources"]["location_risk"], "assessed")
        self.assertEqual(self.mocks["assess_location_risk"].call_args.kwargs["address"],
                         "Road No. 12, Banjara Hills, Govt. High School, Banjara Hills, Hyderabad")

    def critical_prediction(self, complaint):
        """Facts that score 40 + 25 + 15 = 80/100 with the default weights -> critical."""
        self.add_prediction(complaint, location_risk={"score": 1.0}, raw_output={"public_impact": 1.0})

    def test_becoming_critical_alerts_admins_and_officer_once(self):
        complaint = self.make_complaint(category=self.pothole, severity_score=100, officer=self.officer,
                                        status_value=S.ASSIGNED)
        self.critical_prediction(complaint)
        first = priority.recalculate_priority(complaint)
        self.assertEqual(first.priority_level, "critical")
        priority.recalculate_priority(complaint)
        complaint.priority_level = "high"  # pretend it dropped, then rose again
        priority.recalculate_priority(complaint)
        self.assertEqual(self.notification_types(self.admin, complaint), ["critical_complaint"])
        self.assertEqual(self.notification_types(self.officer, complaint), ["critical_complaint"])

    def test_no_alert_when_notify_disabled_or_complaint_closed(self):
        complaint = self.make_complaint(category=self.pothole, severity_score=100, status_value=S.CLOSED)
        self.critical_prediction(complaint)
        self.assertEqual(priority.recalculate_priority(complaint).priority_level, "critical")
        open_one = self.make_complaint(category=self.pothole, severity_score=100)
        self.critical_prediction(open_one)
        self.assertEqual(priority.recalculate_priority(open_one, notify=False).priority_level, "critical")
        self.assertEqual(Notification.objects.filter(notification_type="critical_complaint").count(), 0)

    def test_timeline_records_only_significant_changes(self):
        complaint = self.make_complaint(category=self.pothole, severity_score=72)
        self.add_prediction(complaint)
        priority.recalculate_priority(complaint)
        priority.recalculate_priority(complaint, trigger="recalculated")  # same facts -> no new event
        complaint.severity_score = 20
        priority.recalculate_priority(complaint, trigger="config_change")
        self.assertEqual(self.events(complaint), ["priority_assigned", "priority_updated"])
        self.assertIn("a change of the AI settings", complaint.status_history.last().remarks)
        self.assertEqual(complaint.priority_scores.count(), 3)

    def test_manual_override_is_sticky_until_explicitly_replaced(self):
        complaint = self.make_complaint(category=self.pothole, severity_score=40)
        overrides.override_ai(complaint, actor=self.admin, priority_score=90, reason="VIP road")
        with self.assertLogs("apps.complaints", level="INFO") as logs:
            kept = priority.recalculate_priority(complaint, trigger="duplicate_update")
        self.assertIn("manual override", logs.output[0])
        self.assertTrue(kept.is_override)
        self.assertEqual(Complaint.objects.get(pk=complaint.pk).priority_score, 90)
        fresh = priority.recalculate_priority(complaint, trigger="recalculated", keep_override=False)
        self.assertFalse(fresh.is_override)
        self.assertNotEqual(fresh.final_score, 90)


# ---------------------------------------------------------------------------------------------------------------
# duplicates
# ---------------------------------------------------------------------------------------------------------------
class DuplicateTests(ServiceTestCase):
    def setUp(self):
        super().setUp()
        two_days_ago = timezone.now() - timedelta(days=2)
        self.original = self.make_complaint(category=self.pothole, citizen=self.citizen2, created_at=two_days_ago,
                                            with_image=True)
        self.make_complaint(category=self.pothole, lat=north_of(5), status_value=S.REJECTED, created_at=two_days_ago)
        self.make_complaint(category=self.pothole, lat=north_of(8), created_at=two_days_ago, duplicate_of=self.original)
        self.make_complaint(category=self.pothole, lat=north_of(1000), created_at=two_days_ago)
        self.newer = self.make_complaint(category=self.pothole, lat=north_of(40), with_image=True)
        self.make_complaint(category=self.pothole, lat=north_of(20), created_at=timezone.now() + timedelta(minutes=5))

    def test_detection_links_counts_events_and_notifications(self):
        links = duplicates.detect_duplicates(self.newer)
        self.assertEqual(len(links), 1)
        link = links[0]
        self.assertEqual((link.complaint, link.similar_complaint, link.status),
                         (self.newer, self.original, DuplicateComplaint.Status.PENDING_REVIEW))
        self.assertEqual((link.overall_similarity, link.image_similarity, link.category_match), (0.88, 0.91, True))
        self.assertAlmostEqual(link.distance_m, 40, delta=1)
        target, candidates = self.mocks["find_duplicates"].call_args.args
        self.assertEqual(target["id"], self.newer.pk)
        self.assertEqual([c["id"] for c in candidates], [self.original.pk])  # rejected/merged/far/later excluded
        self.newer.refresh_from_db()
        self.original.refresh_from_db()
        self.assertEqual((self.newer.duplicate_count, self.original.duplicate_count), (1, 1))
        self.assertIn("duplicate_flagged", self.events(self.newer))
        self.assertIn("duplicate_flagged", self.events(self.original))
        notification = Notification.objects.get(user=self.citizen, notification_type="duplicate_detected")
        self.assertIn(self.original.complaint_number, notification.message)
        self.assertEqual(self.original.latest_priority.trigger, "duplicate_update")

    def test_rerun_is_idempotent_and_reviewed_pairs_are_left_alone(self):
        duplicates.detect_duplicates(self.newer)
        links = duplicates.detect_duplicates(self.newer)
        self.assertEqual(len(links), 1)
        self.assertEqual(DuplicateComplaint.objects.count(), 1)
        self.assertEqual(Notification.objects.filter(notification_type="duplicate_detected").count(), 1)
        self.assertEqual(Complaint.objects.get(pk=self.original.pk).duplicate_count, 1)
        DuplicateComplaint.objects.update(status=DuplicateComplaint.Status.NOT_DUPLICATE)
        self.assertEqual(duplicates.detect_duplicates(self.newer), [])
        self.assertEqual(DuplicateComplaint.objects.get().status, DuplicateComplaint.Status.NOT_DUPLICATE)

    def test_confirmed_duplicate_is_merged_and_closed(self):
        self.newer.status = S.ACCEPTED
        self.newer.save(update_fields=["status"])
        self.assign(self.newer, accepted=True)
        link = duplicates.detect_duplicates(self.newer)[0]
        reviewed = duplicates.review_duplicate(link, status="confirmed_duplicate", actor=self.officer, notes="Same pit")
        self.assertEqual((reviewed.status, reviewed.reviewed_by, reviewed.review_notes),
                         ("confirmed_duplicate", self.officer, "Same pit"))
        self.newer.refresh_from_db()
        self.assertEqual((self.newer.status, self.newer.duplicate_of), (S.CLOSED, self.original))
        closing = self.newer.status_history.get(event="closed")
        self.assertEqual(closing.remarks, f"Merged into {self.original.complaint_number}")
        self.mocks["complete_active_assignment"].assert_any_call(self.newer, status="cancelled")
        self.assertIn("duplicate_confirmed", self.events(self.original))
        self.assertEqual(Complaint.objects.get(pk=self.original.pk).duplicate_count, 1)
        self.assertEqual(self.notification_types(self.citizen, self.newer)[-1], "duplicate_detected")
        self.assertTrue(AuditLog.objects.filter(action="duplicate_review", actor=self.officer).exists())
        self.assertEqual(Complaint.objects.count(), 6)  # nothing deleted
        with self.assertRaisesMessage(ServiceError, "already reviewed"):
            duplicates.review_duplicate(link, status="not_duplicate", actor=self.admin)

    def test_not_duplicate_decrements_counts_and_recalculates(self):
        link = duplicates.detect_duplicates(self.newer)[0]
        before = PriorityScore.objects.filter(complaint=self.newer).count()
        duplicates.review_duplicate(link, status="not_duplicate", actor=self.admin)
        link.refresh_from_db()
        self.assertEqual(link.status, "not_duplicate")
        self.assertEqual(Complaint.objects.get(pk=self.newer.pk).duplicate_count, 0)
        self.assertEqual(Complaint.objects.get(pk=self.original.pk).duplicate_count, 0)
        self.assertEqual(PriorityScore.objects.filter(complaint=self.newer).count(), before + 1)
        self.assertTrue(self.newer.status_history.filter(event="remark", remarks__contains="not a duplicate").exists())

    def test_review_permissions_and_decision_validation(self):
        link = duplicates.detect_duplicates(self.newer)[0]
        with self.assertRaises(PermissionDenied):
            duplicates.review_duplicate(link, status="confirmed_duplicate", actor=self.citizen)
        with self.assertRaises(ServiceError):
            duplicates.review_duplicate(link, status="maybe", actor=self.admin)

    def test_preview_scores_without_writing(self):
        counts = (DuplicateComplaint.objects.count(), StatusHistory.objects.count(), Notification.objects.count())
        photo = image_bytes()
        matches = duplicates.preview_duplicates(text="Big pothole outside the school", latitude=north_of(30),
                                                longitude=BASE_LNG, image_data=photo, filename="p.jpg",
                                                category_slug="pothole")
        match = next(m for m in matches if m["complaint"] == self.original)
        self.assertEqual((match["is_duplicate"], match["image_similarity"]), (True, 0.91))
        target = self.mocks["find_duplicates"].call_args.args[0]
        self.assertEqual((target["id"], target["phash"], target["image"]), (None, "8f373714acfcf4d0", photo))
        self.assertEqual(counts, (DuplicateComplaint.objects.count(), StatusHistory.objects.count(),
                                  Notification.objects.count()))


# ---------------------------------------------------------------------------------------------------------------
# submission
# ---------------------------------------------------------------------------------------------------------------
class SubmissionTests(ServiceTestCase):
    def submit(self, *, image=True, **data):
        payload = {"description": "Large pothole near the school entrance causing traffic problems.",
                   "latitude": Decimal("17.412600"), "longitude": Decimal("78.448200"),
                   "address": "Road No. 12, Banjara Hills", "landmark": "Govt. High School", "area": "Banjara Hills",
                   "city": "Hyderabad", "pincode": "500034"}
        payload.update(data)
        return submission.submit_complaint(citizen=self.citizen, data=payload, image=upload() if image else None)

    def test_full_submission_flow(self):
        complaint, analysis = self.submit()
        steps = analysis["steps"]
        self.assertEqual([step["key"] for step in steps], EXPECTED_SUBMISSION_STEPS)
        self.assertEqual({step["status"] for step in steps}, {"done", "skipped"})
        by_key = {step["key"]: step for step in steps}
        self.assertEqual(by_key["officer_assignment"]["status"], "skipped")  # auto-assign is off in the fixtures
        self.assertEqual(by_key["severity"]["duration_ms"], 3)  # severity (1) + location risk (2)
        self.assertIn("Location risk: near a school", by_key["severity"]["detail"])
        self.assertIn("Roads Department", by_key["department_routing"]["detail"])

        complaint.refresh_from_db()
        self.assertEqual(complaint.status, S.ANALYZED)
        self.assertEqual(complaint.title, "Roads / Potholes near Govt. High School, Banjara Hills")
        self.assertEqual((complaint.category, complaint.department), (self.pothole, self.roads))
        self.assertEqual((complaint.severity, complaint.severity_score), ("high", 72))
        self.assertEqual(complaint.sla_due_at, complaint.compute_sla_due())
        self.assertEqual(complaint.priority_score, 63)
        self.assertEqual(complaint.priority_level, "high")
        self.assertEqual(self.events(complaint),
                         ["submitted", "ai_analyzed", "priority_assigned", "department_assigned"])
        self.assertEqual(list(complaint.priority_scores.values_list("trigger", flat=True)), ["initial"])

        photo = complaint.images.get()
        self.assertEqual((photo.phash, photo.dhash, photo.width, photo.height),
                         ("8f373714acfcf4d0", "0f1e2d3c4b5a6978", 64, 48))
        self.assertGreater(photo.file_size, 0)

        prediction = AIPrediction.objects.get(complaint=complaint)
        self.assertEqual((prediction.image_category, prediction.text_category, prediction.final_category_slug),
                         ("pothole", "pothole", "pothole"))
        self.assertEqual((prediction.image_confidence, prediction.multimodal_confidence), (0.88, 0.93))
        self.assertEqual(prediction.bounding_boxes, [[0.2, 0.3, 0.6, 0.7]])
        self.assertEqual(set(prediction.probabilities), {"image", "text", "fused"})
        self.assertEqual(prediction.model_version, "vision=demo-opencv-heuristic-1.0; text=demo-tfidf-logreg-1.0")
        self.assertEqual((prediction.model_mode, prediction.is_demo, prediction.processing_time_ms), ("demo", True, 60))
        self.assertIn("Demo AI Mode", prediction.explanation)
        self.assertEqual(prediction.location_risk["score"], 0.8)
        self.assertIs(type(prediction.detected_objects[0]["confidence"]), float)
        json.dumps(prediction.raw_output, allow_nan=False)
        self.assertEqual(prediction.raw_output["vision"]["quality"]["is_blurry"], False)

        run_kwargs = self.mocks["run_analysis"].call_args.kwargs
        self.assertEqual(run_kwargs["text"], "Large pothole near the school entrance causing traffic problems.")
        self.assertEqual(run_kwargs["filename"].split("_")[0], "pothole")
        self.assertEqual(run_kwargs["config"], AIConfiguration.load().to_engine_config())
        self.assertEqual([c["slug"] for c in run_kwargs["categories"]], ["pothole", "garbage", "open_manhole", "other"])

        self.assertEqual(self.notification_types(self.citizen, complaint),
                         ["complaint_submitted", "ai_analysis_completed", "department_assigned"])
        self.assertEqual(self.notification_types(self.admin, complaint), [])  # not critical
        self.assertEqual(CitizenProfile.objects.get(user=self.citizen).civic_points, 10)
        self.assertTrue(AuditLog.objects.filter(action="create", actor=self.citizen,
                                                entity_id=str(complaint.pk)).exists())

        summary = analysis["summary"]
        self.assertEqual(summary["category"], {"id": self.pothole.pk, "name": "Roads / Potholes", "slug": "pothole",
                                               "icon": "construction", "color": "#D9480F"})
        self.assertEqual(summary["department"]["code"], "ROADS")
        self.assertEqual((summary["priority_score"], summary["priority_level"], summary["severity"]),
                         (63, "high", "high"))
        self.assertEqual((summary["officer"], summary["duplicates_found"], summary["needs_review"]), (None, 0, False))
        self.assertEqual((summary["is_demo"], summary["mode"], summary["confidence"]), (True, "demo", 0.93))
        self.assertIn("Large road damage", summary["explanation"])
        json.dumps(analysis, allow_nan=False)

    def test_submission_without_photo_keeps_the_citizen_title(self):
        complaint, analysis = self.submit(image=False, title="Huge crater", category=self.garbage)
        by_key = {step["key"]: step for step in analysis["steps"]}
        self.assertEqual((by_key["upload"]["status"], by_key["image_analysis"]["status"]), ("skipped", "skipped"))
        complaint.refresh_from_db()
        self.assertEqual(complaint.title, "Huge crater")
        self.assertEqual(complaint.reported_category, self.garbage)
        kwargs = self.mocks["run_analysis"].call_args.kwargs
        self.assertEqual((kwargs["image"], kwargs["reported_category"]), (None, "garbage"))
        self.assertTrue(kwargs["text"].startswith("Huge crater. Large pothole"))
        self.assertEqual(complaint.images.count(), 0)
        self.assertEqual(AIPrediction.objects.get(complaint=complaint).model_version,
                         "vision=none; text=demo-tfidf-logreg-1.0")

    def test_unknown_ai_category_falls_back_to_other(self):
        self.scenario["category"] = "graffiti"
        complaint, analysis = self.submit()
        complaint.refresh_from_db()
        self.assertEqual((complaint.category, complaint.department), (self.other, self.general))
        self.assertEqual(AIPrediction.objects.get(complaint=complaint).final_category_slug, "other")

    def test_low_confidence_flags_review(self):
        self.scenario.update(needs_review=True, confidence=0.25)
        complaint, analysis = self.submit()
        self.assertTrue(Complaint.objects.get(pk=complaint.pk).needs_manual_review)
        self.assertTrue(analysis["summary"]["needs_review"])

    def test_critical_complaint_alerts_admins(self):
        self.scenario.update(severity="critical", severity_score=100, location_risk=1.0)
        complaint, analysis = self.submit()
        self.assertEqual(analysis["summary"]["priority_level"], "critical")
        self.assertEqual(self.notification_types(self.admin, complaint), ["critical_complaint"])

    def test_duplicates_raise_priority_of_both_complaints(self):
        original = self.make_complaint(category=self.pothole, citizen=self.citizen2, lat=north_of(25),
                                       created_at=timezone.now() - timedelta(days=1))
        complaint, analysis = self.submit()
        self.assertEqual(analysis["summary"]["duplicates_found"], 1)
        self.assertEqual(list(complaint.priority_scores.order_by("id").values_list("trigger", flat=True)),
                         ["initial", "duplicate_update"])
        self.assertEqual(original.priority_scores.get().trigger, "duplicate_update")
        self.assertIn("duplicate_flagged", self.events(complaint))
        by_key = {step["key"]: step for step in analysis["steps"]}
        self.assertIn(original.complaint_number, by_key["duplicate_detection"]["detail"])

    def test_duplicates_are_scored_before_the_write_transaction(self):
        self.make_complaint(category=self.pothole, lat=north_of(25), created_at=timezone.now() - timedelta(days=1))
        seen = []

        def scoring(target, candidates, *, config=None):
            seen.append(AIPrediction.objects.filter(complaint_id=target["id"]).exists())
            return fake_find_duplicates(target, candidates, config=config)

        self.mocks["find_duplicates"].side_effect = scoring
        complaint, analysis = self.submit()
        self.assertEqual(seen, [False])  # scored while nothing of the AI result was written yet
        self.assertEqual(analysis["summary"]["duplicates_found"], 1)

    def test_duplicate_engine_failure_is_isolated(self):
        self.make_complaint(category=self.pothole, lat=north_of(25), created_at=timezone.now() - timedelta(days=1))
        self.mocks["find_duplicates"].side_effect = NotImplementedError("text embedder pending")
        with self.assertLogs("apps.complaints", level="WARNING"):
            complaint, analysis = self.submit()
        by_key = {step["key"]: step for step in analysis["steps"]}
        self.assertEqual(by_key["duplicate_detection"]["status"], "failed")
        self.assertIn("text embedder pending", by_key["duplicate_detection"]["detail"])
        self.assertEqual((by_key["department_routing"]["status"], by_key["database_save"]["status"]), ("done", "done"))
        self.assertEqual(DuplicateComplaint.objects.count(), 0)
        self.assertEqual(Complaint.objects.get(pk=complaint.pk).status, S.ANALYZED)

    def test_auto_assignment(self):
        self.configure(auto_assign_officer=True)
        complaint, analysis = self.submit()
        complaint.refresh_from_db()
        self.assertEqual((complaint.status, complaint.assigned_officer), (S.ASSIGNED, self.officer))
        by_key = {step["key"]: step for step in analysis["steps"]}
        self.assertEqual(by_key["officer_assignment"]["detail"], "Assigned to Ravi Kumar (recommendation score 0.83).")
        self.assertEqual(analysis["summary"]["officer"]["full_name"], "Ravi Kumar")
        self.assertEqual(self.events(complaint).count("officer_assigned"), 1)
        # The pipeline asks for the assignment without the citizen notice and sends it after the earlier notices,
        # so the citizen's feed follows the lifecycle (submitted -> analysed -> department -> officer).
        self.mocks["auto_assign"].assert_called_once_with(complaint, notify_citizen=False)
        self.assertEqual(self.notification_types(self.citizen, complaint),
                         ["complaint_submitted", "ai_analysis_completed", "department_assigned", "officer_assigned"])
        officer_notice = Notification.objects.get(user=self.citizen, notification_type="officer_assigned")
        self.assertEqual(officer_notice.title, "Officer assigned to your complaint")
        self.assertIn(f"Ravi Kumar (Roads Department) will handle {complaint.complaint_number}", officer_notice.message)

    def test_auto_assignment_failure_does_not_break_submission(self):
        self.configure(auto_assign_officer=True)
        self.mocks["auto_assign"].side_effect = RuntimeError("recommender offline")
        with self.assertLogs("apps.complaints", level="ERROR"):
            complaint, analysis = self.submit()
        by_key = {step["key"]: step for step in analysis["steps"]}
        self.assertEqual(by_key["officer_assignment"]["status"], "failed")
        self.assertIn("recommender offline", by_key["officer_assignment"]["detail"])
        self.assertEqual(by_key["database_save"]["status"], "done")
        self.assertEqual(Complaint.objects.get(pk=complaint.pk).status, S.ANALYZED)

    def test_ai_failure_keeps_complaint_submitted_and_alerts_admins(self):
        self.mocks["run_analysis"].side_effect = RuntimeError("model crashed")
        with self.assertLogs("apps.complaints", level="ERROR") as logs:
            complaint, analysis = self.submit()
        self.assertIn("model crashed", "\n".join(logs.output))
        complaint.refresh_from_db()
        self.assertEqual((complaint.status, complaint.needs_manual_review), (S.SUBMITTED, True))
        statuses = {step["key"]: step["status"] for step in analysis["steps"]}
        self.assertEqual([step["key"] for step in analysis["steps"]], EXPECTED_SUBMISSION_STEPS)
        self.assertTrue(all(statuses[key] == "failed" for key in pipeline.AI_STEP_KEYS))
        self.assertTrue(all(statuses[key] == "skipped" for key in pipeline.POST_AI_STEP_KEYS))
        self.assertEqual((statuses["database_save"], statuses["notification"]), ("done", "done"))
        self.assertIn("model crashed", analysis["steps"][3]["detail"])
        self.assertEqual(self.notification_types(self.admin, complaint), ["system"])
        self.assertEqual(self.notification_types(self.citizen, complaint), ["complaint_submitted"])
        summary = analysis["summary"]
        self.assertEqual((summary["category"], summary["needs_review"], summary["confidence"]), (None, True, None))
        self.assertIn("could not be completed", summary["explanation"])
        self.assertEqual(AIPrediction.objects.filter(complaint=complaint).count(), 0)
        self.assertEqual(CitizenProfile.objects.get(user=self.citizen).civic_points, 10)

    def test_engine_step_report_is_kept_when_the_analysis_fails(self):
        class EngineError(Exception):
            """Like ai.pipeline.AnalysisError: carries the steps completed before the failure."""

            def __init__(self, message, steps):
                super().__init__(message)
                self.steps = steps

        self.mocks["run_analysis"].side_effect = EngineError("no modality could be analysed", [
            {"key": "preprocess", "label": "Data preprocessing", "status": "done", "duration_ms": 2, "detail": "ok"},
            {"key": "image_analysis", "label": "Image AI analysis", "status": "skipped", "duration_ms": 0,
             "detail": "No photo attached."},
            {"key": "text_analysis", "label": "Text NLP analysis", "status": "failed", "duration_ms": 5,
             "detail": "Text analysis failed (NotImplementedError)."},
        ])
        with self.assertLogs("apps.complaints", level="ERROR"):
            complaint, analysis = self.submit(image=False)
        statuses = [(step["key"], step["status"]) for step in analysis["steps"]][3:8]
        self.assertEqual(statuses, [("preprocess", "done"), ("image_analysis", "skipped"), ("text_analysis", "failed"),
                                    ("multimodal_fusion", "skipped"), ("severity", "skipped")])
        self.assertIn("stopped at an earlier step", analysis["steps"][6]["detail"])
        self.assertEqual(Complaint.objects.get(pk=complaint.pk).status, S.SUBMITTED)

    def test_priority_engine_failure_is_isolated(self):
        self.mocks["calculate_priority"].side_effect = NotImplementedError("priority engine pending")
        with self.assertLogs("apps.complaints", level="WARNING"):
            complaint, analysis = self.submit()
        statuses = {step["key"]: step["status"] for step in analysis["steps"]}
        self.assertEqual(statuses["priority"], "failed")
        self.assertEqual((statuses["department_routing"], statuses["database_save"]), ("done", "done"))
        complaint.refresh_from_db()
        self.assertEqual((complaint.status, complaint.department, complaint.priority_score),
                         (S.ANALYZED, self.roads, 0))

    def test_invalid_input_is_rejected_before_anything_is_saved(self):
        with self.assertRaises(ValidationError) as caught:
            self.submit(description="short", latitude=Decimal("123"))
        self.assertEqual(set(caught.exception.detail), {"description", "latitude"})
        with self.assertRaises(ValidationError):
            self.submit(incident_at=timezone.now() + timedelta(days=1))
        bad_image = SimpleUploadedFile("note.txt", b"not an image", content_type="text/plain")
        with self.assertRaises(ValidationError):
            submission.submit_complaint(citizen=self.citizen, image=bad_image, data={
                "description": "Large pothole near the school.", "latitude": 17.4, "longitude": 78.4})
        self.assertEqual(Complaint.objects.count(), 0)


# ---------------------------------------------------------------------------------------------------------------
# verification
# ---------------------------------------------------------------------------------------------------------------
class VerificationTests(ServiceTestCase):
    def setUp(self):
        super().setUp()
        self.complaint = self.make_complaint(category=self.pothole, status_value=S.IN_PROGRESS, officer=self.officer,
                                             with_image=True)
        ComplaintAssignment.objects.create(complaint=self.complaint, officer=self.officer, accepted_at=timezone.now())
        self.add_prediction(self.complaint)

    def test_upload_evidence_fills_the_current_row_then_starts_a_new_one(self):
        first = verification.upload_evidence(self.complaint, actor=self.officer, before_image=upload("before.jpg"))
        second = verification.upload_evidence(self.complaint, actor=self.officer, after_image=upload("after.jpg"),
                                              remarks="Filled")
        self.assertEqual(first.pk, second.pk)
        self.assertTrue(second.before_image and second.after_image)
        third = verification.upload_evidence(self.complaint, actor=self.officer, after_image=upload("after2.jpg"))
        self.assertNotEqual(third.pk, first.pk)
        self.assertEqual(self.events(self.complaint).count("evidence_uploaded"), 3)
        with self.assertRaises(PermissionDenied):
            verification.upload_evidence(self.complaint, actor=self.officer2, after_image=upload())
        with self.assertRaises(ServiceError):
            verification.upload_evidence(self.complaint, actor=self.officer)
        analyzed = self.make_complaint(category=self.pothole, officer=self.officer)
        with self.assertRaises(ServiceError):
            verification.upload_evidence(analyzed, actor=self.officer, after_image=upload())

    def test_resolution_with_after_photo_is_verified_automatically(self):
        status.resolve_complaint(self.complaint, actor=self.officer, remarks="Filled and compacted",
                                 after_image=upload("after.jpg"))
        self.complaint.refresh_from_db()
        self.assertEqual(self.complaint.status, S.VERIFIED)
        result = ResolutionVerification.objects.get(complaint=self.complaint)
        self.assertEqual((result.status, result.score, result.method, result.is_demo),
                         ("likely_resolved", 91, "ai_assisted", True))
        self.assertIn("not a guarantee", result.explanation)
        self.assertIsNone(result.verified_by)
        self.assertEqual(result.metrics["issue_still_detected"], False)
        before, after = self.mocks["verify_resolution"].call_args.args
        self.assertEqual(before, self.complaint.primary_image.image.path)  # fallback: the citizen's photo
        self.assertTrue(after.endswith(".jpg"))
        self.assertEqual(self.mocks["verify_resolution"].call_args.kwargs["boxes"], [[0.2, 0.3, 0.6, 0.7]])
        self.assertEqual(self.events(self.complaint), ["evidence_uploaded", "resolved", "verification_run", "verified"])
        self.assertEqual(self.notification_types(self.citizen, self.complaint),
                         ["complaint_resolved", "resolution_verified", "feedback_requested"])
        self.assertEqual(CitizenProfile.objects.get(user=self.citizen).civic_points, 15)

    def test_admin_can_resolve_directly_with_an_after_photo(self):
        assigned = self.make_complaint(category=self.pothole, status_value=S.ASSIGNED, officer=self.officer,
                                       with_image=True)
        status.resolve_complaint(assigned, actor=self.admin, remarks="Fixed by the contractor",
                                 after_image=upload("after.jpg"))
        assigned.refresh_from_db()
        self.assertEqual(assigned.status, S.VERIFIED)
        self.assertIsNone(self.mocks["verify_resolution"].call_args.kwargs["boxes"])  # no AI prediction stored
        closed = self.make_complaint(category=self.pothole, status_value=S.CLOSED)
        with self.assertRaisesMessage(ServiceError, "reopen it first"):
            verification.upload_evidence(closed, actor=self.admin, after_image=upload())

    def test_not_resolved_flags_manual_review(self):
        self.scenario["verification_status"] = "not_resolved"
        status.resolve_complaint(self.complaint, actor=self.officer, remarks="Done", after_image=upload("after.jpg"))
        self.complaint.refresh_from_db()
        self.assertEqual((self.complaint.status, self.complaint.needs_manual_review), (S.RESOLVED, True))
        self.assertEqual(self.notification_types(self.officer, self.complaint), ["manual_review_requested"])
        self.assertEqual(self.notification_types(self.admin, self.complaint), ["manual_review_requested"])
        self.assertIn("verify", status.get_allowed_actions(self.complaint, self.officer))

    def test_needs_manual_review_alerts_admins_only(self):
        self.scenario["verification_status"] = "needs_manual_review"
        status.resolve_complaint(self.complaint, actor=self.officer, remarks="Done", after_image=upload("after.jpg"))
        self.assertEqual(self.notification_types(self.officer, self.complaint), [])
        self.assertEqual(self.notification_types(self.admin, self.complaint), ["manual_review_requested"])

    def test_auto_verification_can_be_disabled(self):
        self.configure(auto_verify_resolution=False)
        status.resolve_complaint(self.complaint, actor=self.officer, remarks="Done", after_image=upload("after.jpg"))
        self.mocks["verify_resolution"].assert_not_called()
        result = verification.run_ai_verification(self.complaint, actor=self.officer)
        self.assertEqual(result.verified_by, self.officer)
        self.assertEqual(Complaint.objects.get(pk=self.complaint.pk).status, S.RESOLVED)  # auto-verify off

    def test_verification_errors_are_clear_and_never_undo_the_resolution(self):
        with self.assertRaisesMessage(ServiceError, "Upload an after photo"):
            verification.run_ai_verification(self.complaint, actor=self.officer)
        self.mocks["verify_resolution"].side_effect = RuntimeError("cv2 failure")
        with self.assertLogs("apps.complaints", level="ERROR"):
            status.resolve_complaint(self.complaint, actor=self.officer, remarks="Done",
                                     after_image=upload("after.jpg"))
        self.complaint.refresh_from_db()
        self.assertEqual((self.complaint.status, self.complaint.needs_manual_review), (S.RESOLVED, True))
        self.assertEqual(ResolutionVerification.objects.count(), 0)
        self.assertEqual(self.notification_types(self.admin, self.complaint), ["manual_review_requested"])
        self.assertIn("could not run", self.complaint.status_history.get(event="remark").remarks)
        with self.assertLogs("apps.complaints", level="ERROR"), self.assertRaisesMessage(ServiceError, "cv2 failure"):
            verification.run_ai_verification(self.complaint, actor=self.admin)

    def test_manual_verification_decisions(self):
        self.configure(auto_verify_resolution=False)
        status.resolve_complaint(self.complaint, actor=self.officer, remarks="Done", after_image=upload("after.jpg"))
        with self.assertRaises(ServiceError):
            verification.manual_verification(self.complaint, actor=self.officer, status="likely_resolved")
        rejected = verification.manual_verification(self.complaint, actor=self.admin, status="not_resolved",
                                                    explanation="Edges still broken on site")
        self.assertEqual((rejected.method, rejected.is_manual_override, rejected.score, rejected.verified_by),
                         ("manual", True, 22, self.admin))
        self.complaint.refresh_from_db()
        self.assertEqual(self.complaint.status, S.IN_PROGRESS)
        sent_back = self.complaint.status_history.get(event="in_progress", old_status="resolved")
        self.assertIn("Edges still broken", sent_back.remarks)
        self.assertEqual(self.notification_types(self.officer, self.complaint)[-1], "status_changed")

        status.resolve_complaint(self.complaint, actor=self.officer, remarks="Fixed properly",
                                 after_image=upload("after2.jpg"))
        accepted = verification.manual_verification(self.complaint, actor=self.officer, status="likely_resolved",
                                                    score=150, explanation="Checked in person")
        self.assertEqual(accepted.score, 100)
        self.assertEqual(Complaint.objects.get(pk=self.complaint.pk).status, S.VERIFIED)
        with self.assertRaises(ServiceError):  # officers decide on resolved complaints only
            verification.manual_verification(self.complaint, actor=self.officer, status="not_resolved",
                                             explanation="changed my mind")

    def test_default_manual_scores_stay_inside_their_bands(self):
        V = ResolutionVerification.Status
        for partial, resolved in [(45, 70), (45, 46), (69, 70), (1, 2), (1, 100), (99, 100)]:
            config = {"partial_threshold": partial, "resolved_threshold": resolved}
            with self.subTest(partial=partial, resolved=resolved):
                self.assertGreaterEqual(verification.default_manual_score(V.LIKELY_RESOLVED, config), resolved)
                self.assertTrue(partial <= verification.default_manual_score(V.PARTIALLY_RESOLVED, config) < resolved)
                self.assertLess(verification.default_manual_score(V.NOT_RESOLVED, config), partial)
        defaults = {"partial_threshold": 45, "resolved_threshold": 70}
        self.assertEqual([verification.default_manual_score(s, defaults) for s in V.values],
                         [{V.LIKELY_RESOLVED: 85, V.PARTIALLY_RESOLVED: 58, V.NOT_RESOLVED: 22,
                           V.NEEDS_MANUAL_REVIEW: 0}[s] for s in V.values])

    def test_request_manual_review(self):
        self.configure(auto_verify_resolution=False)
        with self.assertRaises(ServiceError):
            verification.request_manual_review(self.complaint, actor=self.officer)
        status.resolve_complaint(self.complaint, actor=self.officer, remarks="Done", after_image=upload("after.jpg"))
        self.assertIsNone(verification.request_manual_review(self.complaint, actor=self.officer))
        ai_result = verification.run_ai_verification(self.complaint, actor=self.officer)
        flagged = verification.request_manual_review(self.complaint, actor=self.officer, remarks="Lighting was poor")
        self.assertEqual(flagged.pk, ai_result.pk)
        self.assertTrue(flagged.manual_review_requested)
        self.assertTrue(Complaint.objects.get(pk=self.complaint.pk).needs_manual_review)
        self.assertEqual(self.events(self.complaint).count("manual_review_requested"), 2)
        self.assertEqual(self.notification_types(self.admin, self.complaint),
                         ["manual_review_requested", "manual_review_requested"])


# ---------------------------------------------------------------------------------------------------------------
# overrides
# ---------------------------------------------------------------------------------------------------------------
class OverrideTests(ServiceTestCase):
    def setUp(self):
        super().setUp()
        self.complaint = self.make_complaint(category=self.pothole, severity="medium", severity_score=30)
        self.complaint.title = build_title(self.pothole, self.complaint.location)
        self.complaint.save(update_fields=["title"])
        self.add_prediction(self.complaint)

    def test_category_override_reroutes_and_is_audited(self):
        overrides.override_ai(self.complaint, actor=self.admin, category="garbage", reason="It is a garbage dump")
        self.complaint.refresh_from_db()
        self.assertEqual((self.complaint.category, self.complaint.department), (self.garbage, self.waste))
        self.assertTrue(self.complaint.is_ai_overridden)
        self.assertEqual(self.complaint.title, "Garbage / Waste near Govt. High School, Banjara Hills")
        self.assertEqual(self.complaint.sla_due_at, self.complaint.compute_sla_due())
        event = self.complaint.status_history.get(event="ai_overridden")
        self.assertEqual(event.metadata["changes"]["category"], ["pothole", "garbage"])
        self.assertEqual(event.metadata["changes"]["department"], ["ROADS", "WASTE"])
        audit = AuditLog.objects.get(action="ai_override")
        self.assertEqual((audit.actor, audit.changes["reason"]), (self.admin, "It is a garbage dump"))
        self.assertEqual(self.complaint.latest_priority.trigger, "ai_override")
        self.assertEqual(self.notification_types(self.citizen, self.complaint), ["department_assigned"])
        self.assertEqual(AIPrediction.objects.get(complaint=self.complaint).final_category, self.pothole)  # AI kept

    def test_severity_override_uses_a_representative_score(self):
        overrides.override_ai(self.complaint, actor=self.admin, severity="high", reason="Bus route")
        self.assertEqual(Complaint.objects.get(pk=self.complaint.pk).severity_score, 63)  # middle of 51-75
        overrides.override_ai(self.complaint, actor=self.admin, severity="high", severity_score=70, reason="exact")
        self.assertEqual(Complaint.objects.get(pk=self.complaint.pk).severity_score, 70)
        overrides.override_ai(self.complaint, actor=self.admin, severity_score=90, reason="score only")
        self.assertEqual(Complaint.objects.get(pk=self.complaint.pk).severity, "critical")
        with self.assertRaises(ValidationError):
            overrides.override_ai(self.complaint, actor=self.admin, severity="low", severity_score=90, reason="x")
        with self.assertRaises(ValidationError):
            overrides.override_ai(self.complaint, actor=self.admin, severity="extreme", reason="x")

    def test_priority_override_is_clamped_and_explained(self):
        overrides.override_ai(self.complaint, actor=self.admin, priority_score=150, reason="Hospital access road")
        self.complaint.refresh_from_db()
        self.assertEqual((self.complaint.priority_score, self.complaint.priority_level), (100, "critical"))
        override = self.complaint.latest_priority
        self.assertEqual((override.is_override, override.trigger, override.final_score), (True, "override", 100))
        self.assertEqual(override.explanation, "Manually set by Meera Iyer: Hospital access road")
        self.assertEqual(override.factors["override"]["requested_score"], 150)
        self.assertEqual(override.created_by, self.admin)
        self.assertEqual(self.notification_types(self.admin, self.complaint), ["critical_complaint"])

    def test_override_requires_admin_reason_and_a_change(self):
        with self.assertRaises(PermissionDenied):
            overrides.override_ai(self.complaint, actor=self.officer, category="garbage", reason="x")
        with self.assertRaises(ValidationError):
            overrides.override_ai(self.complaint, actor=self.admin, category="garbage", reason=" ")
        with self.assertRaises(ServiceError):
            overrides.override_ai(self.complaint, actor=self.admin, reason="nothing to change")
        with self.assertRaises(ValidationError):
            overrides.override_ai(self.complaint, actor=self.admin, category="unknown-slug", reason="x")


# ---------------------------------------------------------------------------------------------------------------
# pipeline: preview + re-analysis
# ---------------------------------------------------------------------------------------------------------------
class PipelineTests(ServiceTestCase):
    def table_counts(self):
        return [model.objects.count() for model in (Complaint, Location, AIPrediction, PriorityScore,
                                                     DuplicateComplaint, StatusHistory, Notification, AuditLog,
                                                     ComplaintAssignment)]

    def test_analyze_preview_writes_nothing(self):
        original = self.make_complaint(category=self.pothole, lat=north_of(30),
                                       created_at=timezone.now() - timedelta(days=1))
        before = self.table_counts()
        result = pipeline.analyze_preview(image_file=upload("pothole_9.jpg"), text="Big pothole near school",
                                          latitude=BASE_LAT, longitude=BASE_LNG, address="Road No. 12",
                                          reported_category=self.pothole)
        self.assertEqual(before, self.table_counts())
        self.assertEqual((result["category"], result["department"], result["recommended_officer"]),
                         (self.pothole, self.roads, self.officer))
        self.assertEqual(result["duplicates"][0]["complaint"], original)
        self.assertTrue(result["duplicates"][0]["is_duplicate"])
        self.assertEqual(result["priority"]["priority_level"], "high")
        self.assertEqual(result["recommendation"]["score"], 0.83)
        self.assertEqual(result["nearby_count"], 1)
        self.assertEqual([step["key"] for step in result["steps"]][-4:],
                         ["duplicate_detection", "priority", "department_routing", "officer_recommendation"])
        self.assertEqual(self.mocks["run_analysis"].call_args.kwargs["reported_category"], "pothole")
        plain = {key: value for key, value in result.items()
                 if key not in ("category", "department", "recommended_officer", "duplicates")}
        json.dumps(plain, allow_nan=False)
        draft = self.mocks["recommend_officers"].call_args.args[0]
        self.assertIsNone(draft.pk)
        self.assertEqual(draft.location.latitude, Decimal("17.412600"))

    def test_classification_only_preview(self):
        result = pipeline.analyze_preview(text="Overflowing garbage bin", full=False)
        self.assertEqual(result["category"], self.garbage)
        self.assertNotIn("priority", result)
        self.assertIsNone(self.mocks["run_analysis"].call_args.kwargs["latitude"])
        self.mocks["run_analysis"].side_effect = RuntimeError("down")
        with self.assertLogs("apps.complaints", level="ERROR"), \
                self.assertRaisesMessage(ServiceError, "could not be completed"):
            pipeline.analyze_preview(text="anything")

    def test_reanalysis_updates_ai_fields_but_keeps_the_assignment(self):
        complaint = self.make_complaint(category=self.pothole, status_value=S.ASSIGNED, officer=self.officer,
                                        description="Overflowing garbage dumped on the road")
        complaint.title = build_title(self.pothole, complaint.location)
        complaint.save(update_fields=["title"])
        self.add_prediction(complaint)
        analysis = pipeline.reanalyze_complaint(complaint, actor=self.admin)
        complaint.refresh_from_db()
        self.assertEqual(complaint.category, self.garbage)
        self.assertEqual(complaint.title, "Garbage / Waste near Govt. High School, Banjara Hills")
        self.assertEqual((complaint.department, complaint.assigned_officer, complaint.status),
                         (self.roads, self.officer, S.ASSIGNED))
        by_key = {step["key"]: step for step in analysis["steps"]}
        self.assertEqual((by_key["department_routing"]["status"], by_key["officer_assignment"]["status"]),
                         ("skipped", "skipped"))
        self.mocks["auto_assign"].assert_not_called()
        self.assertEqual(complaint.predictions.count(), 2)
        self.assertEqual(complaint.latest_priority.trigger, "reanalysis")
        self.assertTrue(complaint.status_history.filter(event="ai_analyzed", remarks__startswith="AI re-analysis",
                                                        old_status="").exists())
        self.assertEqual(analysis["summary"]["category"]["slug"], "garbage")
        self.assertTrue(AuditLog.objects.filter(action="update", actor=self.admin).exists())

    def test_reanalysis_respects_admin_overrides_and_duplicate_pairs(self):
        original = self.make_complaint(category=self.garbage, lat=north_of(30),
                                       created_at=timezone.now() - timedelta(days=1))
        complaint = self.make_complaint(category=self.garbage, description="Garbage everywhere")
        overrides.override_ai(complaint, actor=self.admin, category="garbage", severity="critical", reason="Checked")
        self.scenario.update(severity="low", severity_score=10)
        pipeline.reanalyze_complaint(complaint, actor=self.admin)
        pipeline.reanalyze_complaint(complaint, actor=self.admin)
        complaint.refresh_from_db()
        self.assertEqual((complaint.severity, complaint.severity_score), ("critical", 88))
        self.assertEqual(DuplicateComplaint.objects.filter(complaint=complaint, similar_complaint=original).count(), 1)
        self.assertEqual(complaint.duplicate_count, 1)

    def test_reanalysis_completes_a_complaint_whose_first_analysis_failed(self):
        self.configure(auto_assign_officer=True)
        complaint = self.make_complaint(status_value=S.SUBMITTED, needs_manual_review=True)
        analysis = pipeline.reanalyze_complaint(complaint, actor=self.admin)
        complaint.refresh_from_db()
        self.assertEqual((complaint.status, complaint.department, complaint.needs_manual_review),
                         (S.ASSIGNED, self.roads, False))
        self.assertEqual(self.notification_types(self.citizen, complaint),
                         ["ai_analysis_completed", "department_assigned", "officer_assigned"])
        self.assertEqual(analysis["summary"]["officer"]["id"], self.officer.pk)


# ---------------------------------------------------------------------------------------------------------------
# SLA task + management command + Celery tasks
# ---------------------------------------------------------------------------------------------------------------
class SlaTests(ServiceTestCase):
    def setUp(self):
        super().setUp()
        now = timezone.now()
        self.overdue = self.make_complaint(category=self.pothole, status_value=S.ACCEPTED, officer=self.officer,
                                           priority_level="high", priority_score=70,
                                           sla_due_at=now - timedelta(hours=3))
        self.old_critical = self.make_complaint(category=self.manhole, priority_level="critical", priority_score=90,
                                                created_at=now - timedelta(hours=50),
                                                sla_due_at=now + timedelta(hours=5))
        self.old_high = self.make_complaint(category=self.pothole, priority_level="high", priority_score=60,
                                            created_at=now - timedelta(hours=49), sla_due_at=now + timedelta(hours=5))
        self.make_complaint(category=self.pothole, priority_level="low", sla_due_at=now - timedelta(hours=3))
        self.make_complaint(category=self.pothole, status_value=S.RESOLVED, priority_level="high",
                            sla_due_at=now - timedelta(hours=3))
        self.make_complaint(category=self.pothole, priority_level="high", sla_due_at=now + timedelta(hours=3))

    def test_alerts_once_per_complaint_per_day(self):
        with self.assertLogs("apps.complaints", level="INFO") as logs:
            self.assertEqual(tasks.check_sla_breaches(), 3)
        self.assertEqual(logs.output, ["INFO:apps.complaints:SLA check: 3 complaint(s) alerted"])
        self.assertEqual(self.notification_types(self.admin), ["high_priority_unresolved"] * 3)
        self.assertEqual(self.notification_types(self.officer), ["high_priority_unresolved"])
        levels = {alert.complaint_id: (alert.title.split(":")[0], alert.level)
                  for alert in Notification.objects.filter(user=self.admin)}
        self.assertEqual(levels, {self.overdue.pk: ("Overdue high-priority complaint", "critical"),
                                  self.old_critical.pk: ("High-priority complaint unresolved", "critical"),
                                  self.old_high.pk: ("High-priority complaint unresolved", "warning")})
        self.assertIn("No officer assigned yet.", Notification.objects.get(complaint=self.old_high).message)
        # Durations in the UI's "d / h" style; the place named once (the title already contains it).
        self.assertIn("(3 h overdue)", Notification.objects.get(user=self.admin, complaint=self.overdue).message)
        old_high = Notification.objects.get(user=self.admin, complaint=self.old_high).message
        self.assertIn("has been open for 2 d 1 h", old_high)
        self.assertEqual(old_high.count("Govt. High School"), 1)
        self.assertEqual(sla.check_sla_breaches(), 0)
        Notification.objects.update(created_at=timezone.now() - timedelta(hours=25))
        self.assertEqual(sla.check_sla_breaches(), 3)

    def test_dry_run_and_management_command(self):
        with self.assertLogs("apps.complaints", level="INFO"):
            self.assertEqual(tasks.check_sla_breaches(dry_run=True), 3)
            self.assertEqual(Notification.objects.count(), 0)
            out = io.StringIO()
            call_command("check_sla", stdout=out)
            self.assertIn("SLA check complete: 3 complaint(s) alerted.", out.getvalue())
            out = io.StringIO()
            call_command("check_sla", "--dry-run", stdout=out)
            self.assertIn("0 complaint(s) would be alerted", out.getvalue())

    def test_reanalyze_task(self):
        analysis = tasks.reanalyze_complaint_task(self.overdue.pk)
        self.assertEqual(set(analysis), {"steps", "summary"})
        json.dumps(analysis, allow_nan=False)
        with self.assertLogs("apps.complaints", level="WARNING"):
            self.assertIsNone(tasks.reanalyze_complaint_task(999999))
        self.assertEqual(tasks.reanalyze_complaint_task.delay(self.overdue.pk).get()["summary"]["category"]["slug"],
                         "pothole")


# ---------------------------------------------------------------------------------------------------------------
# End to end with the real modules (demo mode)
# ---------------------------------------------------------------------------------------------------------------
def road_photo(*, repaired=False, seed=7):
    """640x480 asphalt-like photo; the defect is a dark elliptical pothole unless ``repaired``."""
    rng = np.random.default_rng(seed)
    pixels = np.clip(rng.normal(105, 18, (480, 640, 3)), 0, 255).astype(np.uint8)
    img = Image.fromarray(pixels, "RGB")
    if not repaired:
        ImageDraw.Draw(img).ellipse((220, 200, 430, 330), fill=(28, 25, 22))
    buffer = io.BytesIO()
    img.save(buffer, format="JPEG", quality=90)
    return buffer.getvalue()


@override_settings(MEDIA_ROOT=TEST_MEDIA_ROOT)
class EndToEndDemoTest(FixtureMixin, TestCase):
    """Submission -> auto-assignment -> acceptance -> resolution -> AI verification, all modules real.

    Skipped (not failed) while any collaborator is still a NotImplementedError stub; any other error fails.
    """

    def require(self, label, func, *args, **kwargs):
        try:
            return func(*args, **kwargs)
        except NotImplementedError as exc:
            self.skipTest(f"{label} is not implemented yet ({exc})")

    def test_full_lifecycle_in_demo_mode(self):
        from ai.duplicate import compute_hashes, find_duplicates
        from ai.geospatial import assess_location_risk
        from ai.nlp import analyze_text
        from ai.pipeline import run_analysis
        from ai.priority import calculate_priority
        from ai.verification import verify_resolution
        from ai.vision import analyze_image
        from apps.assignments.services import recommend_officers
        from apps.notifications.services import notify

        with mock.patch.dict(os.environ, {"MODEL_MODE": "demo"}):
            config = context.engine_config()
            before, after = road_photo(), road_photo(repaired=True)
            categories = context.engine_categories()
            # leaf modules first: the pipeline turns their errors into AnalysisError
            self.require("ai.nlp.analyze_text", analyze_text, "Large pothole near the school", categories=categories)
            self.require("ai.vision.analyze_image", analyze_image, before, filename_hint="pothole_e2e.jpg",
                         categories=categories)
            self.require("ai.pipeline.run_analysis", run_analysis, text="Large pothole near the school",
                         latitude=BASE_LAT, longitude=BASE_LNG, categories=context.engine_categories(), config=config)
            self.require("ai.priority.calculate_priority", calculate_priority, priority.build_priority_inputs(
                severity_score=60, category=self.pothole), config=config["priority"])
            self.require("ai.duplicate.compute_hashes", compute_hashes, before)
            probe = {"id": 0, "text": "Large pothole near the school", "latitude": BASE_LAT, "longitude": BASE_LNG,
                     "category": "pothole", "phash": None, "dhash": None}
            self.require("ai.duplicate.find_duplicates (text embeddings)", find_duplicates, probe,
                         [{**probe, "id": 1, "text": "Big pothole outside the school"}], config=config["duplicate"])
            self.require("ai.geospatial.assess_location_risk", assess_location_risk, BASE_LAT, BASE_LNG)
            self.require("ai.verification.verify_resolution", verify_resolution, before, after,
                         config=config["verification"])
            self.require("apps.notifications.services.notify", notify, None, title="probe", message="probe",
                         notification_type="system")
            self.require("apps.assignments.services.recommend_officers", recommend_officers,
                         Complaint(category=self.pothole, department=self.roads), limit=1)
            self.configure(auto_assign_officer=True, auto_verify_resolution=True)

            complaint, analysis = submission.submit_complaint(citizen=self.citizen, image=SimpleUploadedFile(
                "pothole_e2e.jpg", before, content_type="image/jpeg"), data={
                "description": "Large pothole near the school entrance causing traffic problems.",
                "latitude": BASE_LAT, "longitude": BASE_LNG, "address": "Road No. 12, Banjara Hills",
                "area": "Banjara Hills", "city": "Hyderabad"})
            self.assertEqual([step["key"] for step in analysis["steps"]], EXPECTED_SUBMISSION_STEPS)
            self.assertEqual([step for step in analysis["steps"] if step["status"] == "failed"], [])
            complaint.refresh_from_db()
            prediction = complaint.latest_prediction
            self.assertTrue(prediction.is_demo)
            self.assertEqual(prediction.model_mode, "demo")
            self.assertIsNotNone(complaint.category)
            self.assertIsNotNone(complaint.department)
            self.assertIsNotNone(complaint.latest_priority)
            self.assertEqual(complaint.status, S.ASSIGNED)
            self.assertTrue(analysis["summary"]["is_demo"])
            json.dumps(prediction.raw_output, allow_nan=False)

            officer = complaint.assigned_officer
            status.accept_complaint(complaint, actor=officer)
            status.start_work(complaint, actor=officer)
            status.resolve_complaint(complaint, actor=officer, remarks="Pothole filled and levelled",
                                     after_image=SimpleUploadedFile("after_e2e.jpg", after, content_type="image/jpeg"))
            complaint.refresh_from_db()
            self.assertIn(complaint.status, (S.RESOLVED, S.VERIFIED))
            result = complaint.latest_verification
            self.assertIsNotNone(result)
            self.assertTrue(result.is_demo)
            self.assertIn("not a guarantee", result.explanation.lower())
            for event in ("submitted", "ai_analyzed", "priority_assigned", "department_assigned", "officer_assigned",
                          "accepted", "in_progress", "evidence_uploaded", "resolved", "verification_run"):
                self.assertIn(event, self.events(complaint))
            self.assertIn("complaint_submitted", self.notification_types(self.citizen, complaint))

            second, second_analysis = submission.submit_complaint(citizen=self.citizen2, image=None, data={
                "description": "Big road pothole outside the school.", "latitude": north_of(40),
                "longitude": BASE_LNG})
            by_key = {step["key"]: step for step in second_analysis["steps"]}
            self.assertEqual(by_key["duplicate_detection"]["status"], "done")
            self.assertEqual(second_analysis["summary"]["duplicates_found"],
                             DuplicateComplaint.objects.filter(complaint=second).count())
