"""API tests for the complaints app: JSON shapes, scoping, permissions, filters, ordering, the map feed,
duplicate directions, lifecycle actions and the /api/ai/* endpoints.

Fixtures are built directly with the ORM (departments, categories, users of every role, complaints with
locations, photos, predictions, priority scores, timeline rows, duplicate pairs, evidence, verification
and feedback), so these tests do not depend on the service layer. Endpoints that delegate to
``apps.complaints.services`` are tested with the service function patched (``unittest.mock.patch``),
asserting the exact arguments the view passes and the response shape. AI engines are patched the same way;
the "real engine" / "real services" tests run the genuine code and are skipped only while it still
raises ``NotImplementedError`` (the API answers 503 in that case).
"""
import io
import re
import shutil
import tempfile
from datetime import datetime, time, timedelta
from decimal import Decimal
from unittest import mock

import numpy as np
from django.conf import settings
from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import connection
from django.test import TestCase, override_settings
from django.test.utils import CaptureQueriesContext
from django.urls import resolve, reverse
from django.utils import timezone
from PIL import Image, ImageDraw
from rest_framework.test import APIRequestFactory, APITestCase
from rest_framework.throttling import ScopedRateThrottle

from ai.exceptions import ImageProcessingError
from apps.accounts.models import User
from apps.assignments.models import ComplaintAssignment
from apps.audit.models import AuditLog
from apps.core.exceptions import TransitionNotAllowed
from apps.core.models import AIConfiguration
from apps.departments.models import CivicCategory, Department
from apps.feedback.models import Feedback
from apps.officers.models import OfficerProfile

from . import urls as complaint_urls
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
from .serializers import (
    ComplaintListSerializer,
    OfficerMiniSerializer,
    PriorityBreakdownSerializer,
    optimize_complaint_list_queryset,
    serialize_engine_payload,
)

TEST_MEDIA_ROOT = tempfile.mkdtemp(prefix="civicai-complaint-tests-")


def tearDownModule():
    shutil.rmtree(TEST_MEDIA_ROOT, ignore_errors=True)


# ---------------------------------------------------------------------------------------------------
# Contract key sets (docs/BUILD_SPEC.md section 4.1)
# ---------------------------------------------------------------------------------------------------
CATEGORY_MINI_KEYS = {"id", "name", "slug", "icon", "color"}
DEPARTMENT_MINI_KEYS = {"id", "name", "code", "icon", "color"}
USER_MINI_KEYS = {"id", "full_name", "email", "role", "avatar", "phone"}
OFFICER_MINI_KEYS = USER_MINI_KEYS | {"employee_id", "designation", "zone", "department", "is_available"}
LOCATION_KEYS = {"latitude", "longitude", "address", "landmark", "area", "city", "pincode"}
COMPLAINT_MINI_KEYS = {
    "id", "complaint_number", "title", "description", "status", "status_display", "category", "thumbnail",
    "created_at", "location", "priority_score", "priority_level", "severity",
}
COMPLAINT_LIST_KEYS = {
    "id", "complaint_number", "title", "description", "category", "status", "status_display", "severity",
    "severity_score", "priority_score", "priority_level", "department", "assigned_officer", "citizen", "location",
    "thumbnail", "duplicate_count", "has_pending_duplicates", "is_overdue", "sla_due_at", "ai_is_demo",
    "ai_confidence", "needs_manual_review", "created_at", "updated_at", "resolved_at",
}
COMPLAINT_DETAIL_KEYS = COMPLAINT_LIST_KEYS | {
    "incident_at", "reported_category", "images", "ai_prediction", "priority", "duplicates", "duplicate_of",
    "current_assignment", "assignments", "evidence", "latest_verification", "verifications", "feedback", "timeline",
    "allowed_actions", "is_ai_overridden", "reopen_count", "accepted_at", "verified_at", "closed_at",
    "can_reopen_until",
}
IMAGE_KEYS = {"id", "url", "kind", "width", "height", "phash", "uploaded_at"}
AI_PREDICTION_KEYS = {
    "id", "image_category", "image_confidence", "text_category", "text_confidence", "final_category",
    "final_category_slug", "multimodal_confidence", "severity", "severity_score", "severity_reason",
    "severity_factors", "detected_objects", "bounding_boxes", "keywords", "impacts", "probabilities",
    "modality_weights", "location_risk", "explanation", "needs_review", "model_mode", "is_demo", "model_version",
    "processing_time_ms", "created_at",
}
PRIORITY_KEYS = {
    "final_score", "priority_level", "components", "severity_component", "impact_component", "location_component",
    "frequency_component", "duplicate_component", "weights", "factors", "explanation", "trigger", "is_override",
    "created_at",
}
DUPLICATE_LINK_KEYS = {
    "id", "direction", "other", "text_similarity", "image_similarity", "location_similarity", "overall_similarity",
    "distance_m", "category_match", "status", "status_display", "explanation", "reviewed_by", "reviewed_at",
    "created_at",
}
DUPLICATE_PAIR_KEYS = {
    "id", "complaint", "similar_complaint", "text_similarity", "image_similarity", "location_similarity",
    "overall_similarity", "distance_m", "category_match", "status", "status_display", "explanation", "reviewed_by",
    "reviewed_at", "review_notes", "created_at",
}
ASSIGNMENT_KEYS = {
    "id", "complaint", "officer", "department", "assigned_by", "assignment_type", "assignment_type_display",
    "status", "status_display", "is_active", "recommendation_score", "recommendation_reasons", "notes",
    "assigned_at", "accepted_at", "completed_at",
}
EVIDENCE_KEYS = {"id", "before_image", "after_image", "uploaded_by", "remarks", "uploaded_at"}
VERIFICATION_KEYS = {
    "id", "evidence_id", "score", "status", "status_display", "explanation", "metrics", "method", "method_display",
    "is_manual_override", "manual_review_requested", "verified_by", "verified_at", "model_version", "is_demo",
}
FEEDBACK_KEYS = {
    "id", "complaint", "complaint_number", "complaint_title", "citizen", "rating", "text", "sentiment",
    "sentiment_display", "sentiment_score", "sentiment_confidence", "sentiment_model", "is_demo", "department",
    "category", "created_at",
}
TIMELINE_KEYS = {
    "id", "event", "event_display", "old_status", "new_status", "changed_by", "actor_label", "remarks", "metadata",
    "is_public", "timestamp",
}
MAP_KEYS = {
    "id", "complaint_number", "title", "latitude", "longitude", "category", "severity", "priority_level",
    "priority_score", "status", "status_display", "created_at", "thumbnail", "area",
}
PAGINATION_KEYS = {"count", "next", "previous", "page", "page_size", "total_pages", "results"}


