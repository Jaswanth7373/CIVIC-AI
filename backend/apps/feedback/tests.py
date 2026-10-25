"""Tests for citizen feedback: submission service, sentiment handling, pending requests and the REST API.

The AI sentiment model is mocked in most tests (its own unit tests live in ai/tests); ``RealSentimentTests``
calls the real ``ai.nlp.sentiment`` and is skipped while that module raises NotImplementedError. Unit tests use
``StatusServiceDouble`` for the complaint status service (owner B3); ``RealStatusServiceIntegrationTests`` runs the
feedback -> close -> reopen -> feedback cycle against the real module.
"""
from datetime import datetime, timedelta
from decimal import Decimal
from unittest import mock

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APITestCase

from apps.accounts.models import CitizenProfile
from apps.assignments.tests import StatusServiceDouble, require_real_status_service
from apps.complaints.models import Complaint, Location, StatusHistory
from apps.core.exceptions import ServiceError
from apps.departments.models import CivicCategory, Department
from apps.notifications.models import Notification
from apps.officers.models import OfficerProfile

from . import services
from .models import Feedback

User = get_user_model()
PASSWORD = "Civic!Pass2026"
FEEDBACK_KEYS = {
    "id", "complaint", "complaint_number", "complaint_title", "citizen", "rating", "text", "sentiment",
    "sentiment_display", "sentiment_score", "sentiment_confidence", "sentiment_model", "is_demo", "department",
    "category", "created_at",
}
COMPLAINT_MINI_KEYS = {
    "id", "complaint_number", "title", "description", "status", "status_display", "category", "thumbnail",
    "created_at", "location", "priority_score", "priority_level", "severity",
}
LOCATION_KEYS = {"latitude", "longitude", "address", "landmark", "area", "city", "pincode"}
SENTIMENT_TARGET = "ai.nlp.sentiment.analyze_sentiment"


def ai_sentiment(label, score, confidence=0.9):
    """A result in the ai.nlp.sentiment contract shape."""
    return {"label": label, "score": score, "confidence": confidence, "model_version": "demo-lexicon-sentiment-1.0",
            "mode": "demo", "is_demo": True, "method": "lexicon", "explanation": "test double"}


def make_user(email, role="citizen", **extra):
    return User.objects.create_user(email=email, password=PASSWORD, first_name=email.split("@")[0].title(),
                                    role=role, **extra)


class FeedbackFixtures:
    @classmethod
    def setUpTestData(cls):
        cls.roads = Department.objects.create(name="Roads Department", code="ROADS")
        cls.water = Department.objects.create(name="Water Supply", code="WATER")
        cls.pothole = CivicCategory.objects.create(name="Roads / Potholes", slug="pothole", department=cls.roads)
        cls.leak = CivicCategory.objects.create(name="Water Leakage", slug="water_leak", department=cls.water)
        cls.citizen = make_user("asha@test.local")
        cls.other_citizen = make_user("vikram@test.local")
        cls.admin = make_user("admin@test.local", role="admin")
        cls.officer = make_user("ravi@test.local", role="officer")
        OfficerProfile.objects.create(user=cls.officer, department=cls.roads, employee_id="RD-1001")
        cls.water_officer = make_user("meena@test.local", role="officer")
        OfficerProfile.objects.create(user=cls.water_officer, department=cls.water, employee_id="WS-2001")

    @classmethod
    def make_complaint(cls, *, citizen=None, status="resolved", resolved_days_ago=1, category=None,
                       officer=None):
        category = category or cls.pothole
        location = Location.objects.create(latitude=Decimal("17.385000"), longitude=Decimal("78.486700"),
                                           address="Road No. 12", area="Banjara Hills", city="Hyderabad")
        resolved_at = None
        if resolved_days_ago is not None and status in ("resolved", "verified", "closed"):
            resolved_at = timezone.now() - timedelta(days=resolved_days_ago)
        return Complaint.objects.create(
            citizen=citizen or cls.citizen, title=f"{category.name} near Banjara Hills",
            description="Large pothole near the school entrance.", category=category,
            department=category.department, status=status, assigned_officer=officer or cls.officer,
            priority_level="high", priority_score=64, severity="high", location=location, resolved_at=resolved_at,
        )


