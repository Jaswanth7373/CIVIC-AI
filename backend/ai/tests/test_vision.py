"""Unit tests for ai.vision (no Django). Run from backend/:

    venv/Scripts/python.exe -m unittest ai.tests.test_vision -v

The demo-mode tests use the committed synthetic sample photos (``sample_data/images``); if they are missing
the same scenes are rendered in memory with ``scripts/generate_sample_images.py``. Production paths are
exercised with fakes (a fake ``ultralytics`` module, a fake CLIP encoder) so the tests stay fast and need
neither the optional packages nor a model download.
"""
from __future__ import annotations

import importlib.util
import io
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

import cv2
import numpy as np
from PIL import Image

from ai import config as ai_config
from ai.common import reset_registry
from ai.config import CIVIC_CLASSES
from ai.exceptions import ImageProcessingError, ModelUnavailableError
from ai.vision import analyze_image, describe_models
from ai.vision import config as vcfg
from ai.vision import model as vision_model
from ai.vision import postprocessing as post
from ai.vision.preprocessing import image_quality, letterbox, load_image, resize_for_model

BACKEND_DIR = Path(__file__).resolve().parents[2]
SAMPLES = BACKEND_DIR / "sample_data" / "images"
_GENERATOR = None
_ENV = mock.patch.dict(os.environ, {"MODEL_MODE": "demo"})


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
    """Path of a committed sample photo, or the same scene rendered in memory when it is missing."""
    name = f"{slug}/{slug}_{index:02d}.jpg" if state == "before" else f"{state}/{slug}_{index:02d}_{state}.jpg"
    path = SAMPLES / name
    if path.is_file():
        return path
    return _generator().render_sample(slug, index, state)[0]


def fresh_state():
    reset_registry()
    vision_model.reset_load_failures()


class VisionContractTests(unittest.TestCase):
    def setUp(self):
        fresh_state()

    def test_result_follows_the_contract(self):
        r = analyze_image(sample("pothole"))
        expected = {"category", "confidence", "probabilities", "detected_objects", "bounding_boxes", "visual_severity",
                    "quality", "model_version", "mode", "is_demo", "fallback_reason", "explanation",
                    "processing_time_ms"}
        self.assertTrue(expected.issubset(r))
        self.assertEqual(r["category"], "pothole")
        self.assertIsInstance(r["confidence"], float)
        self.assertTrue(set(CIVIC_CLASSES).issubset(r["probabilities"]))
        self.assertAlmostEqual(sum(r["probabilities"].values()), 1.0, places=2)
        self.assertEqual(r["confidence"], max(r["probabilities"].values()))
        self.assertGreater(len(r["detected_objects"]), 0)
        for obj, box in zip(r["detected_objects"], r["bounding_boxes"]):
            self.assertTrue({"label", "confidence", "box", "area_ratio"}.issubset(obj))
            self.assertEqual(obj["box"], box)
            x1, y1, x2, y2 = box
            self.assertTrue(0.0 <= x1 < x2 <= 1.0 and 0.0 <= y1 < y2 <= 1.0)
            self.assertAlmostEqual(obj["area_ratio"], (x2 - x1) * (y2 - y1), places=3)
        self.assertTrue(0.0 <= r["visual_severity"] <= 1.0)
        self.assertEqual(set(r["quality"]), {"width", "height", "blur_score", "brightness", "is_blurry", "is_dark"})
        self.assertEqual((r["quality"]["width"], r["quality"]["height"]), (640, 480))
        self.assertEqual(r["model_version"], "demo-opencv-heuristic-1.0")
        self.assertEqual(r["mode"], "demo")
        self.assertIs(r["is_demo"], True)
        self.assertIsNone(r["fallback_reason"])
        self.assertIn("Demo AI Mode", r["explanation"])
        self.assertIsInstance(r["processing_time_ms"], int)
        json.dumps(r)   # everything must be JSON-serialisable for the API / JSONField

    def test_deterministic(self):
        a = analyze_image(sample("garbage"))
        b = analyze_image(sample("garbage"))
        a.pop("processing_time_ms")
        b.pop("processing_time_ms")
        self.assertEqual(a, b)

    def test_accepts_every_input_type(self):
        path = sample("open_manhole")
        reference = analyze_image(path)
        raw = Path(path).read_bytes() if isinstance(path, Path) else cv2.imencode(".png", path)[1].tobytes()
        inputs = [str(path), raw, io.BytesIO(raw), Image.open(io.BytesIO(raw)), load_image(raw)]
        for value in inputs:
            with self.subTest(type=type(value).__name__):
                r = analyze_image(value)
                self.assertEqual(r["category"], reference["category"])
                self.assertEqual(r["probabilities"], reference["probabilities"])

    def test_demo_confidence_is_capped_and_heuristics_classify_samples(self):
        correct = total = 0
        for slug in CIVIC_CLASSES:
            for index in (1, 2, 3):
                r = analyze_image(sample(slug, index), filename_hint=None)
                self.assertLessEqual(r["confidence"], vcfg.DEMO_CONFIDENCE_CAP + 1e-9)
                self.assertFalse(r["filename_hint_used"])
                correct += r["category"] == slug
                total += 1
        self.assertGreaterEqual(correct / total, 0.8, f"demo accuracy {correct}/{total} below 80%")

    def test_other_class_without_defect_has_low_severity(self):
        r = analyze_image(sample("other", 1))
        self.assertEqual(r["category"], "other")
        self.assertEqual(r["bounding_boxes"], [])
        self.assertLessEqual(r["visual_severity"], 0.2)


