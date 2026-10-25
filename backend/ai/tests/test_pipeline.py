"""Tests for the complaint analysis pipeline and model information (BUILD_SPEC section 2.9).

Most tests replace ``ai.vision.analyze_image`` / ``ai.nlp.analyze_text`` with contract-shaped fakes so the
orchestration (steps, failure handling, counts, priors) is tested on its own. ``RealPipelineIntegrationTest``
runs the real engine end to end and is skipped only while a dependency still raises NotImplementedError.

Run from backend/:  venv/Scripts/python.exe -m unittest ai.tests.test_pipeline -v
"""
import os
import unittest
from unittest import mock

import cv2
import numpy as np

from ai.config import CIVIC_CLASSES, CLASS_LABELS, DEMO_DISCLAIMER
from ai.exceptions import AIEngineError, ImageProcessingError
from ai.model_info import get_model_info
from ai.pipeline import AnalysisError, AnalysisNotImplementedError, run_analysis
from ai.severity.severity_config import DEFAULT_CATEGORY_PROFILES

STEP_KEYS = ["preprocess", "image_analysis", "text_analysis", "multimodal_fusion", "location_risk", "severity"]
STEP_LABELS = ["Data preprocessing", "Image AI analysis", "Text NLP analysis", "Multimodal classification",
               "Location risk assessment", "Severity assessment"]
TEXT = "Large pothole near the school entrance causing traffic problems."
LAT, LNG = 17.4100, 78.4400
SCHOOL = {"id": 1, "name": "Govt. High School", "zone_type": "school", "latitude": 17.4107, "longitude": 78.4402,
          "radius_m": 300, "risk_level": 4}
CATEGORIES = [{"id": i + 1, "slug": slug, "name": CLASS_LABELS[slug], "keywords": [slug.replace("_", " ")],
               "vision_labels": [slug], **DEFAULT_CATEGORY_PROFILES[slug]} for i, slug in enumerate(CIVIC_CLASSES)]
# Same shape (and default values) as AIConfiguration.to_engine_config().
ENGINE_CONFIG = {
    "priority": {"weights": {"severity": 40.0, "public_impact": 25.0, "location_risk": 15.0, "frequency": 10.0,
                             "duplicates": 10.0}, "thresholds": {"medium": 26, "high": 51, "critical": 76}},
    "severity": {"thresholds": {"medium": 26, "high": 51, "critical": 76}},
    "fusion": {"image_weight": 0.55, "text_weight": 0.45, "min_confidence": 0.30},
    "duplicate": {"threshold": 0.72, "radius_m": 300, "window_days": 30,
                  "weights": {"text": 0.4, "image": 0.3, "location": 0.3}},
    "hotspot": {"eps_m": 400, "min_samples": 3, "alert_threshold": 5},
    "verification": {"resolved_threshold": 70, "partial_threshold": 45},
    "nearby_radius_m": 500,
    "frequency_window_days": 30,
}


def distribution(top, confidence):
    rest = (1.0 - confidence) / (len(CIVIC_CLASSES) - 1)
    return {c: (confidence if c == top else rest) for c in CIVIC_CLASSES}


def vision_result(category="pothole", confidence=0.88, **overrides):
    result = {
        "category": category, "confidence": confidence, "probabilities": distribution(category, confidence),
        "detected_objects": [{"label": category, "confidence": confidence, "box": [0.2, 0.4, 0.7, 0.8],
                              "area_ratio": 0.2}],
        "bounding_boxes": [[0.2, 0.4, 0.7, 0.8]], "visual_severity": 0.74,
        "quality": {"width": 160, "height": 120, "blur_score": 210.5, "brightness": 0.46, "is_blurry": False,
                    "is_dark": False},
        "model_version": "demo-opencv-heuristic-1.0", "mode": "demo", "is_demo": True, "fallback_reason": None,
        "explanation": "Demo heuristic.", "processing_time_ms": 41,
    }
    result.update(overrides)
    return result


