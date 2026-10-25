"""Unit tests for multimodal late fusion (BUILD_SPEC section 2.3).

Vision / NLP outputs are built by hand in the contract shape, so the fusion logic is tested in
isolation (no image decoding, no text model).

Run from backend/:  venv/Scripts/python.exe -m unittest ai.tests.test_fusion -v
"""
import unittest

from ai.config import CIVIC_CLASSES, DEMO_DISCLAIMER
from ai.multimodal import fuse_predictions


def distribution(top, confidence, classes=CIVIC_CLASSES, second=None, second_p=0.0):
    """Probability dict: ``top`` gets ``confidence``, optional ``second`` class, rest spread evenly."""
    others = [c for c in classes if c not in (top, second)]
    remaining = 1.0 - confidence - second_p
    probs = {c: remaining / len(others) for c in others}
    probs[top] = confidence
    if second:
        probs[second] = second_p
    return probs


def image_result(top, confidence, *, blurry=False, dark=False, demo=False, **kwargs):
    return {"category": top, "confidence": confidence, "probabilities": distribution(top, confidence, **kwargs),
            "quality": {"is_blurry": blurry, "is_dark": dark}, "visual_severity": 0.6,
            "is_demo": demo, "mode": "demo" if demo else "production"}


def text_result(top, confidence, *, demo=False, **kwargs):
    return {"category": top, "confidence": confidence, "probabilities": distribution(top, confidence, **kwargs),
            "is_demo": demo}


class AgreementTests(unittest.TestCase):
    def test_modalities_agree(self):
        result = fuse_predictions(image_result("pothole", 0.88), text_result("pothole", 0.91))
        self.assertEqual(result["category"], "pothole")
        self.assertEqual(result["agreement"], "agree")
        self.assertFalse(result["needs_review"])
        self.assertGreater(result["confidence"], 0.91)  # corroboration: more confident than either alone
        self.assertAlmostEqual(result["confidence"], 0.93, places=2)
        self.assertTrue(result["explanation"].startswith(
            "Image model detected pothole (88%) and the text classifier agreed (91%); fused confidence 93%."))
        self.assertEqual(result["image_category"], "pothole")
        self.assertEqual(result["text_confidence"], 0.91)

    def test_probability_distribution_is_consistent(self):
        result = fuse_predictions(image_result("garbage", 0.7), text_result("garbage", 0.6))
        self.assertAlmostEqual(sum(result["probabilities"].values()), 1.0, places=3)
        self.assertEqual(result["probabilities"][result["category"]], result["confidence"])
        self.assertEqual(list(result["probabilities"])[0], result["category"])  # sorted most likely first
        self.assertAlmostEqual(sum(result["weights"].values()), 1.0, places=2)
        self.assertEqual(set(result["weights"]), {"image", "text", "reported", "location"})

    def test_confident_disagreement_needs_review(self):
        result = fuse_predictions(image_result("garbage", 0.8), text_result("drainage", 0.85))
        self.assertEqual(result["agreement"], "disagree")
        self.assertTrue(result["needs_review"])
        self.assertIn("image and text are both confident but disagree", result["review_reasons"])
        self.assertIn("but the text classifier suggested drainage (85%)", result["explanation"])
        self.assertIn(result["category"], ("garbage", "drainage"))

    def test_unconfident_image_is_outweighed(self):
        result = fuse_predictions(image_result("garbage", 0.35), text_result("drainage", 0.9))
        self.assertEqual(result["category"], "drainage")
        self.assertEqual(result["agreement"], "disagree")
        self.assertFalse(result["needs_review"])
        self.assertGreater(result["weights"]["text"], result["weights"]["image"])

    def test_trust_floor_keeps_both_modalities(self):
        result = fuse_predictions(image_result("pothole", 0.99), text_result("garbage", 0.05))
        self.assertGreaterEqual(result["weights"]["text"], 0.2 - 1e-9)


