"""Tests for the admin audit-log API (/api/audit-logs/)."""
import datetime
from zoneinfo import ZoneInfo

from django.conf import settings
from rest_framework.test import APITestCase

from apps.accounts.models import User

from .models import AuditLog
from .services import log_action

PASSWORD = "Civic#Route2026"
LOCAL = ZoneInfo(settings.TIME_ZONE)


def make_user(email, role=User.Role.CITIZEN):
    return User.objects.create_user(email=email, password=PASSWORD, role=role, first_name=email.split("@")[0])


class AuditLogApiTests(APITestCase):
    url = "/api/audit-logs/"

    def setUp(self):
        self.admin = make_user("admin@example.com", User.Role.ADMIN)
        self.citizen = make_user("citizen@example.com")
        # 00:30 on 1 Oct in India is still 30 Sep in UTC: date filters must use the local calendar day.
        self.early = log_action(self.citizen, "login", entity=self.citizen, description="citizen signed in")
        AuditLog.objects.filter(pk=self.early.pk).update(
            created_at=datetime.datetime(2026, 10, 1, 0, 30, tzinfo=LOCAL))
        self.update = log_action(self.admin, "update", entity_type="Department", entity_id="3",
                                 description="Updated department ROADS", changes={"sla_hours": [72, 48]})
        AuditLog.objects.filter(pk=self.update.pk).update(
            created_at=datetime.datetime(2026, 10, 5, 12, 0, tzinfo=LOCAL))
        self.config = log_action(self.admin, "config_change", entity_type="AIConfiguration", entity_id="1",
                                 description="AI configuration updated (weight_severity)")
        AuditLog.objects.filter(pk=self.config.pk).update(
            created_at=datetime.datetime(2026, 10, 10, 9, 0, tzinfo=LOCAL))

    def ids(self, **params):
        response = self.client.get(self.url, params)
        self.assertEqual(response.status_code, 200, response.data)
        return [row["id"] for row in response.data["results"]]

    def test_admin_only(self):
        self.assertEqual(self.client.get(self.url).status_code, 401)
        self.client.force_authenticate(self.citizen)
        self.assertEqual(self.client.get(self.url).status_code, 403)
        officer = make_user("officer@example.com", User.Role.OFFICER)
        self.client.force_authenticate(officer)
        self.assertEqual(self.client.get(self.url).status_code, 403)

    def test_list_shape_newest_first_and_paginated(self):
        self.client.force_authenticate(self.admin)
        response = self.client.get(self.url, {"page_size": 2})
        self.assertEqual(response.status_code, 200)
        self.assertEqual((response.data["count"], response.data["total_pages"], len(response.data["results"])),
                         (3, 2, 2))
        row = response.data["results"][0]
        self.assertEqual(set(row), {"id", "actor", "action", "action_display", "entity_type", "entity_id",
                                    "description", "changes", "ip_address", "created_at"})
        self.assertEqual(row["id"], self.config.pk)
        self.assertEqual(row["action_display"], "Configuration change")
        self.assertEqual(row["actor"]["email"], "admin@example.com")
        self.assertEqual(self.client.get(f"{self.url}{self.update.pk}/").data["changes"], {"sla_hours": [72, 48]})
        self.assertEqual(self.client.delete(f"{self.url}{self.update.pk}/").status_code, 405)  # read-only log

    def test_filters(self):
        self.client.force_authenticate(self.admin)
        self.assertEqual(self.ids(action="login"), [self.early.pk])
        self.assertEqual(sorted(self.ids(action="login,update")), sorted([self.early.pk, self.update.pk]))
        self.assertEqual(self.ids(entity_type="department"), [self.update.pk])
        self.assertEqual(self.ids(actor=self.citizen.pk), [self.early.pk])
        self.assertEqual(self.ids(date_from="2026-10-01", date_to="2026-10-01"), [self.early.pk])
        self.assertEqual(self.ids(date_to="2026-09-30"), [])
        self.assertEqual(sorted(self.ids(date_from="2026-10-05")), sorted([self.update.pk, self.config.pk]))
        self.assertEqual(self.ids(search="ROADS"), [self.update.pk])
        self.assertEqual(self.ids(search="citizen@example.com"), [self.early.pk])
        self.assertEqual(self.client.get(self.url, {"date_from": "yesterday"}).status_code, 400)

    def test_api_actions_create_audit_rows(self):
        """End to end: a real login through the API is visible in the audit log with the client IP."""
        self.client.post("/api/auth/login/", {"email": "citizen@example.com", "password": PASSWORD}, format="json",
                         REMOTE_ADDR="203.0.113.7")
        self.client.force_authenticate(self.admin)
        rows = self.client.get(self.url, {"action": "login", "actor": self.citizen.pk}).data["results"]
        newest = rows[0]
        self.assertEqual(newest["description"], "citizen@example.com signed in")
        self.assertEqual(newest["ip_address"], "203.0.113.7")
        self.assertEqual(newest["entity_type"], "User")
