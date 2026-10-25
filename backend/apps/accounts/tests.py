"""API tests for authentication (/api/auth/*), the profile endpoint and admin user management (/api/users/)."""
import io
import shutil
import tempfile
from decimal import Decimal
from unittest import mock

from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import connection
from django.test import override_settings
from django.test.utils import CaptureQueriesContext
from PIL import Image
from rest_framework.test import APITestCase

from apps.audit.models import AuditLog
from apps.complaints.models import Complaint, Location
from apps.core.throttles import CivicScopedRateThrottle
from apps.officers.models import OfficerProfile

from .models import CitizenProfile, User

STRONG_PASSWORD = "Civic#Route2026"


def make_png(name="avatar.png", size=(64, 64), color=(11, 110, 79)):
    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, format="PNG")
    return SimpleUploadedFile(name, buffer.getvalue(), content_type="image/png")


def make_user(email, *, role=User.Role.CITIZEN, password=STRONG_PASSWORD, **extra):
    extra.setdefault("first_name", email.split("@")[0].title())
    return User.objects.create_user(email=email, password=password, role=role, **extra)


def make_complaint(citizen, *, officer=None, status=Complaint.Status.SUBMITTED):
    location = Location.objects.create(latitude=Decimal("17.385000"), longitude=Decimal("78.486700"),
                                       address="MG Road", area="Abids", city="Hyderabad")
    return Complaint.objects.create(citizen=citizen, assigned_officer=officer, status=status, location=location,
                                    description="Large pothole near the bus stop causing traffic problems.")


