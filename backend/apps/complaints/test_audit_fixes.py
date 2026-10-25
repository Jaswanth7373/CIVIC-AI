"""Regression tests for complaint-workflow findings of the phase-4 audit.

* privacy: a citizen never receives officers' (or other citizens') phone / e-mail, nor another citizen's report
  contents through the "similar issues nearby" check or a duplicate link;
* civic points of a deleted complaint are taken back;
* new complaints are rate limited per citizen;
* a report cannot be merged into an original that is already resolved / closed;
* the assigned officer can override an AI-assisted verification after it auto-verified the complaint.
"""
from decimal import Decimal
from unittest import mock

from django.core.cache import cache
from django.test import override_settings
from rest_framework.test import APITestCase

from apps.accounts.models import CitizenProfile, User
from apps.core.throttles import ComplaintSubmissionBurstThrottle, ComplaintSubmissionDailyThrottle
from apps.departments.models import CivicCategory, Department
from apps.officers.models import OfficerProfile

from .models import Complaint, DuplicateComplaint, Location, ResolutionVerification, StatusHistory

PASSWORD = "Civic#Route2026"
S = Complaint.Status


class AuditFixtures(APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.roads = Department.objects.create(name="Roads Department", code="ROADS")
        cls.pothole = CivicCategory.objects.create(name="Roads / Potholes", slug="pothole", department=cls.roads)
        cls.citizen = User.objects.create_user(email="rahul@example.com", password=PASSWORD, first_name="Rahul",
                                               phone="+91 98490 11111")
        cls.neighbour = User.objects.create_user(email="meena@example.com", password=PASSWORD, first_name="Meena",
                                                 phone="+91 98490 22222")
        cls.officer = User.objects.create_user(email="ravi@example.com", password=PASSWORD, role="officer",
                                               first_name="Ravi", last_name="Kumar", phone="+91 98490 33333")
        OfficerProfile.objects.create(user=cls.officer, department=cls.roads, employee_id="RD-1001",
                                      designation="Assistant Engineer")
        cls.admin = User.objects.create_user(email="anita@example.com", password=PASSWORD, role="admin",
                                             first_name="Anita")

    def make_complaint(self, citizen=None, *, status=S.ASSIGNED, officer=None, **fields):
        location = Location.objects.create(latitude=Decimal("17.437500"), longitude=Decimal("78.448300"),
                                           address="Plot 12, Ameerpet Main Road", landmark="Mythrivanam Complex",
                                           area="Ameerpet", city="Hyderabad", pincode="500016")
        return Complaint.objects.create(
            citizen=citizen or self.citizen, title="Roads / Potholes near Mythrivanam Complex, Ameerpet",
            description="Deep pothole outside my house at plot 12, my son fell off his cycle here.",
            category=self.pothole, department=self.roads, status=status, location=location,
            assigned_officer=officer, **fields,
        )


class ContactPrivacyTests(AuditFixtures):
    def test_citizen_does_not_receive_the_officers_phone_or_email(self):
        complaint = self.make_complaint(officer=self.officer)
        StatusHistory.objects.create(complaint=complaint, event="accepted", changed_by=self.officer, is_public=True)
        self.client.force_authenticate(self.citizen)
        data = self.client.get(f"/api/complaints/{complaint.pk}/").data
        officer = data["assigned_officer"]
        self.assertEqual((officer["full_name"], officer["role"]), ("Ravi Kumar", "officer"))
        self.assertIsNone(officer["phone"])
        self.assertIsNone(officer["email"])
        self.assertIsNone(data["timeline"][-1]["changed_by"]["phone"])
        self.assertEqual(data["citizen"]["phone"], "+91 98490 11111")  # their own details stay visible

        for viewer in (self.officer, self.admin):
            with self.subTest(viewer=viewer.role):
                self.client.force_authenticate(viewer)
                self.assertEqual(self.client.get(f"/api/complaints/{complaint.pk}/").data["assigned_officer"]["phone"],
                                 "+91 98490 33333")

    def test_similar_reports_check_redacts_other_citizens_reports(self):
        own = self.make_complaint()
        other = self.make_complaint(self.neighbour)
        matches = [{"complaint": complaint, "text_similarity": 0.9, "image_similarity": None,
                    "location_similarity": 1.0, "overall_similarity": 0.93, "distance_m": 12.0,
                    "category_match": True, "is_duplicate": True, "explanation": "Text 90% similar"}
                   for complaint in (other, own)]
        self.client.force_authenticate(self.citizen)
        with mock.patch("apps.complaints.services.duplicates.preview_duplicates", return_value=matches):
            response = self.client.post("/api/ai/duplicates/", {
                "description": "Deep pothole near Mythrivanam", "latitude": "17.4375", "longitude": "78.4483",
            }, format="multipart")
        self.assertEqual(response.status_code, 200, response.data)
        theirs, mine = (item["complaint"] for item in response.data)
        self.assertEqual(theirs["complaint_number"], other.complaint_number)
        self.assertEqual(theirs["title"], "Roads / Potholes in Ameerpet")
        self.assertEqual(theirs["description"], "")
        self.assertIsNone(theirs["thumbnail"])
        self.assertEqual(theirs["location"], {"latitude": None, "longitude": None, "address": "", "landmark": "",
                                              "area": "Ameerpet", "city": "Hyderabad", "pincode": ""})
        self.assertEqual((theirs["status"], theirs["category"]["slug"]), ("assigned", "pothole"))
        self.assertEqual(response.data[0]["overall_similarity"], 0.93)
        # The citizen's own report is shown in full.
        self.assertEqual(mine["description"], own.description)
        self.assertEqual(mine["location"]["landmark"], "Mythrivanam Complex")

    def test_duplicate_links_on_the_detail_page_redact_the_other_citizens_report(self):
        newer = self.make_complaint()
        original = self.make_complaint(self.neighbour)
        DuplicateComplaint.objects.create(complaint=newer, similar_complaint=original, text_similarity=0.9,
                                          location_similarity=1.0, overall_similarity=0.92)
        self.client.force_authenticate(self.citizen)
        other = self.client.get(f"/api/complaints/{newer.pk}/").data["duplicates"][0]["other"]
        self.assertEqual((other["description"], other["location"]["address"]), ("", ""))
        self.client.force_authenticate(self.admin)
        other = self.client.get(f"/api/complaints/{newer.pk}/").data["duplicates"][0]["other"]
        self.assertEqual(other["description"], original.description)


class CivicPointTests(AuditFixtures):
    def test_deleting_a_complaint_takes_its_submission_points_back(self):
        profile = CitizenProfile.objects.get(user=self.citizen)
        profile.civic_points = 13
        profile.save()
        first = self.make_complaint(status=S.ANALYZED)
        second = self.make_complaint(status=S.ANALYZED)
        self.client.force_authenticate(self.citizen)
        self.assertEqual(self.client.delete(f"/api/complaints/{first.pk}/").status_code, 204)
        profile.refresh_from_db()
        self.assertEqual(profile.civic_points, 3)
        self.assertEqual(self.client.delete(f"/api/complaints/{second.pk}/").status_code, 204)
        profile.refresh_from_db()
        self.assertEqual(profile.civic_points, 0)  # never below zero


@override_settings(TESTING=False)
class SubmissionThrottleTests(AuditFixtures):
    def setUp(self):
        cache.clear()
        self.addCleanup(cache.clear)

    def test_new_complaints_are_limited_per_citizen(self):
        self.client.force_authenticate(self.citizen)
        payload = {"description": "Large pothole near the bus stop causing traffic problems.",
                   "latitude": "17.4375", "longitude": "78.4483"}
        with mock.patch.object(ComplaintSubmissionBurstThrottle, "THROTTLE_RATES",
                               {"complaint_burst": "2/min"}), \
                mock.patch.object(ComplaintSubmissionDailyThrottle, "THROTTLE_RATES",
                                  {"complaint_daily": "100/day"}):
            statuses = [self.client.post("/api/complaints/", payload, format="multipart").status_code
                        for _ in range(3)]
            self.assertEqual(statuses, [201, 201, 429])
            # Another citizen has a budget of their own, and reading is not limited.
            self.client.force_authenticate(self.neighbour)
            self.assertEqual(self.client.post("/api/complaints/", payload, format="multipart").status_code, 201)
            self.client.force_authenticate(self.citizen)
            self.assertEqual(self.client.get("/api/complaints/").status_code, 200)


class DuplicateRecurrenceTests(AuditFixtures):
    def test_a_report_cannot_be_merged_into_a_closed_original(self):
        original = self.make_complaint(self.neighbour, status=S.CLOSED)
        newer = self.make_complaint(officer=self.officer)
        pair = DuplicateComplaint.objects.create(complaint=newer, similar_complaint=original, text_similarity=0.9,
                                                 location_similarity=1.0, overall_similarity=0.92)
        self.client.force_authenticate(self.admin)
        response = self.client.patch(f"/api/duplicates/{pair.pk}/", {"status": "confirmed_duplicate"}, format="json")
        self.assertEqual(response.status_code, 400)
        self.assertIn(f"{original.complaint_number} is already closed", response.data["detail"])
        pair.refresh_from_db()
        newer.refresh_from_db()
        self.assertEqual((pair.status, newer.status, newer.duplicate_of), ("pending_review", S.ASSIGNED, None))
        # Marking it "not a duplicate" keeps the recurrence open with its officer.
        response = self.client.patch(f"/api/duplicates/{pair.pk}/", {"status": "not_duplicate"}, format="json")
        self.assertEqual(response.status_code, 200)

    def test_a_report_can_still_be_merged_into_an_open_original(self):
        original = self.make_complaint(self.neighbour, status=S.IN_PROGRESS)
        newer = self.make_complaint()
        pair = DuplicateComplaint.objects.create(complaint=newer, similar_complaint=original, text_similarity=0.9,
                                                 location_similarity=1.0, overall_similarity=0.92)
        self.client.force_authenticate(self.admin)
        response = self.client.patch(f"/api/duplicates/{pair.pk}/", {"status": "confirmed_duplicate"}, format="json")
        self.assertEqual(response.status_code, 200, response.data)
        newer.refresh_from_db()
        self.assertEqual((newer.status, newer.duplicate_of), (S.CLOSED, original))


class OfficerVerificationOverrideTests(AuditFixtures):
    def verified_complaint(self, *, method, verified_by=None):
        complaint = self.make_complaint(officer=self.officer, status=S.VERIFIED)
        ResolutionVerification.objects.create(
            complaint=complaint, score=88, status="likely_resolved", explanation="Substantial visual change.",
            method=method, is_manual_override=method == "manual", verified_by=verified_by,
        )
        return complaint

    def test_officer_can_send_back_an_ai_verified_complaint(self):
        complaint = self.verified_complaint(method="ai_assisted")
        self.client.force_authenticate(self.officer)
        self.assertIn("manual_verify", self.client.get(f"/api/complaints/{complaint.pk}/").data["allowed_actions"])
        response = self.client.post(f"/api/complaints/{complaint.pk}/manual-verification/", {
            "status": "not_resolved", "explanation": "The patch already broke up again; more work is needed.",
        }, format="json")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual((response.data["method"], response.data["status"]), ("manual", "not_resolved"))
        complaint.refresh_from_db()
        self.assertEqual(complaint.status, S.IN_PROGRESS)

    def test_officer_cannot_overrule_an_administrators_decision(self):
        complaint = self.verified_complaint(method="manual", verified_by=self.admin)
        self.client.force_authenticate(self.officer)
        self.assertNotIn("manual_verify", self.client.get(f"/api/complaints/{complaint.pk}/").data["allowed_actions"])
        response = self.client.post(f"/api/complaints/{complaint.pk}/manual-verification/", {
            "status": "not_resolved", "explanation": "Disagree.",
        }, format="json")
        self.assertEqual(response.status_code, 400)
        self.assertIn("only an administrator", response.data["detail"])
        complaint.refresh_from_db()
        self.assertEqual(complaint.status, S.VERIFIED)