# ---------------------------------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------------------------------
def jpeg_bytes(size=(160, 120), background=(118, 118, 118), blob=(32, 32, 32)):
    """A small synthetic road photo: grey asphalt with a dark elliptical 'pothole'."""
    image = Image.new("RGB", size, background)
    width, height = size
    ImageDraw.Draw(image).ellipse((width // 4, height // 4, width * 3 // 4, height * 3 // 4), fill=blob)
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=85)
    return buffer.getvalue()


def jpeg_upload(name="pothole_01.jpg", **kwargs):
    return SimpleUploadedFile(name, jpeg_bytes(**kwargs), content_type="image/jpeg")


def detail_url(complaint, action=None):
    if action:
        return reverse(f"complaint-{action}", args=[complaint.pk])
    return reverse("complaint-detail", args=[complaint.pk])


def ids(response):
    data = response.data["results"] if isinstance(response.data, dict) and "results" in response.data else response.data
    return [row["id"] for row in data]


@override_settings(MEDIA_ROOT=TEST_MEDIA_ROOT)
class ComplaintAPITestCase(APITestCase):
    """Shared ORM fixtures.

    ROADS: officer "Anil" (assigned to ``c_assigned``) and colleague "Bhanu" (assigned to ``c_resolved``).
    WASTE: officer "Chitra" (assigned to ``c_in_progress``).
    Citizens: "Ravi" owns ``c_assigned`` + ``c_in_progress``; "Sita" owns ``c_unassigned``, ``c_resolved`` and
    ``c_waste_dup``. Duplicate pairs: c_unassigned -> c_assigned (pending, ROADS), c_waste_dup -> c_in_progress
    (pending, WASTE) and c_resolved -> c_in_progress (not_duplicate).
    """

    def assertSanitisedName(self, name, original):
        """Uploads reach views and services as their re-encoded copy: "<20 hex random token>-<original name>"."""
        self.assertRegex(name, rf"^[0-9a-f]{{20}}-{re.escape(original)}$")

    @classmethod
    def make_officer(cls, email, first, last, department, employee_id):
        user = User.objects.create_user(email, "pass-12345", first_name=first, last_name=last, role=User.Role.OFFICER,
                                        phone="9800000000")
        OfficerProfile.objects.create(user=user, department=department, employee_id=employee_id,
                                      designation="Field Officer", zone="Ward 7")
        return user

    @classmethod
    def make_complaint(cls, *, citizen, category=None, department=None, officer=None, status="submitted",
                       severity="", severity_score=0, priority=0, level="", created=None, area="", lat="17.412600",
                       lng="78.448200", title="", description="Large pothole near the school entrance.",
                       sla_due_at=None, resolved_at=None, needs_manual_review=False, duplicate_count=0, image=False):
        location = Location.objects.create(latitude=Decimal(lat), longitude=Decimal(lng), address=f"Main Road, {area}",
                                           area=area, city="Hyderabad", pincode="500034")
        complaint = Complaint.objects.create(
            citizen=citizen, title=title, description=description, category=category, reported_category=category,
            status=status, severity=severity, severity_score=severity_score, priority_score=priority,
            priority_level=level, department=department, assigned_officer=officer, location=location,
            created_at=created or timezone.now(), sla_due_at=sla_due_at, resolved_at=resolved_at,
            needs_manual_review=needs_manual_review, duplicate_count=duplicate_count,
        )
        if image:
            ComplaintImage.objects.create(complaint=complaint, image=jpeg_upload(f"photo_{complaint.pk}.jpg"),
                                          width=160, height=120, phash="ffd8a0c0e0f0f8fc", dhash="0f0f0f0f0f0f0f0f",
                                          file_size=2048)
        return complaint

    @classmethod
    def setUpTestData(cls):
        now = timezone.now()
        cls.now = now
        cls.roads = Department.objects.create(name="Roads Department", code="ROADS", icon="traffic-cone",
                                              color="#D9480F", sla_hours=72)
        cls.waste = Department.objects.create(name="Waste Management", code="WASTE", icon="recycle", color="#9C6B30",
                                              sla_hours=48)
        cls.pothole = CivicCategory.objects.create(
            name="Roads / Potholes", slug="pothole", icon="construction", color="#D9480F", department=cls.roads,
            keywords=["pothole", "gaddha"], vision_labels=["pothole", "road_hole"], base_severity=60,
            public_safety_weight=0.75, sort_order=1,
        )
        cls.garbage = CivicCategory.objects.create(
            name="Garbage / Waste", slug="garbage", icon="trash-2", color="#9C6B30", department=cls.waste,
            keywords=["garbage", "kachra"], vision_labels=["garbage"], base_severity=40, public_safety_weight=0.45,
            sort_order=2,
        )
        cls.retired = CivicCategory.objects.create(name="Retired category", slug="retired", is_active=False,
                                                   department=cls.roads, sort_order=3)

        cls.citizen = User.objects.create_user("ravi@example.com", "pass-12345", first_name="Ravi", last_name="Teja",
                                               phone="9000000001")
        cls.other_citizen = User.objects.create_user("sita@example.com", "pass-12345", first_name="Sita",
                                                     last_name="Rao", phone="9000000002")
        cls.officer = cls.make_officer("anil@example.com", "Anil", "Kumar", cls.roads, "RD-1001")
        cls.roads_colleague = cls.make_officer("bhanu@example.com", "Bhanu", "Prasad", cls.roads, "RD-1002")
        cls.waste_officer = cls.make_officer("chitra@example.com", "Chitra", "Devi", cls.waste, "WM-2001")
        cls.admin = User.objects.create_user("asha@example.com", "pass-12345", first_name="Asha", last_name="Admin",
                                             role=User.Role.ADMIN)

        cls.c_assigned = cls.make_complaint(
            citizen=cls.citizen, category=cls.pothole, department=cls.roads, officer=cls.officer, status="assigned",
            severity="high", severity_score=78, priority=82, level="critical", created=now - timedelta(days=3),
            area="Banjara Hills", title="Pothole near school", sla_due_at=now + timedelta(days=1), duplicate_count=1,
            image=True,
        )
        cls.c_in_progress = cls.make_complaint(
            citizen=cls.citizen, category=cls.garbage, department=cls.waste, officer=cls.waste_officer,
            status="in_progress", severity="medium", severity_score=45, priority=40, level="medium",
            created=now - timedelta(days=10), area="Ameerpet", lat="17.437500", lng="78.448300",
            title="Garbage dump", description="Garbage dumped on the footpath for a week.",
            sla_due_at=now - timedelta(days=1), duplicate_count=1,
        )
        cls.c_unassigned = cls.make_complaint(
            citizen=cls.other_citizen, category=cls.pothole, department=cls.roads, status="analyzed", severity="high",
            severity_score=70, priority=60, level="high", created=now - timedelta(hours=1), area="Banjara Hills",
            lat="17.412900", lng="78.448500", title="Big road pothole", needs_manual_review=True, duplicate_count=1,
            image=True,
        )
        cls.c_resolved = cls.make_complaint(
            citizen=cls.other_citizen, category=cls.pothole, department=cls.roads, officer=cls.roads_colleague,
            status="resolved", severity="low", severity_score=20, priority=20, level="low",
            created=now - timedelta(days=20), area="Kukatpally", lat="17.494800", lng="78.399600",
            title="Small crack", sla_due_at=now - timedelta(days=5), resolved_at=now - timedelta(days=2),
        )
        cls.c_waste_dup = cls.make_complaint(
            citizen=cls.other_citizen, category=cls.garbage, department=cls.waste, status="submitted",
            created=now - timedelta(days=5), area="Ameerpet", lat="17.437600", lng="78.448400",
            title="Garbage again", description="Garbage dumped on the footpath again.", duplicate_count=1,
        )

        # Two predictions: the newest one must win everywhere.
        AIPrediction.objects.create(
            complaint=cls.c_assigned, image_category="pothole", image_confidence=0.4, text_category="road_crack",
            text_confidence=0.5, final_category=cls.pothole, final_category_slug="pothole", multimodal_confidence=0.55,
            is_demo=False, model_mode="production", created_at=now - timedelta(days=3),
        )
        cls.prediction = AIPrediction.objects.create(
            complaint=cls.c_assigned, image_category="pothole", image_confidence=0.88, text_category="pothole",
            text_confidence=0.91, final_category=cls.pothole, final_category_slug="pothole", multimodal_confidence=0.91,
            severity="high", severity_score=78, severity_reason="Large road damage detected near a school.",
            severity_factors={"visual": {"value": 0.8, "weight": 0.25, "contribution": 20.0, "label": "Visual severity"}},
            detected_objects=[{"label": "pothole", "confidence": 0.88, "box": [0.2, 0.3, 0.6, 0.7], "area_ratio": 0.16}],
            bounding_boxes=[[0.2, 0.3, 0.6, 0.7]], keywords=["pothole", "school"],
            impacts=[{"type": "public_safety", "label": "Public Safety", "score": 0.9, "evidence": ["school"]}],
            probabilities={"image": {"pothole": 0.88}, "fused": {"pothole": 0.93}},
            modality_weights={"image": 0.52, "text": 0.38}, location_risk={"score": 0.7, "level": "high"},
            explanation="Image model detected pothole (88%) and the text classifier agreed (91%).", model_mode="demo",
            is_demo=True, model_version="demo-opencv-heuristic-1.0", processing_time_ms=140,
            created_at=now - timedelta(days=3) + timedelta(minutes=1),
        )
        PriorityScore.objects.create(complaint=cls.c_assigned, final_score=50, priority_level="medium",
                                     created_at=now - timedelta(days=3))
        cls.priority = PriorityScore.objects.create(
            complaint=cls.c_assigned, severity_component=34.0, impact_component=22.5, location_component=12.0,
            frequency_component=7.0, duplicate_component=6.5, final_score=82, priority_level="critical",
            weights={"severity": 40, "public_impact": 25, "location_risk": 15, "frequency": 10, "duplicates": 10},
            factors={"nearby_count": 4}, explanation="Critical priority because the issue has high severity.",
            trigger="duplicate_update", created_at=now - timedelta(days=3) + timedelta(minutes=2),
        )

        start = cls.c_assigned.created_at
        StatusHistory.objects.create(complaint=cls.c_assigned, event="submitted", new_status="submitted",
                                     changed_by=cls.citizen, timestamp=start)
        StatusHistory.objects.create(complaint=cls.c_assigned, event="ai_analyzed", old_status="submitted",
                                     new_status="analyzed", timestamp=start + timedelta(minutes=1))
        StatusHistory.objects.create(complaint=cls.c_assigned, event="officer_assigned", old_status="analyzed",
                                     new_status="assigned", metadata={"officer_id": cls.officer.pk},
                                     timestamp=start + timedelta(minutes=2))
        StatusHistory.objects.create(complaint=cls.c_assigned, event="remark", changed_by=cls.officer,
                                     remarks="Internal: road closure permit needed", is_public=False,
                                     timestamp=start + timedelta(minutes=3))

        ComplaintAssignment.objects.create(
            complaint=cls.c_assigned, officer=cls.officer, department=cls.roads, assignment_type="auto",
            recommendation_score=0.83, recommendation_reasons=["Roads Department officer", "1/10 active complaints"],
            assigned_at=start + timedelta(minutes=2),
        )
        ComplaintAssignment.objects.create(complaint=cls.c_in_progress, officer=cls.waste_officer,
                                           department=cls.waste, assignment_type="manual", assigned_by=cls.admin)
        ComplaintAssignment.objects.create(complaint=cls.c_resolved, officer=cls.roads_colleague,
                                           department=cls.roads, status="completed", is_active=False,
                                           completed_at=now - timedelta(days=2))

        cls.dup_roads = DuplicateComplaint.objects.create(
            complaint=cls.c_unassigned, similar_complaint=cls.c_assigned, text_similarity=0.86, image_similarity=0.91,
            location_similarity=0.97, overall_similarity=0.88, distance_m=36.0, category_match=True,
            explanation="Same pothole reported 36 m away.",
        )
        cls.dup_waste = DuplicateComplaint.objects.create(
            complaint=cls.c_waste_dup, similar_complaint=cls.c_in_progress, text_similarity=0.8,
            location_similarity=0.95, overall_similarity=0.75, distance_m=14.0, category_match=True,
        )
        cls.dup_rejected = DuplicateComplaint.objects.create(
            complaint=cls.c_resolved, similar_complaint=cls.c_in_progress, text_similarity=0.3,
            location_similarity=0.1, overall_similarity=0.5, distance_m=280.0, status="not_duplicate",
            reviewed_by=cls.admin, reviewed_at=now - timedelta(days=1), review_notes="Different issue",
        )

        cls.evidence = ResolutionEvidence.objects.create(
            complaint=cls.c_resolved, before_image=jpeg_upload("before.jpg"),
            after_image=jpeg_upload("after.jpg", blob=(118, 118, 118)), uploaded_by=cls.roads_colleague,
            remarks="Patched with asphalt",
        )
        cls.verification = ResolutionVerification.objects.create(
            complaint=cls.c_resolved, evidence=cls.evidence, score=91, status="likely_resolved",
            explanation="Substantial visual change in the damaged area.", metrics={"ssim": 0.41},
            model_version="demo-opencv-verification-1.0", is_demo=True,
        )
        Feedback.objects.create(complaint=cls.c_resolved, citizen=cls.other_citizen, rating=4,
                                text="Resolved quickly", sentiment="positive", sentiment_score=0.8,
                                sentiment_confidence=0.9, sentiment_model="demo-lexicon-sentiment-1.0", is_demo=True)

    def setUp(self):
        cache.clear()  # throttle history lives in the cache

    def as_user(self, user):
        self.client.force_authenticate(user)
        return self.client

    def assertServiceCall(self, mocked, *, with_request=True, **expected):
        """The patched service ran once with exactly ``expected`` keyword arguments (plus the HTTP request,
        which the services use for the audit log's IP address / user agent)."""
        self.assertEqual(mocked.call_count, 1)
        kwargs = dict(mocked.call_args.kwargs)
        if with_request:
            self.assertIsNotNone(kwargs.pop("request", None), "the HTTP request was not passed to the service")
        self.assertEqual(kwargs, expected)


# ---------------------------------------------------------------------------------------------------
# Shapes
# ---------------------------------------------------------------------------------------------------
class ComplaintShapeTests(ComplaintAPITestCase):
    def test_list_shape_and_values(self):
        response = self.as_user(self.admin).get(reverse("complaint-list"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(set(response.data), PAGINATION_KEYS)
        self.assertEqual(response.data["count"], 5)
        rows = {row["id"]: row for row in response.data["results"]}
        row = rows[self.c_assigned.pk]
        self.assertEqual(set(row), COMPLAINT_LIST_KEYS)
        self.assertEqual(set(row["category"]), CATEGORY_MINI_KEYS)
        self.assertEqual(set(row["department"]), DEPARTMENT_MINI_KEYS)
        self.assertEqual(set(row["assigned_officer"]), USER_MINI_KEYS)
        self.assertEqual(set(row["citizen"]), USER_MINI_KEYS)
        self.assertEqual(set(row["location"]), LOCATION_KEYS)
        self.assertEqual(row["complaint_number"], self.c_assigned.complaint_number)
        self.assertEqual(row["status_display"], "Assigned")
        self.assertEqual(row["citizen"]["full_name"], "Ravi Teja")
        self.assertEqual(row["assigned_officer"]["role"], "officer")
        self.assertIsInstance(row["location"]["latitude"], float)
        self.assertAlmostEqual(row["location"]["latitude"], 17.4126)
        self.assertTrue(row["thumbnail"].startswith("http://testserver/media/complaints/"))
        self.assertEqual(row["ai_confidence"], 0.91)  # newest prediction, not the older 0.55 one
        self.assertIs(row["ai_is_demo"], True)
        self.assertIs(row["has_pending_duplicates"], True)
        self.assertIs(row["is_overdue"], False)
        self.assertIsNone(rows[self.c_in_progress.pk]["thumbnail"])
        self.assertIsNone(rows[self.c_in_progress.pk]["ai_confidence"])
        self.assertIs(rows[self.c_in_progress.pk]["ai_is_demo"], False)
        self.assertIs(rows[self.c_in_progress.pk]["is_overdue"], True)
        self.assertIs(rows[self.c_resolved.pk]["is_overdue"], False)  # past SLA but no longer open
        self.assertIs(rows[self.c_resolved.pk]["has_pending_duplicates"], False)  # only a rejected pair

    def test_detail_shape(self):
        with mock.patch("apps.complaints.services.status.get_allowed_actions", return_value=["accept", "reject"]):
            response = self.as_user(self.admin).get(detail_url(self.c_assigned))
        self.assertEqual(response.status_code, 200)
        data = response.data
        self.assertEqual(set(data), COMPLAINT_DETAIL_KEYS)
        self.assertEqual(set(data["reported_category"]), CATEGORY_MINI_KEYS)
        self.assertEqual(len(data["images"]), 1)
        self.assertEqual(set(data["images"][0]), IMAGE_KEYS)
        self.assertTrue(data["images"][0]["url"].startswith("http://testserver/media/"))
        self.assertEqual(set(data["ai_prediction"]), AI_PREDICTION_KEYS)
        self.assertEqual(data["ai_prediction"]["id"], self.prediction.pk)
        self.assertEqual(data["ai_prediction"]["probabilities"],
                         {"image": {"pothole": 0.88}, "text": {}, "fused": {"pothole": 0.93}})
        self.assertEqual(set(data["ai_prediction"]["final_category"]), CATEGORY_MINI_KEYS)
        self.assertEqual(set(data["priority"]), PRIORITY_KEYS)
        self.assertEqual(data["priority"]["final_score"], 82)
        self.assertEqual(data["current_assignment"]["officer"]["employee_id"], "RD-1001")
        self.assertEqual(set(data["current_assignment"]), ASSIGNMENT_KEYS)
        self.assertEqual(set(data["current_assignment"]["officer"]), OFFICER_MINI_KEYS)
        self.assertEqual(set(data["current_assignment"]["officer"]["department"]), DEPARTMENT_MINI_KEYS)
        self.assertEqual(len(data["assignments"]), 1)
        self.assertEqual(data["allowed_actions"], ["accept", "reject"])
        self.assertIsNone(data["duplicate_of"])
        self.assertIsNone(data["can_reopen_until"])
        self.assertEqual([event["event"] for event in data["timeline"]],
                         ["submitted", "ai_analyzed", "officer_assigned", "remark"])  # admin sees private events
        self.assertEqual(set(data["timeline"][0]), TIMELINE_KEYS)
        self.assertEqual([event["actor_label"] for event in data["timeline"]],
                         ["Ravi Teja (Citizen)", "CivicAI Engine", "CivicAI Engine", "Anil Kumar (Officer)"])

    def test_priority_breakdown_components(self):
        data = PriorityBreakdownSerializer(self.priority).data
        self.assertEqual([c["key"] for c in data["components"]],
                         ["severity", "public_impact", "location_risk", "frequency", "duplicates"])
        self.assertEqual([c["label"] for c in data["components"]],
                         ["Severity", "Public Impact", "Location Risk", "Frequency", "Duplicates"])
        severity = data["components"][0]
        self.assertEqual((severity["score"], severity["max"], severity["raw"]), (34.0, 40.0, 0.85))
        self.assertEqual(data["components"][1]["raw"], 0.9)
        self.assertEqual(sum(c["max"] for c in data["components"]), 100.0)

    def test_priority_breakdown_without_stored_weights_uses_defaults(self):
        score = PriorityScore.objects.create(complaint=self.c_in_progress, final_score=90, priority_level="critical",
                                             is_override=True, trigger="override")
        components = PriorityBreakdownSerializer(score).data["components"]
        self.assertEqual([c["max"] for c in components], [40.0, 25.0, 15.0, 10.0, 10.0])
        self.assertTrue(all(c["raw"] == 0.0 for c in components))

    def test_resolved_detail_has_evidence_verification_feedback_and_reopen_deadline(self):
        response = self.as_user(self.admin).get(detail_url(self.c_resolved))
        data = response.data
        self.assertIsNone(data["current_assignment"])  # the only assignment is completed
        self.assertEqual(set(data["evidence"][0]), EVIDENCE_KEYS)
        self.assertTrue(data["evidence"][0]["before_image"].startswith("http://testserver/media/evidence/before/"))
        self.assertTrue(data["evidence"][0]["after_image"].startswith("http://testserver/media/evidence/after/"))
        self.assertEqual(set(data["latest_verification"]), VERIFICATION_KEYS)
        self.assertEqual(data["latest_verification"]["evidence_id"], self.evidence.pk)
        self.assertEqual(data["latest_verification"]["status_display"], "Likely Resolved")
        self.assertEqual(len(data["verifications"]), 1)
        self.assertEqual(set(data["feedback"][0]), FEEDBACK_KEYS)
        self.assertEqual(data["feedback"][0]["department"]["code"], "ROADS")
        self.assertEqual(data["feedback"][0]["category"]["slug"], "pothole")
        self.assertEqual(data["feedback"][0]["sentiment_display"], "Positive")
        expected = self.c_resolved.resolved_at + timedelta(days=settings.CIVICAI["REOPEN_WINDOW_DAYS"])
        self.assertEqual(datetime.fromisoformat(data["can_reopen_until"]), expected)

    def test_allowed_actions_empty_while_lifecycle_service_is_unimplemented(self):
        with mock.patch("apps.complaints.services.status.get_allowed_actions", side_effect=NotImplementedError):
            response = self.as_user(self.citizen).get(detail_url(self.c_assigned))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["allowed_actions"], [])

    def test_allowed_actions_receive_complaint_and_user(self):
        with mock.patch("apps.complaints.services.status.get_allowed_actions", return_value=["edit"]) as allowed:
            response = self.as_user(self.citizen).get(detail_url(self.c_assigned))
        self.assertEqual(response.data["allowed_actions"], ["edit"])
        complaint, user = allowed.call_args.args
        self.assertEqual((complaint.pk, user.pk), (self.c_assigned.pk, self.citizen.pk))

    def test_list_serialization_has_no_per_row_queries(self):
        client = self.as_user(self.admin)
        with CaptureQueriesContext(connection) as before:
            self.assertEqual(client.get(reverse("complaint-list")).status_code, 200)
        for index in range(4):
            extra = self.make_complaint(citizen=self.citizen, category=self.pothole, department=self.roads,
                                        officer=self.officer, status="assigned", image=True, area=f"Area {index}")
            AIPrediction.objects.create(complaint=extra, multimodal_confidence=0.7, is_demo=True)
            StatusHistory.objects.create(complaint=extra, event="submitted")
        with CaptureQueriesContext(connection) as after:
            response = client.get(reverse("complaint-list"))
        self.assertEqual(response.data["count"], 9)
        self.assertEqual(len(after), len(before), [q["sql"] for q in after.captured_queries])
        self.assertLessEqual(len(after), 2)  # COUNT(*) + one SELECT with joins and sub-queries

    def test_detail_query_count_does_not_grow_with_related_rows(self):
        """One query per related collection, however many rows each holds (no N+1).

        Django skips a nested prefetch when its parent relation is empty, so the baseline starts with at
        least one row in every collection, then every collection grows."""
        DuplicateComplaint.objects.create(complaint=self.c_assigned, similar_complaint=self.c_resolved,
                                          overall_similarity=0.6)
        client = self.as_user(self.admin)
        with mock.patch("apps.complaints.services.status.get_allowed_actions", return_value=[]):
            with CaptureQueriesContext(connection) as before:
                client.get(detail_url(self.c_assigned))
            for index in range(5):
                StatusHistory.objects.create(complaint=self.c_assigned, event="remark", changed_by=self.officer,
                                             remarks=f"note {index}")
                ComplaintImage.objects.create(complaint=self.c_assigned, image=f"complaints/extra_{index}.jpg",
                                              kind="additional")
            for index in range(2):
                newer = self.make_complaint(citizen=self.other_citizen, category=self.pothole, image=True,
                                            area=f"Newer {index}")
                DuplicateComplaint.objects.create(complaint=newer, similar_complaint=self.c_assigned,
                                                  overall_similarity=0.8)
                older = self.make_complaint(citizen=self.citizen, category=self.pothole, image=True,
                                            area=f"Older {index}")
                DuplicateComplaint.objects.create(complaint=self.c_assigned, similar_complaint=older,
                                                  overall_similarity=0.7)
            ComplaintAssignment.objects.create(complaint=self.c_assigned, officer=self.roads_colleague,
                                               department=self.roads, status="reassigned", is_active=False)
            with CaptureQueriesContext(connection) as after:
                response = client.get(detail_url(self.c_assigned))
        self.assertEqual(len(response.data["timeline"]), 9)
        self.assertEqual(len(response.data["images"]), 6)
        self.assertEqual(len(response.data["duplicates"]), 6)
        self.assertEqual(len(response.data["assignments"]), 2)
        self.assertEqual(len(after), len(before), [q["sql"] for q in after.captured_queries])

    def test_shared_list_serializer_without_optimised_queryset_gives_same_output(self):
        request = APIRequestFactory().get("/")
        context = {"request": request}
        plain = Complaint.objects.get(pk=self.c_assigned.pk)
        optimised = optimize_complaint_list_queryset(Complaint.objects.filter(pk=self.c_assigned.pk)).get()
        self.assertEqual(ComplaintListSerializer(plain, context=context).data,
                         ComplaintListSerializer(optimised, context=context).data)

    def test_officer_mini_accepts_profile_or_user_without_profile(self):
        from_profile = OfficerMiniSerializer(self.officer.officer_profile).data
        self.assertEqual(set(from_profile), OFFICER_MINI_KEYS)
        self.assertEqual(from_profile["id"], self.officer.pk)
        no_profile = OfficerMiniSerializer(self.admin).data
        self.assertEqual(set(no_profile), OFFICER_MINI_KEYS)
        self.assertEqual({key: no_profile[key] for key in OFFICER_MINI_KEYS - USER_MINI_KEYS},
                         dict.fromkeys(OFFICER_MINI_KEYS - USER_MINI_KEYS))  # unknown -> null

    def test_serialize_engine_payload_makes_numpy_and_models_json_safe(self):
        payload = serialize_engine_payload({
            "score": np.float32(0.5), "count": np.int64(3), "boxes": np.array([[0.1, 0.2]]),
            "ratio": Decimal("1.5"), np.int64(7): "cluster", "category": self.pothole, "officer": self.officer,
            "recommended_officer": self.officer, "nested": [{"department": self.roads}],
            "ssim": float("nan"), "spread": np.float64("inf"),
        })
        self.assertEqual((payload["score"], payload["count"], payload["boxes"], payload["ratio"]),
                         (0.5, 3, [[0.1, 0.2]], 1.5))
        self.assertEqual((payload["ssim"], payload["spread"]), (None, None))  # strict JSON has no NaN
        self.assertIsInstance(payload["count"], int)
        self.assertEqual(payload[7], "cluster")
        self.assertEqual(set(payload["category"]), CATEGORY_MINI_KEYS)
        self.assertEqual(set(payload["officer"]), USER_MINI_KEYS)
        self.assertEqual(set(payload["recommended_officer"]), OFFICER_MINI_KEYS)
        self.assertEqual(set(payload["nested"][0]["department"]), DEPARTMENT_MINI_KEYS)


# ---------------------------------------------------------------------------------------------------
# Scoping & permissions
# ---------------------------------------------------------------------------------------------------
class ScopingAndPermissionTests(ComplaintAPITestCase):
    def test_anonymous_requests_are_rejected(self):
        self.assertEqual(self.client.get(reverse("complaint-list")).status_code, 401)
        self.assertEqual(self.client.get(reverse("ai-model-info")).status_code, 401)

    def test_citizen_sees_only_own_complaints(self):
        response = self.as_user(self.citizen).get(reverse("complaint-list"))
        self.assertCountEqual(ids(response), [self.c_assigned.pk, self.c_in_progress.pk])
        self.assertEqual(self.client.get(detail_url(self.c_unassigned)).status_code, 404)
        self.assertEqual(self.client.get(detail_url(self.c_unassigned, "timeline")).status_code, 404)

    def test_citizen_scope_parameter_cannot_widen_access(self):
        response = self.as_user(self.citizen).get(reverse("complaint-list"), {"scope": "department"})
        self.assertCountEqual(ids(response), [self.c_assigned.pk, self.c_in_progress.pk])

    def test_officer_default_scope_is_assigned_complaints(self):
        response = self.as_user(self.officer).get(reverse("complaint-list"))
        self.assertEqual(ids(response), [self.c_assigned.pk])

    def test_officer_department_scope(self):
        response = self.as_user(self.officer).get(reverse("complaint-list"), {"scope": "department"})
        self.assertCountEqual(ids(response), [self.c_assigned.pk, self.c_unassigned.pk, self.c_resolved.pk])

    def test_invalid_scope_is_a_validation_error(self):
        response = self.as_user(self.officer).get(reverse("complaint-list"), {"scope": "everything"})
        self.assertEqual(response.status_code, 400)
        self.assertIn("scope", response.data["errors"])

    def test_officer_reads_department_complaints_but_not_other_departments(self):
        client = self.as_user(self.officer)
        self.assertEqual(client.get(detail_url(self.c_unassigned)).status_code, 200)
        self.assertEqual(client.get(detail_url(self.c_in_progress)).status_code, 404)

    def test_admin_sees_everything(self):
        response = self.as_user(self.admin).get(reverse("complaint-list"))
        self.assertEqual(response.data["count"], 5)

    def test_role_permissions(self):
        cases = [
            (self.citizen, "accept", self.c_assigned, 403),
            (self.admin, "accept", self.c_assigned, 403),  # officer-only action
            (self.citizen, "override-ai", self.c_assigned, 403),
            (self.officer, "override-ai", self.c_assigned, 403),
            (self.officer, "close", self.c_assigned, 403),
            (self.officer, "reanalyze", self.c_assigned, 403),
            (self.citizen, "remarks", self.c_assigned, 403),
            (self.officer, "reopen", self.c_assigned, 403),
            (self.admin, "request-manual-verification", self.c_assigned, 403),
        ]
        for user, action, complaint, expected in cases:
            with self.subTest(user=user.email, action=action):
                self.as_user(user)
                response = self.client.post(detail_url(complaint, action), {}, format="json")
                self.assertEqual(response.status_code, expected)

    def test_only_citizens_create_complaints(self):
        for user in (self.officer, self.admin):
            with self.subTest(user=user.email):
                response = self.as_user(user).post(reverse("complaint-list"), {"description": "x" * 20}, format="json")
                self.assertEqual(response.status_code, 403)

    def test_department_colleague_cannot_act_on_complaint_assigned_to_someone_else(self):
        with mock.patch("apps.complaints.services.status.accept_complaint") as accept:
            response = self.as_user(self.roads_colleague).post(detail_url(self.c_assigned, "accept"), {}, format="json")
        self.assertEqual(response.status_code, 403)
        self.assertIn("assigned", response.data["detail"])
        accept.assert_not_called()

    def test_officer_of_another_department_gets_404_for_actions(self):
        response = self.as_user(self.waste_officer).post(detail_url(self.c_assigned, "remarks"), {"remarks": "hi"},
                                                         format="json")
        self.assertEqual(response.status_code, 404)

    def test_officer_cannot_edit_or_delete(self):
        client = self.as_user(self.officer)
        self.assertEqual(client.patch(detail_url(self.c_assigned), {"title": "x"}, format="json").status_code, 403)
        self.assertEqual(client.delete(detail_url(self.c_assigned)).status_code, 403)

    def test_timeline_hides_private_events_from_citizens(self):
        response = self.as_user(self.citizen).get(detail_url(self.c_assigned, "timeline"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual([event["event"] for event in response.data], ["submitted", "ai_analyzed", "officer_assigned"])
        self.assertEqual(set(response.data[0]), TIMELINE_KEYS)
        with mock.patch("apps.complaints.services.status.get_allowed_actions", return_value=[]):
            detail = self.client.get(detail_url(self.c_assigned)).data
        self.assertEqual(len(detail["timeline"]), 3)
        admin_timeline = self.as_user(self.admin).get(detail_url(self.c_assigned, "timeline")).data
        self.assertEqual(len(admin_timeline), 4)
        self.assertEqual(admin_timeline[3]["actor_label"], "Anil Kumar (Officer)")


# ---------------------------------------------------------------------------------------------------
# Filters, search, ordering, pagination
# ---------------------------------------------------------------------------------------------------
class ComplaintFilterTests(ComplaintAPITestCase):
    def list_ids(self, **params):
        response = self.as_user(self.admin).get(reverse("complaint-list"), params)
        self.assertEqual(response.status_code, 200, response.data)
        return ids(response)

    def test_status_comma_list(self):
        self.assertCountEqual(self.list_ids(status="assigned,in_progress"), [self.c_assigned.pk, self.c_in_progress.pk])
        self.assertEqual(self.list_ids(status="resolved"), [self.c_resolved.pk])

    def test_invalid_status_is_rejected(self):
        response = self.as_user(self.admin).get(reverse("complaint-list"), {"status": "assigned,flying"})
        self.assertEqual(response.status_code, 400)
        self.assertIn("status", response.data["errors"])

    def test_category_by_slug_or_id(self):
        roads_ids = [self.c_assigned.pk, self.c_unassigned.pk, self.c_resolved.pk]
        self.assertCountEqual(self.list_ids(category="pothole"), roads_ids)
        self.assertCountEqual(self.list_ids(category=str(self.garbage.pk)), [self.c_in_progress.pk, self.c_waste_dup.pk])

    def test_severity_and_priority_level(self):
        self.assertCountEqual(self.list_ids(severity="high"), [self.c_assigned.pk, self.c_unassigned.pk])
        self.assertCountEqual(self.list_ids(severity="high,medium"),
                              [self.c_assigned.pk, self.c_unassigned.pk, self.c_in_progress.pk])
        self.assertEqual(self.list_ids(priority_level="critical"), [self.c_assigned.pk])

    def test_department_by_code_or_id(self):
        self.assertCountEqual(self.list_ids(department="roads"),
                              [self.c_assigned.pk, self.c_unassigned.pk, self.c_resolved.pk])
        self.assertCountEqual(self.list_ids(department=str(self.waste.pk)), [self.c_in_progress.pk, self.c_waste_dup.pk])

    def test_assigned_officer_and_citizen(self):
        self.assertEqual(self.list_ids(assigned_officer=self.officer.pk), [self.c_assigned.pk])
        self.assertCountEqual(self.list_ids(citizen=self.citizen.pk), [self.c_assigned.pk, self.c_in_progress.pk])

    def test_date_range_uses_local_calendar_days(self):
        tz = timezone.get_current_timezone()
        day = timezone.localdate() - timedelta(days=40)
        late = self.make_complaint(citizen=self.citizen, created=timezone.make_aware(datetime.combine(day, time(23, 30)), tz))
        early_next = self.make_complaint(
            citizen=self.citizen, created=timezone.make_aware(datetime.combine(day + timedelta(days=1), time(0, 10)), tz)
        )
        self.assertEqual(self.list_ids(date_from=day.isoformat(), date_to=day.isoformat()), [late.pk])
        next_day = (day + timedelta(days=1)).isoformat()
        self.assertEqual(self.list_ids(date_from=next_day, date_to=next_day), [early_next.pk])
        self.assertNotIn(late.pk, self.list_ids(date_from=next_day))
        self.assertIn(late.pk, self.list_ids(date_to=day.isoformat()))

    def test_date_range_validation(self):
        response = self.as_user(self.admin).get(reverse("complaint-list"), {"date_from": "2026-10-10", "date_to": "2026-10-01"})
        self.assertEqual(response.status_code, 400)
        for ambiguous in ("03/04/2026", "2026-02-30", "yesterday"):
            with self.subTest(value=ambiguous):
                response = self.client.get(reverse("complaint-list"), {"date_from": ambiguous})
                self.assertEqual(response.status_code, 400)
                self.assertIn("date_from", response.data["errors"])

    def test_is_overdue(self):
        self.assertEqual(self.list_ids(is_overdue="true"), [self.c_in_progress.pk])
        self.assertNotIn(self.c_in_progress.pk, self.list_ids(is_overdue="false"))
        self.assertEqual(len(self.list_ids(is_overdue="false")), 4)

    def test_has_duplicates_counts_only_pending_or_confirmed_pairs(self):
        self.assertCountEqual(self.list_ids(has_duplicates="true"),
                              [self.c_assigned.pk, self.c_unassigned.pk, self.c_in_progress.pk, self.c_waste_dup.pk])
        self.assertEqual(self.list_ids(has_duplicates="false"), [self.c_resolved.pk])

    def test_needs_review(self):
        self.assertEqual(self.list_ids(needs_review="true"), [self.c_unassigned.pk])

    def test_search(self):
        self.assertEqual(self.list_ids(search=self.c_assigned.complaint_number), [self.c_assigned.pk])
        self.assertEqual(self.list_ids(search="kukatpally"), [self.c_resolved.pk])
        self.assertCountEqual(self.list_ids(search="footpath"), [self.c_in_progress.pk, self.c_waste_dup.pk])

    def test_ordering(self):
        by_priority = [self.c_waste_dup.pk, self.c_resolved.pk, self.c_in_progress.pk, self.c_unassigned.pk,
                       self.c_assigned.pk]
        self.assertEqual(self.list_ids(ordering="priority_score"), by_priority)
        self.assertEqual(self.list_ids(ordering="-priority_score"), list(reversed(by_priority)))
        newest_first = [self.c_unassigned.pk, self.c_assigned.pk, self.c_waste_dup.pk, self.c_in_progress.pk,
                        self.c_resolved.pk]
        self.assertEqual(self.list_ids(), newest_first)
        self.assertEqual(self.list_ids(ordering="not_a_field"), newest_first)

    def test_empty_parameters_from_a_filter_form_are_ignored(self):
        blank = {name: "" for name in ("status", "category", "severity", "priority_level", "department",
                                       "assigned_officer", "citizen", "date_from", "date_to", "is_overdue",
                                       "has_duplicates", "needs_review", "search", "ordering")}
        self.assertEqual(len(self.list_ids(**blank)), 5)
        by_severity = self.list_ids(ordering="-severity_score")
        self.assertEqual(by_severity[:2], [self.c_assigned.pk, self.c_unassigned.pk])

    def test_pagination(self):
        response = self.as_user(self.admin).get(reverse("complaint-list"), {"page_size": 2, "page": 2})
        self.assertEqual((response.data["count"], response.data["page"], response.data["page_size"],
                          response.data["total_pages"]), (5, 2, 2, 3))
        self.assertEqual(len(response.data["results"]), 2)


# ---------------------------------------------------------------------------------------------------
# Map feed
# ---------------------------------------------------------------------------------------------------
class ComplaintMapTests(ComplaintAPITestCase):
    def test_map_shape_scope_and_filters(self):
        response = self.as_user(self.admin).get(reverse("complaint-map"))
        self.assertEqual(response.status_code, 200)
        self.assertIsInstance(response.data, list)  # not paginated
        self.assertEqual(len(response.data), 5)
        pin = next(row for row in response.data if row["id"] == self.c_assigned.pk)
        self.assertEqual(set(pin), MAP_KEYS)
        self.assertEqual(set(pin["category"]), CATEGORY_MINI_KEYS)
        self.assertEqual((pin["latitude"], pin["longitude"], pin["area"]), (17.4126, 78.4482, "Banjara Hills"))
        self.assertTrue(pin["thumbnail"].startswith("http://testserver/media/"))
        self.assertEqual(pin["status_display"], "Assigned")
        filtered = self.client.get(reverse("complaint-map"), {"category": "garbage", "status": "in_progress"})
        self.assertEqual(ids(filtered), [self.c_in_progress.pk])
        self.assertCountEqual(ids(self.as_user(self.citizen).get(reverse("complaint-map"))),
                              [self.c_assigned.pk, self.c_in_progress.pk])
        self.assertEqual(ids(self.as_user(self.officer).get(reverse("complaint-map"))), [self.c_assigned.pk])

    def test_map_is_capped_to_newest_points(self):
        with mock.patch("apps.complaints.views.MAP_MAX_POINTS", 2):
            response = self.as_user(self.admin).get(reverse("complaint-map"))
        self.assertEqual(ids(response), [self.c_unassigned.pk, self.c_assigned.pk])

    def test_map_query_count_is_constant(self):
        client = self.as_user(self.admin)
        with CaptureQueriesContext(connection) as before:
            client.get(reverse("complaint-map"))
        for index in range(3):
            self.make_complaint(citizen=self.citizen, category=self.garbage, image=True, area=f"Zone {index}")
        with CaptureQueriesContext(connection) as after:
            response = client.get(reverse("complaint-map"))
        self.assertEqual(len(response.data), 8)
        self.assertEqual(len(after), len(before))
        self.assertEqual(len(after), 1)


# ---------------------------------------------------------------------------------------------------
# Duplicates (links on a complaint + the review queue)
# ---------------------------------------------------------------------------------------------------
class DuplicateTests(ComplaintAPITestCase):
    def test_links_from_the_newer_complaint_point_to_the_original(self):
        response = self.as_user(self.admin).get(detail_url(self.c_unassigned, "duplicates"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.data), 1)
        link = response.data[0]
        self.assertEqual(set(link), DUPLICATE_LINK_KEYS)
        self.assertEqual((link["direction"], link["other"]["id"]), ("original", self.c_assigned.pk))
        self.assertEqual(set(link["other"]), COMPLAINT_MINI_KEYS)
        self.assertTrue(link["other"]["thumbnail"].startswith("http://testserver/media/"))
        self.assertEqual(link["status_display"], "Pending Review")

    def test_links_from_the_original_point_to_newer_duplicates(self):
        response = self.as_user(self.admin).get(detail_url(self.c_assigned, "duplicates"))
        self.assertEqual([(l["direction"], l["other"]["id"]) for l in response.data],
                         [("duplicate", self.c_unassigned.pk)])

    def test_both_directions_are_combined_and_sorted(self):
        response = self.as_user(self.admin).get(detail_url(self.c_in_progress, "duplicates"))
        self.assertEqual([(l["direction"], l["other"]["id"], l["status"]) for l in response.data],
                         [("duplicate", self.c_waste_dup.pk, "pending_review"),
                          ("duplicate", self.c_resolved.pk, "not_duplicate")])
        self.assertEqual(response.data[1]["reviewed_by"]["full_name"], "Asha Admin")
        with mock.patch("apps.complaints.services.status.get_allowed_actions", return_value=[]):
            detail = self.client.get(detail_url(self.c_resolved)).data
        self.assertEqual([(l["direction"], l["other"]["id"]) for l in detail["duplicates"]],
                         [("original", self.c_in_progress.pk)])

    def test_review_queue_shape_for_admin(self):
        response = self.as_user(self.admin).get(reverse("duplicate-list"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(set(response.data), PAGINATION_KEYS)
        self.assertEqual(ids(response), [self.dup_roads.pk, self.dup_waste.pk, self.dup_rejected.pk])
        pair = response.data["results"][0]
        self.assertEqual(set(pair), DUPLICATE_PAIR_KEYS)
        self.assertEqual(set(pair["complaint"]), COMPLAINT_MINI_KEYS)
        self.assertEqual((pair["complaint"]["id"], pair["similar_complaint"]["id"]),
                         (self.c_unassigned.pk, self.c_assigned.pk))

    def test_review_queue_is_scoped_for_officers(self):
        self.assertCountEqual(ids(self.as_user(self.officer).get(reverse("duplicate-list"))),
                              [self.dup_roads.pk, self.dup_rejected.pk])
        self.assertCountEqual(ids(self.as_user(self.waste_officer).get(reverse("duplicate-list"))),
                              [self.dup_waste.pk, self.dup_rejected.pk])
        self.assertEqual(self.as_user(self.citizen).get(reverse("duplicate-list")).status_code, 403)

    def test_review_queue_filters(self):
        client = self.as_user(self.admin)
        self.assertEqual(ids(client.get(reverse("duplicate-list"), {"status": "not_duplicate"})), [self.dup_rejected.pk])
        self.assertCountEqual(ids(client.get(reverse("duplicate-list"), {"complaint": self.c_in_progress.pk})),
                              [self.dup_waste.pk, self.dup_rejected.pk])
        self.assertEqual(ids(client.get(reverse("duplicate-list"), {"ordering": "overall_similarity"}))[0],
                         self.dup_rejected.pk)

    def test_review_calls_service_and_returns_fresh_pair(self):
        def fake_review(duplicate, *, status, actor, notes="", request=None):
            DuplicateComplaint.objects.filter(pk=duplicate.pk).update(
                status=status, reviewed_by=actor, reviewed_at=timezone.now(), review_notes=notes
            )
            return duplicate

        with mock.patch("apps.complaints.services.duplicates.review_duplicate", side_effect=fake_review) as review:
            response = self.as_user(self.officer).patch(
                reverse("duplicate-detail", args=[self.dup_roads.pk]),
                {"status": "confirmed_duplicate", "notes": "Same pothole"}, format="json",
            )
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(review.call_args.args[0].pk, self.dup_roads.pk)
        self.assertServiceCall(review, status="confirmed_duplicate", actor=self.officer, notes="Same pothole")
        self.assertEqual(set(response.data), DUPLICATE_PAIR_KEYS)
        self.assertEqual((response.data["status"], response.data["review_notes"]), ("confirmed_duplicate", "Same pothole"))
        self.assertEqual(response.data["reviewed_by"]["id"], self.officer.pk)

    def test_review_validation_scope_and_methods(self):
        url = reverse("duplicate-detail", args=[self.dup_roads.pk])
        with mock.patch("apps.complaints.services.duplicates.review_duplicate") as review:
            client = self.as_user(self.admin)
            self.assertEqual(client.patch(url, {"status": "pending_review"}, format="json").status_code, 400)
            self.assertEqual(client.put(url, {"status": "not_duplicate"}, format="json").status_code, 405)
            self.assertEqual(client.get(url).status_code, 405)
            self.assertEqual(self.as_user(self.waste_officer).patch(url, {"status": "not_duplicate"},
                                                                    format="json").status_code, 404)
            review.assert_not_called()

    def test_review_service_unavailable(self):
        with mock.patch("apps.complaints.services.duplicates.review_duplicate", side_effect=NotImplementedError):
            response = self.as_user(self.admin).patch(reverse("duplicate-detail", args=[self.dup_roads.pk]),
                                                      {"status": "not_duplicate"}, format="json")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.data["detail"], "Duplicate review service unavailable.")


# ---------------------------------------------------------------------------------------------------
# Lifecycle actions (service layer mocked)
# ---------------------------------------------------------------------------------------------------
class ComplaintActionTests(ComplaintAPITestCase):
    def setUp(self):
        super().setUp()
        patcher = mock.patch("apps.complaints.services.status.get_allowed_actions", return_value=[])
        patcher.start()
        self.addCleanup(patcher.stop)

    def set_status(self, new_status):
        def apply(complaint, *args, **kwargs):
            Complaint.objects.filter(pk=complaint.pk).update(status=new_status)
        return apply

    def test_accept(self):
        with mock.patch("apps.complaints.services.status.accept_complaint", side_effect=self.set_status("accepted")) as svc:
            response = self.as_user(self.officer).post(detail_url(self.c_assigned, "accept"), {"remarks": "On my way"},
                                                       format="json")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(set(response.data), COMPLAINT_DETAIL_KEYS)
        self.assertEqual(response.data["status"], "accepted")
        self.assertEqual(svc.call_args.args[0].pk, self.c_assigned.pk)
        self.assertServiceCall(svc, actor=self.officer, remarks="On my way")

    def test_start_work(self):
        with mock.patch("apps.complaints.services.status.start_work", side_effect=self.set_status("in_progress")) as svc:
            response = self.as_user(self.officer).post(detail_url(self.c_assigned, "start"), {}, format="json")
        self.assertEqual(response.data["status"], "in_progress")
        self.assertServiceCall(svc, actor=self.officer, remarks="")

    def test_reject_requires_remarks(self):
        with mock.patch("apps.complaints.services.status.reject_complaint") as svc:
            client = self.as_user(self.officer)
            response = client.post(detail_url(self.c_assigned, "reject"), {}, format="json")
            self.assertEqual(response.status_code, 400)
            self.assertIn("remarks", response.data["errors"])
            svc.assert_not_called()
            response = client.post(detail_url(self.c_assigned, "reject"), {"remarks": "Not in our ward"}, format="json")
        self.assertEqual(response.status_code, 200)
        self.assertServiceCall(svc, actor=self.officer, remarks="Not in our ward")

    def test_update_status(self):
        with mock.patch("apps.complaints.services.status.change_status", side_effect=self.set_status("in_progress")) as svc:
            client = self.as_user(self.admin)
            self.assertEqual(client.post(detail_url(self.c_assigned, "update-status"), {"status": "flying"},
                                         format="json").status_code, 400)
            response = client.post(detail_url(self.c_assigned, "update-status"),
                                   {"status": "in_progress", "remarks": "Crew dispatched"}, format="json")
        self.assertEqual(response.data["status"], "in_progress")
        self.assertEqual(svc.call_args.args[1], "in_progress")
        self.assertServiceCall(svc, actor=self.admin, remarks="Crew dispatched")

    def test_transition_errors_pass_through(self):
        error = TransitionNotAllowed("A closed complaint cannot be accepted.")
        with mock.patch("apps.complaints.services.status.accept_complaint", side_effect=error):
            response = self.as_user(self.officer).post(detail_url(self.c_assigned, "accept"), {}, format="json")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.data, {"detail": "A closed complaint cannot be accepted.",
                                         "code": "transition_not_allowed"})

    def test_unimplemented_service_returns_503(self):
        with mock.patch("apps.complaints.services.status.accept_complaint", side_effect=NotImplementedError("stub")):
            response = self.as_user(self.officer).post(detail_url(self.c_assigned, "accept"), {}, format="json")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.data, {"detail": "Complaint lifecycle service unavailable.",
                                         "code": "service_unavailable"})

    def test_resolve_with_after_image(self):
        with mock.patch("apps.complaints.services.status.resolve_complaint", side_effect=self.set_status("resolved")) as svc:
            client = self.as_user(self.officer)
            missing = client.post(detail_url(self.c_assigned, "resolve"), {"after_image": jpeg_upload("after.jpg")},
                                  format="multipart")
            self.assertEqual(missing.status_code, 400)
            bad = client.post(detail_url(self.c_assigned, "resolve"),
                              {"remarks": "Fixed", "after_image": SimpleUploadedFile("after.jpg", b"not an image")},
                              format="multipart")
            self.assertEqual(bad.status_code, 400)
            self.assertIn("after_image", bad.data["errors"])
            svc.assert_not_called()
            response = client.post(detail_url(self.c_assigned, "resolve"),
                                   {"remarks": "Pothole filled", "after_image": jpeg_upload("after.jpg")},
                                   format="multipart")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["status"], "resolved")
        self.assertEqual(svc.call_args.kwargs["remarks"], "Pothole filled")
        self.assertEqual(svc.call_args.kwargs["actor"], self.officer)
        self.assertSanitisedName(svc.call_args.kwargs["after_image"].name, "after.jpg")

    def test_upload_evidence(self):
        def fake_upload(complaint, *, actor, before_image=None, after_image=None, remarks="", request=None):
            return ResolutionEvidence.objects.create(complaint=complaint, before_image=before_image,
                                                     after_image=after_image, uploaded_by=actor, remarks=remarks)

        with mock.patch("apps.complaints.services.verification.upload_evidence", side_effect=fake_upload) as svc:
            client = self.as_user(self.officer)
            empty = client.post(detail_url(self.c_assigned, "evidence"), {"remarks": "nothing"}, format="multipart")
            self.assertEqual(empty.status_code, 400)
            response = client.post(detail_url(self.c_assigned, "evidence"),
                                   {"after_image": jpeg_upload("after.png"), "remarks": "Done"}, format="multipart")
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(set(response.data), EVIDENCE_KEYS)
        self.assertIsNone(response.data["before_image"])
        self.assertTrue(response.data["after_image"].startswith("http://testserver/media/evidence/after/"))
        self.assertEqual(response.data["uploaded_by"]["id"], self.officer.pk)
        self.assertIsNone(svc.call_args.kwargs["before_image"])
        self.assertEqual(svc.call_args.kwargs["remarks"], "Done")

    def test_ai_verification(self):
        def fake_verify(complaint, *, actor=None, evidence=None, request=None):
            return ResolutionVerification.objects.create(complaint=complaint, score=73, status="likely_resolved",
                                                         explanation="Changed", is_demo=True)

        with mock.patch("apps.complaints.services.verification.run_ai_verification", side_effect=fake_verify) as svc:
            response = self.as_user(self.admin).post(detail_url(self.c_resolved, "verify"), {}, format="json")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(set(response.data), VERIFICATION_KEYS)
        self.assertEqual((response.data["score"], response.data["method"]), (73, "ai_assisted"))
        self.assertServiceCall(svc, actor=self.admin)
        with mock.patch("apps.complaints.services.verification.run_ai_verification", return_value=None):
            response = self.client.post(detail_url(self.c_resolved, "verify"), {}, format="json")
        self.assertEqual(response.status_code, 400)

    def test_manual_verification(self):
        def fake_manual(complaint, *, actor, status, score=None, explanation="", request=None):
            return ResolutionVerification.objects.create(complaint=complaint, score=score or 0, status=status,
                                                         explanation=explanation, method="manual",
                                                         is_manual_override=True, verified_by=actor, is_demo=False)

        with mock.patch("apps.complaints.services.verification.manual_verification", side_effect=fake_manual) as svc:
            client = self.as_user(self.roads_colleague)
            self.assertEqual(client.post(detail_url(self.c_resolved, "manual-verification"),
                                         {"status": "great", "explanation": "x"}, format="json").status_code, 400)
            self.assertEqual(client.post(detail_url(self.c_resolved, "manual-verification"),
                                         {"status": "not_resolved"}, format="json").status_code, 400)
            response = client.post(detail_url(self.c_resolved, "manual-verification"),
                                   {"status": "not_resolved", "score": 30, "explanation": "Still broken"},
                                   format="json")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual((response.data["method_display"], response.data["verified_by"]["id"]),
                         ("Manual", self.roads_colleague.pk))
        self.assertServiceCall(svc, actor=self.roads_colleague, status="not_resolved", score=30,
                               explanation="Still broken")

    def test_request_manual_verification(self):
        with mock.patch("apps.complaints.services.verification.request_manual_review", return_value=None) as svc:
            response = self.as_user(self.roads_colleague).post(detail_url(self.c_resolved, "request-manual-verification"),
                                                               {"remarks": "Lighting was poor"}, format="json")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(set(response.data), COMPLAINT_DETAIL_KEYS)
        self.assertServiceCall(svc, actor=self.roads_colleague, remarks="Lighting was poor")

    def test_reopen_by_owner(self):
        with mock.patch("apps.complaints.services.status.reopen_complaint", side_effect=self.set_status("reopened")) as svc:
            client = self.as_user(self.other_citizen)
            self.assertEqual(client.post(detail_url(self.c_resolved, "reopen"), {}, format="json").status_code, 400)
            response = client.post(detail_url(self.c_resolved, "reopen"), {"reason": "Pothole is back"}, format="json")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.data["status"], "reopened")
            self.assertServiceCall(svc, actor=self.other_citizen, reason="Pothole is back")
            other = self.as_user(self.citizen).post(detail_url(self.c_resolved, "reopen"), {"reason": "x"}, format="json")
        self.assertEqual(other.status_code, 404)

    def test_add_remark_returns_timeline_event(self):
        def fake_remark(complaint, *, actor, remarks, is_public=True):
            return StatusHistory.objects.create(complaint=complaint, event="remark", changed_by=actor, remarks=remarks,
                                                is_public=is_public)

        with mock.patch("apps.complaints.services.status.add_remark", side_effect=fake_remark) as svc:
            response = self.as_user(self.officer).post(detail_url(self.c_assigned, "remarks"),
                                                       {"remarks": "Material ordered"}, format="json")
            internal = self.client.post(detail_url(self.c_assigned, "remarks"),
                                        {"remarks": "Contractor delayed", "is_public": False}, format="json")
        self.assertEqual(response.status_code, 201)
        self.assertEqual(set(response.data), TIMELINE_KEYS)
        self.assertEqual((response.data["remarks"], response.data["actor_label"], response.data["is_public"]),
                         ("Material ordered", "Anil Kumar (Officer)", True))
        self.assertEqual(internal.data["is_public"], False)
        self.assertEqual(svc.call_args_list[0].kwargs, {"actor": self.officer, "remarks": "Material ordered",
                                                        "is_public": True})

    def test_department_colleague_may_add_remarks(self):
        """Remarks are open to every officer who can see the complaint; the service has the final word."""
        def fake_remark(complaint, *, actor, remarks, is_public=True):
            return StatusHistory.objects.create(complaint=complaint, event="remark", changed_by=actor, remarks=remarks)

        with mock.patch("apps.complaints.services.status.add_remark", side_effect=fake_remark) as svc:
            response = self.as_user(self.roads_colleague).post(detail_url(self.c_assigned, "remarks"),
                                                               {"remarks": "Same issue on the next street"},
                                                               format="json")
        self.assertEqual(response.status_code, 201)
        self.assertEqual(svc.call_args.kwargs["actor"], self.roads_colleague)

    def test_override_ai(self):
        with mock.patch("apps.complaints.services.overrides.override_ai") as svc:
            client = self.as_user(self.admin)
            self.assertEqual(client.post(detail_url(self.c_assigned, "override-ai"), {"reason": "wrong"},
                                         format="json").status_code, 400)
            unknown = client.post(detail_url(self.c_assigned, "override-ai"), {"category": "unicorn", "reason": "x"},
                                  format="json")
            self.assertEqual(unknown.status_code, 400)
            self.assertIn("category", unknown.data["errors"])
            response = client.post(detail_url(self.c_assigned, "override-ai"),
                                   {"category": "garbage", "severity": "critical", "priority_score": 90,
                                    "reason": "Photo shows a garbage pile"}, format="json")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertServiceCall(svc, actor=self.admin, category=self.garbage, severity="critical", priority_score=90,
                               reason="Photo shows a garbage pile")

    def test_reanalyze_returns_analysis(self):
        analysis = {"steps": [{"key": "text_analysis", "label": "Text NLP analysis", "status": "done",
                               "duration_ms": 4, "detail": ""}],
                    "summary": {"category": self.pothole, "department": self.roads, "officer": None}}
        with mock.patch("apps.complaints.services.pipeline.reanalyze_complaint", return_value=analysis) as svc:
            response = self.as_user(self.admin).post(detail_url(self.c_assigned, "reanalyze"), {}, format="json")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(set(response.data), COMPLAINT_DETAIL_KEYS | {"analysis"})
        self.assertEqual(set(response.data["analysis"]["summary"]["category"]), CATEGORY_MINI_KEYS)
        self.assertEqual(set(response.data["analysis"]["summary"]["department"]), DEPARTMENT_MINI_KEYS)
        self.assertServiceCall(svc, actor=self.admin)

    def test_close(self):
        with mock.patch("apps.complaints.services.status.close_complaint", side_effect=self.set_status("closed")) as svc:
            response = self.as_user(self.admin).post(detail_url(self.c_resolved, "close"), {"remarks": "Done"},
                                                     format="json")
        self.assertEqual(response.data["status"], "closed")
        self.assertServiceCall(svc, actor=self.admin, remarks="Done")


# ---------------------------------------------------------------------------------------------------
# Create / update / delete
# ---------------------------------------------------------------------------------------------------
class ComplaintCreateTests(ComplaintAPITestCase):
    def form(self, **overrides):
        data = {
            "description": "Large pothole near the school entrance causing traffic problems.",
            "latitude": "17.4123456", "longitude": "78.4481234", "address": "Road No. 12, Banjara Hills",
            "area": "Banjara Hills", "city": "Hyderabad", "pincode": "500034", "category": "pothole",
            "image": jpeg_upload("pothole_report.jpg"),
        }
        data.update(overrides)
        return {key: value for key, value in data.items() if value is not None}

    def post(self, data, user=None):
        return self.as_user(user or self.citizen).post(reverse("complaint-list"), data, format="multipart")

    def test_validation_errors(self):
        incident = (timezone.now() + timedelta(hours=2)).isoformat()
        cases = {
            "description": self.form(description="short"),
            "latitude": self.form(latitude="91"),
            "longitude": self.form(longitude="nan"),
            "incident_at": self.form(incident_at=incident),
            "category": self.form(category="retired"),
        }
        with mock.patch("apps.complaints.services.submission.submit_complaint") as submit:
            for field, data in cases.items():
                with self.subTest(field=field):
                    response = self.post(data)
                    self.assertEqual(response.status_code, 400)
                    self.assertIn(field, response.data["errors"])
            missing = self.post(self.form(latitude=None, longitude=None))
            self.assertEqual(set(missing.data["errors"]), {"latitude", "longitude"})
            submit.assert_not_called()

    def test_image_validation(self):
        gif = io.BytesIO()
        Image.new("RGB", (64, 64), (10, 10, 10)).save(gif, format="GIF")
        tiny = io.BytesIO()
        Image.new("RGB", (16, 16), (10, 10, 10)).save(tiny, format="JPEG")
        uploads = {
            "fake": SimpleUploadedFile("photo.jpg", b"definitely not an image", content_type="image/jpeg"),
            "gif": SimpleUploadedFile("photo.gif", gif.getvalue(), content_type="image/gif"),
            "tiny": SimpleUploadedFile("tiny.jpg", tiny.getvalue(), content_type="image/jpeg"),
        }
        with mock.patch("apps.complaints.services.submission.submit_complaint") as submit:
            for label, upload in uploads.items():
                with self.subTest(upload=label):
                    response = self.post(self.form(image=upload))
                    self.assertEqual(response.status_code, 400)
                    self.assertIn("image", response.data["errors"])
            submit.assert_not_called()

    def test_create_calls_submission_service(self):
        def fake_submit(*, citizen, data, image=None, request=None):
            location = Location.objects.create(latitude=data["latitude"], longitude=data["longitude"],
                                               address=data["address"], area=data["area"], city=data["city"],
                                               pincode=data["pincode"])
            complaint = Complaint.objects.create(citizen=citizen, description=data["description"],
                                                 title="Pothole near Banjara Hills", category=data["category"],
                                                 reported_category=data["category"], location=location,
                                                 status="analyzed", incident_at=data["incident_at"])
            ComplaintImage.objects.create(complaint=complaint, image=image)
            analysis = {
                "steps": [{"key": "validate", "label": "Validation", "status": "done", "duration_ms": 1, "detail": ""}],
                "summary": {"category": data["category"], "confidence": 0.9, "department": self.roads,
                            "officer": self.officer, "duplicates_found": 0, "is_demo": True, "mode": "demo"},
            }
            return complaint, analysis

        incident = (timezone.now() - timedelta(hours=3)).replace(microsecond=0)
        with mock.patch("apps.complaints.services.submission.submit_complaint", side_effect=fake_submit) as submit:
            response = self.post(self.form(incident_at=incident.isoformat(), title=""))
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(set(response.data), COMPLAINT_DETAIL_KEYS | {"analysis"})
        self.assertEqual(response.data["status"], "analyzed")
        self.assertEqual(response.data["citizen"]["id"], self.citizen.pk)
        self.assertTrue(response.data["thumbnail"].startswith("http://testserver/media/complaints/"))
        summary = response.data["analysis"]["summary"]
        self.assertEqual((summary["category"]["slug"], summary["department"]["code"]), ("pothole", "ROADS"))
        self.assertEqual(set(summary["officer"]), USER_MINI_KEYS)

        kwargs = submit.call_args.kwargs
        self.assertEqual(kwargs["citizen"], self.citizen)
        self.assertIsNotNone(kwargs["request"])
        self.assertSanitisedName(kwargs["image"].name, "pothole_report.jpg")
        data = kwargs["data"]
        self.assertEqual(set(data), {"description", "latitude", "longitude", "address", "landmark", "area", "city",
                                     "pincode", "category", "title", "incident_at"})
        self.assertEqual(data["category"], self.pothole)
        self.assertEqual((data["latitude"], data["longitude"]), (17.412346, 78.448123))
        self.assertEqual(data["incident_at"], incident)
        self.assertEqual(data["landmark"], "")

    def test_optional_fields_can_be_omitted(self):
        with mock.patch("apps.complaints.services.submission.submit_complaint",
                        side_effect=NotImplementedError("stub")) as submit:
            response = self.post(self.form(image=None, category=None, address=None, area=None, city=None,
                                           pincode=None))
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.data["detail"], "Complaint submission service unavailable.")
        data = submit.call_args.kwargs["data"]
        self.assertIsNone(data["category"])
        self.assertIsNone(submit.call_args.kwargs["image"])
        self.assertNotIn("incident_at", data)

    def test_create_end_to_end_with_real_services(self):
        """Runs the REAL submission service; skipped only while it is still a NotImplementedError stub."""
        response = self.post(self.form(image=jpeg_upload("pothole_live.jpg")))
        if response.status_code == 503:
            self.skipTest(f"submit_complaint not implemented yet ({response.data['detail']})")
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(set(response.data), COMPLAINT_DETAIL_KEYS | {"analysis"})
        self.assertEqual(set(response.data["analysis"]), {"steps", "summary"})
        for step in response.data["analysis"]["steps"]:
            self.assertTrue({"key", "label", "status", "duration_ms", "detail"} <= set(step))
        complaint = Complaint.objects.get(pk=response.data["id"])
        self.assertEqual(complaint.citizen, self.citizen)
        self.assertEqual(complaint.description, self.form()["description"])
        self.assertAlmostEqual(float(complaint.location.latitude), 17.412346, places=6)
        self.assertEqual(complaint.images.count(), 1)
        self.assertTrue(complaint.complaint_number.startswith("CIV-"))


