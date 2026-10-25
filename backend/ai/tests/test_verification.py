"""Unit tests for ai.verification (no Django). Run from backend/:

    venv/Scripts/python.exe -m unittest ai.tests.test_verification -v

Uses the synthetic before / repaired-after / unchanged sample photos (``sample_data/images``, rendered in
memory if missing). Expected behaviour (BUILD_SPEC 2.8): before vs repaired -> likely_resolved for most
classes, before vs unchanged re-shot -> not_resolved, before vs a different scene -> needs_manual_review.
"""
from __future__ import annotations

import importlib.util
import json
import os
import unittest
from pathlib import Path
from unittest import mock

import cv2
import numpy as np

from ai.common import reset_registry
from ai.config import CIVIC_CLASSES
from ai.exceptions import ImageProcessingError, ModelUnavailableError
from ai.verification import describe_models, verify_resolution
from ai.verification import metrics as m
from ai.verification import verifier
from ai.verification.preprocessing import align_images, prepare_pair
from ai.vision import analyze_image
from ai.vision import model as vision_model
from ai.vision.preprocessing import load_image

BACKEND_DIR = Path(__file__).resolve().parents[2]
SAMPLES = BACKEND_DIR / "sample_data" / "images"
_GENERATOR = None
_ENV = mock.patch.dict(os.environ, {"MODEL_MODE": "demo"})
STATUSES = {"likely_resolved", "partially_resolved", "not_resolved", "needs_manual_review"}


def setUpModule():
    _ENV.start()


def tearDownModule():
    _ENV.stop()


def _generator():
    global _GENERATOR
    if _GENERATOR is None:
        spec = importlib.util.spec_from_file_location("civicai_sample_generator",
                                                      BACKEND_DIR / "scripts" / "generate_sample_images.py")
        _GENERATOR = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(_GENERATOR)
    return _GENERATOR


def sample(slug: str, index: int = 1, state: str = "before"):
    name = f"{slug}/{slug}_{index:02d}.jpg" if state == "before" else f"{state}/{slug}_{index:02d}_{state}.jpg"
    path = SAMPLES / name
    if path.is_file():
        return path
    return _generator().render_sample(slug, index, state)[0]


def fresh_state():
    reset_registry()
    vision_model.reset_load_failures()


class VerificationContractTests(unittest.TestCase):
    def setUp(self):
        fresh_state()

    def test_result_follows_the_contract(self):
        r = verify_resolution(sample("pothole"), sample("pothole", state="after"), category="pothole")
        expected = {"score", "status", "status_label", "explanation", "metrics", "model_version", "mode", "is_demo",
                    "disclaimer", "processing_time_ms"}
        self.assertTrue(expected.issubset(r))
        self.assertIsInstance(r["score"], int)
        self.assertTrue(0 <= r["score"] <= 100)
        self.assertIn(r["status"], STATUSES)
        self.assertEqual(r["status_label"], verifier.STATUS_LABELS[r["status"]])
        self.assertEqual(r["disclaimer"],
                         "AI-assisted verification - not a guarantee. Officers and admins can override the result.")
        self.assertEqual(r["model_version"], "demo-opencv-verification-1.0")
        self.assertEqual(r["mode"], "demo")
        self.assertIs(r["is_demo"], True)
        self.assertIn("Demo AI Mode", r["explanation"])
        self.assertIsInstance(r["processing_time_ms"], int)
        metrics = r["metrics"]
        for key in ("ssim", "histogram_similarity", "change_ratio", "region_change", "scene_consistency",
                    "after_issue_confidence"):
            self.assertIsInstance(metrics[key], float, key)
            self.assertTrue(0.0 <= metrics[key] <= 1.0, key)
        for key in ("issue_still_detected", "quality_ok"):
            self.assertIsInstance(metrics[key], bool, key)
        for key, value in metrics.items():   # flat: the UI renders metrics as a key/value list
            self.assertNotIsInstance(value, (dict, list), key)
        json.dumps(r)

    def test_repaired_pothole_is_likely_resolved_with_reasons(self):
        r = verify_resolution(sample("pothole"), sample("pothole", state="after"), category="pothole")
        self.assertEqual(r["status"], "likely_resolved")
        self.assertGreaterEqual(r["score"], 70)
        self.assertFalse(r["metrics"]["issue_still_detected"])
        self.assertTrue(r["metrics"]["aligned"])
        self.assertIn("substantial visual change", r["explanation"])
        self.assertIn("no longer detected", r["explanation"])
        self.assertIn("same place", r["explanation"])

    def test_issue_that_is_still_the_top_class_counts_as_still_detected(self):
        """Seen on a QA complaint: the after-photo's top class was still garbage (44%, before 75%), yet the
        explanation said "no longer detected" and the metrics "issue still detected: no"."""
        def vision_result(confidence):
            return {"category": "garbage", "confidence": confidence, "is_demo": True, "fallback_reason": None,
                    "model_version": "demo-test", "bounding_boxes": [],
                    "probabilities": {"garbage": confidence, "other": round(1.0 - confidence, 3)}}

        with mock.patch.object(verifier, "analyze_image", side_effect=[vision_result(0.75), vision_result(0.438)]):
            r = verify_resolution(sample("garbage"), sample("garbage", state="unchanged"), category="garbage")
        self.assertTrue(r["metrics"]["issue_still_detected"])
        self.assertIn("still detected in the after-image (confidence 44%, before 75%)", r["explanation"])
        self.assertNotIn("no longer detected", r["explanation"])
        self.assertEqual(r["status"], "not_resolved")


