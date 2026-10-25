"""Regression tests for the security / robustness hardening of the API (phase-4 audit findings).

* client identity: audit-log IP and rate-limit identity ignore a forged ``X-Forwarded-For`` unless a trusted proxy
  count is configured, and never store a value that is not an IP address;
* hostile query strings and bodies get 4xx answers, never 500: Unicode digits, integers beyond 64 bits, dates
  outside 2000-2100, thousands of form fields, oversized bodies;
* uploaded images: the real format decides (a TIFF renamed ``photo.jpg`` is rejected), decompression bombs are
  rejected before decoding, and stored photos are re-encoded without EXIF / GPS under an unguessable name;
* the built-in scheduler of the periodic SLA / hotspot checks.
"""
import io
import re
import shutil
import tempfile
from decimal import Decimal
from pathlib import Path
from unittest import mock

from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import DataError
from django.test import RequestFactory, SimpleTestCase, TestCase, override_settings
from PIL import ExifTags, Image
from rest_framework.settings import api_settings
from rest_framework.test import APITestCase
from rest_framework.throttling import AnonRateThrottle

from apps.accounts.models import User
from apps.audit.models import AuditLog
from apps.complaints.models import Complaint, ComplaintImage, Location
from apps.departments.models import CivicCategory, Department

from . import scheduler
from .exceptions import custom_exception_handler
from .images import sanitize_image_upload
from .throttles import CivicScopedRateThrottle
from .utils import MAX_DB_ID, get_client_ip, normalize_ip, parse_id
from .validators import validate_image_upload

PASSWORD = "Civic#Route2026"
HUGE = "99999999999999999999999"


def image_bytes(fmt="JPEG", size=(640, 480), color=(180, 40, 40), **save_options):
    buffer = io.BytesIO()
    Image.new("RGB" if fmt != "PNG" else "RGBA", size, color).save(buffer, format=fmt, **save_options)
    return buffer.getvalue()


def jpeg_with_gps(size=(800, 600)):
    exif = Image.Exif()
    exif[ExifTags.Base.Make] = "TestPhone"
    exif[ExifTags.Base.Model] = "X1"
    exif[ExifTags.IFD.GPSInfo] = {ExifTags.GPS.GPSLatitudeRef: "N", ExifTags.GPS.GPSLatitude: (17.0, 26.0, 30.0),
                                  ExifTags.GPS.GPSLongitudeRef: "E", ExifTags.GPS.GPSLongitude: (78.0, 29.0, 0.0)}
    return image_bytes("JPEG", size, exif=exif.tobytes())


# ---------------------------------------------------------------------------------------------------------------
# Client identity (audit IP + throttling)
# ---------------------------------------------------------------------------------------------------------------
class ClientIpTests(SimpleTestCase):
    def request(self, remote="198.51.100.20", forwarded=None):
        extra = {"REMOTE_ADDR": remote}
        if forwarded is not None:
            extra["HTTP_X_FORWARDED_FOR"] = forwarded
        return RequestFactory().get("/", **extra)

    def test_forwarded_header_is_ignored_without_a_trusted_proxy(self):
        self.assertEqual(api_settings.NUM_PROXIES, 0)  # secure default: not None (whole header) and not 1
        self.assertEqual(get_client_ip(self.request(forwarded="6.6.6.6")), "198.51.100.20")
        self.assertEqual(get_client_ip(self.request(forwarded="not-an-ip <b>x</b>")), "198.51.100.20")

    def test_trusted_proxy_count_takes_the_address_the_proxy_appended(self):
        with mock.patch.object(api_settings, "NUM_PROXIES", 1):
            # client-supplied "6.6.6.6" first, the proxy appended the real client address last
            self.assertEqual(get_client_ip(self.request("10.0.0.1", "6.6.6.6, 203.0.113.9")), "203.0.113.9")
            self.assertEqual(get_client_ip(self.request("10.0.0.1", "203.0.113.9")), "203.0.113.9")
            self.assertIsNone(get_client_ip(self.request("10.0.0.1", "203.0.113.9, garbage")))
            self.assertEqual(get_client_ip(self.request("10.0.0.1")), "10.0.0.1")
        with mock.patch.object(api_settings, "NUM_PROXIES", 2):
            self.assertEqual(get_client_ip(self.request("10.0.0.1", "6.6.6.6, 203.0.113.9, 10.0.0.2")),
                             "203.0.113.9")

    def test_only_real_ip_addresses_are_returned(self):
        self.assertEqual(normalize_ip("203.0.113.9:5120"), "203.0.113.9")
        self.assertEqual(normalize_ip("[2001:db8::1]:443"), "2001:db8::1")
        self.assertEqual(normalize_ip("2001:DB8:0::1"), "2001:db8::1")
        for value in ("", None, "not-an-ip", "999.1.1.1", "<script>", "1.2.3.4, 5.6.7.8"):
            with self.subTest(value=value):
                self.assertIsNone(normalize_ip(value))
        self.assertIsNone(get_client_ip(None))
        self.assertIsNone(get_client_ip(self.request(remote="")))

    def test_throttle_identity_ignores_a_forged_forwarded_header(self):
        throttle = AnonRateThrottle()
        first = throttle.get_ident(self.request(forwarded="10.9.1.1"))
        second = throttle.get_ident(self.request(forwarded="10.9.2.2"))
        self.assertEqual(first, second)
        self.assertEqual(first, "198.51.100.20")


