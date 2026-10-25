"""API-level end-to-end tests of the whole CivicAI platform.

Every step goes through the REST API exactly like the web app: real JWT tokens from ``/api/auth/login/``, the real
AI engine in demo mode (vision heuristics, TF-IDF text classifier, fusion, severity, priority, duplicate engine,
OpenCV before/after verification, lexicon sentiment) and real generated sample photos from
``backend/sample_data/images``. Nothing is mocked; uploads go to a temporary MEDIA_ROOT.

Scenario (``test_complaint_lifecycle_end_to_end``)
    reference data (``init_civicai``) -> admin creates ROADS and DRAIN officers -> a citizen registers and logs in
    -> submits a pothole photo + description next to a seeded risk zone (Osmania General Hospital) -> full AI
    analysis, priority, routing to ROADS, auto-assignment, notifications, canonical timeline -> a second citizen
    reports the same pothole 30 m away -> duplicate pending review -> the officer accepts, starts, uploads
    before/after photos and resolves -> AI verification -> verified -> citizen feedback (sentiment positive) ->
    closed -> citizen reopens -> admin overrides the AI category -> workload numbers agree on every endpoint ->
    analytics, dashboards and CSV / PDF reports reflect exactly this data.

``test_category_routing`` submits one complaint per category and checks the department routing table;
``test_engine_failure_keeps_the_complaint_and_reports_the_engine_steps`` breaks both AI modalities and checks that
the submission still succeeds with the engine's own step report (``ai.pipeline.AnalysisError.steps``).
"""
import csv
import io
import os
import shutil
import tempfile
from pathlib import Path
from unittest import mock

from django.conf import settings
from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.management import call_command
from django.test import override_settings
from rest_framework.test import APIClient, APITestCase

from apps.accounts.models import User
from apps.assignments.models import ComplaintAssignment
from apps.audit.models import AuditLog
from apps.complaints.models import AIPrediction, Complaint, DuplicateComplaint, PriorityScore, ResolutionVerification
from apps.core.models import AIConfiguration
from apps.notifications.models import Notification

SAMPLE_IMAGES = Path(settings.BASE_DIR) / "sample_data" / "images"
ADMIN_EMAIL, ADMIN_PASSWORD = "admin@e2e.civicai.test", "Admin#Civic2026"
OFFICER_PASSWORD = "Officer#Civic2026"
CITIZEN_PASSWORD = "Citizen#Civic2026"

#: Next to the seeded risk zone "Osmania General Hospital, Afzal Gunj" (17.372954, 78.474270, radius 300 m).
HOSPITAL_SITE = {"latitude": "17.373300", "longitude": "78.474500", "address": "Afzal Gunj main road",
                 "area": "Afzal Gunj", "city": "Hyderabad", "pincode": "500012"}
#: 30 m north of HOSPITAL_SITE (0.00027 degrees of latitude).
NEARBY_SITE = {**HOSPITAL_SITE, "latitude": "17.373570"}
POTHOLE_TEXT = ("Large pothole on the main road near Osmania General Hospital entrance; ambulances and two-wheelers "
                "swerve dangerously around it.")
DUPLICATE_TEXT = ("Big pothole on the main road near Osmania General Hospital gate, ambulances and bikes swerving "
                  "dangerously around it.")
FEEDBACK_TEXT = "The pothole was repaired quickly, great work by the officer. Thank you!"

SUBMISSION_STEPS = [
    "validate", "upload", "save", "preprocess", "image_analysis", "text_analysis", "multimodal_fusion", "severity",
    "priority", "duplicate_detection", "department_routing", "officer_assignment", "database_save", "notification",
]
PRIORITY_COMPONENTS = [("severity", "Severity"), ("public_impact", "Public Impact"), ("location_risk", "Location Risk"),
                       ("frequency", "Frequency"), ("duplicates", "Duplicates")]