class AuthFlowTests(APITestCase):
    register_url = "/api/auth/register/"
    login_url = "/api/auth/login/"

    def setUp(self):
        cache.clear()

    def register(self, **overrides):
        payload = {
            "email": "Ravi.Kumar@Example.com", "password": STRONG_PASSWORD, "confirm_password": STRONG_PASSWORD,
            "first_name": "Ravi", "last_name": "Kumar", "phone": "+91 98765 43210",
        }
        payload.update(overrides)
        return self.client.post(self.register_url, payload, format="json")

    def test_register_creates_citizen_returns_tokens_and_audits(self):
        response = self.register(role="admin")  # a role in the payload must be ignored
        self.assertEqual(response.status_code, 201, response.data)
        user_data = response.data["user"]
        self.assertEqual(user_data["role"], "citizen")
        self.assertEqual(user_data["email"], "ravi.kumar@example.com")
        self.assertEqual(user_data["full_name"], "Ravi Kumar")
        self.assertEqual(user_data["stats"], {"complaints": 0, "civic_points": 0})
        self.assertIsNotNone(user_data["citizen_profile"])
        self.assertIsNone(user_data["officer_profile"])
        self.assertTrue(response.data["access"] and response.data["refresh"])

        user = User.objects.get(email="ravi.kumar@example.com")
        self.assertTrue(user.check_password(STRONG_PASSWORD))
        self.assertFalse(user.is_staff or user.is_superuser)
        self.assertTrue(CitizenProfile.objects.filter(user=user).exists())
        self.assertTrue(AuditLog.objects.filter(action="register", entity_id=str(user.pk)).exists())

        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {response.data['access']}")
        self.assertEqual(self.client.get("/api/auth/profile/").status_code, 200)

    def test_register_validation_errors(self):
        make_user("taken@example.com")
        duplicate = self.register(email="TAKEN@example.com")
        self.assertEqual(duplicate.status_code, 400)
        self.assertIn("email", duplicate.data["errors"])
        self.assertEqual(duplicate.data["code"], "validation_error")

        mismatch = self.register(confirm_password="Different#2026x")
        self.assertEqual(mismatch.status_code, 400)
        self.assertIn("confirm_password", mismatch.data["errors"])

        weak = self.register(password="12345678", confirm_password="12345678")
        self.assertEqual(weak.status_code, 400)
        self.assertIn("password", weak.data["errors"])

        missing_name = self.register(first_name="  ")
        self.assertEqual(missing_name.status_code, 400)
        self.assertIn("first_name", missing_name.data["errors"])

        bad_phone = self.register(phone="call me")
        self.assertEqual(bad_phone.status_code, 400)
        self.assertIn("phone", bad_phone.data["errors"])
        self.assertEqual(User.objects.count(), 1)

    def test_login_success_returns_tokens_user_and_updates_last_login(self):
        user = make_user("asha@example.com", first_name="Asha")
        response = self.client.post(self.login_url, {"email": "  ASHA@example.com ", "password": STRONG_PASSWORD},
                                    format="json")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(set(response.data), {"access", "refresh", "user"})
        self.assertEqual(response.data["user"]["id"], user.pk)
        user.refresh_from_db()
        self.assertIsNotNone(user.last_login)
        self.assertTrue(AuditLog.objects.filter(action="login", actor=user, changes__success=True).exists())

    def test_login_failures_are_generic_and_inactive_is_forbidden(self):
        user = make_user("asha@example.com")
        wrong = self.client.post(self.login_url, {"email": "asha@example.com", "password": "wrong-pass"}, format="json")
        unknown = self.client.post(self.login_url, {"email": "nobody@example.com", "password": "x"}, format="json")
        for response in (wrong, unknown):
            self.assertEqual(response.status_code, 401)
            self.assertEqual(response.data["detail"], "Invalid email or password.")
        self.assertTrue(AuditLog.objects.filter(action="login", actor=None, entity_id=str(user.pk)).exists())

        user.is_active = False
        user.save()
        inactive = self.client.post(self.login_url, {"email": "asha@example.com", "password": STRONG_PASSWORD},
                                    format="json")
        self.assertEqual(inactive.status_code, 403)
        inactive_wrong = self.client.post(self.login_url, {"email": "asha@example.com", "password": "nope"},
                                          format="json")
        self.assertEqual(inactive_wrong.status_code, 401)  # no hint about the account without the password

        missing = self.client.post(self.login_url, {"email": "asha@example.com"}, format="json")
        self.assertEqual(missing.status_code, 400)

    def test_login_ignores_stale_authorization_header(self):
        make_user("asha@example.com")
        self.client.credentials(HTTP_AUTHORIZATION="Bearer not-a-valid-token")
        response = self.client.post(self.login_url, {"email": "asha@example.com", "password": STRONG_PASSWORD},
                                    format="json")
        self.assertEqual(response.status_code, 200)

    def test_refresh_rotates_and_blacklists_the_used_token(self):
        make_user("asha@example.com")
        tokens = self.client.post(self.login_url, {"email": "asha@example.com", "password": STRONG_PASSWORD},
                                  format="json").data
        refreshed = self.client.post("/api/auth/refresh/", {"refresh": tokens["refresh"]}, format="json")
        self.assertEqual(refreshed.status_code, 200)
        self.assertEqual(set(refreshed.data), {"access", "refresh"})
        self.assertNotEqual(refreshed.data["refresh"], tokens["refresh"])
        reused = self.client.post("/api/auth/refresh/", {"refresh": tokens["refresh"]}, format="json")
        self.assertEqual(reused.status_code, 401)

    def test_refresh_for_deleted_account_is_401_not_500(self):
        user = make_user("asha@example.com")
        tokens = self.client.post(self.login_url, {"email": "asha@example.com", "password": STRONG_PASSWORD},
                                  format="json").data
        User.objects.filter(pk=user.pk).delete()
        response = self.client.post("/api/auth/refresh/", {"refresh": tokens["refresh"]}, format="json")
        self.assertEqual(response.status_code, 401)

    def test_logout_blacklists_refresh_token(self):
        user = make_user("asha@example.com")
        tokens = self.client.post(self.login_url, {"email": "asha@example.com", "password": STRONG_PASSWORD},
                                  format="json").data
        anonymous = self.client.post("/api/auth/logout/", {"refresh": tokens["refresh"]}, format="json")
        self.assertEqual(anonymous.status_code, 401)  # authentication required
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {tokens['access']}")
        response = self.client.post("/api/auth/logout/", {"refresh": tokens["refresh"]}, format="json")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, {"detail": "Logged out."})
        self.assertTrue(AuditLog.objects.filter(action="logout", actor=user).exists())

        self.client.credentials()
        self.assertEqual(
            self.client.post("/api/auth/refresh/", {"refresh": tokens["refresh"]}, format="json").status_code, 401
        )
        # The access token of the session is revoked too: the session ends now, not when the token expires.
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {tokens['access']}")
        self.assertEqual(self.client.get("/api/auth/profile/").status_code, 401)
        again = self.client.post("/api/auth/logout/", {"refresh": tokens["refresh"]}, format="json")
        self.assertEqual(again.status_code, 401)

    def test_logout_keeps_the_users_other_sessions(self):
        make_user("asha@example.com")
        credentials = {"email": "asha@example.com", "password": STRONG_PASSWORD}
        phone = self.client.post(self.login_url, credentials, format="json").data
        laptop = self.client.post(self.login_url, credentials, format="json").data
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {phone['access']}")
        logout = self.client.post("/api/auth/logout/", {"refresh": phone["refresh"]}, format="json")
        self.assertEqual(logout.status_code, 200)
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {laptop['access']}")
        self.assertEqual(self.client.get("/api/auth/profile/").status_code, 200)
        self.client.credentials()
        self.assertEqual(
            self.client.post("/api/auth/refresh/", {"refresh": laptop["refresh"]}, format="json").status_code, 200
        )

    def test_change_password_ends_every_other_session_at_once(self):
        user = make_user("asha@example.com")
        credentials = {"email": "asha@example.com", "password": STRONG_PASSWORD}
        current = self.client.post(self.login_url, credentials, format="json").data
        other = self.client.post(self.login_url, credentials, format="json").data
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {current['access']}")
        response = self.client.post("/api/auth/change-password/",
                                    {"old_password": STRONG_PASSWORD, "new_password": "Another#Pass2026"},
                                    format="json")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(set(response.data), {"detail", "access", "refresh"})
        self.assertEqual(AuditLog.objects.get(action="password_change", actor=user).changes, {"sessions_revoked": 2})

        for tokens in (current, other):  # access tokens issued before the change stop working immediately ...
            self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {tokens['access']}")
            self.assertEqual(self.client.get("/api/auth/profile/").status_code, 401)
            self.client.credentials()  # ... and so do their refresh tokens
            self.assertEqual(
                self.client.post("/api/auth/refresh/", {"refresh": tokens["refresh"]}, format="json").status_code, 401
            )
        # The pair returned by the change keeps the session that made it signed in.
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {response.data['access']}")
        self.assertEqual(self.client.get("/api/auth/profile/").status_code, 200)
        self.client.credentials()
        self.assertEqual(
            self.client.post("/api/auth/refresh/", {"refresh": response.data["refresh"]}, format="json").status_code,
            200,
        )

    def test_refresh_token_with_an_old_password_fingerprint_is_rejected(self):
        user = make_user("asha@example.com")
        tokens = self.client.post(self.login_url, {"email": "asha@example.com", "password": STRONG_PASSWORD},
                                  format="json").data
        user.set_password("Changed#ByAdmin2026")  # e.g. an administrator reset the password
        user.save()
        response = self.client.post("/api/auth/refresh/", {"refresh": tokens["refresh"]}, format="json")
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.data["code"], "password_changed")

    def test_concurrent_reuse_of_one_refresh_token_rotates_it_only_once(self):
        """Two requests that both passed the blacklist check before either rotated: only the first one wins."""
        from rest_framework_simplejwt.tokens import BlacklistMixin

        make_user("asha@example.com")
        tokens = self.client.post(self.login_url, {"email": "asha@example.com", "password": STRONG_PASSWORD},
                                  format="json").data
        with mock.patch.object(BlacklistMixin, "check_blacklist", lambda token: None):  # the race window
            first = self.client.post("/api/auth/refresh/", {"refresh": tokens["refresh"]}, format="json")
            second = self.client.post("/api/auth/refresh/", {"refresh": tokens["refresh"]}, format="json")
        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 401)
        self.assertEqual(second.data["detail"], "Token is blacklisted")

    def test_whitespace_only_passwords_are_rejected(self):
        for password in (" " * 8, "\t \t    \n"):
            with self.subTest(password=repr(password)):
                response = self.register(email="spaces@example.com", password=password, confirm_password=password)
                self.assertEqual(response.status_code, 400)
                self.assertIn("password", response.data["errors"])
        self.assertFalse(User.objects.filter(email="spaces@example.com").exists())
        # Spaces inside a passphrase are still fine.
        self.assertEqual(self.register(email="phrase@example.com", password="green mango tree 42",
                                       confirm_password="green mango tree 42").status_code, 201)

    def test_logout_rejects_another_users_token(self):
        make_user("asha@example.com")
        make_user("ravi@example.com")
        asha = self.client.post(self.login_url, {"email": "asha@example.com", "password": STRONG_PASSWORD},
                                format="json").data
        ravi = self.client.post(self.login_url, {"email": "ravi@example.com", "password": STRONG_PASSWORD},
                                format="json").data
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {asha['access']}")
        response = self.client.post("/api/auth/logout/", {"refresh": ravi["refresh"]}, format="json")
        self.assertEqual(response.status_code, 400)
        self.assertIn("refresh", response.data["errors"])

    def test_change_password(self):
        user = make_user("asha@example.com")
        self.client.force_authenticate(user)
        url = "/api/auth/change-password/"
        wrong_old = self.client.post(url, {"old_password": "nope", "new_password": "Another#Pass2026"}, format="json")
        self.assertEqual(wrong_old.status_code, 400)
        self.assertIn("old_password", wrong_old.data["errors"])
        weak = self.client.post(url, {"old_password": STRONG_PASSWORD, "new_password": "password"}, format="json")
        self.assertEqual(weak.status_code, 400)
        self.assertIn("new_password", weak.data["errors"])

        ok = self.client.post(url, {"old_password": STRONG_PASSWORD, "new_password": "Another#Pass2026"}, format="json")
        self.assertEqual(ok.status_code, 200)
        user.refresh_from_db()
        self.assertTrue(user.check_password("Another#Pass2026"))
        self.assertTrue(AuditLog.objects.filter(action="password_change", actor=user).exists())
        self.client.force_authenticate(None)
        login = self.client.post(self.login_url, {"email": "asha@example.com", "password": "Another#Pass2026"},
                                 format="json")
        self.assertEqual(login.status_code, 200)

    @override_settings(TESTING=False)
    def test_login_and_register_are_rate_limited(self):
        cache.clear()
        with mock.patch.object(CivicScopedRateThrottle, "THROTTLE_RATES", {"auth": "3/min"}):
            bad_login = {"email": "x@example.com", "password": "bad"}
            statuses = [self.client.post(self.login_url, bad_login, format="json").status_code for _ in range(4)]
            self.assertEqual(statuses, [401, 401, 401, 429])
            # Same client IP and the same scope -> register is limited as well.
            self.assertEqual(self.register().status_code, 429)