class AuditIpTests(APITestCase):
    def test_failed_login_audit_row_records_the_real_address(self):
        User.objects.create_user(email="asha@example.com", password=PASSWORD, first_name="Asha")
        self.client.post("/api/auth/login/", {"email": "asha@example.com", "password": "wrong"}, format="json",
                         REMOTE_ADDR="198.51.100.7", HTTP_X_FORWARDED_FOR="not-an-ip <b>x</b> AAAA")
        self.client.post("/api/auth/login/", {"email": "asha@example.com", "password": "wrong"}, format="json",
                         REMOTE_ADDR="198.51.100.7", HTTP_X_FORWARDED_FOR="6.6.6.6")
        self.assertEqual(list(AuditLog.objects.values_list("ip_address", flat=True)), ["198.51.100.7"] * 2)

    @override_settings(TESTING=False)
    def test_login_rate_limit_cannot_be_bypassed_with_forwarded_headers(self):
        cache.clear()
        with mock.patch.object(CivicScopedRateThrottle, "THROTTLE_RATES", {"auth": "3/min"}):
            statuses = [
                self.client.post("/api/auth/login/", {"email": "x@example.com", "password": "bad"}, format="json",
                                 HTTP_X_FORWARDED_FOR=f"10.9.{n}.{n}").status_code
                for n in range(5)
            ]
        cache.clear()
        self.assertEqual(statuses, [401, 401, 401, 429, 429])


# ---------------------------------------------------------------------------------------------------------------
# Hostile query strings / bodies -> 4xx, never 500
# ---------------------------------------------------------------------------------------------------------------
class ParseIdTests(SimpleTestCase):
    def test_only_ascii_digits_in_the_64_bit_range_are_ids(self):
        self.assertEqual(parse_id("12"), 12)
        self.assertEqual(parse_id(" 7 "), 7)
        self.assertEqual(parse_id(5), 5)
        self.assertEqual(parse_id(str(MAX_DB_ID)), MAX_DB_ID)
        for value in ("²", "٣", "1e30", HUGE, str(MAX_DB_ID + 1), "0", "-3", "3.5", "", None, True, "pothole"):
            with self.subTest(value=value):
                self.assertIsNone(parse_id(value))