class ExpectedBehaviourTests(unittest.TestCase):
    """The three scenarios of BUILD_SPEC 2.8 on every class of the sample set."""

    @classmethod
    def setUpClass(cls):
        fresh_state()
        cls.boxes = {slug: analyze_image(sample(slug))["bounding_boxes"] for slug in CIVIC_CLASSES}

    def test_before_vs_repaired_is_likely_resolved_for_most_classes(self):
        for use_boxes in (True, False):
            resolved = []
            for slug in CIVIC_CLASSES:
                boxes = self.boxes[slug] if use_boxes else None
                r = verify_resolution(sample(slug), sample(slug, state="after"), category=slug, boxes=boxes)
                if r["status"] == "likely_resolved":
                    self.assertGreaterEqual(r["score"], 70)
                    resolved.append(slug)
            with self.subTest(boxes=use_boxes):
                self.assertGreaterEqual(len(resolved), 7, f"only {resolved} likely resolved")

    def test_before_vs_unchanged_is_not_resolved(self):
        for slug in CIVIC_CLASSES:
            with self.subTest(slug=slug):
                r = verify_resolution(sample(slug), sample(slug, state="unchanged"), category=slug,
                                      boxes=self.boxes[slug])
                self.assertEqual(r["status"], "not_resolved")
                self.assertLess(r["score"], 45)
                self.assertGreaterEqual(r["metrics"]["scene_consistency"], 0.5)
                if slug != "other":   # the catch-all class cannot be "re-detected"
                    self.assertTrue(r["metrics"]["issue_still_detected"])
                    self.assertIn("still detected", r["explanation"])

    def test_before_vs_different_scene_needs_manual_review(self):
        for before, after in (("pothole", "fallen_tree"), ("garbage", "drainage"), ("open_manhole", "road_crack")):
            with self.subTest(before=before, after=after):
                r = verify_resolution(sample(before), sample(after, state="after"), category=before,
                                      boxes=self.boxes[before])
                self.assertEqual(r["status"], "needs_manual_review")
                self.assertLess(r["metrics"]["scene_consistency"], verifier.SCENE_MISMATCH)
                self.assertIn("may not show the same place", r["explanation"])