# ---------------------------------------------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------------------------------------------
class SubmitFeedbackTests(FeedbackFixtures, StatusServiceDouble, TestCase):
    def setUp(self):
        super().setUp()
        self.complaint = self.make_complaint()

    def submit(self, rating, text="", *, complaint=None, citizen=None, sentiment=None):
        with mock.patch(SENTIMENT_TARGET, return_value=sentiment or ai_sentiment("positive", 0.8)) as model:
            feedback = services.submit_feedback(complaint or self.complaint, citizen=citizen or self.citizen,
                                                rating=rating, text=text)
        return feedback, model

    def test_positive_feedback_closes_the_complaint_and_rewards_the_citizen(self):
        feedback, model = self.submit(5, "  The issue was resolved quickly.  ")
        model.assert_called_once_with("The issue was resolved quickly.", 5)
        self.assertEqual((feedback.rating, feedback.text), (5, "The issue was resolved quickly."))
        self.assertEqual((feedback.sentiment, feedback.sentiment_score, feedback.sentiment_confidence),
                         ("positive", 0.8, 0.9))
        self.assertEqual(feedback.sentiment_model, "demo-lexicon-sentiment-1.0")
        self.assertTrue(feedback.is_demo)

        args, kwargs = self.add_event.call_args
        self.assertEqual(args[1], "feedback")
        self.assertEqual(kwargs["actor"], self.citizen)
        self.assertEqual(kwargs["metadata"]["feedback_id"], feedback.pk)
        self.assertEqual(kwargs["metadata"]["rating"], 5)
        args, kwargs = self.change_status.call_args
        self.assertEqual((args[1], kwargs["actor"], kwargs["notify"]), ("closed", None, False))
        self.complaint.refresh_from_db()
        self.assertEqual(self.complaint.status, "closed")
        events = list(StatusHistory.objects.filter(complaint=self.complaint).values_list("event", flat=True))
        self.assertEqual(events, ["feedback", "status_changed"])

        officer_note = Notification.objects.get(user=self.officer)
        self.assertEqual((officer_note.notification_type, officer_note.level), ("feedback_received", "success"))
        self.assertIn("5/5", officer_note.message)
        self.assertFalse(Notification.objects.filter(user=self.admin).exists())
        self.assertEqual(CitizenProfile.objects.get(user=self.citizen).civic_points, 5)

    def test_negative_feedback_alerts_admins(self):
        feedback, _ = self.submit(2, "Still not fixed, waste of time.", sentiment=ai_sentiment("negative", -0.7))
        self.assertEqual(feedback.sentiment, "negative")
        admin_note = Notification.objects.get(user=self.admin)
        self.assertEqual((admin_note.notification_type, admin_note.level), ("feedback_received", "warning"))
        self.assertEqual(admin_note.link, f"/admin/complaints/{self.complaint.pk}")
        self.assertIn("Still not fixed", admin_note.message)
        self.assertEqual(Notification.objects.get(user=self.officer).level, "warning")

    def test_low_rating_alerts_admins_even_with_positive_text(self):
        self.submit(1, "Thanks", sentiment=ai_sentiment("positive", 0.4))
        self.assertTrue(Notification.objects.filter(user=self.admin, notification_type="feedback_received").exists())

    def test_rating_fallback_when_sentiment_model_is_not_implemented(self):
        expected = {1: ("negative", -1.0), 3: ("neutral", 0.0), 5: ("positive", 1.0)}
        for rating, (label, score) in expected.items():
            with self.subTest(rating=rating):
                complaint = self.make_complaint()
                with mock.patch(SENTIMENT_TARGET, side_effect=NotImplementedError("stub")):
                    feedback = services.submit_feedback(complaint, citizen=self.citizen, rating=rating, text="ok")
                self.assertEqual((feedback.sentiment, feedback.sentiment_score), (label, score))
                self.assertEqual(feedback.sentiment_model, "rating-fallback")
                self.assertTrue(feedback.is_demo)

    def test_unexpected_model_errors_also_fall_back_to_the_rating(self):
        with mock.patch(SENTIMENT_TARGET, side_effect=RuntimeError("model download failed")):
            with self.assertLogs("apps.feedback", level="ERROR"):
                feedback = services.submit_feedback(self.complaint, citizen=self.citizen, rating=4, text="Good")
        self.assertEqual((feedback.sentiment, feedback.sentiment_model), ("positive", "rating-fallback"))

    def test_model_output_is_sanitised(self):
        feedback, _ = self.submit(4, "Nice", sentiment=ai_sentiment("POSITIVE", 3.5, confidence=7))
        self.assertEqual((feedback.sentiment, feedback.sentiment_score, feedback.sentiment_confidence),
                         ("positive", 1.0, 1.0))
        complaint = self.make_complaint()
        with self.assertLogs("apps.feedback", level="ERROR"):
            feedback, _ = self.submit(4, "Nice", complaint=complaint, sentiment=ai_sentiment("mixed", 0.1))
        self.assertEqual(feedback.sentiment_model, "rating-fallback")

    def test_only_the_owner_can_give_feedback(self):
        with self.assertRaisesMessage(ServiceError, "your own complaints"):
            self.submit(4, citizen=self.other_citizen)
        self.assertFalse(Feedback.objects.exists())

    def test_complaint_must_be_resolved_or_verified(self):
        for status in ("assigned", "in_progress", "closed", "rejected"):
            with self.subTest(status=status):
                complaint = self.make_complaint(status=status)
                with self.assertRaisesMessage(ServiceError, "once the complaint is resolved"):
                    self.submit(4, complaint=complaint)
        verified = self.make_complaint(status="verified")
        self.assertEqual(self.submit(4, complaint=verified)[0].complaint_id, verified.pk)

    def test_feedback_only_once_per_resolution_cycle(self):
        first, _ = self.submit(4)
        Complaint.objects.filter(pk=self.complaint.pk).update(status="resolved")
        self.complaint.refresh_from_db()
        with self.assertRaisesMessage(ServiceError, "already given feedback"):
            self.submit(5)
        # feedback (2 h ago) -> reopened (1 h ago) -> resolved again: the citizen is asked again
        Feedback.objects.filter(pk=first.pk).update(created_at=timezone.now() - timedelta(hours=2))
        StatusHistory.objects.create(complaint=self.complaint, event="reopened", old_status="closed",
                                     new_status="reopened", timestamp=timezone.now() - timedelta(hours=1))
        feedback, _ = self.submit(2)
        self.assertEqual(Feedback.objects.filter(complaint=self.complaint).count(), 2)
        self.assertEqual(feedback.rating, 2)
        Complaint.objects.filter(pk=self.complaint.pk).update(status="resolved")
        self.complaint.refresh_from_db()
        with self.assertRaisesMessage(ServiceError, "already given feedback"):
            self.submit(5)

    def test_invalid_ratings_are_rejected(self):
        for rating in (0, 6, "x", True, 4.5, None):
            with self.subTest(rating=rating), self.assertRaisesMessage(ServiceError, "Rating must be"):
                self.submit(rating)
        self.assertEqual(self.submit("4")[0].rating, 4)

    def test_pending_feedback_for(self):
        # self.complaint: resolved 1 day ago, no feedback -> pending
        oldest = self.make_complaint(resolved_days_ago=4)
        newest = self.make_complaint(status="verified", resolved_days_ago=0)
        rated = self.make_complaint(resolved_days_ago=2)
        Feedback.objects.create(complaint=rated, citizen=self.citizen, rating=4, sentiment="positive")
        reopened = self.make_complaint(resolved_days_ago=3)
        Feedback.objects.create(complaint=reopened, citizen=self.citizen, rating=1, sentiment="negative",
                                created_at=timezone.now() - timedelta(days=6))
        StatusHistory.objects.create(complaint=reopened, event="reopened", timestamp=timezone.now() - timedelta(days=5))
        self.make_complaint(status="in_progress")
        self.make_complaint(status="closed")
        self.make_complaint(citizen=self.other_citizen)

        result = list(services.pending_feedback_for(self.citizen))
        self.assertEqual(result, [newest, self.complaint, reopened, oldest])

    def test_pending_feedback_only_counts_feedback_after_the_latest_reopen(self):
        now = timezone.now()
        rated_after_reopen = self.make_complaint(resolved_days_ago=1)
        StatusHistory.objects.create(complaint=rated_after_reopen, event="reopened", timestamp=now - timedelta(days=5))
        Feedback.objects.create(complaint=rated_after_reopen, citizen=self.citizen, rating=4, sentiment="positive",
                                created_at=now - timedelta(days=2))
        reopened_twice = self.make_complaint(resolved_days_ago=1)
        StatusHistory.objects.create(complaint=reopened_twice, event="reopened", timestamp=now - timedelta(days=8))
        Feedback.objects.create(complaint=reopened_twice, citizen=self.citizen, rating=2, sentiment="negative",
                                created_at=now - timedelta(days=6))
        StatusHistory.objects.create(complaint=reopened_twice, event="reopened", timestamp=now - timedelta(days=4))

        pending = list(services.pending_feedback_for(self.citizen))

        self.assertNotIn(rated_after_reopen, pending)
        self.assertIn(reopened_twice, pending)
        # The list agrees with the eligibility rule used when the feedback is submitted.
        self.assertIsNotNone(services.feedback_block_reason(rated_after_reopen, self.citizen))
        self.assertIsNone(services.feedback_block_reason(reopened_twice, self.citizen))

    def test_suggest_reopen_needs_low_rating_and_open_window(self):
        recent = Feedback(complaint=self.make_complaint(resolved_days_ago=1), rating=2)
        old = Feedback(complaint=self.make_complaint(resolved_days_ago=30), rating=1)
        happy = Feedback(complaint=self.make_complaint(resolved_days_ago=1), rating=4)
        self.assertTrue(services.should_suggest_reopen(recent))
        self.assertFalse(services.should_suggest_reopen(old))
        self.assertFalse(services.should_suggest_reopen(happy))