class HostileInputTests(APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.roads = Department.objects.create(name="Roads Department", code="ROADS")
        cls.pothole = CivicCategory.objects.create(name="Roads / Potholes", slug="pothole", department=cls.roads)
        cls.admin = User.objects.create_user(email="admin@example.com", password=PASSWORD, role="admin",
                                             first_name="Anita")
        cls.citizen = User.objects.create_user(email="citizen@example.com", password=PASSWORD, first_name="Rahul")
        cls.officer = User.objects.create_user(email="officer@example.com", password=PASSWORD, role="officer",
                                               first_name="Ravi")
        location = Location.objects.create(latitude=Decimal("17.385000"), longitude=Decimal("78.486700"),
                                           area="Abids", city="Hyderabad")
        cls.complaint = Complaint.objects.create(citizen=cls.citizen, category=cls.pothole, department=cls.roads,
                                                 location=location, status=Complaint.Status.ASSIGNED,
                                                 description="Large pothole near the bus stop.")

    def setUp(self):
        self.client.force_authenticate(self.admin)

    def status_of(self, method, url, data=None, **extra):
        response = getattr(self.client, method)(url, data, **extra)
        return response.status_code

    def test_unicode_digits_are_treated_as_unknown_slugs(self):
        for url in ("/api/complaints/", "/api/complaints/map/", "/api/feedback/", "/api/officers/"):
            for name in ("category", "department"):
                with self.subTest(url=url, filter=name):
                    response = self.client.get(url, {name: "²"})
                    self.assertEqual(response.status_code, 200)
        for url in ("/api/analytics/overview/", "/api/analytics/categories/"):
            with self.subTest(url=url):
                self.assertEqual(self.status_of("get", url, {"category": "²"}), 400)
                self.assertEqual(self.status_of("get", url, {"department": "²"}), 400)
        self.assertEqual(self.client.get("/api/feedback/", {"rating": "²,4"}).status_code, 200)
        self.client.force_authenticate(self.citizen)
        response = self.client.post("/api/complaints/", {"description": "Large pothole near the bus stop.",
                                                         "latitude": "17.385", "longitude": "78.4867",
                                                         "category": "²"}, format="multipart")
        self.assertEqual(response.status_code, 400)
        self.assertIn("category", response.data["errors"])
        response = self.client.post("/api/ai/analyze/", {"description": "Large pothole near the bus stop.",
                                                         "category": "²"}, format="multipart")
        self.assertEqual(response.status_code, 400)

    def test_numbers_beyond_64_bits_are_rejected_or_not_found(self):
        for url, params in (
            ("/api/complaints/", {"citizen": "1e30"}),
            ("/api/complaints/", {"assigned_officer": HUGE}),
            ("/api/complaints/", {"citizen": "1.5"}),
            ("/api/duplicates/", {"complaint": HUGE}),
            ("/api/feedback/", {"complaint": HUGE}),
            ("/api/assignments/", {"officer": HUGE}),
            ("/api/audit-logs/", {"actor": HUGE}),
            ("/api/categories/", {"department": HUGE}),
        ):
            with self.subTest(url=url, params=params):
                self.assertEqual(self.status_of("get", url, params), 400)
        for url in (f"/api/complaints/{HUGE}/", f"/api/officers/{HUGE}/workload/", f"/api/analytics/alerts/{HUGE}/",
                    f"/api/users/{HUGE}/", f"/api/notifications/{HUGE}/read/", f"/api/departments/{HUGE}/"):
            with self.subTest(url=url):
                self.assertEqual(self.status_of("get", url), 404)
        self.assertEqual(self.client.get("/api/complaints/", {"citizen": self.citizen.pk}).data["count"], 1)

    def test_unassigned_filter(self):
        self.assertEqual(self.client.get("/api/complaints/", {"unassigned": "true"}).data["count"], 1)
        Complaint.objects.filter(pk=self.complaint.pk).update(assigned_officer=self.officer)
        self.assertEqual(self.client.get("/api/complaints/", {"unassigned": "true"}).data["count"], 0)
        self.assertEqual(self.client.get("/api/complaints/", {"unassigned": "false"}).data["count"], 1)
        Complaint.objects.filter(pk=self.complaint.pk).update(assigned_officer=None, status="closed")
        self.assertEqual(self.client.get("/api/complaints/", {"unassigned": "true"}).data["count"], 0)
        self.assertEqual(len(self.client.get("/api/complaints/map/", {"unassigned": "true"}).data), 0)

    def test_dates_outside_the_supported_window_are_rejected(self):
        for url in ("/api/complaints/", "/api/complaints/map/", "/api/feedback/", "/api/audit-logs/"):
            for params in ({"date_to": "9999-12-31"}, {"date_from": "0001-01-01"}):
                with self.subTest(url=url, params=params):
                    response = self.client.get(url, params)
                    self.assertEqual(response.status_code, 400)
        self.assertEqual(self.client.get("/api/complaints/", {"date_from": "2026-01-01"}).status_code, 200)

    def test_too_many_form_fields_is_a_bad_request(self):
        self.client.force_authenticate(None)
        body = "&".join(f"f{n}=x" for n in range(1500))
        response = self.client.generic("POST", "/api/contact/", body, content_type="application/x-www-form-urlencoded")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["code"], "parse_error")

    @override_settings(MAX_REQUEST_BODY_BYTES=1024)
    def test_oversized_request_body_is_refused_before_it_is_read(self):
        self.client.force_authenticate(None)
        response = self.client.generic("POST", "/api/contact/", "x" * 4096, content_type="application/json")
        self.assertEqual(response.status_code, 413)
        self.assertEqual(response.json()["code"], "payload_too_large")

    def test_database_range_errors_become_validation_errors(self):
        for error in (OverflowError("Python int too large to convert to SQLite INTEGER"),
                      DataError("Out of range value for column 'id'")):
            with self.subTest(error=type(error).__name__), self.assertLogs("apps.core", level="WARNING"):
                response = custom_exception_handler(error, {})
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.data["code"], "validation_error")