def text_result(category="pothole", confidence=0.91, **overrides):
    result = {
        "category": category, "confidence": confidence, "probabilities": distribution(category, confidence),
        "keywords": ["pothole", "school", "traffic"],
        "impacts": [{"type": "public_safety", "label": "Public Safety", "score": 0.9, "evidence": ["school"]},
                    {"type": "traffic", "label": "Traffic", "score": 0.7, "evidence": ["traffic"]}],
        "primary_impact": "Public Safety", "safety_score": 0.8, "urgency_score": 0.6, "severity_hint": "high",
        "severity_hint_score": 0.72, "location_mentions": ["school entrance"], "clean_text": TEXT.lower(),
        "language": "en", "model_version": "demo-tfidf-logreg-1.0", "mode": "demo", "is_demo": True,
        "explanation": "Demo TF-IDF.", "processing_time_ms": 12,
    }
    result.update(overrides)
    return result


def road_photo(height=120, width=160):
    """Synthetic grey road with a dark pothole (BGR)."""
    rng = np.random.default_rng(7)
    img = np.clip(np.full((height, width, 3), 115, np.int16) + rng.integers(-15, 15, size=(height, width, 1)),
                  0, 255).astype(np.uint8)
    cv2.ellipse(img, (width // 2, int(height * 0.6)), (width // 5, height // 7), 0, 0, 360, (30, 30, 34), -1)
    return img


NEARBY = [
    {"id": 11, "category": "pothole", "latitude": 17.4102, "longitude": 78.4401, "status": "submitted"},
    {"id": 12, "category": "pothole", "latitude": 17.4098, "longitude": 78.4399, "status": "assigned"},
    {"id": 13, "category": "garbage", "latitude": 17.4105, "longitude": 78.4405, "status": "resolved"},
]


class PipelineTestCase(unittest.TestCase):
    """Patches the modality analysers with fakes (demo mode)."""

    def setUp(self):
        self.analyze_image = mock.MagicMock(return_value=vision_result())
        self.analyze_text = mock.MagicMock(return_value=text_result())
        for patcher in (mock.patch("ai.vision.analyze_image", self.analyze_image),
                        mock.patch("ai.nlp.analyze_text", self.analyze_text),
                        mock.patch.dict(os.environ, {"MODEL_MODE": "demo"})):
            patcher.start()
            self.addCleanup(patcher.stop)

    def run_pipeline(self, **overrides):
        kwargs = dict(text=TEXT, latitude=LAT, longitude=LNG, image=road_photo(), filename="pothole_01.jpg",
                      address="Road No. 12, Banjara Hills", reported_category="pothole", categories=CATEGORIES,
                      risk_zones=[SCHOOL], nearby=NEARBY, config=ENGINE_CONFIG)
        kwargs.update(overrides)
        return run_analysis(**kwargs)

    def steps(self, result):
        return {step["key"]: step for step in result["steps"]}


class ContractTests(PipelineTestCase):
    def test_contract_keys(self):
        result = self.run_pipeline()
        for key in ("vision", "text", "fusion", "location_risk", "severity", "nearby_count", "frequency_count",
                    "mode", "is_demo", "model_versions", "steps", "processing_time_ms"):
            self.assertIn(key, result)
        self.assertEqual(result["mode"], "demo")
        self.assertTrue(result["is_demo"])
        self.assertEqual(result["model_versions"]["vision"], "demo-opencv-heuristic-1.0")
        self.assertEqual(result["model_versions"]["text"], "demo-tfidf-logreg-1.0")
        self.assertIsInstance(result["processing_time_ms"], int)
        self.assertEqual(result["fusion"]["category"], "pothole")
        self.assertEqual(result["fusion"]["agreement"], "agree")
        self.assertIn(result["severity"]["severity"], ("high", "critical"))
        self.assertEqual(result["location_risk"]["zones"][0]["name"], "Govt. High School")
        self.assertAlmostEqual(result["public_impact"], 0.97)

    def test_steps_order_labels_and_status(self):
        result = self.run_pipeline()
        self.assertEqual([s["key"] for s in result["steps"]], STEP_KEYS)
        self.assertEqual([s["label"] for s in result["steps"]], STEP_LABELS)
        for step in result["steps"]:
            with self.subTest(step=step["key"]):
                self.assertEqual(set(step), {"key", "label", "status", "duration_ms", "detail"})
                self.assertEqual(step["status"], "done")
                self.assertIsInstance(step["duration_ms"], int)
                self.assertGreaterEqual(step["duration_ms"], 0)
                self.assertTrue(step["detail"])
        self.assertIn("photo decoded (160x120 px)", self.steps(result)["preprocess"]["detail"])

    def test_modalities_receive_decoded_image_hint_and_categories(self):
        self.run_pipeline()
        args, kwargs = self.analyze_image.call_args
        self.assertIsInstance(args[0], np.ndarray)
        self.assertEqual(args[0].shape, (120, 160, 3))
        self.assertEqual(kwargs["filename_hint"], "pothole_01.jpg")
        self.assertIs(kwargs["categories"], CATEGORIES)
        self.analyze_text.assert_called_once_with(TEXT, categories=CATEGORIES)

    def test_nearby_and_frequency_counts(self):
        result = self.run_pipeline()
        self.assertEqual(result["nearby_count"], 3)
        self.assertEqual(result["frequency_count"], 2)  # nearby complaints with the fused category
        self.assertEqual(result["location_prior"], {"pothole": 0.6667, "garbage": 0.3333})
        self.assertGreater(result["fusion"]["weights"]["location"], 0.0)
        self.assertEqual(result["severity"]["factors"]["nearby"]["detail"], "3 complaints nearby")

    def test_frequency_follows_the_fused_category(self):
        self.analyze_image.return_value = vision_result("garbage", 0.8)
        self.analyze_text.return_value = text_result("garbage", 0.85)
        result = self.run_pipeline(reported_category=None)
        self.assertEqual(result["fusion"]["category"], "garbage")
        self.assertEqual(result["frequency_count"], 1)

    def test_text_is_normalised(self):
        self.run_pipeline(text="  Large   pothole near   school \n")
        self.analyze_text.assert_called_once_with("Large pothole near school", categories=CATEGORIES)

    def test_config_sections_are_applied(self):
        config = {**ENGINE_CONFIG, "severity": {"thresholds": {"medium": 5, "high": 10, "critical": 15}}}
        self.assertEqual(self.run_pipeline(config=config)["severity"]["severity"], "critical")


class FailureHandlingTests(PipelineTestCase):
    def test_without_photo_image_step_is_skipped(self):
        result = self.run_pipeline(image=None)
        self.assertEqual(self.steps(result)["image_analysis"]["status"], "skipped")
        self.assertIsNone(result["vision"])
        self.analyze_image.assert_not_called()
        self.assertEqual(result["fusion"]["agreement"], "single_modality")
        self.assertFalse(result["severity"]["factors"]["visual"]["available"])

    def test_image_failure_continues_with_text(self):
        self.analyze_image.side_effect = ImageProcessingError("cannot identify image")
        with self.assertLogs("ai.pipeline", level="WARNING"):
            result = self.run_pipeline()
        steps = self.steps(result)
        self.assertEqual(steps["image_analysis"]["status"], "failed")
        self.assertIn("continues without the photo", steps["image_analysis"]["detail"])
        self.assertEqual(steps["text_analysis"]["status"], "done")
        self.assertEqual(steps["severity"]["status"], "done")
        self.assertIsNone(result["vision"])
        self.assertEqual(result["fusion"]["agreement"], "single_modality")

    def test_malformed_modality_result_counts_as_a_failure(self):
        self.analyze_text.return_value = None  # violates the analyze_text contract
        with self.assertLogs("ai.pipeline", level="WARNING"):
            result = self.run_pipeline()
        self.assertEqual(self.steps(result)["text_analysis"]["status"], "failed")
        self.assertIsNone(result["text"])
        self.assertIsNone(result["model_versions"]["text"])
        self.assertEqual(result["fusion"]["agreement"], "single_modality")

    def test_undecodable_photo_is_reported_without_calling_vision(self):
        result = self.run_pipeline(image=b"this is not a jpeg")
        steps = self.steps(result)
        self.assertIn("photo could not be decoded", steps["preprocess"]["detail"])
        self.assertEqual(steps["image_analysis"]["status"], "failed")
        self.analyze_image.assert_not_called()
        self.assertEqual(result["fusion"]["category"], "pothole")

    def test_empty_text_skips_text_analysis(self):
        result = self.run_pipeline(text="   ")
        self.assertEqual(self.steps(result)["text_analysis"]["status"], "skipped")
        self.analyze_text.assert_not_called()
        self.assertIsNone(result["text"])
        self.assertIsNone(result["public_impact"])
        self.assertEqual(result["fusion"]["agreement"], "single_modality")

    def test_no_evidence_at_all_is_flagged_not_raised(self):
        result = self.run_pipeline(image=None, text="", reported_category=None, nearby=[])
        self.assertEqual(result["fusion"]["agreement"], "none")
        self.assertTrue(result["fusion"]["needs_review"])
        self.assertEqual(result["fusion"]["category"], "other")

    def test_all_modalities_failing_raises_with_steps(self):
        self.analyze_text.side_effect = RuntimeError("model file missing")
        with self.assertLogs("ai.pipeline", level="WARNING"), self.assertRaises(AnalysisError) as caught:
            self.run_pipeline(image=None)
        self.assertIsInstance(caught.exception, AIEngineError)
        self.assertNotIsInstance(caught.exception, NotImplementedError)
        self.assertIn("model file missing", str(caught.exception))
        self.assertEqual([s["key"] for s in caught.exception.steps], ["preprocess", "image_analysis", "text_analysis"])
        self.assertEqual(caught.exception.steps[-1]["status"], "failed")

    def test_stub_dependency_surfaces_as_not_implemented(self):
        self.analyze_text.side_effect = NotImplementedError("ai.nlp.analyze_text is not implemented yet")
        with self.assertLogs("ai.pipeline", level="WARNING"), self.assertRaises(NotImplementedError) as caught:
            self.run_pipeline(image=None)
        self.assertIsInstance(caught.exception, AnalysisNotImplementedError)
        self.assertIsInstance(caught.exception, AnalysisError)
        self.assertEqual(caught.exception.steps[-1]["key"], "text_analysis")

    def test_stub_vision_degrades_to_text_only(self):
        self.analyze_image.side_effect = NotImplementedError("ai.vision.inference.analyze_image is not implemented yet")
        with self.assertLogs("ai.pipeline", level="WARNING"):
            result = self.run_pipeline()
        self.assertEqual(self.steps(result)["image_analysis"]["status"], "failed")
        self.assertEqual(result["fusion"]["agreement"], "single_modality")

    def test_missing_coordinates_skip_the_location_step(self):
        result = self.run_pipeline(latitude=None, longitude=None)  # e.g. /api/ai/classify/ without a location
        steps = self.steps(result)
        self.assertEqual(steps["location_risk"]["status"], "skipped")
        self.assertFalse(result["location_risk"]["assessed"])
        self.assertEqual(steps["severity"]["status"], "done")
        self.assertFalse(result["severity"]["factors"]["location"]["available"])

    def test_invalid_coordinates_fail_only_the_location_step(self):
        with self.assertLogs("ai.pipeline", level="WARNING"):
            result = self.run_pipeline(latitude="north")
        steps = self.steps(result)
        self.assertEqual(steps["location_risk"]["status"], "failed")
        self.assertIn("could not be assessed", result["location_risk"]["explanation"])
        self.assertEqual(steps["severity"]["status"], "done")
        self.assertFalse(result["severity"]["factors"]["location"]["available"])

    def test_production_fallback_is_flagged(self):
        self.analyze_image.return_value = vision_result(mode="production", is_demo=True,
                                                        fallback_reason="ultralytics is not installed")
        self.analyze_text.return_value = text_result(mode="production", is_demo=False,
                                                     model_version="minilm-logreg-1.0")
        with mock.patch.dict(os.environ, {"MODEL_MODE": "production"}):
            result = self.run_pipeline()
        self.assertEqual(result["mode"], "production")
        self.assertTrue(result["is_demo"])  # part of the decision came from a demo technique
        self.assertEqual(result["fallback_reasons"], ["vision: ultralytics is not installed"])
        self.assertIn("Fallback: ultralytics is not installed", self.steps(result)["image_analysis"]["detail"])


class ModelInfoTests(unittest.TestCase):
    def test_structure_in_demo_mode(self):
        with mock.patch.dict(os.environ, {"MODEL_MODE": "demo"}):
            info = get_model_info()
        for key in ("mode", "is_demo", "badge", "models", "components", "registry", "disclaimer"):
            self.assertIn(key, info)
        self.assertEqual((info["mode"], info["is_demo"], info["badge"]), ("demo", True, "Demo AI Mode"))
        self.assertEqual(info["disclaimer"], DEMO_DISCLAIMER)
        self.assertEqual([c["key"] for c in info["components"]],
                         ["priority", "duplicates", "hotspots", "fusion", "severity"])
        for component in info["components"]:
            for key in ("name", "task", "version", "detail"):
                self.assertTrue(component[key], (component["key"], key))
        self.assertGreaterEqual(len(info["models"]), 3)
        self.assertIsInstance(info["registry"], list)
        self.assertEqual(info["components"][0]["weights"]["severity"], 40.0)

    def test_production_mode_has_no_disclaimer(self):
        with mock.patch.dict(os.environ, {"MODEL_MODE": "production"}):
            info = get_model_info()
        self.assertEqual((info["mode"], info["is_demo"], info["badge"]), ("production", False, "Production AI"))
        self.assertIsNone(info["disclaimer"])

    def test_configured_weights_are_reported(self):
        config = {"priority": {"weights": {"severity": 50, "public_impact": 20, "location_risk": 10, "frequency": 10,
                                           "duplicates": 10}},
                  "hotspot": {"eps_m": 250, "min_samples": 4}}
        info = get_model_info(config)
        self.assertEqual(info["components"][0]["weights"]["severity"], 50.0)
        self.assertIn("eps = 250 m", info["components"][2]["detail"])
        sources = {c["key"]: c["parameters"] for c in info["components"]}
        self.assertEqual(sources, {"priority": "configured", "duplicates": "defaults", "hotspots": "configured",
                                   "fusion": "defaults", "severity": "defaults"})
        full = {c["key"]: c["parameters"] for c in get_model_info(ENGINE_CONFIG)["components"]}
        self.assertEqual(set(full.values()), {"configured"})
        self.assertEqual({c["parameters"] for c in get_model_info()["components"]}, {"defaults"})

    def test_failing_module_is_isolated(self):
        with mock.patch("ai.vision.describe_models", side_effect=RuntimeError("boom")), \
                self.assertLogs("ai.model_info", level="WARNING"):
            info = get_model_info()
        vision_rows = [m for m in info["models"] if m["name"] == "vision"]
        self.assertEqual(vision_rows[0]["status"], "error")
        self.assertIn("boom", vision_rows[0]["detail"])
        self.assertTrue(any(m["name"] != "vision" for m in info["models"]))


class RealPipelineIntegrationTest(unittest.TestCase):
    """The real vision + NLP + fusion + geospatial + severity chain; skipped only while a dependency is a stub."""

    def test_end_to_end(self):
        from ai.nlp import analyze_text
        from ai.vision import analyze_image

        photo = road_photo(480, 640)
        try:
            analyze_image(photo, filename_hint=None, categories=CATEGORIES)
            analyze_text(TEXT, categories=CATEGORIES)
        except NotImplementedError as exc:
            self.skipTest(f"a pipeline dependency is not implemented yet: {exc}")

        with mock.patch.dict(os.environ, {"MODEL_MODE": "demo"}):
            try:
                result = run_analysis(text=TEXT, latitude=LAT, longitude=LNG, image=photo, filename="photo.jpg",
                                      address="Road No. 12, Banjara Hills", reported_category=None,
                                      categories=CATEGORIES, risk_zones=[SCHOOL], nearby=NEARBY,
                                      config=ENGINE_CONFIG)
            except NotImplementedError as exc:
                self.skipTest(f"a pipeline dependency is not implemented yet: {exc}")
        self.assertEqual([s["key"] for s in result["steps"]], STEP_KEYS)
        self.assertTrue(all(s["status"] == "done" for s in result["steps"]), result["steps"])
        self.assertIn(result["fusion"]["category"], CIVIC_CLASSES)
        self.assertEqual(result["text"]["category"], "pothole")
        self.assertTrue(0 <= result["severity"]["score"] <= 100)
        self.assertTrue(result["is_demo"])
        self.assertTrue(result["fusion"]["explanation"])
        self.assertTrue(result["severity"]["reason"].endswith("."))


if __name__ == "__main__":
    unittest.main()
