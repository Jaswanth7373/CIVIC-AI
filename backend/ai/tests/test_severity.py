"""Unit tests for the severity engine (BUILD_SPEC section 2.4).

Run from backend/:  venv/Scripts/python.exe -m unittest ai.tests.test_severity -v
"""
import unittest

from ai.config import score_to_level
from ai.severity import DEFAULT_FACTOR_WEIGHTS, SeverityConfig, assess_severity, impact_strength

FACTOR_KEYS = ("visual", "issue_type", "public_safety", "location", "impact", "nearby", "frequency")


def vision(severity, *, blurry=False, dark=False, category="pothole"):
    return {"category": category, "confidence": 0.85, "visual_severity": severity,
            "quality": {"is_blurry": blurry, "is_dark": dark}}


TEXT_SEVERE = {
    "category": "pothole", "safety_score": 0.8, "severity_hint_score": 0.72, "urgency_score": 0.6,
    "primary_impact": "Public Safety",
    "impacts": [{"type": "public_safety", "label": "Public Safety", "score": 0.9, "evidence": ["school"]},
                {"type": "traffic", "label": "Traffic", "score": 0.7, "evidence": ["traffic"]}],
}
TEXT_MILD = {"category": "garbage", "safety_score": 0.1, "severity_hint_score": 0.2, "urgency_score": 0.1,
             "primary_impact": "Environment", "impacts": [{"type": "environment", "label": "Environment",
                                                           "score": 0.3}]}
SCHOOL_RISK = {"score": 0.8, "level": "critical", "is_high_traffic": True,
               "zones": [{"name": "Govt. High School", "zone_type": "school", "distance_m": 85.0, "risk_level": 4}],
               "components": {"zones": 0.73, "keywords": 0.3, "density": 0.0}}
NO_RISK = {"score": 0.0, "level": "low", "zones": [], "is_high_traffic": False,
           "components": {"zones": 0.0, "keywords": 0.0, "density": 0.0}}
POTHOLE_PROFILE = {"base_severity": 60, "public_safety_weight": 0.75}


def severe_case(**overrides):
    kwargs = dict(category="pothole", category_profile=POTHOLE_PROFILE, vision=vision(0.85), text=TEXT_SEVERE,
                  location_risk=SCHOOL_RISK, nearby_count=5, frequency_count=3)
    kwargs.update(overrides)
    return assess_severity(**kwargs)


class ContractTests(unittest.TestCase):
    def test_shape_and_ranges(self):
        result = severe_case()
        self.assertTrue(set(result).issuperset({"severity", "score", "reason", "factors"}))
        self.assertIsInstance(result["score"], int)
        self.assertTrue(0 <= result["score"] <= 100)
        self.assertEqual(result["severity"], score_to_level(result["score"]))
        self.assertEqual(tuple(result["factors"]), FACTOR_KEYS)
        for key, factor in result["factors"].items():
            with self.subTest(factor=key):
                self.assertTrue({"value", "weight", "contribution", "label"} <= set(factor))
                self.assertTrue(0.0 <= factor["value"] <= 1.0)
        self.assertAlmostEqual(sum(f["weight"] for f in result["factors"].values()), 1.0, places=3)
        self.assertAlmostEqual(sum(f["contribution"] for f in result["factors"].values()), result["score"], delta=1.0)

    def test_default_weights_sum_to_one(self):
        self.assertAlmostEqual(sum(DEFAULT_FACTOR_WEIGHTS.values()), 1.0)

    def test_minimal_call(self):
        result = assess_severity(category="other")
        self.assertIn(result["severity"], ("low", "medium", "high", "critical"))
        self.assertTrue(result["reason"].endswith("."))


class ScoringTests(unittest.TestCase):
    def test_severe_vs_mild(self):
        severe = severe_case()
        mild = assess_severity(category="garbage", category_profile={"base_severity": 40, "public_safety_weight": 0.45},
                               vision=vision(0.2, category="garbage"), text=TEXT_MILD, location_risk=NO_RISK)
        self.assertIn(severe["severity"], ("high", "critical"))
        self.assertIn(mild["severity"], ("low", "medium"))
        self.assertGreater(severe["score"], mild["score"] + 25)

    def test_location_risk_is_monotonic(self):
        scores = [severe_case(location_risk={"score": s, "level": "x"})["score"] for s in (0.0, 0.3, 0.6, 0.9)]
        self.assertEqual(scores, sorted(scores))
        self.assertGreater(scores[-1], scores[0])

    def test_recurrence_raises_severity(self):
        alone = severe_case(nearby_count=0, frequency_count=0)
        recurring = severe_case(nearby_count=8, frequency_count=6)
        with_duplicates = severe_case(nearby_count=0, frequency_count=0, duplicate_count=4)
        self.assertGreater(recurring["score"], alone["score"])
        self.assertGreater(with_duplicates["factors"]["frequency"]["value"], alone["factors"]["frequency"]["value"])

    def test_category_profile_overrides_defaults(self):
        dangerous = severe_case(category_profile={"base_severity": 95, "public_safety_weight": 0.8})
        harmless = severe_case(category_profile={"base_severity": 5, "public_safety_weight": 0.8})
        self.assertGreater(dangerous["score"], harmless["score"])
        self.assertEqual(dangerous["factors"]["issue_type"]["value"], 0.95)

    def test_custom_thresholds_and_weights(self):
        low_bar = severe_case(config={"thresholds": {"medium": 10, "high": 20, "critical": 30}})
        self.assertEqual(low_bar["severity"], "critical")
        visual_only = severe_case(config={"weights": {key: (1 if key == "visual" else 0) for key in FACTOR_KEYS}})
        self.assertEqual(visual_only["score"], 85)  # 100 x visual_severity 0.85

    def test_whole_engine_config_accepted(self):
        result = severe_case(config={"severity": {"thresholds": {"medium": 10, "high": 20, "critical": 30}},
                                     "priority": {}})
        self.assertEqual(result["severity"], "critical")

    def test_invalid_config_raises(self):
        with self.assertRaises(ValueError):
            SeverityConfig.from_dict({"thresholds": {"medium": 80, "high": 50, "critical": 90}})
        with self.assertRaises(ValueError):
            SeverityConfig.from_dict({"weights": {"colour": 0.5}})

    def test_impact_strength(self):
        self.assertEqual(impact_strength([]), 0.0)
        self.assertAlmostEqual(impact_strength([{"score": 0.9}, {"score": 0.7}]), 0.97)
        self.assertEqual(impact_strength([{"score": 1.0}, {"score": 1.0}]), 1.0)