class RealSentimentTests(FeedbackFixtures, StatusServiceDouble, TestCase):
    """Uses the real ai.nlp.sentiment model once A2 has implemented it."""

    def test_real_sentiment_model_labels_positive_feedback(self):
        from ai.nlp import sentiment

        try:
            sentiment.analyze_sentiment("The issue was resolved quickly.", 5)
        except NotImplementedError:
            self.skipTest("ai.nlp.sentiment.analyze_sentiment is not implemented yet")
        feedback = services.submit_feedback(self.make_complaint(), citizen=self.citizen, rating=5,
                                            text="The issue was resolved quickly.")
        self.assertEqual(feedback.sentiment, "positive")
        self.assertNotEqual(feedback.sentiment_model, services.RATING_FALLBACK_MODEL)
        self.assertGreater(feedback.sentiment_score, 0)


class RealStatusServiceIntegrationTests(FeedbackFixtures, APITestCase):
    """End-to-end with the real apps.complaints.services.status (only the sentiment model is mocked)."""

    def setUp(self):
        require_real_status_service(self)
        sentiment_patcher = mock.patch(SENTIMENT_TARGET, return_value=ai_sentiment("negative", -0.6))
        self.addCleanup(sentiment_patcher.stop)
        sentiment_patcher.start()

    def test_feedback_closes_the_complaint_and_can_be_given_again_after_a_reopen(self):
        from apps.complaints.services import status as status_service

        complaint = self.make_complaint(status="verified")
        self.client.force_authenticate(self.citizen)
        response = self.client.post("/api/feedback/", {"complaint": complaint.pk, "rating": 2,
                                                       "text": "Still not fixed properly"}, format="json")
        self.assertEqual(response.status_code, 201, response.data)
        self.assertTrue(response.data["suggest_reopen"])
        complaint.refresh_from_db()
        self.assertEqual(complaint.status, "closed")
        self.assertIsNotNone(complaint.closed_at)
        events = list(complaint.status_history.values_list("event", flat=True))
        self.assertEqual(events, ["feedback", "closed"])
        self.assertNotIn("feedback", status_service.get_allowed_actions(complaint, self.citizen))
        self.assertEqual(list(services.pending_feedback_for(self.citizen)), [])

        # reopen -> the officer resolves again -> the citizen is asked for feedback again
        status_service.reopen_complaint(complaint, actor=self.citizen, reason="The pothole is back")
        status_service.change_status(complaint, "in_progress", actor=self.officer)
        status_service.resolve_complaint(complaint, actor=self.officer, remarks="Patched again")
        complaint.refresh_from_db()
        self.assertEqual(complaint.status, "resolved")
        self.assertIn("feedback", status_service.get_allowed_actions(complaint, self.citizen))
        self.assertEqual(list(services.pending_feedback_for(self.citizen)), [complaint])
        again = self.client.post("/api/feedback/", {"complaint": complaint.pk, "rating": 4}, format="json")
        self.assertEqual(again.status_code, 201, again.data)
        self.assertEqual(Feedback.objects.filter(complaint=complaint).count(), 2)