class ComplaintUpdateDeleteTests(ComplaintAPITestCase):
    def patch(self, user, complaint, data):
        return self.as_user(user).patch(detail_url(complaint), data, format="json")

    def test_citizen_edits_title_and_location_while_editable(self):
        with mock.patch("apps.complaints.services.status.get_allowed_actions", return_value=["edit", "delete"]), \
                mock.patch("apps.complaints.services.pipeline.reanalyze_complaint") as reanalyze:
            response = self.patch(self.citizen, self.c_assigned, {"title": "Deep pothole", "landmark": "Opp. school"})
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["title"], "Deep pothole")
        self.assertEqual(response.data["location"]["landmark"], "Opp. school")
        self.assertNotIn("analysis", response.data)
        reanalyze.assert_not_called()
        self.c_assigned.refresh_from_db()
        self.assertEqual(self.c_assigned.location.landmark, "Opp. school")
        log = AuditLog.objects.get(action="update", entity_id=str(self.c_assigned.pk))
        self.assertEqual(log.changes["title"], ["Pothole near school", "Deep pothole"])

    def test_description_change_triggers_reanalysis(self):
        analysis = {"steps": [], "summary": {"category": self.pothole}}
        with mock.patch("apps.complaints.services.status.get_allowed_actions", return_value=["edit"]), \
                mock.patch("apps.complaints.services.pipeline.reanalyze_complaint", return_value=analysis) as reanalyze:
            response = self.patch(self.citizen, self.c_assigned,
                                  {"description": "Very large pothole, two bikes fell this morning."})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(reanalyze.call_args.args[0].pk, self.c_assigned.pk)
        self.assertServiceCall(reanalyze, actor=self.citizen)
        self.assertEqual(response.data["analysis"]["summary"]["category"]["slug"], "pothole")

    def test_edit_is_rolled_back_when_reanalysis_is_unavailable(self):
        with mock.patch("apps.complaints.services.status.get_allowed_actions", return_value=["edit"]), \
                mock.patch("apps.complaints.services.pipeline.reanalyze_complaint", side_effect=NotImplementedError):
            response = self.patch(self.citizen, self.c_assigned, {"description": "A completely new description."})
        self.assertEqual(response.status_code, 503)
        self.c_assigned.refresh_from_db()
        self.assertEqual(self.c_assigned.description, "Large pothole near the school entrance.")

    def test_citizen_cannot_edit_once_not_editable(self):
        with mock.patch("apps.complaints.services.status.get_allowed_actions", return_value=["reopen"]):
            response = self.patch(self.citizen, self.c_assigned, {"title": "Changed"})
        self.assertEqual(response.status_code, 403)
        self.c_assigned.refresh_from_db()
        self.assertEqual(self.c_assigned.title, "Pothole near school")

    def test_edit_check_reports_unavailable_lifecycle_service(self):
        with mock.patch("apps.complaints.services.status.get_allowed_actions", side_effect=NotImplementedError):
            response = self.patch(self.citizen, self.c_assigned, {"title": "Changed"})
        self.assertEqual(response.status_code, 503)

    def test_edit_validation_and_scope(self):
        with mock.patch("apps.complaints.services.status.get_allowed_actions", return_value=["edit"]):
            self.assertEqual(self.patch(self.citizen, self.c_assigned, {"description": "short"}).status_code, 400)
            future = (timezone.now() + timedelta(days=1)).isoformat()
            self.assertEqual(self.patch(self.citizen, self.c_assigned, {"incident_at": future}).status_code, 400)
            self.assertEqual(self.patch(self.citizen, self.c_unassigned, {"title": "x"}).status_code, 404)

    def test_admin_edits_regardless_of_lifecycle(self):
        with mock.patch("apps.complaints.services.status.get_allowed_actions", return_value=[]):
            response = self.as_user(self.admin).put(detail_url(self.c_resolved), {"city": "Secunderabad"}, format="json")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["location"]["city"], "Secunderabad")

    def test_citizen_deletes_editable_complaint(self):
        location_id = self.c_unassigned.location_id
        with mock.patch("apps.complaints.services.status.get_allowed_actions", return_value=["edit", "delete"]), \
                mock.patch("apps.complaints.services.priority.recalculate_priority") as recalc:
            response = self.as_user(self.other_citizen).delete(detail_url(self.c_unassigned))
        self.assertEqual(response.status_code, 204)
        self.assertFalse(Complaint.objects.filter(pk=self.c_unassigned.pk).exists())
        self.assertFalse(Location.objects.filter(pk=location_id).exists())
        self.assertTrue(AuditLog.objects.filter(action="delete", entity_id=str(self.c_unassigned.pk)).exists())
        self.c_assigned.refresh_from_db()
        self.assertEqual(self.c_assigned.duplicate_count, 0)  # its only duplicate link was deleted
        self.assertEqual([call.args[0].pk for call in recalc.call_args_list], [self.c_assigned.pk])
        self.assertServiceCall(recalc, with_request=False, trigger="duplicate_update", actor=None)

    def test_citizen_cannot_delete_after_work_started(self):
        with mock.patch("apps.complaints.services.status.get_allowed_actions", return_value=["reopen"]):
            response = self.as_user(self.citizen).delete(detail_url(self.c_in_progress))
        self.assertEqual(response.status_code, 403)
        self.assertTrue(Complaint.objects.filter(pk=self.c_in_progress.pk).exists())

    def test_admin_deletes_any_complaint(self):
        with mock.patch("apps.complaints.services.priority.recalculate_priority", side_effect=NotImplementedError):
            response = self.as_user(self.admin).delete(detail_url(self.c_resolved))
        self.assertEqual(response.status_code, 204)  # follow-up priority failure never breaks the delete
        self.assertFalse(Complaint.objects.filter(pk=self.c_resolved.pk).exists())