class MissingEvidenceTests(unittest.TestCase):
    def test_missing_image_redistributes_visual_weight(self):
        result = severe_case(vision=None)
        visual = result["factors"]["visual"]
        self.assertEqual(visual["weight"], 0.0)
        self.assertFalse(visual["available"])
        self.assertEqual(visual["contribution"], 0.0)
        self.assertAlmostEqual(sum(f["weight"] for f in result["factors"].values()), 1.0, places=3)
        # every remaining weight grows by 1 / (1 - 0.25)
        self.assertAlmostEqual(result["factors"]["issue_type"]["weight"], 0.20 / 0.75, places=3)
        self.assertIn("reported", result["reason"])

    def test_missing_text_redistributes_impact_weight(self):
        result = severe_case(text=None)
        self.assertFalse(result["factors"]["impact"]["available"])
        self.assertEqual(result["factors"]["impact"]["weight"], 0.0)

    def test_blurry_photo_counts_less(self):
        sharp = severe_case()
        blurry = severe_case(vision=vision(0.85, blurry=True))
        self.assertLess(blurry["factors"]["visual"]["weight"], sharp["factors"]["visual"]["weight"])
        self.assertIn("blurry", blurry["factors"]["visual"]["detail"])

    def test_dark_photo_not_penalised_for_streetlights(self):
        dark_light = assess_severity(category="streetlight", vision=vision(0.7, dark=True, category="streetlight"))
        bright_light = assess_severity(category="streetlight", vision=vision(0.7, category="streetlight"))
        self.assertEqual(dark_light["factors"]["visual"]["weight"], bright_light["factors"]["visual"]["weight"])
        dark_pothole = severe_case(vision=vision(0.85, dark=True))
        self.assertLess(dark_pothole["factors"]["visual"]["weight"], 0.25)


class ReasonTests(unittest.TestCase):
    def test_reason_names_the_strongest_factors(self):
        reason = severe_case()["reason"]
        self.assertTrue(reason.startswith("Severe pothole detected near Govt. High School"))
        self.assertIn("public-safety risk", reason)
        self.assertTrue(reason.endswith("."))

    def test_high_traffic_phrase(self):
        risk = {"score": 0.6, "level": "high", "zones": [], "is_high_traffic": True}
        reason = severe_case(category="road_crack", category_profile=None, location_risk=risk)["reason"]
        self.assertIn("Severe road damage detected near a high-traffic area", reason)

    def test_mild_reason(self):
        mild = assess_severity(category="garbage", vision=vision(0.15, category="garbage"), text=TEXT_MILD,
                               location_risk=NO_RISK)
        self.assertEqual(mild["reason"], "Minor garbage dump detected, with no major risk factors.")

    def test_reason_adjective_never_contradicts_the_level(self):
        # A strong visual signal on a medium result used to read "Severe pothole detected" beside "medium".
        medium = assess_severity(category="pothole", vision=vision(0.9), text=TEXT_MILD, location_risk=NO_RISK)
        self.assertEqual(medium["severity"], "medium")
        self.assertEqual(medium["reason"], "Clearly visible pothole detected, with no major risk factors.")
        for category in ("pothole", "garbage", "streetlight", "road_crack", "open_manhole"):
            for visual in (0.1, 0.3, 0.5, 0.7, 0.95):
                for text, risk in ((TEXT_MILD, NO_RISK), (TEXT_SEVERE, SCHOOL_RISK)):
                    result = assess_severity(category=category, vision=vision(visual, category=category), text=text,
                                             location_risk=risk)
                    with self.subTest(category=category, visual=visual, level=result["severity"]):
                        if result["reason"].startswith("Severe"):
                            self.assertIn(result["severity"], ("high", "critical"))
                        if result["reason"].startswith("Minor"):
                            self.assertEqual(result["severity"], "low")

    def test_admin_category_uses_its_name(self):
        result = assess_severity(category="illegal_parking", category_profile={
            "name": "Illegal Parking", "base_severity": 35, "public_safety_weight": 0.3})
        self.assertTrue(result["reason"].startswith("Illegal parking reported"))
        self.assertEqual(result["factors"]["issue_type"]["value"], 0.35)


class HazardFloorTests(unittest.TestCase):
    def test_open_manhole_is_at_least_high(self):
        result = assess_severity(category="open_manhole", text={"safety_score": 0.1, "impacts": []},
                                 location_risk=NO_RISK)
        self.assertTrue(result["floor_applied"])
        self.assertGreaterEqual(result["score"], 51)
        self.assertIn(result["severity"], ("high", "critical"))
        self.assertIn("Rated at least High", result["reason"])

    def test_floor_not_applied_to_ordinary_categories(self):
        result = assess_severity(category="garbage", location_risk=NO_RISK)
        self.assertFalse(result["floor_applied"])


if __name__ == "__main__":
    unittest.main()