SUBMISSION_TIMELINE = ["submitted", "ai_analyzed", "priority_assigned", "department_assigned", "officer_assigned"]
WORKLOAD_KEYS = ("active", "capacity", "utilization", "overloaded")


def sample_photo(slug):
    """First generated sample photo of a category."""
    files = sorted((SAMPLE_IMAGES / slug).glob("*.jpg"))
    if not files:
        raise AssertionError(f"No sample photos in {SAMPLE_IMAGES / slug}; run scripts/generate_sample_images.py")
    return files[0]


def after_photo(before):
    """The generated "repaired" photo of the same scene (``after/<name>_after.jpg``)."""
    path = SAMPLE_IMAGES / "after" / f"{before.stem}_after.jpg"
    if not path.exists():
        raise AssertionError(f"Missing repaired sample photo {path}")
    return path


def upload(path):
    return SimpleUploadedFile(path.name, path.read_bytes(), content_type="image/jpeg")


def is_subsequence(expected, actual):
    """True when ``expected`` appears in ``actual`` in the same order (other items may be interleaved)."""
    remaining = iter(actual)
    return all(item in remaining for item in expected)


@mock.patch.dict(os.environ, {"MODEL_MODE": "demo"})
class EndToEndApiTests(APITestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.media_root = tempfile.mkdtemp(prefix="civicai-e2e-media-")
        cls.enterClassContext(override_settings(MEDIA_ROOT=cls.media_root))

    @classmethod
    def tearDownClass(cls):
        super().tearDownClass()
        shutil.rmtree(cls.media_root, ignore_errors=True)

    @classmethod
    def setUpTestData(cls):
        call_command("init_civicai", admin_email=ADMIN_EMAIL, admin_password=ADMIN_PASSWORD, stdout=io.StringIO())

    # ------------------------------------------------------------------------------------------------------
    # API helpers
    # ------------------------------------------------------------------------------------------------------
    def login(self, email, password):
        client = APIClient()
        response = client.post("/api/auth/login/", {"email": email, "password": password}, format="json")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(set(response.data), {"access", "refresh", "user"})
        client.credentials(HTTP_AUTHORIZATION=f"Bearer {response.data['access']}")
        client.user_id = response.data["user"]["id"]
        return client

    def register_and_login(self, email, first_name, last_name):
        response = APIClient().post("/api/auth/register/", {
            "email": email, "password": CITIZEN_PASSWORD, "confirm_password": CITIZEN_PASSWORD,
            "first_name": first_name, "last_name": last_name, "phone": "9876543210",
        }, format="json")
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(response.data["user"]["role"], "citizen")
        return self.login(email, CITIZEN_PASSWORD)

    def create_officer(self, admin, email, code, base):
        departments = {item["code"]: item["id"] for item in admin.get("/api/departments/").data}
        response = admin.post("/api/officers/", {
            "email": email, "password": OFFICER_PASSWORD, "first_name": code.title(), "last_name": "Officer",
            "department": departments[code], "employee_id": f"{code}-1001", "designation": "Field Officer",
            "base_latitude": base[0], "base_longitude": base[1], "max_active_complaints": 10, "is_available": True,
        }, format="json")
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(response.data["department"]["code"], code)
        return self.login(email, OFFICER_PASSWORD)

    def submit(self, citizen, description, site, photo):
        response = citizen.post("/api/complaints/", {**site, "description": description, "image": upload(photo)},
                                format="multipart")
        self.assertEqual(response.status_code, 201, response.data)
        return response.data

    def ok(self, response, status_code=200):
        self.assertEqual(response.status_code, status_code, getattr(response, "data", response.content[:300]))
        return response.data

    def notification_types(self, client):
        rows = self.ok(client.get("/api/notifications/", {"page_size": 100}))["results"]
        return [row["notification_type"] for row in rows], rows

    # ------------------------------------------------------------------------------------------------------
    # The scenario
    # ------------------------------------------------------------------------------------------------------
    def test_complaint_lifecycle_end_to_end(self):
        admin = self.login(ADMIN_EMAIL, ADMIN_PASSWORD)
        roads = self.create_officer(admin, "roads.officer@e2e.civicai.test", "ROADS", ("17.373700", "78.474100"))
        drain = self.create_officer(admin, "drain.officer@e2e.civicai.test", "DRAIN", ("17.380000", "78.480000"))
        ravi = self.register_and_login("ravi@e2e.civicai.test", "Ravi", "Kumar")
        photo = sample_photo("pothole")

        first = self.check_submission(ravi, roads, photo)
        self.check_priority_recalculation_is_consistent(admin, first)
        self.check_submission_notifications(ravi, roads, first)
        second = self.check_duplicate_report(admin, roads, first, photo)
        verification = self.check_resolution(roads, first, photo)
        self.check_feedback(ravi, first)
        self.check_reopen(ravi, roads, first, verification)
        self.check_admin_override(admin, second)
        self.check_workload_agrees_everywhere(admin, roads, second)
        self.check_analytics(admin, ravi, roads, drain, first, second)
        self.check_reports(admin, first, second)

    def check_submission(self, citizen, roads, photo):
        data = self.submit(citizen, POTHOLE_TEXT, HOSPITAL_SITE, photo)
        steps = data["analysis"]["steps"]
        self.assertEqual([step["key"] for step in steps], SUBMISSION_STEPS)
        self.assertEqual({step["key"]: step["status"] for step in steps if step["status"] != "done"}, {},
                         [(step["key"], step["detail"]) for step in steps])
        self.assertTrue(all(step["duration_ms"] >= 0 and step["label"] for step in steps))

        self.assertEqual(data["category"]["slug"], "pothole")
        self.assertEqual(data["department"]["code"], "ROADS")
        self.assertEqual(data["assigned_officer"]["id"], roads.user_id)
        self.assertEqual(data["status"], "assigned")
        self.assertTrue(data["complaint_number"].startswith("CIV-"))
        self.assertIsNotNone(data["sla_due_at"])

        summary = data["analysis"]["summary"]
        self.assertEqual((summary["category"]["slug"], summary["department"]["code"], summary["officer"]["id"]),
                         ("pothole", "ROADS", roads.user_id))
        self.assertEqual((summary["is_demo"], summary["mode"], summary["duplicates_found"]), (True, "demo", 0))
        self.assertEqual((summary["priority_score"], summary["priority_level"]),
                         (data["priority_score"], data["priority_level"]))

        prediction = data["ai_prediction"]
        self.assertEqual((prediction["is_demo"], prediction["model_mode"]), (True, "demo"))
        self.assertEqual(prediction["final_category_slug"], "pothole")
        self.assertIn("demo", prediction["explanation"].lower())  # demo results are always labelled as such
        stored = AIPrediction.objects.get(complaint_id=data["id"])
        self.assertTrue(stored.is_demo)
        self.assertEqual(stored.final_category.slug, "pothole")
        zones = [zone["name"] for zone in prediction["location_risk"]["zones"]]
        self.assertIn("Osmania General Hospital, Afzal Gunj", zones)  # the seeded risk zone was used

        priority = data["priority"]
        self.assertEqual([(item["key"], item["label"]) for item in priority["components"]], PRIORITY_COMPONENTS)
        self.assertEqual([item["max"] for item in priority["components"]], [40.0, 25.0, 15.0, 10.0, 10.0])
        self.assertAlmostEqual(sum(item["score"] for item in priority["components"]), priority["final_score"],
                               delta=1.0)
        self.assertEqual(priority["final_score"], data["priority_score"])
        self.assertEqual(priority["trigger"], "initial")
        self.assertGreater(priority["components"][2]["raw"], 0.5)  # high-risk location (hospital)

        self.assertEqual([event["event"] for event in data["timeline"]], SUBMISSION_TIMELINE)
        self.assertEqual(data["timeline"][1]["actor_label"], "CivicAI Engine")
        assignments = self.ok(roads.get("/api/assignments/", {"complaint": data["id"]}))["results"]
        self.assertEqual([(row["assignment_type"], row["is_active"], row["assigned_by"]) for row in assignments],
                         [("auto", True, None)])
        return data

    def check_priority_recalculation_is_consistent(self, admin, first):
        """Initial and recalculated priorities use the same engine inputs (public impact rule included)."""
        recalculated = self.ok(admin.post("/api/ai/priority/", {"complaint_id": first["id"]}, format="json"))
        initial = first["priority"]
        self.assertEqual(recalculated["final_score"], initial["final_score"])
        self.assertEqual(recalculated["impact_component"], initial["impact_component"])
        self.assertEqual(recalculated["location_component"], initial["location_component"])
        latest, original = PriorityScore.objects.filter(complaint_id=first["id"]).order_by("-id")[:2]
        self.assertEqual(latest.factors["inputs"]["public_impact"], original.factors["inputs"]["public_impact"])
        stored = AIPrediction.objects.get(complaint_id=first["id"])
        self.assertEqual(latest.factors["inputs"]["public_impact"], round(stored.raw_output["public_impact"], 4))

    def check_submission_notifications(self, citizen, roads, first):
        types, rows = self.notification_types(citizen)
        self.assertTrue({"complaint_submitted", "ai_analysis_completed", "department_assigned",
                         "officer_assigned"} <= set(types), types)
        self.assertTrue(all(row["link"] == f"/citizen/complaints/{first['id']}" for row in rows))
        officer_types, officer_rows = self.notification_types(roads)
        self.assertIn("new_assignment", officer_types)
        self.assertTrue(all(row["link"] == f"/officer/complaints/{first['id']}" for row in officer_rows))

        unread = self.ok(citizen.get("/api/notifications/unread-count/"))["count"]
        self.assertEqual(unread, len(rows))
        read = self.ok(citizen.post(f"/api/notifications/{rows[0]['id']}/read/"))
        self.assertTrue(read["is_read"])
        self.assertEqual(self.ok(citizen.get("/api/notifications/unread-count/"))["count"], unread - 1)
        self.assertEqual(self.ok(citizen.post("/api/notifications/read-all/"))["updated"], unread - 1)

    def check_duplicate_report(self, admin, roads, first, photo):
        sita = self.register_and_login("sita@e2e.civicai.test", "Sita", "Devi")
        data = self.submit(sita, DUPLICATE_TEXT, NEARBY_SITE, photo)
        steps = {step["key"]: step for step in data["analysis"]["steps"]}
        self.assertEqual(steps["duplicate_detection"]["status"], "done")
        self.assertEqual(data["analysis"]["summary"]["duplicates_found"], 1)
        self.assertTrue(data["has_pending_duplicates"])
        self.assertEqual(data["duplicate_count"], 1)
        link = data["duplicates"][0]
        self.assertEqual((link["direction"], link["other"]["id"], link["status"]),
                         ("original", first["id"], "pending_review"))
        self.assertAlmostEqual(link["distance_m"], 30.0, delta=2.0)
        self.assertGreaterEqual(link["overall_similarity"], AIConfiguration.load().duplicate_threshold)
        self.assertEqual(link["image_similarity"], 1.0)  # the very same photo
        self.assertIn("duplicate_flagged", [event["event"] for event in data["timeline"]])
        self.assertEqual(data["priority"]["components"][4]["key"], "duplicates")
        self.assertGreater(data["priority"]["components"][4]["score"], 0)

        for client in (admin, roads):
            pairs = self.ok(client.get("/api/duplicates/"))
            self.assertEqual(pairs["count"], 1)
            pair = pairs["results"][0]
            self.assertEqual((pair["complaint"]["id"], pair["similar_complaint"]["id"], pair["status"]),
                             (data["id"], first["id"], "pending_review"))
        self.assertEqual(sita.get("/api/duplicates/").status_code, 403)
        original = self.ok(admin.get(f"/api/complaints/{first['id']}/"))
        self.assertEqual(original["duplicate_count"], 1)
        self.assertEqual(original["duplicates"][0]["direction"], "duplicate")
        return data

    def check_resolution(self, roads, first, photo):
        url = f"/api/complaints/{first['id']}"
        self.assertEqual(self.ok(roads.post(f"{url}/accept/", {"remarks": "On my way."}, format="json"))["status"],
                         "accepted")
        self.assertEqual(self.ok(roads.post(f"{url}/start/", {}, format="json"))["status"], "in_progress")
        evidence = self.ok(roads.post(f"{url}/evidence/", {
            "before_image": upload(photo), "after_image": upload(after_photo(photo)),
            "remarks": "Patched with hot-mix asphalt.",
        }, format="multipart"), status_code=201)
        self.assertTrue(evidence["before_image"].startswith("http://testserver/media/"))
        self.assertTrue(evidence["after_image"].startswith("http://testserver/media/"))

        resolved = self.ok(roads.post(f"{url}/resolve/", {"remarks": "Pothole filled and compacted."},
                                      format="multipart"))
        verification = resolved["latest_verification"]
        self.assertIsNotNone(verification, "AI verification must run automatically when an after photo exists")
        stored = ResolutionVerification.objects.get(complaint_id=first["id"])
        self.assertEqual((stored.pk, stored.status, stored.score), (verification["id"], verification["status"],
                                                                    verification["score"]))
        self.assertEqual((verification["method"], verification["is_demo"], verification["evidence_id"]),
                         ("ai_assisted", True, evidence["id"]))
        self.assertIn("AI-assisted verification", verification["explanation"])
        self.assertTrue(0 <= verification["score"] <= 100)
        if verification["status"] == "likely_resolved":
            self.assertEqual(resolved["status"], "verified")
            self.assertIsNotNone(resolved["verified_at"])
        else:
            self.assertEqual(resolved["status"], "resolved")
            self.assertTrue(resolved["needs_manual_review"])
        return verification

    def check_feedback(self, citizen, first):
        pending = self.ok(citizen.get("/api/feedback/pending/"))
        self.assertEqual([item["complaint"]["id"] for item in pending], [first["id"]])
        feedback = self.ok(citizen.post("/api/feedback/", {"complaint": first["id"], "rating": 5,
                                                           "text": FEEDBACK_TEXT}, format="json"), status_code=201)
        self.assertEqual((feedback["sentiment"], feedback["is_demo"], feedback["suggest_reopen"]),
                         ("positive", True, False))
        self.assertGreater(feedback["sentiment_score"], 0)
        closed = self.ok(citizen.get(f"/api/complaints/{first['id']}/"))
        self.assertEqual(closed["status"], "closed")
        self.assertIsNotNone(closed["closed_at"])
        self.assertIsNotNone(closed["can_reopen_until"])
        self.assertEqual(len(closed["feedback"]), 1)
        self.assertEqual(self.ok(citizen.get("/api/feedback/pending/")), [])

    def check_reopen(self, citizen, roads, first, verification):
        reopened = self.ok(citizen.post(f"/api/complaints/{first['id']}/reopen/",
                                        {"reason": "The patch sank again after the rain."}, format="json"))
        self.assertEqual((reopened["status"], reopened["reopen_count"]), ("reopened", 1))
        self.assertIsNone(reopened["resolved_at"])
        self.assertEqual(PriorityScore.objects.filter(complaint_id=first["id"]).latest("id").trigger, "reopened")
        self.assertIn("complaint_reopened", self.notification_types(roads)[0])
        expected = ["submitted", "ai_analyzed", "priority_assigned", "department_assigned", "officer_assigned",
                    "accepted", "in_progress", "evidence_uploaded", "resolved", "verification_run"]
        if verification["status"] == "likely_resolved":
            expected.append("verified")
        expected += ["feedback", "closed", "reopened"]
        events = [event["event"] for event in reopened["timeline"]]
        self.assertTrue(is_subsequence(expected, events), events)

    def check_admin_override(self, admin, second):
        data = self.ok(admin.post(f"/api/complaints/{second['id']}/override-ai/",
                                  {"category": "road_crack", "reason": "The photo shows surface cracks."},
                                  format="json"))
        self.assertEqual((data["category"]["slug"], data["is_ai_overridden"], data["department"]["code"]),
                         ("road_crack", True, "ROADS"))
        self.assertIn("ai_overridden", [event["event"] for event in data["timeline"]])
        self.assertEqual(data["ai_prediction"]["final_category_slug"], "pothole")  # the AI decision is kept
        self.assertTrue(AuditLog.objects.filter(action=AuditLog.Action.AI_OVERRIDE,
                                                entity_id=str(second["id"])).exists())

    def check_workload_agrees_everywhere(self, admin, roads, second):
        """/officers/{id}/workload/, /officers/, /assignments/recommend/, /analytics/officers/, the officer dashboard
        and the profile all report the same workload (apps.assignments.services)."""
        officer_id = roads.user_id
        expected_active = Complaint.objects.filter(assigned_officer_id=officer_id,
                                                   status__in=Complaint.OPEN_ASSIGNED_STATUSES).count()
        self.assertEqual(expected_active, 2)  # the reopened complaint and the duplicate report
        workload = self.ok(roads.get(f"/api/officers/{officer_id}/workload/"))
        self.assertEqual((workload["active"], workload["capacity"]), (2, 10))
        self.assertEqual((workload["utilization"], workload["overloaded"]), (0.2, False))
        self.assertEqual(len(workload["complaints"]), 2)
        reference = {key: workload[key] for key in WORKLOAD_KEYS}

        listing = self.ok(admin.get("/api/officers/"))["results"]
        self.assertEqual(next(row for row in listing if row["id"] == officer_id)["active_workload"], 2)
        ranked = self.ok(admin.get("/api/assignments/recommend/", {"complaint": second["id"], "limit": 10}))
        candidate = next(row for row in ranked if row["officer"]["id"] == officer_id)
        self.assertEqual({"active": candidate["workload"], "capacity": candidate["capacity"],
                          "utilization": candidate["utilization"], "overloaded": candidate["overloaded"]}, reference)
        analytics = self.ok(admin.get("/api/analytics/officers/"))
        row = next(item for item in analytics if item["officer"]["id"] == officer_id)
        self.assertEqual({key: row[key] for key in WORKLOAD_KEYS}, reference)
        self.assertEqual(self.ok(roads.get("/api/analytics/dashboard/"))["workload"], reference)
        self.assertEqual(self.ok(roads.get("/api/auth/profile/"))["officer_profile"]["active_workload"], 2)

    def check_analytics(self, admin, citizen, roads, drain, first, second):
        total = Complaint.objects.count()
        self.assertEqual(total, 2)
        overview = self.ok(admin.get("/api/analytics/overview/"))
        totals = overview["totals"]
        self.assertEqual((totals["total"], totals["reopened"], totals["duplicates_pending"]), (2, 1, 1))
        self.assertEqual(totals["pending"], 2)  # reopened + assigned
        self.assertEqual(sum(item["count"] for item in overview["status_distribution"]), total)
        self.assertEqual(sum(item["count"] for item in overview["priority_histogram"]), total)
        self.assertEqual((overview["avg_rating"], overview["satisfaction_rate"]), (5.0, 100.0))

        categories = {row["category"]["slug"]: row for row in self.ok(admin.get("/api/analytics/categories/"))}
        self.assertEqual((categories["pothole"]["total"], categories["road_crack"]["total"]), (1, 1))
        self.assertEqual(sum(row["total"] for row in categories.values()), total)
        departments = {row["department"]["code"]: row for row in self.ok(admin.get("/api/analytics/departments/"))}
        self.assertEqual(departments["ROADS"]["total"], 2)
        self.assertEqual(departments["ROADS"]["officer_count"], 1)
        self.assertEqual(departments["ROADS"]["active_workload"], 2)
        self.assertEqual(departments["DRAIN"]["total"], 0)

        trends = self.ok(admin.get("/api/analytics/trends/", {"period": "day", "days": 30}))
        self.assertEqual(sum(item["submitted"] for item in trends["series"]), total)
        hotspots = self.ok(admin.get("/api/analytics/hotspots/"))
        self.assertEqual({point["id"] for point in hotspots["points"]}, {first["id"], second["id"]})
        self.assertEqual(hotspots["clusters"], [])  # two complaints are below DBSCAN min_samples (3)

        sentiment = self.ok(admin.get("/api/analytics/sentiment/"))
        self.assertEqual((sentiment["total_feedback"], sentiment["positive_pct"], sentiment["average_rating"]),
                         (1, 100.0, 5.0))
        keywords = sentiment["top_keywords"]["positive"]
        self.assertTrue(keywords and all(set(item) == {"keyword", "count"} for item in keywords))
        self.assertEqual(sentiment["top_keywords"]["negative"], [])

        ai = self.ok(admin.get("/api/analytics/ai/"))
        self.assertEqual((ai["mode"], ai["is_demo"]), ("demo", True))
        self.assertEqual(ai["total_predictions"], AIPrediction.objects.count())
        self.assertEqual(ai["override_count"], 1)
        self.assertEqual(ai["duplicates"]["pending"], 1)
        self.assertEqual(ai["verification"]["total"], 1)
        self.assertTrue(all(component["parameters"] == "configured" for component in ai["model_info"]["components"]
                            if component["key"] in ("priority", "duplicates", "fusion")))

        officers = {row["officer"]["id"]: row for row in self.ok(admin.get("/api/analytics/officers/"))}
        self.assertEqual((officers[roads.user_id]["active"], officers[drain.user_id]["active"]), (2, 0))

        citizen_dashboard = self.ok(citizen.get("/api/analytics/dashboard/"))
        self.assertEqual((citizen_dashboard["role"], citizen_dashboard["totals"]["total"]), ("citizen", 1))
        self.assertEqual(citizen_dashboard["recent_complaints"][0]["id"], first["id"])
        officer_dashboard = self.ok(roads.get("/api/analytics/dashboard/"))
        self.assertEqual((officer_dashboard["role"], officer_dashboard["totals"]["assigned"]), ("officer", 2))
        self.assertEqual(officer_dashboard["department"]["code"], "ROADS")
        admin_dashboard = self.ok(admin.get("/api/analytics/dashboard/"))
        self.assertEqual((admin_dashboard["role"], admin_dashboard["totals"]["total"]), ("admin", 2))

        public = self.ok(APIClient().get("/api/analytics/public/"))
        self.assertEqual((public["total_complaints"], public["active_officers"], public["citizens"]), (2, 2, 2))
        self.assertNotIn("email", str(public))  # no personal data on the public page

    def check_reports(self, admin, first, second):
        response = admin.get("/api/analytics/reports/", {"report": "complaints", "format": "csv"})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response["Content-Type"].startswith("text/csv"))
        self.assertIn("attachment;", response["Content-Disposition"])
        rows = list(csv.reader(io.StringIO(response.content.decode("utf-8-sig"))))
        text = response.content.decode("utf-8-sig")
        self.assertIn(first["complaint_number"], text)
        self.assertIn(second["complaint_number"], text)
        self.assertGreaterEqual(len(rows), 3)  # header + two complaints
        pdf = admin.get("/api/analytics/reports/", {"report": "summary", "format": "pdf"})
        self.assertEqual(pdf.status_code, 200)
        self.assertEqual(pdf["Content-Type"], "application/pdf")
        self.assertTrue(pdf.content.startswith(b"%PDF"))
        self.assertEqual(AuditLog.objects.filter(action=AuditLog.Action.EXPORT).count(), 2)

    # ------------------------------------------------------------------------------------------------------
    # Routing of every civic category
    # ------------------------------------------------------------------------------------------------------
    def test_category_routing(self):
        citizen = self.register_and_login("anil@e2e.civicai.test", "Anil", "Reddy")
        cases = [
            ("garbage", "WASTE", "Garbage dumped and overflowing near the bus stop, bad smell and stray dogs everywhere."),
            ("streetlight", "ELEC", "Streetlight not working on the colony road for a week, the whole lane is dark."),
            ("fallen_tree", "PARKS", "A big tree has fallen across the road after the storm and is blocking traffic."),
            ("open_manhole", "ROADS", "Open manhole without a cover on the footpath, people can fall into it at night."),
        ]
        for index, (slug, department, description) in enumerate(cases):
            with self.subTest(category=slug):
                site = {"latitude": f"17.4{index}0000", "longitude": "78.450000", "area": "Ameerpet",
                        "city": "Hyderabad"}
                data = self.submit(citizen, description, site, sample_photo(slug))
                self.assertEqual(data["category"]["slug"], slug)
                self.assertEqual(data["department"]["code"], department)
                self.assertEqual(data["analysis"]["summary"]["department"]["code"], department)
                self.assertIn("department_assigned", [event["event"] for event in data["timeline"]])
                failed = [step["key"] for step in data["analysis"]["steps"] if step["status"] == "failed"]
                self.assertEqual(failed, [])
        manhole = Complaint.objects.get(category__slug="open_manhole")
        self.assertEqual(manhole.category.secondary_department.code, "DRAIN")

    # ------------------------------------------------------------------------------------------------------
    # Failure handling with the real pipeline
    # ------------------------------------------------------------------------------------------------------
    def test_engine_failure_keeps_the_complaint_and_reports_the_engine_steps(self):
        citizen = self.register_and_login("meena@e2e.civicai.test", "Meena", "Rao")
        with mock.patch("ai.vision.analyze_image", side_effect=RuntimeError("vision model crashed")), \
                mock.patch("ai.nlp.analyze_text", side_effect=RuntimeError("text model crashed")), \
                self.assertLogs("apps.complaints", level="ERROR"):
            data = self.submit(citizen, POTHOLE_TEXT, HOSPITAL_SITE, sample_photo("pothole"))
        steps = {step["key"]: step for step in data["analysis"]["steps"]}
        # the engine's own step report (ai.pipeline.AnalysisError.steps) is merged into the response
        self.assertEqual(steps["preprocess"]["status"], "done")
        self.assertEqual((steps["image_analysis"]["status"], steps["text_analysis"]["status"]), ("failed", "failed"))
        self.assertIn("vision model crashed", steps["image_analysis"]["detail"])
        self.assertIn("text model crashed", steps["text_analysis"]["detail"])
        self.assertEqual((steps["multimodal_fusion"]["status"], steps["severity"]["status"]), ("skipped", "skipped"))
        self.assertEqual(steps["database_save"]["status"], "done")
        self.assertEqual((data["status"], data["needs_manual_review"]), ("submitted", True))
        self.assertTrue(data["analysis"]["summary"]["needs_review"])
        self.assertFalse(AIPrediction.objects.filter(complaint_id=data["id"]).exists())
        admin = User.objects.get(email=ADMIN_EMAIL)
        self.assertTrue(Notification.objects.filter(user=admin, complaint_id=data["id"]).exists())
        self.assertFalse(ComplaintAssignment.objects.filter(complaint_id=data["id"]).exists())
        self.assertFalse(DuplicateComplaint.objects.filter(complaint_id=data["id"]).exists())