# ---------------------------------------------------------------------------------------------------------------
# Uploaded images
# ---------------------------------------------------------------------------------------------------------------
class ImageUploadTests(SimpleTestCase):
    def upload(self, data, name="photo.jpg"):
        return SimpleUploadedFile(name, data)

    def assert_rejected(self, data, name, message):
        with self.assertRaisesMessage(Exception, message):
            validate_image_upload(self.upload(data, name))

    def test_real_format_decides_not_the_file_name(self):
        for fmt in ("TIFF", "GIF", "BMP"):
            with self.subTest(fmt=fmt):
                self.assert_rejected(image_bytes(fmt), "photo.jpg", f"Unsupported image format ({fmt})")
        validate_image_upload(self.upload(image_bytes("PNG"), "photo.jpg"))  # a PNG named .jpg is still an image

    def test_decompression_bombs_are_rejected_before_decoding(self):
        bomb = io.BytesIO()
        Image.new("L", (8000, 8000)).save(bomb, format="PNG")  # ~100 KB file, 64 megapixels
        self.assert_rejected(bomb.getvalue(), "bomb.png", "exceeds the 12 megapixel limit for PNG and WebP images")
        with override_settings(MAX_IMAGE_PIXELS=1_000_000):
            self.assert_rejected(image_bytes("JPEG", (1200, 1000)), "big.jpg", "exceeds the 1 megapixel limit")

    def test_sanitised_copy_has_no_metadata_and_an_unguessable_name(self):
        clean = sanitize_image_upload(self.upload(jpeg_with_gps(), "IMG_20261017_101530.jpg"))
        data = clean.read()
        self.assertRegex(clean.name, r"^[0-9a-f]{20}-IMG_20261017_101530\.jpg$")
        self.assertEqual(clean.content_type, "image/jpeg")
        self.assertNotIn(b"TestPhone", data)
        with Image.open(io.BytesIO(data)) as img:
            self.assertEqual(img.format, "JPEG")
            self.assertEqual(len(img.getexif()), 0)
        # The extension follows the content: a PNG uploaded as "shot.jpg" is stored as .png
        renamed = sanitize_image_upload(self.upload(image_bytes("PNG"), "shot.jpg"))
        self.assertTrue(renamed.name.endswith("-shot.png"))
        self.assertEqual(renamed.content_type, "image/png")

    @override_settings(MAX_STORED_IMAGE_SIDE=1000)
    def test_large_photos_are_downscaled(self):
        clean = sanitize_image_upload(self.upload(image_bytes("JPEG", (4000, 3000)), "wide.jpg"))
        with Image.open(clean) as img:
            self.assertEqual(img.size, (1000, 750))

    def test_exif_orientation_is_applied_to_the_pixels(self):
        exif = Image.Exif()
        exif[ExifTags.Base.Orientation] = 6  # "rotate 90 degrees clockwise to display"
        clean = sanitize_image_upload(self.upload(image_bytes("JPEG", (800, 600), exif=exif.tobytes())))
        with Image.open(clean) as img:
            self.assertEqual(img.size, (600, 800))
            self.assertNotIn(ExifTags.Base.Orientation, img.getexif())


