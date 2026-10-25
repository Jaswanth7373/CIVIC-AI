"""Executable API contract audit.

* the live URLconf (``apps.core.api_inventory``) and docs/API_ENDPOINTS.md list exactly the same endpoints with
  the same permission levels - the published API documentation cannot drift from the code;
* the endpoints and permission levels of docs/BUILD_SPEC.md section 4.2 all exist (spot checks of every group);
* role enforcement really happens over HTTP for representative endpoints of each level.
"""
import io
import re
from pathlib import Path

from django.conf import settings
from django.core.management import call_command
from django.test import SimpleTestCase
from rest_framework.test import APITestCase

from apps.accounts.models import User

from .api_inventory import api_endpoints, normalize_path

API_DOC = Path(settings.BASE_DIR).parent / "docs" / "API_ENDPOINTS.md"
_CELL_SPLIT = re.compile(r"(?<!\\)\|")
METHODS = ("GET", "POST", "PUT", "PATCH", "DELETE")

#: Spot checks transcribed from BUILD_SPEC section 4.2 (method, path) -> permission level.
SPEC_LEVELS = {
    ("POST", "/api/auth/register/"): "P",
    ("POST", "/api/auth/login/"): "P",
    ("POST", "/api/auth/refresh/"): "P",
    ("POST", "/api/auth/logout/"): "A",
    ("GET", "/api/auth/profile/"): "A",
    ("PATCH", "/api/auth/profile/"): "A",
    ("POST", "/api/auth/change-password/"): "A",
    ("GET", "/api/users/"): "AD",
    ("DELETE", "/api/users/{id}/"): "AD",
    ("GET", "/api/officers/"): "O/AD",
    ("POST", "/api/officers/"): "AD",
    ("GET", "/api/officers/{id}/workload/"): "O/AD",
    ("GET", "/api/departments/"): "P",
    ("POST", "/api/departments/"): "AD",
    ("GET", "/api/departments/routing/"): "A",
    ("PUT", "/api/departments/routing/"): "AD",
    ("GET", "/api/categories/"): "P",
    ("DELETE", "/api/categories/{id}/"): "AD",
    ("GET", "/api/complaints/"): "A",
    ("POST", "/api/complaints/"): "C",
    ("GET", "/api/complaints/{id}/"): "A",
    ("PATCH", "/api/complaints/{id}/"): "C (owner)/AD",
    ("DELETE", "/api/complaints/{id}/"): "C (owner)/AD",
    ("GET", "/api/complaints/map/"): "A",
    ("GET", "/api/complaints/{id}/timeline/"): "A",
    ("GET", "/api/complaints/{id}/duplicates/"): "A",
    ("POST", "/api/complaints/{id}/accept/"): "O (assigned)",
    ("POST", "/api/complaints/{id}/reject/"): "O (assigned)/AD",
    ("POST", "/api/complaints/{id}/start/"): "O (assigned)",
    ("POST", "/api/complaints/{id}/update-status/"): "O (assigned)/AD",
    ("POST", "/api/complaints/{id}/resolve/"): "O (assigned)/AD",
    ("POST", "/api/complaints/{id}/evidence/"): "O (assigned)/AD",
    ("POST", "/api/complaints/{id}/verify/"): "O (assigned)/AD",
    ("POST", "/api/complaints/{id}/manual-verification/"): "O (assigned)/AD",
    ("POST", "/api/complaints/{id}/request-manual-verification/"): "O (assigned)",
    ("POST", "/api/complaints/{id}/reopen/"): "C (owner)/AD",
    ("POST", "/api/complaints/{id}/remarks/"): "O/AD",
    ("POST", "/api/complaints/{id}/override-ai/"): "AD",
    ("POST", "/api/complaints/{id}/reanalyze/"): "AD",
    ("POST", "/api/complaints/{id}/close/"): "AD",
    ("GET", "/api/duplicates/"): "O/AD",
    ("PATCH", "/api/duplicates/{id}/"): "O/AD",
    ("POST", "/api/ai/analyze/"): "A",
    ("POST", "/api/ai/classify/"): "A",
    ("POST", "/api/ai/priority/"): "O/AD",
    ("POST", "/api/ai/duplicates/"): "A",
    ("POST", "/api/ai/verify-resolution/"): "O/AD",
    ("POST", "/api/ai/sentiment/"): "AD",
    ("GET", "/api/ai/model-info/"): "A",
    ("POST", "/api/ai/demo/"): "P",
    ("GET", "/api/system/config/"): "P",
    ("GET", "/api/ai/config/"): "O/AD",
    ("PUT", "/api/ai/config/"): "AD",
    ("GET", "/api/risk-zones/"): "O/AD",
    ("POST", "/api/risk-zones/"): "AD",
    ("POST", "/api/contact/"): "P",
    ("GET", "/api/contact/"): "AD",
    ("PATCH", "/api/contact/{id}/"): "AD",
    ("GET", "/api/geo/reverse/"): "P",
    ("GET", "/api/geo/search/"): "P",
    ("GET", "/api/audit-logs/"): "AD",
    ("GET", "/api/assignments/"): "O/AD",
    ("POST", "/api/assignments/"): "AD",
    ("PUT", "/api/assignments/{id}/"): "AD",
    ("GET", "/api/assignments/recommend/"): "AD",
    ("POST", "/api/feedback/"): "C",
    ("GET", "/api/feedback/"): "A",
    ("GET", "/api/feedback/pending/"): "C",
    ("GET", "/api/notifications/"): "A",
    ("GET", "/api/notifications/unread-count/"): "A",
    ("PUT", "/api/notifications/{id}/read/"): "A",
    ("POST", "/api/notifications/{id}/read/"): "A",
    ("POST", "/api/notifications/read-all/"): "A",
    ("DELETE", "/api/notifications/{id}/"): "A",
    ("GET", "/api/analytics/dashboard/"): "A",
    ("GET", "/api/analytics/overview/"): "AD",
    ("GET", "/api/analytics/categories/"): "AD",
    ("GET", "/api/analytics/departments/"): "AD",
    ("GET", "/api/analytics/trends/"): "AD",
    ("GET", "/api/analytics/hotspots/"): "O/AD",
    ("GET", "/api/analytics/sentiment/"): "AD",
    ("GET", "/api/analytics/officers/"): "AD",
    ("GET", "/api/analytics/ai/"): "AD",
    ("GET", "/api/analytics/public/"): "P",
    ("GET", "/api/analytics/reports/"): "AD",
    ("POST", "/api/analytics/run-checks/"): "AD",
    ("GET", "/api/analytics/alerts/"): "AD",
    ("PATCH", "/api/analytics/alerts/{id}/"): "AD",
}