# ---------------------------------------------------------------------------------------------------------------
# REST API
# ---------------------------------------------------------------------------------------------------------------
class FeedbackApiTests(FeedbackFixtures, StatusServiceDouble, APITestCase):
    def setUp(self):
        super().setUp()
        sentiment_patcher = mock.patch(SENTIMENT_TARGET, return_value=ai_sentiment("positive", 0.6))
        self.addCleanup(sentiment_patcher.stop)
        self.sentiment = sentiment_patcher.start()
        self.complaint = self.make_complaint()
        self.client.force_authenticate(self.citizen)

    def post(self, data):
        return self.client.post("/api/feedback/", data, format="json")

    def test_citizen_submits_feedback(self):
        response = self.post({"complaint": self.complaint.pk, "rating": 5, "text": "Resolved quickly"})
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(set(response.data), FEEDBACK_KEYS | {"suggest_reopen"})
        self.assertFalse(response.data["suggest_reopen"])
        self.assertEqual(response.data["complaint"], self.complaint.pk)
        self.assertEqual(response.data["complaint_number"], self.complaint.complaint_number)
        self.assertEqual(response.data["sentiment_display"], "Positive")
        self.assertEqual(response.data["department"]["code"], "ROADS")
        self.assertEqual(response.data["category"]["slug"], "pothole")
        self.assertEqual(response.data["citizen"]["id"], self.citizen.pk)

    def test_low_rating_suggests_reopen(self):
        self.sentiment.return_value = ai_sentiment("negative", -0.8)
        response = self.post({"complaint": self.complaint.pk, "rating": 1, "text": "Still broken"})
        self.assertEqual(response.status_code, 201)
        self.assertTrue(response.data["suggest_reopen"])

    def test_validation_and_eligibility_errors(self):
        foreign = self.make_complaint(citizen=self.other_citizen)
        response = self.post({"complaint": foreign.pk, "rating": 4})
        self.assertEqual(response.status_code, 400)
        self.assertIn("complaint", response.data["errors"])
        response = self.post({"complaint": self.complaint.pk, "rating": 6})
        self.assertEqual(response.status_code, 400)
        self.assertIn("rating", response.data["errors"])
        open_complaint = self.make_complaint(status="in_progress")
        response = self.post({"complaint": open_complaint.pk, "rating": 4})
        self.assertEqual((response.status_code, response.data["code"]), (400, "service_error"))
        self.assertFalse(Feedback.objects.exists())

    def test_only_citizens_submit_and_see_pending(self):
        self.client.force_authenticate(self.officer)
        self.assertEqual(self.post({"complaint": self.complaint.pk, "rating": 4}).status_code, 403)
        self.assertEqual(self.client.get("/api/feedback/pending/").status_code, 403)
        self.client.force_authenticate(None)
        self.assertEqual(self.client.get("/api/feedback/").status_code, 401)

    def test_list_is_scoped_by_role(self):
        own = Feedback.objects.create(complaint=self.complaint, citizen=self.citizen, rating=4,
                                      sentiment="positive")
        water_complaint = self.make_complaint(citizen=self.other_citizen, category=self.leak,
                                              officer=self.water_officer)
        other = Feedback.objects.create(complaint=water_complaint, citizen=self.other_citizen, rating=2,
                                        sentiment="negative")
        cases = {self.citizen: {own.pk}, self.other_citizen: {other.pk}, self.officer: {own.pk},
                 self.water_officer: {other.pk}, self.admin: {own.pk, other.pk}}
        for user, expected in cases.items():
            with self.subTest(user=user.email):
                self.client.force_authenticate(user)
                response = self.client.get("/api/feedback/")
                self.assertEqual(response.status_code, 200)
                self.assertEqual({item["id"] for item in response.data["results"]}, expected)
        self.assertEqual(set(response.data["results"][0]), FEEDBACK_KEYS)

    def test_list_filters(self):
        tz = timezone.get_default_timezone()
        water_complaint = self.make_complaint(category=self.leak, officer=self.water_officer)

        def feedback(complaint, rating, sentiment, local_time):
            return Feedback.objects.create(complaint=complaint, citizen=self.citizen, rating=rating,
                                           sentiment=sentiment, created_at=timezone.make_aware(local_time, tz))

        early = feedback(self.complaint, 5, "positive", datetime(2026, 10, 1, 10, 0))
        mid = feedback(water_complaint, 3, "neutral", datetime(2026, 10, 5, 10, 0))
        late = feedback(self.complaint, 1, "negative", datetime(2026, 10, 10, 23, 30))
        next_day = feedback(water_complaint, 2, "negative", datetime(2026, 10, 11, 0, 30))
        self.client.force_authenticate(self.admin)

        def ids(**params):
            response = self.client.get("/api/feedback/", params)
            self.assertEqual(response.status_code, 200, response.data)
            return {item["id"] for item in response.data["results"]}

        self.assertEqual(ids(sentiment="negative"), {late.pk, next_day.pk})
        self.assertEqual(ids(sentiment="positive,neutral"), {early.pk, mid.pk})
        self.assertEqual(ids(rating="1,2"), {late.pk, next_day.pk})
        self.assertEqual(ids(rating="5"), {early.pk})
        self.assertEqual(ids(rating="none"), set())
        self.assertEqual(ids(department=self.water.pk), {mid.pk, next_day.pk})
        self.assertEqual(ids(department="roads"), {early.pk, late.pk})
        self.assertEqual(ids(category=self.leak.pk), {mid.pk, next_day.pk})
        self.assertEqual(ids(category="pothole"), {early.pk, late.pk})
        self.assertEqual(ids(complaint=water_complaint.pk), {mid.pk, next_day.pk})
        self.assertEqual(ids(date_from="2026-10-05"), {mid.pk, late.pk, next_day.pk})
        self.assertEqual(ids(date_to="2026-10-05"), {early.pk, mid.pk})
        self.assertEqual(ids(date_from="2026-10-10", date_to="2026-10-10"), {late.pk})
        self.assertEqual(self.client.get("/api/feedback/", {"date_from": "2026-13-45"}).status_code, 400)

    def test_pending_requests(self):
        rated = self.make_complaint()
        Feedback.objects.create(complaint=rated, citizen=self.citizen, rating=4, sentiment="positive")
        response = self.client.get("/api/feedback/pending/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.data), 1)
        item = response.data[0]
        self.assertEqual(set(item), {"complaint", "resolved_at"})
        self.assertEqual(set(item["complaint"]), COMPLAINT_MINI_KEYS)
        self.assertEqual(set(item["complaint"]["location"]), LOCATION_KEYS)
        self.assertEqual(item["complaint"]["id"], self.complaint.pk)
        self.assertEqual(item["complaint"]["category"]["slug"], "pothole")
        self.assertIsNone(item["complaint"]["thumbnail"])
        self.assertIsNotNone(item["resolved_at"])