class FilenameHintTests(unittest.TestCase):
    def setUp(self):
        fresh_state()

    def test_matching_hint_raises_confidence_and_is_disclosed(self):
        plain = analyze_image(sample("pothole"))
        hinted = analyze_image(sample("pothole"), filename_hint="pothole_03.jpg")
        self.assertTrue(hinted["filename_hint_used"])
        self.assertGreater(hinted["confidence"], plain["confidence"])
        self.assertLessEqual(hinted["confidence"], vcfg.DEMO_HINT_CONFIDENCE_CAP + 1e-9)
        self.assertIn("filename hint", hinted["explanation"].lower())
        self.assertNotIn("filename hint", plain["explanation"].lower())

    def test_conflicting_hint_says_what_the_image_showed(self):
        r = analyze_image(sample("garbage"), filename_hint="my_pothole_photo.jpg")
        self.assertTrue(r["filename_hint_used"])
        self.assertIn("filename hint", r["explanation"].lower())
        self.assertIn("image alone pointed to Garbage", r["explanation"])

    def test_hint_parsing(self):
        cases = {
            "pothole_03.jpg": "pothole", "Open-Manhole 2.PNG": "open_manhole", "street_light_dead.jpeg": "streetlight",
            "IMG_20261017_1234.jpg": None, "pothole_near_garbage.jpg": None, None: None,
        }
        for name, expected in cases.items():
            with self.subTest(name=name):
                self.assertEqual(post.filename_hint_class(name)[0], expected)
        admin = [{"slug": "illegal_parking", "name": "Illegal parking", "vision_labels": ["parked_car"]}]
        self.assertEqual(post.filename_hint_class("parked_car_1.jpg", admin)[0], "illegal_parking")

    def test_hint_is_ignored_by_production_models(self):
        with mock.patch.dict(os.environ, {"MODEL_MODE": "production"}), \
                mock.patch.object(vision_model, "load_yolo_model", side_effect=ModelUnavailableError("YOLO: test")), \
                mock.patch.object(vision_model, "load_clip_encoder", return_value=FakeClipEncoder("pothole")):
            r = analyze_image(sample("garbage"), filename_hint="pothole.jpg")
        self.assertFalse(r["filename_hint_used"])
        self.assertNotIn("filename hint", r["explanation"].lower())