class SingleModalityTests(unittest.TestCase):
    def test_text_only(self):
        result = fuse_predictions(None, text_result("pothole", 0.91))
        self.assertEqual(result["agreement"], "single_modality")
        self.assertEqual(result["category"], "pothole")
        self.assertEqual(result["weights"]["image"], 0.0)
        self.assertEqual(result["weights"]["text"], 1.0)
        self.assertEqual(result["image_category"], "")
        self.assertEqual(result["image_confidence"], 0.0)
        self.assertAlmostEqual(result["confidence"], 0.91, places=3)
        self.assertIn("no photo was provided", result["explanation"])

    def test_image_only(self):
        result = fuse_predictions(image_result("open_manhole", 0.8), None)
        self.assertEqual(result["agreement"], "single_modality")
        self.assertEqual(result["category"], "open_manhole")
        self.assertEqual(result["text_category"], "")
        self.assertIn("no description was analysed", result["explanation"])

    def test_no_evidence(self):
        result = fuse_predictions(None, None)
        self.assertEqual(result["agreement"], "none")
        self.assertEqual(result["category"], "other")  # exact tie -> catch-all category
        self.assertTrue(result["needs_review"])
        self.assertIn("no image or text evidence was available", result["review_reasons"])

    def test_no_evidence_with_reported_category(self):
        result = fuse_predictions(None, None, reported_category="garbage")
        self.assertEqual(result["category"], "garbage")
        self.assertLess(result["confidence"], 0.3)
        self.assertTrue(result["needs_review"])

    def test_result_without_probabilities(self):
        result = fuse_predictions({"category": "streetlight", "confidence": 0.7}, None)
        self.assertEqual(result["category"], "streetlight")
        self.assertAlmostEqual(result["confidence"], 0.7, places=3)


class ReliabilityTests(unittest.TestCase):
    def test_blurry_and_dark_images_lose_weight(self):
        text = text_result("pothole", 0.7)
        normal = fuse_predictions(image_result("pothole", 0.7), text)
        blurry = fuse_predictions(image_result("pothole", 0.7, blurry=True), text)
        both = fuse_predictions(image_result("pothole", 0.7, blurry=True, dark=True), text)
        self.assertLess(blurry["weights"]["image"], normal["weights"]["image"])
        self.assertLess(both["weights"]["image"], blurry["weights"]["image"])
        self.assertIn("the photo is blurry and dark", both["explanation"])

    def test_darkness_is_expected_for_streetlights(self):
        text = text_result("streetlight", 0.7)
        bright = fuse_predictions(image_result("streetlight", 0.7), text)
        dark = fuse_predictions(image_result("streetlight", 0.7, dark=True), text)
        self.assertEqual(bright["weights"], dark["weights"])

    def test_low_confidence_demo_image_loses_weight(self):
        text = text_result("garbage", 0.6)
        production = fuse_predictions(image_result("garbage", 0.4), text)
        demo = fuse_predictions(image_result("garbage", 0.4, demo=True), text)
        self.assertLess(demo["weights"]["image"], production["weights"]["image"])
        self.assertIn("demo image heuristic is not confident", demo["explanation"])

    def test_demo_image_heuristic_counts_half(self):
        """The demo heuristic is 22 % accurate on real photos: its confident but wrong opinion no longer outvotes a
        confident description, while the same opinion from a production model still decides."""
        text = text_result("open_manhole", 0.7)
        production = fuse_predictions(image_result("road_crack", 0.75), text)
        demo = fuse_predictions(image_result("road_crack", 0.75, demo=True), text)
        self.assertEqual(production["category"], "road_crack")
        self.assertEqual(demo["category"], "open_manhole")
        self.assertLess(demo["weights"]["image"], production["weights"]["image"])
        self.assertIn("unreliable on real street photos", demo["explanation"])
        agree = fuse_predictions(image_result("pothole", 0.75, demo=True), text_result("pothole", 0.7))
        self.assertEqual(agree["agreement"], "agree")  # an agreeing demo photo still corroborates
        self.assertGreater(agree["confidence"], 0.7)

    def test_demo_results_carry_the_disclaimer(self):
        demo = fuse_predictions(image_result("pothole", 0.8, demo=True), text_result("pothole", 0.8, demo=True))
        self.assertIn(DEMO_DISCLAIMER, demo["explanation"])
        production = fuse_predictions(image_result("pothole", 0.8), text_result("pothole", 0.8))
        self.assertNotIn(DEMO_DISCLAIMER, production["explanation"])


