"""Tests for the public landing-page demo ``POST /api/ai/demo/`` (real AI engine, demo mode).

The endpoint must work without an account, run the real vision / NLP / fusion / severity engines, never write to
the database or the media storage, validate its inputs and be rate limited with the ``ai_public`` scope.
"""
import io
import os
import shutil
import tempfile
from pathlib import Path
from unittest import mock

from django.conf import settings
from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.management import call_command
from django.db import connection
from django.test import override_settings
from django.test.utils import CaptureQueriesContext
from django.urls import reverse
from rest_framework.test import APITestCase

from ai import vision as vision_engine
from apps.core.models import AIConfiguration
from apps.core.throttles import CivicScopedRateThrottle

from .models import AIPrediction, Complaint

SAMPLE_IMAGES = Path(settings.BASE_DIR) / "sample_data" / "images"
DEMO_KEYS = {"vision", "text", "fusion", "category", "severity_hint", "is_demo", "mode", "disclaimer",
             "processing_time_ms"}
WRITE_STATEMENTS = ("INSERT", "UPDATE", "DELETE", "REPLACE")


def sample_image(slug):
    """First generated sample photo of a category (``backend/sample_data/images/<slug>/``)."""
    folder = SAMPLE_IMAGES / slug
    files = sorted(folder.glob("*.jpg")) if folder.is_dir() else []
    if not files:
        raise AssertionError(f"No sample images in {folder}; run scripts/generate_sample_images.py")
    return files[0]


def upload(path, name=None):
    return SimpleUploadedFile(name or path.name, path.read_bytes(), content_type="image/jpeg")


@mock.patch.dict(os.environ, {"MODEL_MODE": "demo"})
class PublicDemoEndpointTests(APITestCase):
    url = reverse("ai-demo")

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.media_root = tempfile.mkdtemp(prefix="civicai-demo-media-")
        cls.enterClassContext(override_settings(MEDIA_ROOT=cls.media_root))

    @classmethod
    def tearDownClass(cls):
        super().tearDownClass()
        shutil.rmtree(cls.media_root, ignore_errors=True)

    @classmethod
    def setUpTestData(cls):
        call_command("init_civicai", stdout=io.StringIO())
        AIConfiguration.load()

    def setUp(self):
        cache.clear()  # throttle history lives in the cache

    def post(self, data, **extra):
        return self.client.post(self.url, data, format="multipart", **extra)

    def assert_no_writes(self, context):
        writes = [query["sql"] for query in context.captured_queries
                  if query["sql"].lstrip().upper().startswith(WRITE_STATEMENTS)]
        self.assertEqual(writes, [], "the public demo must not write to the database")

    def test_photo_and_description_run_every_engine_without_writing_anything(self):
        counts_before = (Complaint.objects.count(), AIPrediction.objects.count())
        with CaptureQueriesContext(connection) as context:
            response = self.post({
                "image": upload(sample_image("pothole"), name="upload.jpg"),
                "description": "Large pothole on the main road near the school, vehicles are swerving.",
            })
        self.assertEqual(response.status_code, 200, response.data)
        data = response.data
        self.assertEqual(set(data), DEMO_KEYS)
        self.assert_no_writes(context)
        self.assertEqual((Complaint.objects.count(), AIPrediction.objects.count()), counts_before)
        self.assertEqual(os.listdir(self.media_root), [])  # the photo is never stored

        self.assertEqual(data["category"]["slug"], "pothole")
        self.assertEqual(set(data["category"]), {"id", "name", "slug", "icon", "color"})
        self.assertEqual(data["fusion"]["category"], "pothole")
        self.assertIn(data["fusion"]["agreement"], ("agree", "disagree"))
        self.assertIsNotNone(data["vision"])
        self.assertTrue(data["vision"]["is_demo"])
        self.assertEqual(data["text"]["category"], "pothole")
        self.assertEqual((data["is_demo"], data["mode"]), (True, "demo"))
        self.assertIn("Demo AI Mode", data["disclaimer"])
        self.assertIn("nothing is stored", data["disclaimer"])
        hint = data["severity_hint"]
        self.assertEqual(set(hint), {"level", "score", "reason"})
        self.assertIn(hint["level"], ("low", "medium", "high", "critical"))
        self.assertTrue(0 <= hint["score"] <= 100)
        self.assertTrue(hint["reason"])
        self.assertIsInstance(data["processing_time_ms"], int)
        self.assertGreaterEqual(data["processing_time_ms"], 0)

    def test_description_only(self):
        response = self.post({"description": "Garbage dumped near the bus stop, very bad smell and flies."})
        self.assertEqual(response.status_code, 200, response.data)
        self.assertIsNone(response.data["vision"])
        self.assertEqual(response.data["text"]["category"], "garbage")
        self.assertEqual(response.data["category"]["slug"], "garbage")
        self.assertEqual(response.data["fusion"]["agreement"], "single_modality")

    def test_photo_only_uses_pixels_not_the_file_name(self):
        path = sample_image("fallen_tree")
        with mock.patch("ai.vision.analyze_image", wraps=vision_engine.analyze_image) as spy:
            response = self.post({"image": upload(path)})
        self.assertEqual(response.status_code, 200, response.data)
        self.assertIsNone(response.data["text"])
        self.assertIsNotNone(response.data["vision"])
        self.assertIsNone(spy.call_args.kwargs["filename_hint"])
        self.assertIn(response.data["fusion"]["agreement"], ("single_modality", "none"))

    def test_validation(self):
        self.assertEqual(self.post({}).status_code, 400)
        self.assertEqual(self.post({"description": ""}).status_code, 400)
        too_long = self.post({"description": "pothole " * 200})
        self.assertEqual(too_long.status_code, 400)
        self.assertIn("description", too_long.data["errors"])
        not_an_image = self.post({"image": SimpleUploadedFile("photo.jpg", b"definitely not a jpeg",
                                                              content_type="image/jpeg")})
        self.assertEqual(not_an_image.status_code, 400)
        self.assertIn("image", not_an_image.data["errors"])
        self.assertEqual(self.client.get(self.url).status_code, 405)

    def test_public_and_ignores_credentials(self):
        response = self.post({"description": "Streetlight not working on the main road at night."},
                             HTTP_AUTHORIZATION="Bearer not-a-valid-token")
        self.assertEqual(response.status_code, 200, response.data)  # an expired / bad token never blocks the demo

    @override_settings(TESTING=False)
    def test_rate_limited_with_the_ai_public_scope(self):
        with mock.patch.object(CivicScopedRateThrottle, "THROTTLE_RATES", {"ai_public": "2/min"}):
            codes = [self.post({"description": "Water pipeline burst, water wasting on the road."}).status_code
                     for _ in range(3)]
        self.assertEqual(codes, [200, 200, 429])
