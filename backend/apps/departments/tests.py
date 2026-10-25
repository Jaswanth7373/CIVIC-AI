"""Tests for departments, categories, routing (/api/departments/, /api/categories/, /api/departments/routing/)
and the ``init_civicai`` reference-data command."""
from decimal import Decimal
from io import StringIO

from django.core.management import CommandError, call_command
from django.test import TestCase
from rest_framework.test import APITestCase

from apps.accounts.models import User
from apps.audit.models import AuditLog
from apps.complaints.models import Complaint, Location
from apps.core.models import AIConfiguration, RiskZone
from apps.officers.models import OfficerProfile

from .defaults import DEFAULT_CATEGORIES, DEFAULT_DEPARTMENTS, DEFAULT_RISK_ZONES, ensure_reference_data
from .models import CivicCategory, Department

PASSWORD = "Civic#Route2026"


def make_user(email, role=User.Role.CITIZEN):
    return User.objects.create_user(email=email, password=PASSWORD, role=role, first_name=email.split("@")[0])


def make_complaint(citizen, *, department=None, category=None, status=Complaint.Status.SUBMITTED):
    location = Location.objects.create(latitude=Decimal("17.385"), longitude=Decimal("78.4867"))
    return Complaint.objects.create(citizen=citizen, department=department, category=category, status=status,
                                    location=location, description="Garbage dumped near the market road.")


class ReferenceDataApiTestCase(APITestCase):
    def setUp(self):
        ensure_reference_data()
        self.admin = make_user("admin@example.com", User.Role.ADMIN)
        self.citizen = make_user("citizen@example.com")
        self.roads = Department.objects.get(code="ROADS")
        self.drain = Department.objects.get(code="DRAIN")
        self.gen = Department.objects.get(code="GEN")


class DepartmentApiTests(ReferenceDataApiTestCase):
    url = "/api/departments/"

    def test_anonymous_list_is_public_non_paginated_and_hides_inactive(self):
        Department.objects.filter(code="GEN").update(is_active=False)
        response = self.client.get(self.url)
        self.assertEqual(response.status_code, 200)
        self.assertIsInstance(response.data, list)
        self.assertEqual(len(response.data), 6)
        expected = {"id", "name", "code", "description", "email", "phone", "head_name", "icon", "color", "sla_hours",
                    "is_active", "officer_count", "category_count", "open_complaints", "total_complaints",
                    "created_at", "updated_at"}
        self.assertEqual(set(response.data[0]), expected)
        # include_inactive is honoured for admins only
        self.assertEqual(len(self.client.get(self.url, {"include_inactive": "true"}).data), 6)
        self.client.force_authenticate(self.admin)
        self.assertEqual(len(self.client.get(self.url, {"include_inactive": "true"}).data), 7)
        self.assertEqual(self.client.get(f"{self.url}{self.gen.pk}/").status_code, 200)
        self.client.force_authenticate(None)
        self.assertEqual(self.client.get(f"{self.url}{self.gen.pk}/").status_code, 404)

    def test_counters(self):
        officer = make_user("officer@example.com", User.Role.OFFICER)
        OfficerProfile.objects.create(user=officer, department=self.roads, employee_id="RD-1")
        inactive_officer = make_user("old@example.com", User.Role.OFFICER)
        inactive_officer.is_active = False
        inactive_officer.save()
        OfficerProfile.objects.create(user=inactive_officer, department=self.roads, employee_id="RD-2")
        make_complaint(self.citizen, department=self.roads, status=Complaint.Status.ASSIGNED)
        make_complaint(self.citizen, department=self.roads, status=Complaint.Status.CLOSED)
        roads = next(row for row in self.client.get(self.url).data if row["code"] == "ROADS")
        self.assertEqual(roads["officer_count"], 1)
        self.assertEqual(roads["category_count"], 3)  # pothole, open_manhole, road_crack
        self.assertEqual(roads["open_complaints"], 1)
        self.assertEqual(roads["total_complaints"], 2)

    def test_admin_create_update_and_validation(self):
        self.client.force_authenticate(self.admin)
        payload = {"name": "Health & Sanitation", "code": "health", "icon": "heart-pulse", "color": "#c2255c",
                   "sla_hours": 36, "email": "health@example.com"}
        created = self.client.post(self.url, payload, format="json")
        self.assertEqual(created.status_code, 201, created.data)
        self.assertEqual(created.data["code"], "HEALTH")
        self.assertEqual(created.data["color"], "#C2255C")
        self.assertEqual(created.data["officer_count"], 0)
        self.assertTrue(AuditLog.objects.filter(action="create", entity_type="Department").exists())

        duplicate = self.client.post(self.url, {**payload, "name": "Health Two"}, format="json")
        self.assertEqual(duplicate.status_code, 400)
        self.assertIn("code", duplicate.data["errors"])
        bad = self.client.post(self.url, {"name": "Bad", "code": "BAD", "color": "red", "icon": "Not An Icon"},
                               format="json")
        self.assertEqual(set(bad.data["errors"]), {"color", "icon"})

        updated = self.client.patch(f"{self.url}{created.data['id']}/", {"sla_hours": 24, "head_name": "Dr. Rao"},
                                    format="json")
        self.assertEqual(updated.status_code, 200)
        self.assertEqual(updated.data["sla_hours"], 24)
        log = AuditLog.objects.filter(action="update", entity_type="Department").latest("created_at")
        self.assertEqual(log.changes["sla_hours"], [36, 24])

    def test_writes_require_admin(self):
        payload = {"name": "X Dept", "code": "XDEPT"}
        self.assertEqual(self.client.post(self.url, payload, format="json").status_code, 401)
        self.client.force_authenticate(self.citizen)
        self.assertEqual(self.client.post(self.url, payload, format="json").status_code, 403)
        self.assertEqual(self.client.delete(f"{self.url}{self.gen.pk}/").status_code, 403)

    def test_delete_unused_deletes_and_used_deactivates(self):
        self.client.force_authenticate(self.admin)
        spare = Department.objects.create(name="Spare Department", code="SPARE")
        self.assertEqual(self.client.delete(f"{self.url}{spare.pk}/").status_code, 204)
        self.assertFalse(Department.objects.filter(pk=spare.pk).exists())

        make_complaint(self.citizen, department=self.roads)
        response = self.client.delete(f"{self.url}{self.roads.pk}/")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.data["deactivated"])
        self.assertEqual(response.data["usage"]["complaints"], 1)
        self.assertFalse(response.data["department"]["is_active"])
        self.roads.refresh_from_db()
        self.assertFalse(self.roads.is_active)


