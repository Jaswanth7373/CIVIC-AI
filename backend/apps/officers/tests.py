"""API tests for officer management (/api/officers/) and the workload endpoint."""
from datetime import timedelta
from decimal import Decimal
from unittest import mock

from django.db import IntegrityError, connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APITestCase

from apps.accounts.models import User
from apps.audit.models import AuditLog
from apps.complaints.models import AIPrediction, Complaint, DuplicateComplaint, Level, Location
from apps.departments.models import Department
from apps.feedback.models import Feedback

from .models import OfficerProfile
from .serializers import OfficerMiniSerializer

PASSWORD = "Civic#Route2026"


def make_user(email, role=User.Role.CITIZEN, **extra):
    extra.setdefault("first_name", email.split("@")[0].title())
    return User.objects.create_user(email=email, password=PASSWORD, role=role, **extra)


def make_officer(email, department=None, employee_id=None, **profile):
    user = make_user(email, User.Role.OFFICER)
    OfficerProfile.objects.create(user=user, department=department, employee_id=employee_id or f"EMP-{user.pk:05d}",
                                  **profile)
    return user


def make_complaint(citizen, officer=None, status=Complaint.Status.ASSIGNED, **fields):
    location = Location.objects.create(latitude=Decimal("17.412300"), longitude=Decimal("78.448000"),
                                       address="Road No. 12", area="Banjara Hills", city="Hyderabad")
    return Complaint.objects.create(citizen=citizen, assigned_officer=officer, status=status, location=location,
                                    description="Open manhole near the school gate is dangerous.", **fields)


