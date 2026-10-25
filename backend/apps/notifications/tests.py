"""Tests for the notification service and the notifications REST API."""
from decimal import Decimal
from types import SimpleNamespace
from unittest import mock

from django.contrib.auth import get_user_model
from django.db import DatabaseError, transaction
from django.test import SimpleTestCase, TestCase
from rest_framework.test import APITestCase

from apps.complaints.models import Complaint, Location
from apps.departments.models import Department
from apps.officers.models import OfficerProfile

from . import services
from .models import Notification

User = get_user_model()
PASSWORD = "Civic!Pass2026"
NOTIFICATION_KEYS = {
    "id", "title", "message", "notification_type", "type_display", "level", "complaint", "complaint_number",
    "link", "is_read", "read_at", "created_at",
}
PAGINATION_KEYS = {"count", "next", "previous", "page", "page_size", "total_pages", "results"}


def make_user(email, role="citizen", **extra):
    return User.objects.create_user(email=email, password=PASSWORD, first_name=email.split("@")[0].title(),
                                    role=role, **extra)


def make_officer(email, department, **extra):
    user = make_user(email, role="officer", **extra)
    OfficerProfile.objects.create(user=user, department=department, employee_id=f"EMP-{user.pk}")
    return user


def make_complaint(citizen):
    location = Location.objects.create(latitude=Decimal("17.385000"), longitude=Decimal("78.486700"),
                                       address="Road No. 12", area="Banjara Hills", city="Hyderabad")
    return Complaint.objects.create(citizen=citizen, title="Pothole near school",
                                    description="Large pothole near the school gate", location=location)


class ComplaintLinkTests(SimpleTestCase):
    def test_link_per_role(self):
        complaint = SimpleNamespace(pk=12)
        self.assertEqual(services.complaint_link(complaint, "citizen"), "/citizen/complaints/12")
        self.assertEqual(services.complaint_link(complaint, "officer"), "/officer/complaints/12")
        self.assertEqual(services.complaint_link(complaint, "admin"), "/admin/complaints/12")

    def test_accepts_id_and_handles_missing_values(self):
        self.assertEqual(services.complaint_link(7, "officer"), "/officer/complaints/7")
        self.assertEqual(services.complaint_link(None, "citizen"), "")
        self.assertEqual(services.complaint_link(7, "guest"), "")
        self.assertEqual(services.complaint_link(7, None), "")


class NotifyServiceTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.roads = Department.objects.create(name="Roads Department", code="ROADS")
        cls.water = Department.objects.create(name="Water Supply", code="WATER")
        cls.citizen = make_user("citizen@test.local")
        cls.officer = make_officer("officer@test.local", cls.roads)
        cls.water_officer = make_officer("water@test.local", cls.water)
        cls.inactive_officer = make_officer("gone@test.local", cls.roads, is_active=False)
        cls.admin = make_user("admin@test.local", role="admin")
        cls.inactive_admin = make_user("old-admin@test.local", role="admin", is_active=False)
        # A superuser whose role field says "citizen" must still be treated as an administrator.
        cls.superuser = User.objects.create_superuser(email="root@test.local", password=PASSWORD,
                                                      first_name="Root", role="citizen")
        cls.complaint = make_complaint(cls.citizen)

    def _notify(self, user, **overrides):
        kwargs = {"title": "Officer assigned", "message": "Ravi will handle your complaint.",
                  "notification_type": "officer_assigned", "complaint": self.complaint}
        kwargs.update(overrides)
        return services.notify(user, **kwargs)

    def test_notify_creates_notification_with_role_based_link(self):
        citizen_note = self._notify(self.citizen)
        officer_note = self._notify(self.officer, notification_type="new_assignment")
        root_note = self._notify(self.superuser, notification_type="hotspot_alert")
        self.assertEqual(citizen_note.link, f"/citizen/complaints/{self.complaint.pk}")
        self.assertEqual(officer_note.link, f"/officer/complaints/{self.complaint.pk}")
        self.assertEqual(root_note.link, f"/admin/complaints/{self.complaint.pk}")
        self.assertEqual(citizen_note.complaint_id, self.complaint.pk)
        self.assertFalse(citizen_note.is_read)

    def test_explicit_link_is_kept_and_no_complaint_means_no_link(self):
        note = self._notify(self.admin, link="/admin/hotspots", notification_type="hotspot_alert")
        self.assertEqual(note.link, "/admin/hotspots")
        plain = self._notify(self.admin, complaint=None, notification_type="system")
        self.assertEqual(plain.link, "")
        self.assertIsNone(plain.complaint_id)

    def test_inactive_or_missing_user_is_skipped(self):
        self.assertIsNone(self._notify(self.inactive_officer))
        self.assertIsNone(self._notify(None))
        self.assertFalse(Notification.objects.filter(user=self.inactive_officer).exists())

    def test_default_level_follows_notification_type(self):
        expected = {
            "critical_complaint": "critical",
            "complaint_resolved": "success",
            "resolution_verified": "success",
            "high_priority_unresolved": "warning",
            "hotspot_alert": "warning",
            "manual_review_requested": "warning",
            "complaint_reopened": "warning",
            "complaint_submitted": "info",
            "feedback_received": "info",
        }
        for notification_type, level in expected.items():
            with self.subTest(notification_type=notification_type):
                self.assertEqual(self._notify(self.admin, notification_type=notification_type).level, level)

    def test_explicit_level_wins_and_invalid_level_falls_back(self):
        self.assertEqual(self._notify(self.citizen, notification_type="status_changed", level="success").level,
                         "success")
        self.assertEqual(self._notify(self.citizen, notification_type="critical_complaint", level="loud").level,
                         "critical")

    def test_unknown_type_is_stored_as_system(self):
        note = self._notify(self.citizen, notification_type="made_up_type")
        self.assertEqual(note.notification_type, "system")

    def test_long_title_is_truncated_to_column_size(self):
        note = self._notify(self.citizen, title="x" * 400)
        self.assertEqual(len(note.title), 160)

    def test_notify_never_raises_and_keeps_outer_transaction_usable(self):
        with transaction.atomic():
            with mock.patch.object(Notification.objects, "create", side_effect=DatabaseError("disk full")):
                with self.assertLogs("apps.notifications", level="ERROR"):
                    self.assertIsNone(self._notify(self.citizen))
            # the surrounding transaction still works after the failed notification
            self.assertIsNotNone(self._notify(self.citizen))
        self.assertEqual(Notification.objects.filter(user=self.citizen).count(), 1)

    def test_notify_many_deduplicates_and_ignores_none(self):
        created = services.notify_many(
            [self.citizen, self.officer, self.citizen, None, self.inactive_officer],
            title="Update", message="Something changed", notification_type="status_changed",
            complaint=self.complaint,
        )
        self.assertEqual(created, 2)
        self.assertEqual(Notification.objects.filter(user=self.citizen).count(), 1)

    def test_notify_admins_targets_active_admins_and_superusers(self):
        created = services.notify_admins(title="Hotspot", message="5 complaints in 400 m",
                                         notification_type="hotspot_alert", complaint=self.complaint)
        self.assertEqual(created, 2)
        recipients = set(Notification.objects.values_list("user_id", flat=True))
        self.assertEqual(recipients, {self.admin.pk, self.superuser.pk})
        self.assertTrue(all(link.startswith("/admin/") for link in Notification.objects.values_list("link", flat=True)))

    def test_notify_department_officers(self):
        created = services.notify_department_officers(self.roads, title="Critical", message="Critical pothole",
                                                      notification_type="critical_complaint")
        self.assertEqual(created, 1)
        self.assertEqual(list(Notification.objects.values_list("user_id", flat=True)), [self.officer.pk])
        self.assertEqual(services.notify_department_officers(None, title="x", message="y",
                                                             notification_type="system"), 0)
        self.assertEqual(services.notify_department_officers(self.water.pk, title="x", message="y",
                                                             notification_type="system"), 1)

    def test_mark_read_is_idempotent_and_mark_all_read_is_per_user(self):
        first = self._notify(self.citizen)
        self._notify(self.citizen)
        other = self._notify(self.officer)
        services.mark_read(first)
        read_at = first.read_at
        self.assertIsNotNone(read_at)
        services.mark_read(first)
        self.assertEqual(first.read_at, read_at)
        self.assertEqual(services.unread_count(self.citizen), 1)
        self.assertEqual(services.mark_all_read(self.citizen), 1)
        self.assertEqual(services.unread_count(self.citizen), 0)
        other.refresh_from_db()
        self.assertFalse(other.is_read)