class CategoryApiTests(ReferenceDataApiTestCase):
    url = "/api/categories/"

    def test_public_list_shape(self):
        response = self.client.get(self.url)
        self.assertEqual(response.status_code, 200)
        self.assertEqual([row["slug"] for row in response.data][:3], ["pothole", "garbage", "drainage"])
        manhole = next(row for row in response.data if row["slug"] == "open_manhole")
        self.assertEqual(manhole["department_detail"]["code"], "ROADS")
        self.assertEqual(manhole["secondary_department_detail"]["code"], "DRAIN")
        self.assertEqual((manhole["sla_hours"], manhole["effective_sla_hours"]), (12, 12))
        pothole = response.data[0]
        self.assertEqual(pothole["effective_sla_hours"], 72)  # falls back to the Roads SLA
        self.assertEqual(pothole["complaint_count"], 0)
        self.assertIn("gaddha", pothole["keywords"])

    def test_create_with_auto_unique_slug_and_term_normalisation(self):
        self.client.force_authenticate(self.admin)
        payload = {"name": "Broken Footpath", "department": self.roads.pk, "icon": "footprints", "color": "#495057",
                   "keywords": ["Footpath", " broken  footpath ", "footpath", "Sidewalk"],
                   "vision_labels": ["broken footpath", "Sidewalk_Damage"], "base_severity": 45,
                   "public_safety_weight": 0.5}
        first = self.client.post(self.url, payload, format="json")
        self.assertEqual(first.status_code, 201, first.data)
        self.assertEqual(first.data["slug"], "broken_footpath")
        self.assertEqual(first.data["keywords"], ["footpath", "broken footpath", "sidewalk"])
        self.assertEqual(first.data["vision_labels"], ["broken_footpath", "sidewalk_damage"])
        self.assertEqual(first.data["complaint_count"], 0)
        second = self.client.post(self.url, {**payload, "name": "Broken footpath!"}, format="json")
        self.assertEqual(second.status_code, 201, second.data)
        self.assertEqual(second.data["slug"], "broken_footpath_2")
        self.assertTrue(AuditLog.objects.filter(action="create", entity_type="CivicCategory").exists())

    def test_validation(self):
        self.client.force_authenticate(self.admin)
        cases = [
            ({"name": "Kw1", "keywords": "pothole"}, "keywords"),
            ({"name": "Kw2", "keywords": ["ok", "  "]}, "keywords"),
            ({"name": "Kw3", "vision_labels": [1, 2]}, "vision_labels"),
            ({"name": "Kw4", "base_severity": 140}, "base_severity"),
            ({"name": "Kw5", "public_safety_weight": 1.5}, "public_safety_weight"),
            ({"name": "Kw6", "department": self.roads.pk, "secondary_department": self.roads.pk},
             "secondary_department"),
            ({"name": "roads / potholes"}, "name"),
            ({"name": "Kw7", "slug": "pothole"}, "slug"),
        ]
        for payload, field in cases:
            with self.subTest(field=field, payload=payload):
                response = self.client.post(self.url, payload, format="json")
                self.assertEqual(response.status_code, 400)
                self.assertIn(field, response.data["errors"])

    def test_slug_is_immutable_and_updates_are_audited(self):
        self.client.force_authenticate(self.admin)
        pothole = CivicCategory.objects.get(slug="pothole")
        renamed = self.client.patch(f"{self.url}{pothole.pk}/", {"slug": "potholes"}, format="json")
        self.assertEqual(renamed.status_code, 400)
        same = self.client.patch(f"{self.url}{pothole.pk}/", {"slug": "pothole", "base_severity": 65}, format="json")
        self.assertEqual(same.status_code, 200, same.data)
        self.assertEqual(same.data["base_severity"], 65)
        log = AuditLog.objects.filter(action="update", entity_type="CivicCategory").latest("created_at")
        self.assertEqual(log.changes["base_severity"], [60, 65])

    def test_delete_used_category_deactivates(self):
        self.client.force_authenticate(self.admin)
        garbage = CivicCategory.objects.get(slug="garbage")
        make_complaint(self.citizen, category=garbage)
        response = self.client.delete(f"{self.url}{garbage.pk}/")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.data["deactivated"])
        self.assertEqual(response.data["category"]["complaint_count"], 1)
        self.assertNotIn("garbage", [row["slug"] for row in self.client.get(self.url).data])
        self.assertIn("garbage", [row["slug"] for row in self.client.get(self.url, {"include_inactive": "true"}).data])

        unused = CivicCategory.objects.create(name="Temporary", slug="temporary")
        self.assertEqual(self.client.delete(f"{self.url}{unused.pk}/").status_code, 204)

    def test_writes_require_admin(self):
        self.client.force_authenticate(self.citizen)
        self.assertEqual(self.client.post(self.url, {"name": "Nope"}, format="json").status_code, 403)