class OfficerApiTests(APITestCase):
    url = "/api/officers/"

    def setUp(self):
        self.admin = make_user("admin@example.com", User.Role.ADMIN)
        self.citizen = make_user("citizen@example.com")
        self.roads = Department.objects.create(name="Roads Department", code="ROADS", icon="traffic-cone",
                                               color="#D9480F")
        self.water = Department.objects.create(name="Water Supply", code="WATER", icon="droplets", color="#3B5BDB")

    def create_payload(self, **overrides):
        payload = {
            "email": "Ravi.Officer@Example.com", "password": PASSWORD, "first_name": "Ravi", "last_name": "Kumar",
            "phone": "9876543210", "department": self.roads.pk, "employee_id": "rd-1001",
            "designation": "Assistant Engineer", "zone": "Ward 7", "base_latitude": 17.41234567,
            "base_longitude": 78.44876543, "max_active_complaints": 8, "is_available": True,
            "skills": ["Road repair", " road repair ", "Asphalt  patching"], "joined_on": "2024-06-01",
        }
        payload.update(overrides)
        return payload

    def test_admin_creates_officer_with_profile(self):
        self.client.force_authenticate(self.admin)
        response = self.client.post(self.url, self.create_payload(), format="json")
        self.assertEqual(response.status_code, 201, response.data)
        user = User.objects.get(email="ravi.officer@example.com")
        self.assertEqual(response.data["id"], user.pk)
        self.assertEqual(user.role, User.Role.OFFICER)
        self.assertTrue(user.check_password(PASSWORD))
        self.assertEqual(response.data["user"]["full_name"], "Ravi Kumar")
        self.assertEqual(response.data["department"]["code"], "ROADS")
        self.assertEqual(response.data["department_id"], self.roads.pk)
        self.assertEqual(response.data["employee_id"], "RD-1001")
        self.assertEqual(response.data["skills"], ["Road repair", "Asphalt patching"])
        self.assertAlmostEqual(response.data["base_latitude"], 17.412346, places=6)
        self.assertEqual(response.data["active_workload"], 0)
        self.assertEqual(response.data["resolved_count"], 0)
        self.assertIsNone(response.data["avg_resolution_hours"])
        self.assertIsNone(response.data["avg_rating"])
        self.assertTrue(AuditLog.objects.filter(action="create", actor=self.admin, entity_id=str(user.pk)).exists())

    def test_create_validation_and_uniqueness(self):
        self.client.force_authenticate(self.admin)
        no_password = self.client.post(self.url, self.create_payload(password=""), format="json")
        self.assertEqual(no_password.status_code, 400)
        self.assertIn("password", no_password.data["errors"])
        self.assertEqual(self.client.post(self.url, self.create_payload(), format="json").status_code, 201)

        same_email = self.client.post(self.url, self.create_payload(employee_id="RD-2002"), format="json")
        self.assertIn("email", same_email.data["errors"])
        same_employee = self.client.post(self.url, self.create_payload(email="other@example.com",
                                                                        employee_id="RD-1001"), format="json")
        self.assertIn("employee_id", same_employee.data["errors"])
        half_coordinates = self.client.post(self.url, self.create_payload(email="third@example.com", employee_id="",
                                                                           base_longitude=None), format="json")
        self.assertIn("base_latitude", half_coordinates.data["errors"])
        self.assertEqual(User.objects.filter(role=User.Role.OFFICER).count(), 1)

    def test_create_is_atomic(self):
        self.client.force_authenticate(self.admin)
        users_before = User.objects.count()
        with mock.patch.object(OfficerProfile.objects, "create", side_effect=IntegrityError("duplicate")):
            response = self.client.post(self.url, self.create_payload(), format="json")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(User.objects.count(), users_before)  # the half-created user was rolled back

    def test_role_protection(self):
        officer = make_officer("officer@example.com", self.roads)
        self.client.force_authenticate(self.citizen)
        self.assertEqual(self.client.get(self.url).status_code, 403)
        self.assertEqual(self.client.post(self.url, self.create_payload(), format="json").status_code, 403)

        self.client.force_authenticate(officer)
        listing = self.client.get(self.url)
        self.assertEqual(listing.status_code, 200)
        self.assertEqual(listing.data["count"], 1)
        self.assertEqual(self.client.get(f"{self.url}{officer.pk}/").status_code, 200)
        self.assertEqual(self.client.post(self.url, self.create_payload(), format="json").status_code, 403)
        self.assertEqual(self.client.patch(f"{self.url}{officer.pk}/", {"zone": "X"}, format="json").status_code, 403)
        self.assertEqual(self.client.delete(f"{self.url}{officer.pk}/").status_code, 403)

    def test_list_aggregates(self):
        officer = make_officer("ravi@example.com", self.roads)
        make_complaint(self.citizen, officer, Complaint.Status.ASSIGNED)
        make_complaint(self.citizen, officer, Complaint.Status.IN_PROGRESS)
        created = timezone.now() - timedelta(hours=30)
        resolved = make_complaint(self.citizen, officer, Complaint.Status.CLOSED, created_at=created,
                                  resolved_at=created + timedelta(hours=10))
        second = make_complaint(self.citizen, officer, Complaint.Status.VERIFIED, created_at=created,
                                resolved_at=created + timedelta(hours=20))
        Feedback.objects.create(complaint=resolved, citizen=self.citizen, rating=5, sentiment="positive")
        Feedback.objects.create(complaint=second, citizen=self.citizen, rating=2, sentiment="negative")
        make_complaint(self.citizen, None, Complaint.Status.SUBMITTED)  # not this officer's

        self.client.force_authenticate(self.admin)
        row = self.client.get(self.url).data["results"][0]
        self.assertEqual(row["active_workload"], 2)
        self.assertEqual(row["resolved_count"], 2)
        self.assertEqual(row["avg_resolution_hours"], 15.0)
        self.assertEqual(row["avg_rating"], 3.5)
        detail = self.client.get(f"{self.url}{officer.pk}/").data
        self.assertEqual((detail["active_workload"], detail["avg_resolution_hours"]), (2, 15.0))

    def test_list_query_count_does_not_grow_with_rows(self):
        self.client.force_authenticate(self.admin)

        def count_queries():
            with CaptureQueriesContext(connection) as context:
                response = self.client.get(self.url)
            self.assertEqual(response.status_code, 200)
            return len(context.captured_queries)

        for index in range(2):
            officer = make_officer(f"first{index}@example.com", self.roads)
            make_complaint(self.citizen, officer)
        few = count_queries()
        for index in range(6):
            officer = make_officer(f"more{index}@example.com", self.water)
            make_complaint(self.citizen, officer, Complaint.Status.RESOLVED, resolved_at=timezone.now())
        self.assertEqual(count_queries(), few)

    def test_update_officer_and_optional_password(self):
        officer = make_officer("ravi@example.com", self.roads, employee_id="RD-1001")
        self.client.force_authenticate(self.admin)
        detail = f"{self.url}{officer.pk}/"
        response = self.client.patch(detail, {"department": self.water.pk, "designation": "Junior Engineer",
                                              "password": "", "max_active_complaints": 12}, format="json")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["department"]["code"], "WATER")
        self.assertEqual(response.data["max_active_complaints"], 12)
        officer.refresh_from_db()
        self.assertTrue(officer.check_password(PASSWORD))  # blank password keeps the old one

        changed = self.client.patch(detail, {"password": "Fresh#Route2027"}, format="json")
        self.assertEqual(changed.status_code, 200)
        officer.refresh_from_db()
        self.assertTrue(officer.check_password("Fresh#Route2027"))
        log = AuditLog.objects.filter(action="update", entity_id=str(officer.pk)).first()
        self.assertEqual(log.changes.get("password"), "changed")

        put = self.client.put(detail, {"email": "ravi@example.com", "first_name": "Ravi", "zone": "Ward 9"},
                              format="json")
        self.assertEqual(put.status_code, 200, put.data)
        self.assertEqual(put.data["zone"], "Ward 9")

    def test_delete_deactivates_the_officer(self):
        officer = make_officer("ravi@example.com", self.roads)
        make_complaint(self.citizen, officer, Complaint.Status.ACCEPTED)
        self.client.force_authenticate(self.admin)
        response = self.client.delete(f"{self.url}{officer.pk}/")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.data["deactivated"])
        self.assertEqual(response.data["open_complaints"], 1)
        officer.refresh_from_db()
        self.assertFalse(officer.is_active)
        self.assertFalse(officer.officer_profile.is_available)
        self.assertTrue(OfficerProfile.objects.filter(user=officer).exists())
        self.assertEqual(self.client.get(self.url, {"is_active": "false"}).data["count"], 1)

    def test_filters_and_search(self):
        make_officer("ravi@example.com", self.roads, zone="Ward 7")
        make_officer("sita@example.com", self.water, is_available=False)
        self.client.force_authenticate(self.admin)
        self.assertEqual(self.client.get(self.url, {"department": self.roads.pk}).data["count"], 1)
        self.assertEqual(self.client.get(self.url, {"department": "water"}).data["count"], 1)
        self.assertEqual(self.client.get(self.url, {"is_available": "false"}).data["count"], 1)
        self.assertEqual(self.client.get(self.url, {"search": "sita"}).data["count"], 1)
        self.assertEqual(self.client.get(self.url, {"zone": "ward"}).data["count"], 1)
        ordered = self.client.get(self.url, {"ordering": "-stat_active_workload"})
        self.assertEqual(ordered.status_code, 200)

    def test_workload_endpoint(self):
        officer = make_officer("ravi@example.com", self.roads, max_active_complaints=4)
        low = make_complaint(self.citizen, officer, Complaint.Status.ASSIGNED, priority_score=30,
                             priority_level=Level.MEDIUM)
        critical = make_complaint(self.citizen, officer, Complaint.Status.IN_PROGRESS, priority_score=88,
                                  priority_level=Level.CRITICAL)
        make_complaint(self.citizen, officer, Complaint.Status.ACCEPTED, priority_score=60, priority_level=Level.HIGH)
        make_complaint(self.citizen, officer, Complaint.Status.RESOLVED, resolved_at=timezone.now())
        AIPrediction.objects.create(complaint=critical, multimodal_confidence=0.91, is_demo=True)
        DuplicateComplaint.objects.create(complaint=critical, similar_complaint=low, overall_similarity=0.8)

        self.client.force_authenticate(self.admin)
        response = self.client.get(f"{self.url}{officer.pk}/workload/")
        self.assertEqual(response.status_code, 200)
        data = response.data
        self.assertEqual((data["active"], data["capacity"], data["critical"]), (3, 4, 1))
        self.assertEqual((data["utilization"], data["overloaded"]), (0.75, False))
        self.assertEqual(data["by_status"], {"assigned": 1, "accepted": 1, "in_progress": 1, "reopened": 0})
        self.assertEqual([item["id"] for item in data["complaints"]][0], critical.pk)  # highest priority first
        first = data["complaints"][0]
        expected = {"id", "complaint_number", "title", "description", "category", "status", "status_display",
                    "severity", "severity_score", "priority_score", "priority_level", "department",
                    "assigned_officer", "citizen", "location", "thumbnail", "duplicate_count",
                    "has_pending_duplicates", "is_overdue", "sla_due_at", "ai_is_demo", "ai_confidence",
                    "needs_manual_review", "created_at", "updated_at", "resolved_at"}
        self.assertEqual(set(first), expected)
        self.assertTrue(first["has_pending_duplicates"])
        self.assertTrue(first["ai_is_demo"])
        self.assertEqual(first["ai_confidence"], 0.91)
        self.assertEqual(first["assigned_officer"]["id"], officer.pk)
        self.assertEqual(first["location"]["area"], "Banjara Hills")
        self.assertEqual(first["status_display"], "In Progress")

    def test_workload_is_clamped_and_matches_the_officer_list(self):
        officer = make_officer("ravi@example.com", self.roads, max_active_complaints=2)
        for status in (Complaint.Status.ASSIGNED, Complaint.Status.ACCEPTED, Complaint.Status.IN_PROGRESS):
            make_complaint(self.citizen, officer, status)
        self.client.force_authenticate(self.admin)
        workload = self.client.get(f"{self.url}{officer.pk}/workload/").data
        self.assertEqual((workload["active"], workload["capacity"]), (3, 2))
        self.assertEqual((workload["utilization"], workload["overloaded"]), (1.0, True))
        row = self.client.get(self.url).data["results"][0]
        self.assertEqual(row["active_workload"], workload["active"])
        self.assertEqual(len(workload["complaints"]), 3)

    def test_officer_sees_only_own_workload(self):
        ravi = make_officer("ravi@example.com", self.roads)
        sita = make_officer("sita@example.com", self.roads)
        self.client.force_authenticate(ravi)
        self.assertEqual(self.client.get(f"{self.url}{ravi.pk}/workload/").status_code, 200)
        self.assertEqual(self.client.get(f"{self.url}{sita.pk}/workload/").status_code, 403)
        self.client.force_authenticate(self.citizen)
        self.assertEqual(self.client.get(f"{self.url}{ravi.pk}/workload/").status_code, 403)

    def test_officer_mini_serializer_shape(self):
        officer = make_officer("ravi@example.com", self.roads, employee_id="RD-1001", zone="Ward 7")
        data = OfficerMiniSerializer(officer).data
        self.assertEqual(set(data), {"id", "full_name", "email", "role", "avatar", "phone", "employee_id",
                                     "designation", "zone", "department", "is_available"})
        self.assertEqual(data["department"]["code"], "ROADS")
        plain = OfficerMiniSerializer(self.citizen).data  # no profile -> None values, no crash
        self.assertIsNone(plain["employee_id"])