@override_settings(MEDIA_ROOT=tempfile.mkdtemp(prefix="civicai-hardening-media-"))
class StoredPhotoTests(APITestCase):
    """End to end: the complaint photo a citizen uploads is stored without EXIF / GPS under a random name."""

    @classmethod
    def tearDownClass(cls):
        from django.conf import settings

        shutil.rmtree(settings.MEDIA_ROOT, ignore_errors=True)
        super().tearDownClass()

    def test_complaint_photo_is_stored_clean(self):
        from django.core.management import call_command

        call_command("init_civicai", verbosity=0)
        citizen = User.objects.create_user(email="citizen@example.com", password=PASSWORD, first_name="Rahul")
        self.client.force_authenticate(citizen)
        response = self.client.post("/api/complaints/", {
            "description": "Large pothole near the bus stop causing traffic problems.",
            "latitude": "17.385", "longitude": "78.4867", "area": "Abids",
            "image": SimpleUploadedFile("pothole_photo.jpg", jpeg_with_gps((1600, 1200)), content_type="image/jpeg"),
        }, format="multipart")
        self.assertEqual(response.status_code, 201, response.data)
        photo = ComplaintImage.objects.get(complaint_id=response.data["id"])
        stored = Path(photo.image.path)
        self.assertRegex(stored.name, r"^[0-9a-f]{20}-pothole_photo\.jpg$")
        data = stored.read_bytes()
        self.assertNotIn(b"TestPhone", data)
        with Image.open(stored) as img:
            self.assertEqual(len(img.getexif()), 0)
            self.assertEqual((photo.width, photo.height), img.size)
        self.assertEqual(photo.file_size, len(data))
        self.assertTrue(re.search(r"/media/complaints/\d{4}/\d{2}/[0-9a-f]{20}-pothole_photo\.jpg$",
                                  response.data["images"][0]["url"]))


# ---------------------------------------------------------------------------------------------------------------
# Built-in scheduler of the periodic checks
# ---------------------------------------------------------------------------------------------------------------
class SchedulerTests(TestCase):
    def setUp(self):
        cache.clear()
        self.addCleanup(cache.clear)

    def test_each_check_starts_once_per_interval(self):
        started = []
        spawn = lambda key, path: started.append(key)  # noqa: E731 - synchronous stand-in for the thread
        self.assertEqual(scheduler.start_due_checks(spawn=spawn), ["sla_check", "hotspot_scan"])
        self.assertEqual(scheduler.start_due_checks(spawn=spawn), [])
        cache.delete(f"{scheduler.CACHE_PREFIX}sla_check")  # the SLA interval elapsed
        self.assertEqual(scheduler.start_due_checks(spawn=spawn), ["sla_check"])
        self.assertEqual(started, ["sla_check", "hotspot_scan", "sla_check"])
        with override_settings(HOTSPOT_SCAN_INTERVAL_MINUTES=0):
            cache.clear()
            self.assertEqual(scheduler.start_due_checks(spawn=spawn), ["sla_check"])

    def test_run_check_executes_the_task_and_never_raises(self):
        with mock.patch("apps.complaints.tasks.check_sla_breaches", return_value=2) as task:
            scheduler.run_check("sla_check", "apps.complaints.tasks.check_sla_breaches")
        task.assert_called_once_with()
        with mock.patch("apps.complaints.tasks.check_sla_breaches", side_effect=RuntimeError("db down")), \
                self.assertLogs("apps.core", level="ERROR"):
            scheduler.run_check("sla_check", "apps.complaints.tasks.check_sla_breaches")

    def test_middleware_starts_due_checks_only_when_enabled(self):
        with mock.patch.object(scheduler, "_spawn_thread") as spawn:
            self.client.get("/api/health/")
            spawn.assert_not_called()  # disabled while the test-suite runs
            with override_settings(PERIODIC_CHECKS_ENABLED=True):
                self.client.get("/api/health/")
                self.client.get("/api/health/")
        self.assertEqual(sorted(call.args[0] for call in spawn.call_args_list), ["hotspot_scan", "sla_check"])