class NotificationApiTests(APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.alice = make_user("alice@test.local")
        cls.bob = make_user("bob@test.local")
        cls.complaint = make_complaint(cls.alice)
        cls.alice_notes = [
            services.notify(cls.alice, title=f"Update {i}", message="Status changed",
                            notification_type="status_changed", complaint=cls.complaint)
            for i in range(3)
        ]
        cls.bob_note = services.notify(cls.bob, title="Hello Bob", message="Welcome", notification_type="system")

    def setUp(self):
        self.client.force_authenticate(self.alice)

    def test_list_returns_only_own_notifications_in_contract_shape(self):
        response = self.client.get("/api/notifications/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(set(response.data), PAGINATION_KEYS)
        self.assertEqual(response.data["count"], 3)
        ids = {item["id"] for item in response.data["results"]}
        self.assertEqual(ids, {note.pk for note in self.alice_notes})
        item = response.data["results"][0]
        self.assertEqual(set(item), NOTIFICATION_KEYS)
        self.assertEqual(item["complaint"], self.complaint.pk)
        self.assertEqual(item["complaint_number"], self.complaint.complaint_number)
        self.assertEqual(item["type_display"], "Status changed")
        self.assertEqual(item["link"], f"/citizen/complaints/{self.complaint.pk}")

    def test_is_read_filter_and_pagination(self):
        services.mark_read(self.alice_notes[0])
        unread = self.client.get("/api/notifications/", {"is_read": "false"})
        read = self.client.get("/api/notifications/", {"is_read": "true"})
        self.assertEqual(unread.data["count"], 2)
        self.assertEqual(read.data["count"], 1)
        self.assertEqual(read.data["results"][0]["id"], self.alice_notes[0].pk)
        paged = self.client.get("/api/notifications/", {"page_size": 2})
        self.assertEqual((paged.data["page_size"], paged.data["total_pages"], len(paged.data["results"])), (2, 2, 2))

    def test_unread_count_is_per_user(self):
        response = self.client.get("/api/notifications/unread-count/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, {"count": 3})
        self.client.force_authenticate(self.bob)
        self.assertEqual(self.client.get("/api/notifications/unread-count/").data, {"count": 1})

    def test_mark_read_with_post_and_put(self):
        for method, note in (("post", self.alice_notes[0]), ("put", self.alice_notes[1])):
            with self.subTest(method=method):
                response = getattr(self.client, method)(f"/api/notifications/{note.pk}/read/")
                self.assertEqual(response.status_code, 200)
                self.assertEqual(set(response.data), NOTIFICATION_KEYS)
                self.assertTrue(response.data["is_read"])
                self.assertIsNotNone(response.data["read_at"])
        self.assertEqual(self.client.get("/api/notifications/unread-count/").data, {"count": 1})

    def test_cannot_touch_another_users_notification(self):
        self.assertEqual(self.client.post(f"/api/notifications/{self.bob_note.pk}/read/").status_code, 404)
        self.assertEqual(self.client.delete(f"/api/notifications/{self.bob_note.pk}/").status_code, 404)
        self.bob_note.refresh_from_db()
        self.assertFalse(self.bob_note.is_read)

    def test_read_all_only_affects_own_notifications(self):
        response = self.client.post("/api/notifications/read-all/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, {"updated": 3})
        self.assertEqual(self.client.post("/api/notifications/read-all/").data, {"updated": 0})
        self.bob_note.refresh_from_db()
        self.assertFalse(self.bob_note.is_read)

    def test_delete_own_notification(self):
        note = self.alice_notes[2]
        self.assertEqual(self.client.delete(f"/api/notifications/{note.pk}/").status_code, 204)
        self.assertFalse(Notification.objects.filter(pk=note.pk).exists())

    def test_authentication_required(self):
        self.client.force_authenticate(None)
        self.assertEqual(self.client.get("/api/notifications/").status_code, 401)
        self.assertEqual(self.client.get("/api/notifications/unread-count/").status_code, 401)