class RoutingApiTests(ReferenceDataApiTestCase):
    url = "/api/departments/routing/"

    def test_get_requires_authentication(self):
        self.assertEqual(self.client.get(self.url).status_code, 401)
        self.client.force_authenticate(self.citizen)
        response = self.client.get(self.url)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.data), 9)
        manhole = next(row for row in response.data if row["category"]["slug"] == "open_manhole")
        self.assertEqual(set(manhole), {"category", "department", "secondary_department"})
        self.assertEqual(manhole["department"]["code"], "ROADS")
        self.assertEqual(manhole["secondary_department"]["code"], "DRAIN")
        self.assertIsNone(next(row for row in response.data if row["category"]["slug"] == "pothole")[
            "secondary_department"])

    def test_admin_updates_routing_atomically_with_audit(self):
        pothole = CivicCategory.objects.get(slug="pothole")
        garbage = CivicCategory.objects.get(slug="garbage")
        self.client.force_authenticate(self.citizen)
        self.assertEqual(self.client.put(self.url, {"mappings": []}, format="json").status_code, 403)

        self.client.force_authenticate(self.admin)
        response = self.client.put(self.url, {"mappings": [
            {"category": pothole.pk, "department": self.gen.pk, "secondary_department": self.roads.pk},
            {"category": garbage.pk, "department": None},
        ]}, format="json")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(len(response.data), 9)
        pothole.refresh_from_db()
        garbage.refresh_from_db()
        self.assertEqual((pothole.department_id, pothole.secondary_department_id), (self.gen.pk, self.roads.pk))
        self.assertIsNone(garbage.department_id)
        log = AuditLog.objects.get(entity_type="CategoryRouting")
        self.assertEqual(log.changes["pothole"]["department"], ["ROADS", "GEN"])

        invalid = self.client.put(self.url, {"mappings": [
            {"category": pothole.pk, "department": self.drain.pk},
            {"category": garbage.pk, "department": 999999},
        ]}, format="json")
        self.assertEqual(invalid.status_code, 400)
        pothole.refresh_from_db()
        self.assertEqual(pothole.department_id, self.gen.pk)  # nothing applied

        same = self.client.put(self.url, {"mappings": [
            {"category": pothole.pk, "department": self.drain.pk, "secondary_department": self.drain.pk},
        ]}, format="json")
        self.assertEqual(same.status_code, 400)
        repeated = self.client.put(self.url, {"mappings": [
            {"category": pothole.pk, "department": self.drain.pk},
            {"category": pothole.pk, "department": self.roads.pk},
        ]}, format="json")
        self.assertEqual(repeated.status_code, 400)