class ProfileTests(APITestCase):
    url = "/api/auth/profile/"

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        media_root = tempfile.mkdtemp(prefix="civicai-test-media-")  # uploads never touch backend/media
        cls.addClassCleanup(shutil.rmtree, media_root, ignore_errors=True)
        cls.enterClassContext(override_settings(MEDIA_ROOT=media_root))

    def setUp(self):
        self.user = make_user("meena@example.com", first_name="Meena")
        self.client.force_authenticate(self.user)

    def test_get_profile_shape(self):
        make_complaint(self.user)
        response = self.client.get(self.url)
        self.assertEqual(response.status_code, 200)
        expected = {"id", "email", "first_name", "last_name", "full_name", "role", "phone", "avatar", "is_active",
                    "date_joined", "last_login", "citizen_profile", "officer_profile", "stats"}
        self.assertEqual(set(response.data), expected)
        self.assertEqual(response.data["stats"]["complaints"], 1)
        self.client.force_authenticate(None)
        self.assertEqual(self.client.get(self.url).status_code, 401)

    def test_patch_json_with_nested_citizen_profile(self):
        response = self.client.patch(self.url, {
            "first_name": "Meena", "last_name": "Reddy", "phone": "9876543210",
            "citizen_profile": {"address": "Plot 12, Road No. 3", "area": "Banjara Hills", "city": "Hyderabad",
                                "pincode": "500034", "gender": "female", "preferred_language": "te",
                                "email_notifications": False, "date_of_birth": "1998-04-12"},
        }, format="json")
        self.assertEqual(response.status_code, 200, response.data)
        profile = response.data["citizen_profile"]
        self.assertEqual(profile["area"], "Banjara Hills")
        self.assertEqual(profile["date_of_birth"], "1998-04-12")
        self.assertFalse(profile["email_notifications"])
        self.assertEqual(response.data["full_name"], "Meena Reddy")
        self.assertTrue(AuditLog.objects.filter(action="update", actor=self.user, entity_id=str(self.user.pk)).exists())

    def test_patch_multipart_flat_fields_with_generated_png_avatar(self):
        response = self.client.patch(self.url, {
            "first_name": "Meena", "city": "Secunderabad", "pincode": "500003", "email_notifications": "false",
            "date_of_birth": "", "avatar": make_png(),
        }, format="multipart")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertTrue(response.data["avatar"].startswith("http://testserver/media/avatars/"))
        self.assertEqual(response.data["citizen_profile"]["city"], "Secunderabad")
        self.assertFalse(response.data["citizen_profile"]["email_notifications"])
        self.assertIsNone(response.data["citizen_profile"]["date_of_birth"])
        self.user.refresh_from_db()
        self.assertTrue(self.user.avatar.name.startswith("avatars/"))

        bracketed = self.client.patch(self.url, {"citizen_profile[area]": "Begumpet"}, format="multipart")
        self.assertEqual(bracketed.status_code, 200, bracketed.data)
        self.assertEqual(bracketed.data["citizen_profile"]["area"], "Begumpet")

        old_name = self.user.avatar.name
        with self.captureOnCommitCallbacks(execute=True):
            removed = self.client.patch(self.url, {"remove_avatar": "true"}, format="multipart")
        self.assertEqual(removed.status_code, 200)
        self.assertIsNone(removed.data["avatar"])
        self.assertFalse(self.user.avatar.storage.exists(old_name))  # old file cleaned up

    def test_invalid_avatar_and_fields_are_rejected(self):
        fake = SimpleUploadedFile("avatar.png", b"definitely not an image", content_type="image/png")
        response = self.client.patch(self.url, {"avatar": fake}, format="multipart")
        self.assertEqual(response.status_code, 400)
        self.assertIn("avatar", response.data["errors"])
        tiny = self.client.patch(self.url, {"avatar": make_png(size=(8, 8))}, format="multipart")
        self.assertEqual(tiny.status_code, 400)
        future = self.client.patch(self.url, {"citizen_profile": {"date_of_birth": "2999-01-01"}}, format="json")
        self.assertEqual(future.status_code, 400)

    def test_officer_profile_contains_officer_details_and_workload(self):
        officer = make_user("officer@example.com", role=User.Role.OFFICER)
        OfficerProfile.objects.create(user=officer, employee_id="RD-1001", zone="Ward 7")
        make_complaint(self.user, officer=officer, status=Complaint.Status.ASSIGNED)
        self.client.force_authenticate(officer)
        response = self.client.get(self.url)
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.data["citizen_profile"])
        self.assertEqual(response.data["officer_profile"]["employee_id"], "RD-1001")
        self.assertEqual(response.data["officer_profile"]["active_workload"], 1)
        self.assertEqual(response.data["stats"]["complaints"], 1)