# ---------------------------------------------------------------------------------------------------
# AI endpoints
# ---------------------------------------------------------------------------------------------------
VISION_RESULT = {
    "category": "pothole", "confidence": 0.81, "probabilities": {"pothole": 0.81, "garbage": 0.19},
    "detected_objects": [{"label": "pothole", "confidence": 0.81, "box": [0.25, 0.25, 0.75, 0.75], "area_ratio": 0.25}],
    "bounding_boxes": [[0.25, 0.25, 0.75, 0.75]], "visual_severity": 0.7,
    "quality": {"width": 160, "height": 120, "blur_score": 210.5, "brightness": 0.4, "is_blurry": False,
                "is_dark": False},
    "model_version": "demo-opencv-heuristic-1.0", "mode": "demo", "is_demo": True, "fallback_reason": None,
    "explanation": "Dark elliptical region on textured grey ground.", "processing_time_ms": 12,
}
TEXT_RESULT = {"category": "pothole", "confidence": 0.9, "probabilities": {"pothole": 0.9}, "keywords": ["pothole"],
               "is_demo": True, "mode": "demo", "model_version": "demo-tfidf-logreg-1.0"}
FUSION_RESULT = {"category": "pothole", "confidence": 0.93, "probabilities": {"pothole": 0.93},
                 "agreement": "agree", "needs_review": False, "explanation": "Both modalities agree."}