class ImageInputTests(unittest.TestCase):
    def test_undecodable_input_raises_image_processing_error(self):
        bad_inputs = [b"definitely not an image", b"", "C:/no/such/file.jpg", 12345, np.zeros((5, 5, 3), np.uint8),
                      np.zeros((10, 10, 7), np.uint8), None]
        jpeg = cv2.imencode(".jpg", np.full((64, 64, 3), 128, np.uint8))[1].tobytes()
        bad_inputs.append(jpeg[: len(jpeg) // 3])   # truncated file
        for value in bad_inputs:
            with self.subTest(value=repr(value)[:40]):
                with self.assertRaises(ImageProcessingError):
                    analyze_image(value)

    def test_exif_orientation_is_applied(self):
        img = Image.new("RGB", (80, 40), (200, 30, 30))
        exif = Image.Exif()
        exif[0x0112] = 6   # "rotate 90 degrees clockwise to display"
        buf = io.BytesIO()
        img.save(buf, format="JPEG", exif=exif.tobytes())
        self.assertEqual(load_image(buf.getvalue()).shape[:2], (80, 40))

    def test_colour_modes_become_bgr_uint8(self):
        rgba = Image.new("RGBA", (32, 32), (0, 0, 255, 0))           # fully transparent -> white background
        out = load_image(rgba)
        self.assertEqual(out.shape, (32, 32, 3))
        self.assertEqual(out.dtype, np.uint8)
        self.assertTrue((out == 255).all())
        self.assertEqual(load_image(Image.new("RGB", (32, 32), (255, 0, 0)))[0, 0].tolist(), [0, 0, 255])  # BGR
        self.assertEqual(load_image(np.full((20, 30), 77, np.uint8)).shape, (20, 30, 3))
        self.assertEqual(int(load_image(np.full((20, 20, 3), 0.5, np.float32))[0, 0, 0]), 127)
        buf = io.BytesIO()
        Image.fromarray(np.full((24, 24), 65535, np.uint16)).save(buf, format="PNG")
        self.assertEqual(int(load_image(buf.getvalue())[0, 0, 0]), 255)    # 16-bit rescaled, not clipped

    def test_quality_flags(self):
        img = load_image(sample("pothole"))
        sharp = image_quality(img)
        self.assertFalse(sharp["is_blurry"])
        self.assertTrue(image_quality(cv2.GaussianBlur(img, (0, 0), 3))["is_blurry"])
        self.assertTrue(image_quality((img * 0.2).astype(np.uint8))["is_dark"])
        self.assertFalse(sharp["is_dark"])

    def test_resize_and_letterbox(self):
        big = np.zeros((960, 1280, 3), np.uint8)
        self.assertEqual(resize_for_model(big).shape, (480, 640, 3))
        small = np.zeros((100, 200, 3), np.uint8)
        self.assertIs(resize_for_model(small), small)
        padded, ratio, (pad_x, pad_y) = letterbox(big, 640)
        self.assertEqual(padded.shape, (640, 640, 3))
        self.assertAlmostEqual(ratio, 0.5)
        self.assertEqual((pad_x, pad_y), (0, 80))
        self.assertTrue((padded[:80] == 114).all())


class FakeClipEncoder:
    """Deterministic stand-in for ``SentenceTransformer(CLIP)``.

    Each class prompt (and each admin-category prompt) gets its own axis; an image is embedded close to the
    axis of ``image_class``. CLIP zero-shot should therefore pick ``image_class``.
    """

    def __init__(self, image_class: str, dims: int = 32):
        self.image_class = image_class
        self.dims = dims
        self.prompt_axis = {p: i for i, cls in enumerate(vcfg.CLIP_PROMPTS) for p in vcfg.CLIP_PROMPTS[cls]}
        self.calls = 0

    def _axis_for_text(self, text: str) -> int:
        if text in self.prompt_axis:
            return self.prompt_axis[text]
        return len(vcfg.CLIP_PROMPTS) + (sum(map(ord, text.split()[-1])) % 8)   # admin prompts: their own axes

    def encode(self, items, convert_to_numpy=True, normalize_embeddings=True, show_progress_bar=False):
        self.calls += 1
        rows = []
        for item in items:
            v = np.full(self.dims, 0.01)
            if isinstance(item, str):
                v[self._axis_for_text(item)] = 1.0
            else:
                v[list(vcfg.CLIP_PROMPTS).index(self.image_class)] = 1.0
            rows.append(v / np.linalg.norm(v))
        return np.stack(rows)


def fake_ultralytics(names, boxes, fail=False):
    """A fake ``ultralytics`` module whose YOLO returns fixed detections ``[(xyxy, conf, cls_id), ...]``."""

    class Boxes:
        def __init__(self):
            self.xyxy = np.array([b[0] for b in boxes], dtype=np.float32).reshape(-1, 4)
            self.conf = np.array([b[1] for b in boxes], dtype=np.float32)
            self.cls = np.array([b[2] for b in boxes], dtype=np.float32)

    class YOLO:
        def __init__(self, weights):
            self.weights = weights
            self.names = names

        def predict(self, img, **kwargs):
            if fail:
                raise RuntimeError("CUDA out of memory")
            return [types.SimpleNamespace(boxes=Boxes())]

    module = types.ModuleType("ultralytics")
    module.YOLO = YOLO
    return module


class ModeTests(unittest.TestCase):
    def setUp(self):
        fresh_state()
        self.tmp = tempfile.TemporaryDirectory()
        self.weights = Path(self.tmp.name) / "civicai_yolov8.pt"
        self.weights.write_bytes(b"fake weights")

    def tearDown(self):
        self.tmp.cleanup()
        fresh_state()

    def test_production_without_models_falls_back_with_reason(self):
        with mock.patch.dict(os.environ, {"MODEL_MODE": "production"}), \
                mock.patch.object(vision_model, "_installed", return_value=False):
            r = analyze_image(sample("pothole"))
            models = {m["name"]: m for m in describe_models()}
        self.assertEqual(r["mode"], "production")
        self.assertIs(r["is_demo"], True)
        self.assertEqual(r["model_version"], vcfg.DEMO_MODEL_VERSION)
        self.assertIn("ultralytics", r["fallback_reason"])
        self.assertIn("sentence-transformers", r["fallback_reason"])
        self.assertIn("unavailable", r["explanation"])
        self.assertEqual(r["category"], "pothole")
        self.assertEqual(models["YOLOv8 civic issue detector"]["status"], "not_installed")
        self.assertEqual(models["CLIP zero-shot classifier"]["status"], "not_installed")
        self.assertEqual(models["Demo OpenCV heuristics"]["status"], "fallback")

    def test_failed_clip_load_is_reported_and_not_retried(self):
        loader = mock.Mock(side_effect=OSError("We couldn't connect to 'https://huggingface.co'\nsecond line"))
        fake_st = types.ModuleType("sentence_transformers")
        fake_st.SentenceTransformer = loader
        only_st = mock.patch.object(vision_model, "_installed",
                                    side_effect=lambda name: name == "sentence_transformers")
        with mock.patch.dict(os.environ, {"MODEL_MODE": "production"}), \
                mock.patch.dict(sys.modules, {"sentence_transformers": fake_st}), only_st, \
                self.assertLogs("ai.vision.model", level="WARNING"):
            first = analyze_image(sample("garbage"))
            second = analyze_image(sample("garbage"))
            models = {m["name"]: m for m in describe_models()}
        self.assertEqual(loader.call_count, 1)    # negative cache: no second slow attempt
        for r in (first, second):
            self.assertEqual(r["mode"], "production")
            self.assertTrue(r["is_demo"])
            self.assertIn("CLIP: could not load", r["fallback_reason"])
            self.assertNotIn("\n", r["fallback_reason"])
        self.assertEqual(models["CLIP zero-shot classifier"]["status"], "error")

    def test_clip_zero_shot_path(self):
        encoder = FakeClipEncoder("road_crack")
        categories = [{"slug": "broken_footpath", "name": "Broken footpath", "vision_labels": ["footpath"],
                       "description": "Damaged pedestrian footpath tiles."}]
        with mock.patch.dict(os.environ, {"MODEL_MODE": "production"}), \
                mock.patch.object(vision_model, "load_yolo_model", side_effect=ModelUnavailableError("YOLO: test")), \
                mock.patch.object(vision_model, "load_clip_encoder", return_value=encoder):
            r = analyze_image(sample("road_crack"), categories=categories)
            again = analyze_image(sample("pothole"), categories=categories)
            calls_before = encoder.calls
            analyze_image(sample("garbage"), categories=categories)
            self.assertEqual(encoder.calls, calls_before + 1)   # prompt embeddings cached; only the image is encoded
        self.assertEqual(r["category"], "road_crack")
        self.assertEqual(again["category"], "road_crack")   # the fake encoder always "sees" a crack
        self.assertEqual(r["mode"], "production")
        self.assertIs(r["is_demo"], False)
        self.assertIsNone(r["fallback_reason"])
        self.assertTrue(r["model_version"].startswith("clip-zero-shot:"))
        self.assertIn("broken_footpath", r["probabilities"])
        self.assertAlmostEqual(sum(r["probabilities"].values()), 1.0, places=2)
        self.assertTrue(all(obj["approximate"] for obj in r["detected_objects"]))
        self.assertIn("approximate", r["explanation"])
        self.assertNotIn("Demo AI Mode", r["explanation"])

    def test_yolo_path_maps_detector_labels(self):
        detections = [([100, 120, 300, 260], 0.82, 0), ([105, 125, 295, 255], 0.6, 0), ([400, 300, 500, 400], 0.4, 1)]
        module = fake_ultralytics({0: "D40", 1: "trash"}, detections)
        with mock.patch.dict(os.environ, {"MODEL_MODE": "production"}), \
                mock.patch.dict(sys.modules, {"ultralytics": module}), \
                mock.patch.object(vision_model, "_installed", return_value=True), \
                mock.patch.object(ai_config, "YOLO_WEIGHTS", self.weights):
            r = analyze_image(sample("pothole"))
            models = {m["name"]: m for m in describe_models()}
        self.assertEqual(r["category"], "pothole")                 # RDD2022 code D40 -> pothole
        self.assertEqual(r["model_version"], "yolov8:civicai_yolov8.pt")
        self.assertIs(r["is_demo"], False)
        pothole_boxes = [o for o in r["detected_objects"] if o["label"] == "pothole"]
        self.assertEqual(len(pothole_boxes), 1)                    # overlapping duplicate removed by NMS
        self.assertEqual(pothole_boxes[0]["detector_label"], "D40")
        self.assertAlmostEqual(pothole_boxes[0]["box"][0], 100 / 640, places=3)
        self.assertGreater(r["probabilities"]["garbage"], r["probabilities"]["drainage"])  # trash -> garbage
        self.assertEqual(models["YOLOv8 civic issue detector"]["status"], "active")

    def test_yolo_crash_during_inference_falls_back(self):
        module = fake_ultralytics({0: "pothole"}, [], fail=True)
        with mock.patch.dict(os.environ, {"MODEL_MODE": "production"}), \
                mock.patch.dict(sys.modules, {"ultralytics": module}), \
                mock.patch.object(vision_model, "_installed", return_value=True), \
                mock.patch.object(ai_config, "YOLO_WEIGHTS", self.weights), \
                self.assertLogs("ai.vision.inference", level="ERROR"):
            r = analyze_image(sample("pothole"))
        self.assertEqual(r["mode"], "production")
        self.assertTrue(r["is_demo"])
        self.assertIn("failed during inference", r["fallback_reason"])
        self.assertEqual(r["category"], "pothole")

    def test_describe_models_in_demo_mode(self):
        analyze_image(sample("pothole"))
        models = describe_models()
        self.assertEqual(len(models), 3)
        valid = {"active", "available", "not_installed", "weights_missing", "fallback", "error"}
        for m in models:
            self.assertEqual(set(m), {"name", "task", "framework", "version", "status", "is_demo", "detail"})
            self.assertIn(m["status"], valid)
        demo = [m for m in models if m["is_demo"]]
        self.assertEqual(len(demo), 1)
        self.assertEqual(demo[0]["status"], "active")
        yolo = models[0]
        expected = "not_installed" if importlib.util.find_spec("ultralytics") is None else yolo["status"]
        self.assertEqual(yolo["status"], expected)


class CategoryMappingTests(unittest.TestCase):
    def setUp(self):
        fresh_state()

    def test_label_synonyms_and_admin_vision_labels(self):
        index = post.build_label_index([{"slug": "graffiti_vandalism", "vision_labels": ["Graffiti", "spray paint"]}])
        self.assertEqual(post.map_label("D40"), ["pothole"])
        self.assertEqual(post.map_label("Trash"), ["garbage"])
        self.assertEqual(post.map_label("unicorn"), ["other"])
        self.assertEqual(post.map_label("graffiti", index), ["graffiti_vandalism"])   # specific beats "other"
        self.assertEqual(post.map_label("spray-paint", index), ["graffiti_vandalism"])

    def test_admin_category_shares_probability_of_matching_label(self):
        admin = [{"slug": "illegal_dumping", "name": "Illegal dumping", "vision_labels": ["garbage", "dumping"]},
                 {"slug": "stray_cattle", "name": "Stray cattle", "vision_labels": ["cow"]}]
        r = analyze_image(sample("garbage"), categories=admin)
        self.assertIn("illegal_dumping", r["probabilities"])
        self.assertNotIn("stray_cattle", r["probabilities"])     # "cow" is not in the demo vocabulary
        self.assertAlmostEqual(r["probabilities"]["illegal_dumping"], r["probabilities"]["garbage"], places=4)
        self.assertAlmostEqual(sum(r["probabilities"].values()), 1.0, places=2)
        self.assertIn(r["category"], ("garbage", "illegal_dumping"))

    def test_default_categories_do_not_change_probabilities(self):
        defaults = [{"slug": "garbage", "vision_labels": ["garbage", "trash", "litter", "waste_pile"]},
                    {"slug": "pothole", "vision_labels": ["pothole", "road_hole"]}]
        plain = analyze_image(sample("garbage"))
        with_defaults = analyze_image(sample("garbage"), categories=defaults)
        self.assertEqual(plain["probabilities"], with_defaults["probabilities"])


class PostprocessingTests(unittest.TestCase):
    def test_nms_and_boxes(self):
        boxes = [[0, 0, 100, 100], [5, 5, 100, 100], [200, 200, 300, 300]]
        self.assertEqual(post.nms(boxes, [0.9, 0.8, 0.7]), [0, 2])
        self.assertEqual(post.normalize_box([-10, 20, 700, 240], 640, 480), [0.0, 0.0417, 1.0, 0.5])
        self.assertIsNone(post.normalize_box([700, 10, 800, 20], 640, 480))
        self.assertAlmostEqual(post.box_iou([0, 0, 10, 10], [5, 0, 15, 10]), 1 / 3)

    def test_probability_helpers(self):
        capped = post.cap_confidence({"pothole": 0.9, "garbage": 0.06, "other": 0.04}, 0.75)
        self.assertAlmostEqual(capped["pothole"], 0.75)
        self.assertAlmostEqual(sum(capped.values()), 1.0)
        self.assertGreater(capped["garbage"], capped["other"])
        empty = post.label_probs_to_class_probs(post.evidence_to_label_probs({}))
        self.assertEqual(post.top_class(empty)[0], "other")
        self.assertLess(post.top_class(empty)[1], 0.6)              # "nothing detected" is not a confident claim
        strong = post.label_probs_to_class_probs(post.evidence_to_label_probs(post.detection_evidence(
            [{"label": "pothole", "confidence": 0.6}, {"label": "pothole", "confidence": 0.6}])))
        self.assertAlmostEqual(strong["pothole"], 0.84 + 0.16 * 0.5 / 9, places=3)   # noisy-OR of two boxes

    def test_visual_severity(self):
        small = [{"area_ratio": 0.01, "contrast": 0.2}]
        large = [{"area_ratio": 0.25, "contrast": 0.9}, {"area_ratio": 0.05, "contrast": 0.8}]
        self.assertEqual(post.visual_severity([], 0.9), vcfg.SEVERITY_NO_DETECTION)
        self.assertLess(post.visual_severity(small, 0.7), post.visual_severity(large, 0.7))
        self.assertLess(post.visual_severity(large, 0.3), post.visual_severity(large, 0.9))
        self.assertLessEqual(post.visual_severity(large, 1.0), 1.0)


if __name__ == "__main__":
    unittest.main()