def documented_endpoints():
    """``{(method, path): permission}`` from the Markdown tables of docs/API_ENDPOINTS.md."""
    rows = {}
    for line in API_DOC.read_text(encoding="utf-8").splitlines():
        cells = [cell.strip() for cell in _CELL_SPLIT.split(line.strip())[1:-1]]
        if len(cells) >= 3 and cells[0] in METHODS:
            key = (cells[0], cells[1])
            if key in rows:
                raise AssertionError(f"{key} is documented twice in {API_DOC.name}")
            rows[key] = cells[2]
    return rows


class ApiContractTests(SimpleTestCase):
    def test_path_normalisation(self):
        self.assertEqual(normalize_path(r"api/^complaints/(?P<pk>\d+)/accept/$"), "/api/complaints/{id}/accept/")
        self.assertEqual(normalize_path("api/analytics/alerts/<int:pk>/"), "/api/analytics/alerts/{id}/")

    def test_documentation_matches_the_live_url_configuration(self):
        live = {(endpoint.method, endpoint.path): endpoint.permission for endpoint in api_endpoints()}
        documented = documented_endpoints()
        self.assertEqual(sorted(set(live) - set(documented)), [], f"endpoints missing from {API_DOC.name}")
        self.assertEqual(sorted(set(documented) - set(live)), [], "documented endpoints that do not exist")
        wrong = {key: (documented[key], live[key]) for key in live if documented[key] != live[key]}
        self.assertEqual(wrong, {}, "documented permission level (left) differs from the code (right)")

    def test_every_specified_endpoint_exists_with_its_permission_level(self):
        live = {(endpoint.method, endpoint.path): endpoint.permission for endpoint in api_endpoints()}
        missing = sorted(key for key in SPEC_LEVELS if key not in live)
        self.assertEqual(missing, [])
        wrong = {key: (level, live[key]) for key, level in SPEC_LEVELS.items() if live[key] != level}
        self.assertEqual(wrong, {}, "BUILD_SPEC level (left) differs from the code (right)")

    def test_management_command_prints_the_inventory(self):
        out = io.StringIO()
        call_command("api_endpoints", stdout=out)
        self.assertIn("| POST | /api/ai/demo/ | P | PublicDemoView |", out.getvalue())


class RoleEnforcementTests(APITestCase):
    """Representative endpoints of each level answer 401 / 403 / 200 as documented."""

    PASSWORD = "Contract#Check2026"

    @classmethod
    def setUpTestData(cls):
        cls.users = {
            role: User.objects.create_user(email=f"{role}@contract.test", password=cls.PASSWORD, role=role,
                                           first_name=role.title())
            for role in ("citizen", "officer", "admin")
        }

    def status_for(self, role, method, path):
        self.client.force_authenticate(self.users[role] if role else None)
        return getattr(self.client, method.lower())(path, {}, format="json").status_code

    def test_levels_are_enforced(self):
        cases = [
            ("GET", "/api/analytics/public/", {None: 200, "citizen": 200}),
            ("GET", "/api/categories/", {None: 200}),
            ("GET", "/api/analytics/dashboard/", {None: 401, "citizen": 200, "officer": 200, "admin": 200}),
            ("GET", "/api/feedback/pending/", {None: 401, "citizen": 200, "officer": 403, "admin": 403}),
            ("GET", "/api/duplicates/", {"citizen": 403, "officer": 200, "admin": 200}),
            ("GET", "/api/analytics/overview/", {"citizen": 403, "officer": 403, "admin": 200}),
            ("GET", "/api/users/", {"officer": 403, "admin": 200}),
            ("GET", "/api/ai/config/", {"citizen": 403, "officer": 200}),
            ("PATCH", "/api/ai/config/", {"officer": 403}),
            ("POST", "/api/complaints/", {"officer": 403, "admin": 403}),
        ]
        for method, path, expected in cases:
            for role, code in expected.items():
                with self.subTest(method=method, path=path, role=role):
                    self.assertEqual(self.status_for(role, method, path), code)