class AIEndpointTests(ComplaintAPITestCase):
    # --- classify ----------------------------------------------------------------------------------
    def test_classify_calls_engines_with_db_categories(self):
        with mock.patch("ai.vision.analyze_image", return_value=VISION_RESULT) as vision, \
                mock.patch("ai.nlp.analyze_text", return_value=TEXT_RESULT) as nlp, \
                mock.patch("ai.multimodal.fuse_predictions", return_value=FUSION_RESULT) as fuse:
            response = self.as_user(self.citizen).post(
                reverse("ai-classify"), {"image": jpeg_upload("pothole_03.jpg"), "description": "Big pothole here"},
                format="multipart",
            )
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(set(response.data), {"vision", "text", "fusion", "category", "is_demo", "mode"})
        self.assertEqual(response.data["category"]["id"], self.pothole.pk)
        self.assertIs(response.data["is_demo"], True)
        self.assertEqual(response.data["fusion"], FUSION_RESULT)
        image_bytes = vision.call_args.args[0]
        self.assertIsInstance(image_bytes, bytes)
        self.assertTrue(image_bytes.startswith(b"\xff\xd8"))  # JPEG magic number
        self.assertSanitisedName(vision.call_args.kwargs["filename_hint"], "pothole_03.jpg")
        slugs = {category["slug"] for category in vision.call_args.kwargs["categories"]}
        self.assertEqual(slugs, {"pothole", "garbage"})  # the inactive category is not sent to the engines
        self.assertEqual(nlp.call_args.args[0], "Big pothole here")
        self.assertEqual(fuse.call_args.args, (VISION_RESULT, TEXT_RESULT))
        self.assertEqual(set(fuse.call_args.kwargs["config"]), {"image_weight", "text_weight", "min_confidence"})

    def test_classify_text_only_and_validation(self):
        with mock.patch("ai.vision.analyze_image") as vision, \
                mock.patch("ai.nlp.analyze_text", return_value=TEXT_RESULT), \
                mock.patch("ai.multimodal.fuse_predictions", return_value={**FUSION_RESULT, "category": "unknown"}):
            client = self.as_user(self.citizen)
            self.assertEqual(client.post(reverse("ai-classify"), {}, format="multipart").status_code, 400)
            response = client.post(reverse("ai-classify"), {"description": "Garbage everywhere"}, format="multipart")
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.data["vision"])
        self.assertIsNone(response.data["category"])  # fused slug without a DB category
        vision.assert_not_called()

    def test_classify_reports_image_errors_and_unavailable_engines(self):
        client = self.as_user(self.citizen)
        with mock.patch("ai.vision.analyze_image", side_effect=ImageProcessingError("cannot decode image")):
            response = client.post(reverse("ai-classify"), {"image": jpeg_upload()}, format="multipart")
        self.assertEqual(response.status_code, 400)
        self.assertIn("cannot decode image", response.data["errors"]["image"][0])
        with mock.patch("ai.vision.analyze_image", side_effect=NotImplementedError("vision stub")):
            response = client.post(reverse("ai-classify"), {"image": jpeg_upload()}, format="multipart")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.data["detail"], "Vision engine unavailable.")

    def test_classify_with_real_engines(self):
        """Real vision / NLP / fusion engines; skipped only while one of them is still a stub."""
        response = self.as_user(self.citizen).post(
            reverse("ai-classify"),
            {"image": jpeg_upload("road_photo.jpg"), "description": "Large pothole near the school entrance."},
            format="multipart",
        )
        if response.status_code == 503:
            self.skipTest(f"AI engines not implemented yet ({response.data['detail']})")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(set(response.data), {"vision", "text", "fusion", "category", "is_demo", "mode"})
        self.assertIn(response.data["mode"], ("demo", "production"))
        if response.data["category"] is not None:
            self.assertEqual(set(response.data["category"]), CATEGORY_MINI_KEYS)

    # --- analyze -----------------------------------------------------------------------------------
    def test_analyze_preview_normalises_service_objects(self):
        preview = {
            "vision": VISION_RESULT, "text": TEXT_RESULT, "fusion": FUSION_RESULT, "location_risk": {"score": 0.4},
            "severity": {"severity": "high", "score": 70}, "priority": {"final_score": 66},
            "duplicates": [{"complaint": self.c_assigned, "overall_similarity": 0.9},
                           {"complaint_id": self.c_unassigned.pk, "overall_similarity": 0.7},
                           {"complaint_id": 987654, "overall_similarity": 0.6}],
            "department": self.roads, "recommended_officer": self.officer, "category": self.pothole,
            "is_demo": True, "mode": "demo", "steps": [],
        }
        with mock.patch("apps.complaints.services.pipeline.analyze_preview", return_value=preview) as svc:
            response = self.as_user(self.citizen).post(
                reverse("ai-analyze"),
                {"image": jpeg_upload(), "description": "Large pothole near school", "latitude": "17.41",
                 "longitude": "78.44", "address": "Road No. 12", "category": str(self.pothole.pk)},
                format="multipart",
            )
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(set(response.data["department"]), DEPARTMENT_MINI_KEYS)
        self.assertEqual(set(response.data["recommended_officer"]), OFFICER_MINI_KEYS)
        self.assertEqual(set(response.data["category"]), CATEGORY_MINI_KEYS)
        self.assertEqual([d["complaint"]["id"] for d in response.data["duplicates"]],
                         [self.c_assigned.pk, self.c_unassigned.pk])
        self.assertEqual(set(response.data["duplicates"][1]), {"complaint", "overall_similarity"})
        self.assertEqual(set(response.data["duplicates"][0]["complaint"]), COMPLAINT_MINI_KEYS)
        kwargs = svc.call_args.kwargs
        self.assertEqual((kwargs["text"], kwargs["latitude"], kwargs["longitude"], kwargs["address"]),
                         ("Large pothole near school", 17.41, 78.44, "Road No. 12"))
        self.assertEqual(kwargs["reported_category"], self.pothole)
        self.assertSanitisedName(kwargs["image_file"].name, "pothole_01.jpg")

    def test_analyze_validation_and_unavailable_service(self):
        client = self.as_user(self.citizen)
        with mock.patch("apps.complaints.services.pipeline.analyze_preview", side_effect=NotImplementedError) as svc:
            self.assertEqual(client.post(reverse("ai-analyze"), {}, format="multipart").status_code, 400)
            half = client.post(reverse("ai-analyze"), {"description": "Pothole", "latitude": "17.4"}, format="multipart")
            self.assertEqual(half.status_code, 400)
            response = client.post(reverse("ai-analyze"), {"description": "Pothole on road"}, format="multipart")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.data["detail"], "AI analysis service unavailable.")
        self.assertEqual(svc.call_count, 1)

    # --- priority ----------------------------------------------------------------------------------
    def test_priority_recalculation_for_stored_complaint(self):
        def fake_recalculate(complaint, *, trigger="recalculated", actor=None):
            return PriorityScore.objects.create(complaint=complaint, severity_component=30, impact_component=20,
                                                location_component=10, frequency_component=5,
                                                duplicate_component=5, final_score=70, priority_level="high",
                                                weights={"severity": 40, "public_impact": 25, "location_risk": 15,
                                                         "frequency": 10, "duplicates": 10}, created_by=actor)

        with mock.patch("apps.complaints.services.priority.recalculate_priority", side_effect=fake_recalculate) as svc:
            response = self.as_user(self.officer).post(reverse("ai-priority"), {"complaint_id": self.c_assigned.pk},
                                                       format="json")
            out_of_scope = self.as_user(self.waste_officer).post(reverse("ai-priority"),
                                                                 {"complaint_id": self.c_assigned.pk}, format="json")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(set(response.data), PRIORITY_KEYS)
        self.assertEqual(response.data["components"][0], {"key": "severity", "label": "Severity", "score": 30.0,
                                                          "max": 40.0, "raw": 0.75})
        self.assertServiceCall(svc, with_request=False, actor=self.officer)
        self.assertEqual(out_of_scope.status_code, 404)
        self.assertEqual(self.as_user(self.citizen).post(reverse("ai-priority"), {"complaint_id": self.c_assigned.pk},
                                                         format="json").status_code, 403)

    def test_priority_simulation_merges_weight_overrides(self):
        engine_output = {"final_score": 71, "priority_level": "high", "components": {}, "weights": {},
                         "factors": {}, "explanation": "High priority because ...", "summary": "Priority Score: 71/100"}
        with mock.patch("ai.priority.PriorityEngine") as engine_class:
            engine_class.return_value.calculate.return_value = engine_output
            response = self.as_user(self.admin).post(reverse("ai-priority"), {
                "severity_score": 80, "public_impact": 0.6, "location_risk": 0.5, "nearby_count": 4,
                "frequency_count": 2, "duplicate_count": 1, "category": "pothole", "weights": {"severity": 50},
            }, format="json")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data, engine_output)
        config = engine_class.call_args.args[0]
        self.assertEqual(config["weights"], {"severity": 50.0, "public_impact": 25.0, "location_risk": 15.0,
                                             "frequency": 10.0, "duplicates": 10.0})
        self.assertEqual(config["thresholds"], {"medium": 26, "high": 51, "critical": 76})
        inputs = engine_class.return_value.calculate.call_args.args[0]
        self.assertEqual(inputs, {"severity_score": 80.0, "public_impact": 0.6, "location_risk": 0.5,
                                  "nearby_count": 4, "frequency_count": 2, "duplicate_count": 1,
                                  "category_safety_weight": 0.75, "is_reopened": False, "category": "pothole"})

    def test_priority_simulation_validation(self):
        client = self.as_user(self.admin)
        bad_inputs = [
            {"severity_score": 120},
            {"severity_score": 50, "weights": {"speed": 10}},
            {"severity_score": 50, "nearby_count": 1, "frequency_count": 3},
            {"severity_score": 50, "weights": {k: 0 for k in ("severity", "public_impact", "location_risk",
                                                              "frequency", "duplicates")}},
        ]
        with mock.patch("ai.priority.PriorityEngine") as engine_class:
            for payload in bad_inputs:
                with self.subTest(payload=payload):
                    self.assertEqual(client.post(reverse("ai-priority"), payload, format="json").status_code, 400)
            engine_class.assert_not_called()

    def test_priority_simulation_with_real_engine(self):
        response = self.as_user(self.admin).post(reverse("ai-priority"), {"severity_score": 85, "public_impact": 0.8,
                                                                          "location_risk": 0.6, "nearby_count": 5,
                                                                          "frequency_count": 3, "duplicate_count": 2},
                                                 format="json")
        if response.status_code == 503:
            self.skipTest(f"Priority engine not implemented yet ({response.data['detail']})")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertTrue(0 <= response.data["final_score"] <= 100)
        self.assertEqual(set(response.data["components"]),
                         {"severity", "public_impact", "location_risk", "frequency", "duplicates"})

    # --- duplicates --------------------------------------------------------------------------------
    def test_duplicates_rerun_for_stored_complaint_returns_links(self):
        with mock.patch("apps.complaints.services.duplicates.detect_duplicates", return_value=[]) as detect:
            response = self.as_user(self.officer).post(reverse("ai-duplicates"), {"complaint_id": self.c_assigned.pk},
                                                       format="json")
            hidden = self.as_user(self.citizen).post(reverse("ai-duplicates"), {"complaint_id": self.c_unassigned.pk},
                                                     format="json")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(detect.call_args.args[0].pk, self.c_assigned.pk)
        self.assertEqual([(link["direction"], link["other"]["id"]) for link in response.data],
                         [("duplicate", self.c_unassigned.pk)])
        self.assertEqual(set(response.data[0]), DUPLICATE_LINK_KEYS)
        self.assertEqual(hidden.status_code, 404)

    def test_similar_nearby_check_delegates_to_preview_service(self):
        matches = [
            {"complaint": self.c_assigned, "text_similarity": 0.86, "image_similarity": 0.9,
             "location_similarity": 0.97, "overall_similarity": 0.89, "distance_m": 30.0, "category_match": True,
             "is_duplicate": True, "explanation": "Very similar"},
            {"complaint": self.c_unassigned, "text_similarity": 0.5, "image_similarity": None,
             "location_similarity": 0.9, "overall_similarity": 0.55, "distance_m": 40.0, "category_match": True,
             "is_duplicate": False, "explanation": "Somewhat similar"},
        ]
        with mock.patch("apps.complaints.services.duplicates.preview_duplicates", return_value=matches) as preview, \
                mock.patch("ai.nlp.analyze_text", return_value=TEXT_RESULT) as nlp:
            response = self.as_user(self.citizen).post(
                reverse("ai-duplicates"),
                {"description": "Big road pothole outside school", "latitude": "17.4127", "longitude": "78.4483",
                 "image": jpeg_upload("new.jpg")},
                format="multipart",
            )
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual([item["complaint"]["id"] for item in response.data], [self.c_assigned.pk, self.c_unassigned.pk])
        item = response.data[0]
        self.assertEqual(set(item), {"complaint", "text_similarity", "image_similarity", "location_similarity",
                                     "overall_similarity", "distance_m", "category_match", "is_duplicate",
                                     "explanation"})
        self.assertEqual(set(item["complaint"]), COMPLAINT_MINI_KEYS)
        self.assertIs(item["is_duplicate"], True)
        kwargs = preview.call_args.kwargs
        self.assertEqual((kwargs["text"], kwargs["latitude"], kwargs["longitude"]),
                         ("Big road pothole outside school", 17.4127, 78.4483))
        self.assertSanitisedName(kwargs["filename"], "new.jpg")
        self.assertTrue(kwargs["image_data"].startswith(b"\xff\xd8"))
        self.assertEqual(kwargs["category_slug"], "pothole")  # predicted by the text classifier
        self.assertEqual(nlp.call_args.args[0], "Big road pothole outside school")

    def test_similar_nearby_check_uses_hint_and_tolerates_missing_nlp(self):
        client = self.as_user(self.citizen)
        form = {"description": "Garbage pile", "latitude": "17.4375", "longitude": "78.4483"}
        with mock.patch("apps.complaints.services.duplicates.preview_duplicates", return_value=[]) as preview, \
                mock.patch("ai.nlp.analyze_text", side_effect=NotImplementedError) as nlp:
            hinted = client.post(reverse("ai-duplicates"), {**form, "category": "garbage"}, format="multipart")
            self.assertEqual(preview.call_args.kwargs["category_slug"], "garbage")
            nlp.assert_not_called()
            unhinted = client.post(reverse("ai-duplicates"), form, format="multipart")
        self.assertEqual((hinted.status_code, hinted.data, unhinted.status_code), (200, [], 200))
        self.assertIsNone(preview.call_args.kwargs["category_slug"])  # no category is guessed
        self.assertIsNone(preview.call_args.kwargs["image_data"])
        missing = client.post(reverse("ai-duplicates"), {"description": "Garbage pile"}, format="multipart")
        self.assertEqual(missing.status_code, 400)
        self.assertEqual(set(missing.data["errors"]), {"latitude", "longitude"})

    def test_similar_nearby_check_with_real_services(self):
        """Real preview service + engines; skipped only while a component still raises NotImplementedError."""
        response = self.as_user(self.citizen).post(
            reverse("ai-duplicates"),
            {"description": "Big road pothole outside the school", "latitude": "17.412650", "longitude": "78.448250",
             "category": "pothole"}, format="multipart")
        if response.status_code == 503:
            self.skipTest(f"Duplicate preview not available yet ({response.data['detail']})")
        self.assertEqual(response.status_code, 200, response.data)
        for item in response.data:
            self.assertEqual(set(item["complaint"]), COMPLAINT_MINI_KEYS)
            self.assertTrue(0 <= item["overall_similarity"] <= 1)

    # --- verification ------------------------------------------------------------------------------
    def test_verify_resolution_from_two_uploads_writes_nothing(self):
        result = {"score": 88, "status": "likely_resolved", "status_label": "Likely Resolved",
                  "explanation": "Substantial change", "metrics": {"ssim": np.float64(0.41)}, "is_demo": True,
                  "disclaimer": "AI-assisted verification - not a guarantee."}
        with mock.patch("ai.verification.verify_resolution", return_value=result) as engine:
            response = self.as_user(self.officer).post(
                reverse("ai-verify-resolution"),
                {"before_image": jpeg_upload("before.jpg"), "after_image": jpeg_upload("after.jpg"),
                 "category": "pothole"}, format="multipart",
            )
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["score"], 88)
        before, after = engine.call_args.args
        self.assertTrue(isinstance(before, bytes) and isinstance(after, bytes))
        self.assertEqual(engine.call_args.kwargs["category"], "pothole")
        self.assertEqual(engine.call_args.kwargs["config"], {"resolved_threshold": 70, "partial_threshold": 45})
        self.assertEqual(ResolutionVerification.objects.count(), 1)  # only the fixture row

    def test_verify_resolution_validation_and_permissions(self):
        with mock.patch("ai.verification.verify_resolution") as engine:
            response = self.as_user(self.officer).post(reverse("ai-verify-resolution"),
                                                       {"before_image": jpeg_upload()}, format="multipart")
            self.assertEqual(response.status_code, 400)
            self.assertIn("after_image", response.data["errors"])
            citizen = self.as_user(self.citizen).post(reverse("ai-verify-resolution"), {"complaint_id": 1}, format="json")
            self.assertEqual(citizen.status_code, 403)
            engine.assert_not_called()

    def test_verify_resolution_for_stored_complaint(self):
        def fake_verify(complaint, *, actor=None, evidence=None, request=None):
            return ResolutionVerification.objects.create(complaint=complaint, score=64, status="partially_resolved",
                                                         is_demo=True)

        with mock.patch("apps.complaints.services.verification.run_ai_verification", side_effect=fake_verify) as svc:
            response = self.as_user(self.roads_colleague).post(reverse("ai-verify-resolution"),
                                                               {"complaint_id": self.c_resolved.pk}, format="json")
            not_assigned = self.as_user(self.officer).post(reverse("ai-verify-resolution"),
                                                           {"complaint_id": self.c_resolved.pk}, format="json")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(set(response.data), VERIFICATION_KEYS)
        self.assertEqual(response.data["status"], "partially_resolved")
        self.assertEqual(svc.call_count, 1)
        self.assertEqual(not_assigned.status_code, 403)  # department colleague, not the assigned officer

    def test_verify_resolution_engine_unavailable(self):
        with mock.patch("ai.verification.verify_resolution", side_effect=NotImplementedError):
            response = self.as_user(self.admin).post(
                reverse("ai-verify-resolution"),
                {"before_image": jpeg_upload("b.jpg"), "after_image": jpeg_upload("a.jpg")}, format="multipart")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.data["detail"], "Verification engine unavailable.")

    def test_verify_resolution_with_real_engine(self):
        response = self.as_user(self.admin).post(
            reverse("ai-verify-resolution"),
            {"before_image": jpeg_upload("before.jpg"), "after_image": jpeg_upload("after.jpg", blob=(118, 118, 118)),
             "category": "pothole"}, format="multipart")
        if response.status_code == 503:
            self.skipTest(f"Verification engine not implemented yet ({response.data['detail']})")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertIn(response.data["status"],
                      {"likely_resolved", "partially_resolved", "not_resolved", "needs_manual_review"})
        self.assertTrue(0 <= response.data["score"] <= 100)

    # --- sentiment / model info / throttling -------------------------------------------------------
    def test_sentiment_is_admin_only(self):
        output = {"label": "positive", "score": 0.82, "confidence": 0.9, "method": "lexicon", "is_demo": True}
        with mock.patch("ai.nlp.sentiment.analyze_sentiment", return_value=output) as engine:
            response = self.as_user(self.admin).post(reverse("ai-sentiment"), {"text": "Resolved quickly", "rating": 5},
                                                     format="json")
            self.assertEqual(self.client.post(reverse("ai-sentiment"), {}, format="json").status_code, 400)
            for user in (self.citizen, self.officer):
                self.assertEqual(self.as_user(user).post(reverse("ai-sentiment"), {"text": "ok"},
                                                         format="json").status_code, 403)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, output)
        self.assertEqual(engine.call_args.args, ("Resolved quickly", 5))

    def test_model_info_includes_configuration(self):
        response = self.as_user(self.citizen).get(reverse("ai-model-info"))
        self.assertEqual(response.status_code, 200, response.data)
        self.assertTrue({"mode", "is_demo", "models", "components", "config"} <= set(response.data))
        self.assertEqual(response.data["config"]["weight_severity"], 40.0)
        self.assertEqual(response.data["config"]["duplicate_radius_m"], 300)
        self.assertIn("updated_by", response.data["config"])
        self.assertEqual(self.client.post(reverse("ai-model-info"), {}, format="json").status_code, 405)

    def test_model_info_components_show_the_live_configuration(self):
        config = AIConfiguration.load()
        config.weight_severity, config.weight_public_impact = 50, 15
        config.duplicate_radius_m, config.hotspot_eps_m = 250, 600
        config.save()
        response = self.as_user(self.citizen).get(reverse("ai-model-info"))
        self.assertEqual(response.status_code, 200, response.data)
        components = {component["key"]: component for component in response.data["components"]}
        self.assertEqual(components["priority"]["parameters"], "configured")
        self.assertEqual((components["priority"]["weights"]["severity"], components["priority"]["weights"]["public_impact"]),
                         (50, 15))
        self.assertIn("within 250 m", components["duplicates"]["detail"])
        self.assertIn("eps = 600 m", components["hotspots"]["detail"])
        self.assertEqual(response.data["config"]["weight_severity"], 50.0)

    def test_post_ai_endpoints_use_the_ai_throttle_scope(self):
        output = {"label": "neutral", "score": 0.0}
        with mock.patch.object(ScopedRateThrottle, "THROTTLE_RATES", {"ai": "2/min"}), \
                mock.patch("ai.nlp.sentiment.analyze_sentiment", return_value=output):
            client = self.as_user(self.admin)
            codes = [client.post(reverse("ai-sentiment"), {"text": "ok"}, format="json").status_code for _ in range(3)]
            reads = [client.get(reverse("ai-model-info")).status_code for _ in range(3)]
        self.assertEqual(codes, [200, 200, 429])
        self.assertEqual(reads, [200, 200, 200])  # GET is not limited by the "ai" scope


# ---------------------------------------------------------------------------------------------------
# URL configuration
# ---------------------------------------------------------------------------------------------------
class ComplaintUrlTests(TestCase):
    def test_routes(self):
        self.assertEqual(reverse("complaint-map"), "/api/complaints/map/")
        self.assertEqual(resolve("/api/complaints/map/").url_name, "complaint-map")
        for action in ("update-status", "manual-verification", "request-manual-verification", "override-ai",
                       "timeline", "duplicates", "accept", "reject", "start", "resolve", "evidence", "verify",
                       "reopen", "remarks", "reanalyze", "close"):
            with self.subTest(action=action):
                self.assertEqual(reverse(f"complaint-{action}", args=[7]), f"/api/complaints/7/{action}/")
        for name in ("analyze", "classify", "priority", "duplicates", "verify-resolution", "sentiment", "model-info"):
            with self.subTest(name=name):
                self.assertEqual(reverse(f"ai-{name}"), f"/api/ai/{name}/")
        self.assertEqual(reverse("duplicate-detail", args=[3]), "/api/duplicates/3/")

    def test_ai_config_is_left_to_the_core_app(self):
        self.assertFalse(any(str(pattern.pattern).startswith("ai/config") for pattern in complaint_urls.urlpatterns))