class VerificationRulesTests(unittest.TestCase):
    def setUp(self):
        fresh_state()

    def test_thresholds_come_from_config(self):
        before, after = sample("open_manhole"), sample("open_manhole", state="after")
        default = verify_resolution(before, after, category="open_manhole")
        self.assertEqual(default["status"], "likely_resolved")
        strict = verify_resolution(before, after, category="open_manhole",
                                   config={"verification": {"resolved_threshold": 100, "partial_threshold": 50}})
        self.assertEqual(strict["score"], default["score"])
        self.assertEqual(strict["status"], "partially_resolved" if default["score"] >= 50 else "not_resolved")
        with self.assertRaises(ValueError):
            verify_resolution(before, after, config={"resolved_threshold": 40, "partial_threshold": 60})

    def test_poor_quality_needs_manual_review(self):
        dark_after = (load_image(sample("garbage", state="after")) * 0.04).astype(np.uint8)
        r = verify_resolution(sample("garbage"), dark_after, category="garbage")
        self.assertEqual(r["status"], "needs_manual_review")
        self.assertFalse(r["metrics"]["quality_ok"])
        self.assertIn("too dark", r["explanation"])

    def test_category_is_inferred_when_missing(self):
        r = verify_resolution(sample("garbage"), sample("garbage", state="after"))
        self.assertTrue(r["details"]["category_inferred"])
        self.assertEqual(r["details"]["category"], "garbage")
        self.assertIn("No category was given", r["explanation"])

    def test_identical_photos_are_not_resolved(self):
        img = load_image(sample("road_crack"))
        r = verify_resolution(img, img.copy(), category="road_crack")
        self.assertEqual(r["status"], "not_resolved")
        self.assertGreater(r["metrics"]["ssim"], 0.99)
        self.assertLess(r["metrics"]["region_change"], 0.05)

    def test_undecodable_after_image_raises(self):
        with self.assertRaises(ImageProcessingError):
            verify_resolution(sample("pothole"), b"not an image")

    def test_describe_models(self):
        models = describe_models()
        self.assertEqual(len(models), 2)
        for entry in models:
            self.assertEqual(set(entry), {"name", "task", "framework", "version", "status", "is_demo", "detail"})
        self.assertEqual(models[0]["status"], "active")


class FakeClip:
    """Stand-in for the CLIP zero-shot model: ``encode_image`` returns a fixed vector per call order."""

    def __init__(self, vectors):
        self.vectors = [np.asarray(v, dtype=np.float32) / np.linalg.norm(v) for v in vectors]
        self.calls = 0

    def encode_image(self, img):
        vector = self.vectors[self.calls % len(self.vectors)]
        self.calls += 1
        return vector


class ProductionModeTests(unittest.TestCase):
    def setUp(self):
        fresh_state()

    def tearDown(self):
        fresh_state()

    def test_production_without_clip_falls_back_and_reports_it(self):
        with mock.patch.dict(os.environ, {"MODEL_MODE": "production"}), \
                mock.patch.object(vision_model, "_installed", return_value=False):
            r = verify_resolution(sample("pothole"), sample("pothole", state="after"), category="pothole")
            models = {e["name"]: e for e in describe_models()}
        self.assertEqual(r["mode"], "production")
        self.assertIs(r["is_demo"], True)
        self.assertEqual(r["model_version"], verifier.DEMO_VERSION)
        self.assertIn("sentence-transformers", r["fallback_reason"])
        self.assertIsNone(r["metrics"]["clip_similarity"])
        self.assertEqual(r["status"], "likely_resolved")
        self.assertEqual(models["CLIP scene similarity"]["status"], "not_installed")

    def test_clip_scene_similarity_is_used_and_can_veto(self):
        similar = FakeClip([[1.0, 0.1, 0.0], [1.0, 0.12, 0.0]])
        unrelated = FakeClip([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])
        with mock.patch.dict(os.environ, {"MODEL_MODE": "production"}), \
                mock.patch.object(verifier, "load_clip_model", return_value=similar), \
                mock.patch.object(vision_model, "load_yolo_model", side_effect=ModelUnavailableError("YOLO: test")), \
                mock.patch.object(vision_model, "load_clip_encoder", side_effect=ModelUnavailableError("CLIP: test")):
            ok = verify_resolution(sample("pothole"), sample("pothole", state="after"), category="pothole")
        with mock.patch.dict(os.environ, {"MODEL_MODE": "production"}), \
                mock.patch.object(verifier, "load_clip_model", return_value=unrelated), \
                mock.patch.object(vision_model, "load_yolo_model", side_effect=ModelUnavailableError("YOLO: test")), \
                mock.patch.object(vision_model, "load_clip_encoder", side_effect=ModelUnavailableError("CLIP: test")):
            vetoed = verify_resolution(sample("pothole"), sample("pothole", state="after"), category="pothole")
        self.assertGreater(ok["metrics"]["clip_similarity"], 0.99)
        self.assertTrue(ok["model_version"].endswith("clip-ViT-B-32"))
        self.assertEqual(ok["status"], "likely_resolved")
        self.assertIs(ok["is_demo"], True)            # re-detection fell back to the demo vision heuristics
        self.assertIn("YOLO: test", ok["fallback_reason"])
        self.assertAlmostEqual(vetoed["metrics"]["clip_similarity"], 0.0, places=3)
        self.assertEqual(vetoed["status"], "needs_manual_review")   # CLIP says the photos show unrelated things


class MetricsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.img = load_image(sample("garbage"))

    def test_ssim_properties(self):
        a = self.img
        rng = np.random.default_rng(0)
        noisy = np.clip(a.astype(np.int16) + rng.normal(0, 25, a.shape), 0, 255).astype(np.uint8)
        other = load_image(sample("fallen_tree"))
        self.assertAlmostEqual(m.ssim(a, a), 1.0, places=6)
        self.assertAlmostEqual(m.ssim(a, noisy), m.ssim(noisy, a), places=6)
        self.assertLess(m.ssim(a, noisy), 0.9)
        self.assertLess(m.ssim(a, other), m.ssim(a, noisy))
        constant = np.full((64, 64), 120, np.uint8)
        self.assertAlmostEqual(m.ssim(constant, constant), 1.0, places=6)

    def test_histogram_edges_and_colour(self):
        a = self.img
        self.assertAlmostEqual(m.histogram_similarity(a, a), 1.0, places=6)
        self.assertEqual(m.edge_density_change(a, a), 0.0)
        self.assertEqual(m.colour_shift(a, a), 0.0)
        self.assertEqual(m.mean_abs_diff(a, a), 0.0)
        plain = cv2.GaussianBlur(a, (0, 0), 8)
        self.assertGreater(m.edge_density_change(a, plain), 0.5)

    def test_photometric_normalisation_removes_lighting_change(self):
        a = self.img.astype(np.float64)
        darker = np.clip(a * 0.8 + 10, 0, 255).astype(np.uint8)
        corrected = m.normalise_photometry(darker, self.img)
        self.assertLess(np.abs(corrected - a).mean(), 2.5)
        change = m.change_map(self.img, darker)
        self.assertLess(m.change_ratio(change), 0.02)

    def test_region_change_and_most_changed_box(self):
        before = self.img.copy()
        after = before.copy()
        after[120:240, 200:360] = (225, 225, 225)       # a visible 160x120 change (e.g. fresh concrete)
        change = m.change_map(before, after)
        inside, _, source = m.region_change(change, [[200 / 640, 120 / 480, 360 / 640, 240 / 480]])
        elsewhere, _, _ = m.region_change(change, [[0.0, 0.7, 0.2, 0.95]])
        self.assertEqual(source, "prior_boxes")
        self.assertGreater(inside, 0.5)
        self.assertLess(elsewhere, 0.1)
        auto, box, source = m.region_change(change)
        self.assertEqual(source, "most_changed_region")
        self.assertGreater(auto, 0.5)
        self.assertLess(abs((box[0] + box[2]) / 2 - 280 / 640), 0.06)
        self.assertLess(abs((box[1] + box[3]) / 2 - 180 / 480), 0.06)


class AlignmentTests(unittest.TestCase):
    def test_registers_a_moved_camera(self):
        before = load_image(sample("pothole"))
        h, w = before.shape[:2]
        matrix = cv2.getRotationMatrix2D((w / 2, h / 2), 3.0, 1.04)
        matrix[:, 2] += (14, -9)
        moved = cv2.warpAffine(before, matrix, (w, h), borderMode=cv2.BORDER_REFLECT)
        b, a, info = prepare_pair(before, moved)
        result = align_images(b, a)
        self.assertTrue(result.aligned)
        self.assertGreater(result.inlier_ratio, 0.5)
        self.assertGreater(result.scene_consistency, 0.5)
        self.assertFalse(info["aspect_mismatch"])
        self.assertGreater(m.ssim(b, result.after, result.valid), m.ssim(b, a) + 0.2)

    def test_plain_images_do_not_align(self):
        plain = np.full((240, 320, 3), 128, np.uint8)
        result = align_images(plain, plain.copy())
        self.assertFalse(result.aligned)
        self.assertFalse(result.enough_features)


if __name__ == "__main__":
    unittest.main()