class UserManagementTests(APITestCase):
    url = "/api/users/"

    def setUp(self):
        self.admin = make_user("admin@example.com", role=User.Role.ADMIN, first_name="Admin")
        self.citizen = make_user("citizen@example.com", first_name="Lakshmi")
        self.citizen.citizen_profile.civic_points = 25
        self.citizen.citizen_profile.save()
        make_complaint(self.citizen)
        make_complaint(self.citizen)

    def test_role_protection(self):
        self.assertEqual(self.client.get(self.url).status_code, 401)
        self.client.force_authenticate(self.citizen)
        self.assertEqual(self.client.get(self.url).status_code, 403)
        officer = make_user("officer@example.com", role=User.Role.OFFICER)
        self.client.force_authenticate(officer)
        self.assertEqual(self.client.get(self.url).status_code, 403)

    def test_list_rows_have_counts_and_filters_work(self):
        self.client.force_authenticate(self.admin)
        response = self.client.get(self.url)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["count"], 2)
        row = next(item for item in response.data["results"] if item["id"] == self.citizen.pk)
        self.assertEqual(row["complaint_count"], 2)
        self.assertEqual(row["civic_points"], 25)
        self.assertEqual(row["stats"], {"complaints": 2, "civic_points": 25})

        citizens = self.client.get(self.url, {"role": "citizen"})
        self.assertEqual([item["id"] for item in citizens.data["results"]], [self.citizen.pk])
        search = self.client.get(self.url, {"search": "lakshmi"})
        self.assertEqual(search.data["count"], 1)
        inactive = self.client.get(self.url, {"is_active": "false"})
        self.assertEqual(inactive.data["count"], 0)

    def test_list_query_count_does_not_grow_with_rows(self):
        self.client.force_authenticate(self.admin)

        def count_queries():
            with CaptureQueriesContext(connection) as context:
                self.assertEqual(self.client.get(self.url).status_code, 200)
            return len(context.captured_queries)

        few = count_queries()
        for index in range(4):
            officer = make_user(f"officer{index}@example.com", role=User.Role.OFFICER)
            OfficerProfile.objects.create(user=officer, employee_id=f"RD-{index}")
            make_complaint(self.citizen, officer=officer, status=Complaint.Status.ASSIGNED)
            make_user(f"citizen{index}@example.com")
        self.assertEqual(count_queries(), few)

    def test_admin_creates_users_of_any_role(self):
        self.client.force_authenticate(self.admin)
        response = self.client.post(self.url, {
            "email": "Field.Officer@Example.com", "password": STRONG_PASSWORD, "first_name": "Kiran", "role": "officer",
        }, format="json")
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(response.data["role"], "officer")
        self.assertEqual(response.data["email"], "field.officer@example.com")
        self.assertIsNotNone(response.data["officer_profile"])  # minimal profile created
        user = User.objects.get(email="field.officer@example.com")
        self.assertTrue(OfficerProfile.objects.filter(user=user, employee_id=f"EMP-{user.pk:05d}").exists())
        self.assertTrue(AuditLog.objects.filter(action="create", actor=self.admin, entity_id=str(user.pk)).exists())

        duplicate = self.client.post(self.url, {"email": "field.officer@example.com", "password": STRONG_PASSWORD,
                                                "first_name": "Copy"}, format="json")
        self.assertEqual(duplicate.status_code, 400)

    def test_update_soft_delete_and_self_protection(self):
        self.client.force_authenticate(self.admin)
        detail = f"{self.url}{self.citizen.pk}/"
        updated = self.client.patch(detail, {"first_name": "Lakshmi Devi", "phone": "040-2345678"}, format="json")
        self.assertEqual(updated.status_code, 200, updated.data)
        self.assertEqual(updated.data["first_name"], "Lakshmi Devi")
        self.assertEqual(updated.data["complaint_count"], 2)

        deleted = self.client.delete(detail)
        self.assertEqual(deleted.status_code, 200)
        self.assertTrue(deleted.data["deactivated"])
        self.citizen.refresh_from_db()
        self.assertFalse(self.citizen.is_active)
        self.assertTrue(User.objects.filter(pk=self.citizen.pk).exists())  # soft delete

        own = f"{self.url}{self.admin.pk}/"
        self.assertEqual(self.client.delete(own).status_code, 400)
        self.assertEqual(self.client.patch(own, {"role": "citizen"}, format="json").status_code, 400)
        self.assertEqual(self.client.patch(own, {"is_active": False}, format="json").status_code, 400)
        self.assertEqual(self.client.get(f"{self.url}abc/").status_code, 404)

    def test_regular_admin_cannot_modify_superuser(self):
        root = User.objects.create_superuser(email="root@example.com", password=STRONG_PASSWORD, first_name="Root")
        self.client.force_authenticate(self.admin)
        patched = self.client.patch(f"{self.url}{root.pk}/", {"first_name": "X"}, format="json")
        self.assertEqual(patched.status_code, 403)
        self.assertEqual(self.client.delete(f"{self.url}{root.pk}/").status_code, 403)
        root.refresh_from_db()
        self.assertTrue(root.is_active)