class PriorTests(unittest.TestCase):
    def test_reported_category_tips_a_near_tie(self):
        text = text_result("pothole", 0.40, second="road_crack", second_p=0.38)
        self.assertEqual(fuse_predictions(None, text)["category"], "pothole")
        tipped = fuse_predictions(None, text, reported_category="road_crack")
        self.assertEqual(tipped["category"], "road_crack")
        self.assertAlmostEqual(tipped["weights"]["reported"], 0.12)
        self.assertIn("citizen-selected category (road crack)", tipped["explanation"])

    def test_reported_category_cannot_override_confident_evidence(self):
        result = fuse_predictions(image_result("pothole", 0.85), text_result("pothole", 0.9),
                                  reported_category="garbage")
        self.assertEqual(result["category"], "pothole")

    def test_location_prior_is_weak_and_scaled_by_evidence(self):
        text = text_result("pothole", 0.8)
        one = fuse_predictions(None, text, location_prior={"garbage": 1.0}, location_prior_count=1)
        many = fuse_predictions(None, text, location_prior={"garbage": 1.0}, location_prior_count=12)
        self.assertLess(one["weights"]["location"], many["weights"]["location"])
        self.assertLessEqual(many["weights"]["location"], 0.08)
        self.assertEqual(many["category"], "pothole")
        self.assertIn("mostly garbage", many["explanation"])

    def test_unknown_reported_category_is_ignored(self):
        result = fuse_predictions(None, text_result("pothole", 0.8), reported_category="not-a-category",
                                  categories=[{"slug": c} for c in CIVIC_CLASSES])
        self.assertEqual(result["weights"]["reported"], 0.0)


class CategoryTests(unittest.TestCase):
    def test_admin_defined_category_can_win(self):
        categories = [{"slug": c, "name": c.title()} for c in CIVIC_CLASSES]
        categories.append({"slug": "illegal_parking", "name": "Illegal Parking"})
        classes = CIVIC_CLASSES + ["illegal_parking"]
        text = text_result("illegal_parking", 0.8, classes=classes)
        result = fuse_predictions(image_result("other", 0.5, classes=classes), text, categories=categories)
        self.assertEqual(result["category"], "illegal_parking")
        self.assertIn("Illegal Parking", result["explanation"])

    def test_decision_restricted_to_active_categories(self):
        active = [{"slug": c} for c in CIVIC_CLASSES if c != "streetlight"]
        image = image_result("streetlight", 0.9, second="pothole", second_p=0.05)
        result = fuse_predictions(image, None, categories=active)
        self.assertNotEqual(result["category"], "streetlight")
        self.assertNotIn("streetlight", result["probabilities"])
        self.assertEqual(result["image_category"], "streetlight")  # what the model said is still reported
        self.assertIn("not an active category", result["explanation"])

    def test_low_confidence_needs_review(self):
        result = fuse_predictions(None, text_result("pothole", 0.8), config={"min_confidence": 0.95})
        self.assertTrue(result["needs_review"])
        self.assertTrue(any("below the 95% minimum" in r for r in result["review_reasons"]))

    def test_small_margin_needs_review(self):
        result = fuse_predictions(None, text_result("garbage", 0.45, second="drainage", second_p=0.42))
        self.assertTrue(result["needs_review"])
        self.assertLess(result["margin"], 0.1)

    def test_config_handling(self):
        engine_config = {"fusion": {"image_weight": 0.9, "text_weight": 0.1, "min_confidence": 0.3}}
        heavy_image = fuse_predictions(image_result("garbage", 0.7), text_result("pothole", 0.7),
                                       config=engine_config)
        self.assertEqual(heavy_image["category"], "garbage")
        with self.assertRaises(ValueError):
            fuse_predictions(None, None, config={"image_weight": 0, "text_weight": 0})
        with self.assertRaises(ValueError):
            fuse_predictions(None, None, config={"min_confidence": 7})


if __name__ == "__main__":
    unittest.main()
