"""Unit tests for duplicate detection (BUILD_SPEC section 2.6).

The text embedder (owned by ai.nlp) is replaced by a small deterministic bag-of-words embedder with
the same contract (``encode`` -> L2-normalised rows), so these tests exercise the duplicate logic
independently; one extra test uses the real embedder when it is available.

Run from backend/:  venv/Scripts/python.exe -m unittest ai.tests.test_duplicate -v
"""
import io
import math
import os
import re
import tempfile
import unittest
import zlib
from unittest import mock

import cv2
import numpy as np
from PIL import Image

from ai.common import get_statuses
from ai.duplicate import batch_text_similarity, compute_hashes, find_duplicates, hash_similarity
from ai.duplicate import image_similarity as image_module
from ai.duplicate.image_similarity import image_similarity
from ai.duplicate.location_similarity import location_similarity
from ai.duplicate.text_similarity import text_similarity

BASE = (17.4100, 78.4400)
SPEC_TEXT_A = "Large pothole near school."
SPEC_TEXT_B = "Big road pothole outside school."


class FakeEmbedder:
    """Deterministic hashing bag-of-words embedder with a tiny synonym map (stands in for ai.nlp.embedding)."""

    name = "test-bag-of-words"
    is_demo = True
    SYNONYMS = {"big": "large", "huge": "large", "outside": "near", "beside": "near", "potholes": "pothole"}
    STOPWORDS = {"a", "an", "the", "is", "on", "in", "of", "and", "there"}
    DIM = 512

    def _tokens(self, text):
        words = re.findall(r"[a-z]+", text.lower())
        return [self.SYNONYMS.get(w, w) for w in words if w not in self.STOPWORDS]

    def encode(self, texts):
        matrix = np.zeros((len(texts), self.DIM))
        for row, text in enumerate(texts):
            for token in self._tokens(text):
                matrix[row, zlib.crc32(token.encode()) % self.DIM] += 1.0
        norms = np.linalg.norm(matrix, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        return matrix / norms

    def similarity(self, a, b):
        va, vb = self.encode([a, b])
        return float(max(0.0, va @ vb))


def offset(lat, lng, north_m=0.0, east_m=0.0):
    """Move a coordinate by metres north / east (small-distance approximation)."""
    return (lat + north_m / 111195.0, lng + east_m / (111195.0 * math.cos(math.radians(lat))))


def road_scene(seed=0, brightness=0, size=(120, 160)):
    """Grey textured road with a dark elliptical pothole (BGR uint8)."""
    rng = np.random.default_rng(seed)
    h, w = size
    base = np.full((h, w, 3), 110, np.int16) + rng.integers(-12, 12, size=(h, w, 1)) + brightness
    img = np.clip(base, 0, 255).astype(np.uint8)
    cv2.ellipse(img, (w // 2, int(h * 0.58)), (w // 4, h // 6), 0, 0, 360, (35, 35, 40), -1)
    return img


def park_scene(seed=1, size=(120, 160)):
    """Green vegetation with a brown trunk - a different scene."""
    rng = np.random.default_rng(seed)
    h, w = size
    img = np.zeros((h, w, 3), np.uint8)
    img[:] = (40, 150, 60)
    img = np.clip(img.astype(np.int16) + rng.integers(-25, 25, size=(h, w, 3)), 0, 255).astype(np.uint8)
    cv2.rectangle(img, (w // 3, h // 4), (w // 3 + 18, h - 1), (30, 60, 100), -1)
    return img


def record(cid, text, lat, lng, category="pothole", **extra):
    return {"id": cid, "text": text, "latitude": lat, "longitude": lng, "category": category, **extra}


class EmbedderPatch(unittest.TestCase):
    """Base class: every test runs with the fake embedder and in demo mode."""

    def setUp(self):
        patches = [mock.patch("ai.nlp.embedding.get_text_embedder", return_value=FakeEmbedder()),
                   mock.patch.dict(os.environ, {"MODEL_MODE": "demo"})]
        for patcher in patches:
            patcher.start()
            self.addCleanup(patcher.stop)


class HashTests(unittest.TestCase):
    def test_hash_format(self):
        hashes = compute_hashes(road_scene())
        for kind in ("phash", "dhash", "ahash"):
            self.assertRegex(hashes[kind], r"^[0-9a-f]{16}$")
        self.assertEqual((hashes["width"], hashes["height"]), (160, 120))

    def test_identical_images(self):
        a, b = compute_hashes(road_scene()), compute_hashes(road_scene())
        for kind in ("phash", "dhash", "ahash"):
            self.assertEqual(hash_similarity(a[kind], b[kind]), 1.0)

    def test_similar_vs_different_images(self):
        original = compute_hashes(road_scene(seed=0))
        brighter = compute_hashes(road_scene(seed=0, brightness=15))
        different = compute_hashes(park_scene())
        near = hash_similarity(original["phash"], brighter["phash"])
        far = hash_similarity(original["phash"], different["phash"])
        self.assertGreater(near, 0.85)
        self.assertLess(far, near)
        self.assertLess(far, 1.0)

    def test_hash_similarity_arithmetic_and_none_safety(self):
        self.assertEqual(hash_similarity("ffffffffffffffff", "0000000000000000"), 0.0)
        self.assertEqual(hash_similarity("0000000000000001", "0000000000000000"), round(1 - 1 / 64, 4))
        self.assertIsNone(hash_similarity(None, "0000000000000000"))
        self.assertIsNone(hash_similarity("", "0000000000000000"))
        self.assertIsNone(hash_similarity("not-hex", "0000000000000000"))
        self.assertIsNone(hash_similarity("00ff", "0000000000000000"))  # different sizes

    def test_all_input_types_give_the_same_hashes(self):
        bgr = road_scene()
        pil = Image.fromarray(bgr[:, :, ::-1].copy())
        buffer = io.BytesIO()
        pil.save(buffer, format="PNG")
        expected = compute_hashes(bgr)
        self.assertEqual(compute_hashes(pil), expected)
        self.assertEqual(compute_hashes(buffer.getvalue()), expected)
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "scene.png")
            pil.save(path)
            self.assertEqual(compute_hashes(path), expected)

    def test_pillow_fallback_when_vision_loader_fails(self):
        with mock.patch("ai.vision.preprocessing.load_image", side_effect=NotImplementedError("stub")):
            self.assertEqual(compute_hashes(road_scene()), compute_hashes(road_scene()))
            self.assertEqual(compute_hashes(road_scene())["width"], 160)

    def test_undecodable_input_raises(self):
        from ai.exceptions import ImageProcessingError

        with self.assertRaises(ImageProcessingError):
            compute_hashes(b"definitely not an image")


class ImageSimilarityTests(EmbedderPatch):
    def test_identical_and_different_images(self):
        self.assertAlmostEqual(image_similarity(road_scene(), road_scene()), 1.0, places=3)
        same_scene = image_similarity(road_scene(), road_scene(brightness=10))
        different = image_similarity(road_scene(), park_scene())
        self.assertGreater(same_scene, different)
        self.assertLess(different, 0.6)

    def test_production_mode_adds_clip(self):
        def fake_clip(bgr):
            vector = np.asarray(bgr.reshape(-1, 3).mean(axis=0), dtype=np.float32)
            return vector / np.linalg.norm(vector)

        with mock.patch.dict(os.environ, {"MODEL_MODE": "production"}), \
                mock.patch.object(image_module, "clip_embedding", side_effect=fake_clip):
            comparison = image_module.compare_features(image_module.extract_features(road_scene()),
                                                       image_module.extract_features(road_scene()))
        self.assertEqual(comparison["method"], "clip+hash+histogram")
        self.assertAlmostEqual(comparison["similarity"], 1.0, places=3)

    def test_clip_unavailable_falls_back_and_reports_status(self):
        from ai.exceptions import ModelUnavailableError

        unavailable = ModelUnavailableError("CLIP: the 'sentence-transformers' package is not installed")
        # a fresh state object per call (no cached failure from other tests), CLIP loading fails
        with mock.patch.object(image_module, "get_or_load", side_effect=lambda key, loader: loader()), \
                mock.patch.object(image_module, "_shared_clip_encoder", side_effect=unavailable), \
                self.assertLogs("ai.duplicate", level="WARNING"):
            self.assertIsNone(image_module.clip_embedding(road_scene()))
        status = {s["name"]: s for s in get_statuses()}["duplicate.image_embeddings"]
        self.assertEqual(status["status"], "fallback")
        self.assertIn("sentence-transformers", status["detail"])

    def test_clip_encoder_is_shared_with_the_vision_module(self):
        encoder = object()
        with mock.patch.object(image_module, "get_or_load", side_effect=lambda key, loader: loader()), \
                mock.patch("ai.vision.model.load_clip_encoder", return_value=encoder) as shared:
            self.assertIs(image_module._clip_model(), encoder)
        shared.assert_called_once_with()
        self.assertEqual(image_module.CLIP_REGISTRY_KEY.split(":")[0], "clip.encoder")


class LocationSimilarityTests(unittest.TestCase):
    def test_kernel_shape(self):
        self.assertEqual(location_similarity(0, 300), 1.0)
        self.assertAlmostEqual(location_similarity(42, 300), 0.96, places=2)
        values = [location_similarity(d, 300) for d in range(0, 460, 20)]
        self.assertEqual(values, sorted(values, reverse=True))
        self.assertLess(location_similarity(300, 300), 0.15)
        self.assertEqual(location_similarity(450, 300), 0.0)
        self.assertEqual(location_similarity(5000, 300), 0.0)
        self.assertEqual(location_similarity(None, 300), 0.0)
        with self.assertRaises(ValueError):
            location_similarity(10, 0)


class TextSimilarityTests(EmbedderPatch):
    def test_batch_and_single(self):
        scores = batch_text_similarity(SPEC_TEXT_A, [SPEC_TEXT_B, "", "Streetlight not working at night"])
        self.assertAlmostEqual(scores[0], 4 / (2 * math.sqrt(5)), places=3)
        self.assertEqual(scores[1], 0.0)
        self.assertLess(scores[2], 0.2)
        self.assertEqual(text_similarity(SPEC_TEXT_A, SPEC_TEXT_B), scores[0])
        self.assertEqual(text_similarity("", SPEC_TEXT_B), 0.0)


class FindDuplicatesTests(EmbedderPatch):
    def test_spec_example_pair_is_a_duplicate(self):
        target = record(2, SPEC_TEXT_A, *BASE)
        candidate = record(1, SPEC_TEXT_B, *offset(*BASE, north_m=40))
        results = find_duplicates(target, [candidate])
        self.assertEqual(len(results), 1)
        match = results[0]
        self.assertEqual(match["complaint_id"], 1)
        self.assertTrue(match["is_duplicate"])
        self.assertGreaterEqual(match["overall_similarity"], 0.72)
        self.assertAlmostEqual(match["distance_m"], 40.0, delta=1.0)
        self.assertIsNone(match["image_similarity"])
        self.assertTrue(match["category_match"])
        self.assertEqual(match["explanation"], "Text 89% similar, no image comparison, 40 m apart, same category")
        for key in ("complaint_id", "text_similarity", "image_similarity", "location_similarity", "distance_m",
                    "category_match", "overall_similarity", "is_duplicate", "explanation"):
            self.assertIn(key, match)

    def test_spec_example_with_photos(self):
        target = record(2, SPEC_TEXT_A, *BASE, image=road_scene(seed=0))
        candidate = record(1, SPEC_TEXT_B, *offset(*BASE, north_m=40), image=road_scene(seed=0, brightness=12))
        match = find_duplicates(target, [candidate])[0]
        self.assertIsNotNone(match["image_similarity"])
        self.assertGreater(match["image_similarity"], 0.8)
        self.assertEqual(match["image_method"], "hash+histogram")
        self.assertTrue(0.85 <= match["overall_similarity"] <= 0.95)
        self.assertRegex(match["explanation"], r"^Text \d+% similar, images \d+% similar, \d+ m apart")
        self.assertEqual(match["weights"], {"text": 0.4, "image": 0.3, "location": 0.3})

    def test_far_apart_is_not_a_duplicate(self):
        target = record(2, SPEC_TEXT_A, *BASE)
        far = record(1, SPEC_TEXT_B, *offset(*BASE, north_m=2000))
        results = find_duplicates(target, [far])
        self.assertTrue(all(not r["is_duplicate"] for r in results))
        if results:
            self.assertEqual(results[0]["location_similarity"], 0.0)

    def test_missing_image_renormalises_weights(self):
        target = record(2, SPEC_TEXT_A, *BASE, image=road_scene())
        candidate = record(1, SPEC_TEXT_B, *offset(*BASE, north_m=60))
        match = find_duplicates(target, [candidate])[0]
        self.assertIsNone(match["image_similarity"])
        self.assertEqual(match["weights"], {"text": round(0.4 / 0.7, 4), "image": 0.0, "location": round(0.3 / 0.7, 4)})
        expected = (0.4 * match["text_similarity"] + 0.3 * match["location_similarity"]) / 0.7
        self.assertAlmostEqual(match["overall_similarity"], expected, places=3)

    def test_category_mismatch_penalty(self):
        target = record(2, "Garbage dumped near the school", *BASE, category="garbage")
        candidate = record(1, "Pothole near the school", *offset(*BASE, north_m=20), category="pothole")
        match = find_duplicates(target, [candidate])[0]
        self.assertTrue(match["category_penalty_applied"])
        self.assertFalse(match["category_match"])
        expected = 0.85 * (0.4 * match["text_similarity"] + 0.3 * match["location_similarity"]) / 0.7
        self.assertAlmostEqual(match["overall_similarity"], expected, places=3)
        self.assertIn("different category", match["explanation"])

    def test_no_penalty_for_near_identical_text(self):
        target = record(2, "Huge pothole near the school gate", *BASE, category="road_crack")
        candidate = record(1, "Big pothole near the school gate", *offset(*BASE, north_m=20), category="pothole")
        match = find_duplicates(target, [candidate])[0]
        self.assertGreater(match["text_similarity"], 0.8)
        self.assertFalse(match["category_penalty_applied"])

    def test_sorting_floor_and_skipping(self):
        target = record(10, SPEC_TEXT_A, *BASE)
        candidates = [
            record(1, "Pothole near school", *offset(*BASE, north_m=150)),
            record(2, SPEC_TEXT_B, *offset(*BASE, north_m=10)),
            record(3, "Streetlight broken in the colony", *offset(*BASE, north_m=3000), category="streetlight"),
            record(10, SPEC_TEXT_A, *BASE),  # the target itself
            record(4, SPEC_TEXT_B, None, None),  # invalid coordinates
        ]
        with self.assertLogs("ai.duplicate", level="WARNING") as logs:
            results = find_duplicates(target, candidates)
        self.assertIn("invalid coordinates", logs.output[0])
        ids = [r["complaint_id"] for r in results]
        self.assertEqual(ids, [2, 1])
        scores = [r["overall_similarity"] for r in results]
        self.assertEqual(scores, sorted(scores, reverse=True))
        self.assertTrue(all(s >= 0.45 for s in scores))

    def test_stored_hashes_are_compared(self):
        hashes = compute_hashes(road_scene())
        target = record(2, SPEC_TEXT_A, *BASE, phash=hashes["phash"], dhash=hashes["dhash"])
        candidate = record(1, SPEC_TEXT_B, *offset(*BASE, north_m=30), phash=hashes["phash"], dhash=hashes["dhash"])
        match = find_duplicates(target, [candidate])[0]
        self.assertEqual(match["image_similarity"], 1.0)
        self.assertEqual(match["image_method"], "hash")

    def test_image_paths_and_missing_files(self):
        with tempfile.TemporaryDirectory() as folder:
            target_path = os.path.join(folder, "target.png")
            cv2.imwrite(target_path, road_scene())
            stored = compute_hashes(park_scene())
            target = record(2, SPEC_TEXT_A, *BASE, image_path=target_path)
            on_disk = record(1, SPEC_TEXT_B, *offset(*BASE, north_m=30), image_path=target_path)
            missing = record(3, SPEC_TEXT_B, *offset(*BASE, north_m=35),
                             image_path=os.path.join(folder, "gone.jpg"), phash=stored["phash"], dhash=stored["dhash"])
            results = {r["complaint_id"]: r for r in find_duplicates(target, [on_disk, missing])}
        self.assertEqual(results[1]["image_method"], "hash+histogram")
        self.assertAlmostEqual(results[1]["image_similarity"], 1.0, places=3)
        self.assertEqual(results[3]["image_method"], "hash")
        self.assertLess(results[3]["image_similarity"], results[1]["image_similarity"])

    def test_config_and_validation(self):
        target = record(2, SPEC_TEXT_A, *BASE)
        candidate = record(1, SPEC_TEXT_B, *offset(*BASE, north_m=40))
        strict = find_duplicates(target, [candidate], config={"duplicate": {"threshold": 0.99, "radius_m": 300}})
        self.assertFalse(strict[0]["is_duplicate"])
        with self.assertRaises(ValueError):
            find_duplicates(target, [candidate], config={"weights": {"colour": 0.2}})
        with self.assertRaises(ValueError):
            find_duplicates(record(2, SPEC_TEXT_A, None, None), [candidate])
        self.assertEqual(find_duplicates(target, []), [])


class RealEmbedderTests(unittest.TestCase):
    """Uses the real ai.nlp embedder; skipped while that module is still a stub."""

    def test_spec_example_with_real_embedder(self):
        from ai.nlp.embedding import get_text_embedder

        try:
            get_text_embedder().encode(["probe"])
        except NotImplementedError as exc:
            self.skipTest(f"ai.nlp.embedding not implemented yet: {exc}")
        target = record(2, SPEC_TEXT_A, *BASE)
        candidate = record(1, SPEC_TEXT_B, *offset(*BASE, north_m=40))
        match = find_duplicates(target, [candidate])[0]
        self.assertTrue(match["is_duplicate"], match)


if __name__ == "__main__":
    unittest.main()