class InitCivicAICommandTests(TestCase):
    def run_command(self, *args):
        out = StringIO()
        call_command("init_civicai", *args, stdout=out)
        return out.getvalue()

    def test_is_idempotent_and_matches_the_spec(self):
        first = self.run_command()
        second = self.run_command()
        self.assertIn("7 (7 created)", first)
        self.assertIn("7 (0 created, 7 updated)", second)
        self.assertEqual(Department.objects.count(), len(DEFAULT_DEPARTMENTS))
        self.assertEqual(CivicCategory.objects.count(), len(DEFAULT_CATEGORIES))
        self.assertEqual(RiskZone.objects.count(), len(DEFAULT_RISK_ZONES))
        self.assertEqual(AIConfiguration.objects.count(), 1)
        self.assertEqual((Department.objects.count(), CivicCategory.objects.count()), (7, 9))
        self.assertGreaterEqual(RiskZone.objects.count(), 10)

        water = Department.objects.get(code="WATER")
        self.assertEqual((water.name, water.icon, water.color, water.sla_hours), ("Water Supply", "droplets",
                                                                                  "#3B5BDB", 24))
        manhole = CivicCategory.objects.get(slug="open_manhole")
        self.assertEqual((manhole.department.code, manhole.secondary_department.code), ("ROADS", "DRAIN"))
        self.assertEqual((manhole.base_severity, manhole.public_safety_weight, manhole.sla_hours), (85, 0.95, 12))
        tree = CivicCategory.objects.get(slug="fallen_tree")
        self.assertEqual((tree.department.code, tree.icon, tree.sla_hours), ("PARKS", "tree-deciduous", 24))
        self.assertIn("chettu", tree.keywords)
        self.assertEqual(CivicCategory.objects.get(slug="garbage").vision_labels,
                         ["garbage", "trash", "litter", "waste_pile"])
        for zone in RiskZone.objects.all():
            self.assertTrue(3 <= zone.risk_level <= 5 and 200 <= zone.radius_m <= 500, zone.name)
            self.assertTrue(17.2 < float(zone.latitude) < 17.6 and 78.2 < float(zone.longitude) < 78.7, zone.name)

    def test_existing_ai_configuration_is_never_reset(self):
        config = AIConfiguration.load()
        config.weight_severity, config.weight_public_impact = 30, 35
        config.save()
        self.run_command()
        config.refresh_from_db()
        self.assertEqual((config.weight_severity, config.weight_public_impact), (30, 35))

    def test_keep_existing_leaves_admin_edits_alone(self):
        self.run_command()
        Department.objects.filter(code="ROADS").update(sla_hours=60)
        self.run_command("--keep-existing")
        self.assertEqual(Department.objects.get(code="ROADS").sla_hours, 60)
        self.run_command()
        self.assertEqual(Department.objects.get(code="ROADS").sla_hours, 72)

    def test_every_default_department_has_fictitious_contacts(self):
        self.run_command()
        for department in Department.objects.all():
            with self.subTest(code=department.code):
                self.assertTrue(department.email.endswith("@civicai.local"))  # reserved, non-routable domain
                self.assertRegex(department.phone, r"^\+91 40 0000 01\d\d$")  # unassigned exchange
                self.assertTrue(department.head_name)

    def test_keep_existing_fills_only_empty_contact_fields(self):
        """Installations created before the defaults had contacts get them; contacts an admin entered stay."""
        self.run_command()
        Department.objects.update(email="", phone="", head_name="")
        Department.objects.filter(code="ROADS").update(email="roads@ghmc.example", head_name="Chief Engineer")
        self.run_command("--keep-existing")
        roads = Department.objects.get(code="ROADS")
        self.assertEqual((roads.email, roads.phone, roads.head_name),
                         ("roads@ghmc.example", "+91 40 0000 0101", "Chief Engineer"))
        self.assertEqual(Department.objects.get(code="WATER").email, "water@civicai.local")

    def test_admin_account_creation_and_update(self):
        output = self.run_command("--admin-email", "Admin@CivicAI.local", "--admin-password", PASSWORD)
        self.assertIn("created admin@civicai.local", output)
        self.assertNotIn(PASSWORD, output)
        admin = User.objects.get(email="admin@civicai.local")
        self.assertTrue(admin.is_superuser and admin.is_staff and admin.role == User.Role.ADMIN)
        self.assertTrue(admin.check_password(PASSWORD))

        self.run_command("--admin-email", "admin@civicai.local", "--admin-password", "Second#Route2027")
        self.assertEqual(User.objects.filter(email__iexact="admin@civicai.local").count(), 1)
        admin.refresh_from_db()
        self.assertTrue(admin.check_password("Second#Route2027"))

        with self.assertRaises(CommandError):
            self.run_command("--admin-email", "new-admin@civicai.local")  # no password for a new account
        with self.assertRaises(CommandError):
            self.run_command("--admin-email", "weak@civicai.local", "--admin-password", "password")
        with self.assertRaises(CommandError):
            self.run_command("--admin-email", "not-an-email", "--admin-password", PASSWORD)
