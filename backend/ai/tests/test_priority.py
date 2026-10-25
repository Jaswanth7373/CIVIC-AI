"""Unit tests for the priority engine (BUILD_SPEC section 2.5).

Run from backend/:  venv/Scripts/python.exe -m unittest ai.tests.test_priority -v
"""
import unittest

from ai.priority import (
    COMPONENT_KEYS,
    DEFAULT_WEIGHTS,
    PriorityConfig,
    PriorityEngine,
    calculate_priority,
    normalize_weights,
    public_impact_from_text,
)
from ai.priority.priority_rules import (
    duplicates_rule,
    frequency_rule,
    location_risk_rule,
    public_impact_rule,
    reopen_adjustment,
    saturating,
    severity_rule,
)

# Inputs that reproduce the breakdown shown in the specification:
# Severity 35/40, Public Impact 25/25, Location Risk 12/15, Frequency 8/10, Duplicates 7/10 -> 87/100.
SPEC_INPUTS = {
    "severity_score": 87.5,
    "public_impact": 1.0,
    "category_safety_weight": 1.0,
    "location_risk": 0.8,
    "nearby_count": 6,
    "frequency_count": 4,
    "duplicate_count": 3,
    "is_reopened": False,
    "category": "pothole",
}
SEVERITY_ONLY = {"weights": {"severity": 100, "public_impact": 0, "location_risk": 0, "frequency": 0, "duplicates": 0}}


class SpecExampleTests(unittest.TestCase):
    def test_breakdown_reproduces_the_spec(self):
        result = PriorityEngine().calculate(SPEC_INPUTS)
        components = result["components"]
        expected = {"severity": (35.0, 40.0), "public_impact": (25.0, 25.0), "location_risk": (12.0, 15.0),
                    "frequency": (8.0, 10.0), "duplicates": (7.0, 10.0)}
        for key, (score, maximum) in expected.items():
            with self.subTest(component=key):
                self.assertEqual(components[key]["score"], score)
                self.assertEqual(components[key]["max"], maximum)
        self.assertEqual(result["final_score"], 87)
        self.assertEqual(result["priority_level"], "critical")
        self.assertEqual(result["summary"], "Priority Score: 87/100")
        self.assertEqual(result["breakdown"], ["Severity 35/40", "Public Impact 25/25", "Location Risk 12/15",
                                               "Frequency 8/10", "Duplicates 7/10"])

    def test_contract_shape(self):
        result = PriorityEngine().calculate(SPEC_INPUTS)
        for key in ("final_score", "priority_level", "components", "weights", "factors", "explanation", "summary"):
            self.assertIn(key, result)
        self.assertEqual(list(result["components"]), list(COMPONENT_KEYS))
        labels = {"severity": "Severity", "public_impact": "Public Impact", "location_risk": "Location Risk",
                  "frequency": "Frequency", "duplicates": "Duplicates"}
        for key, component in result["components"].items():
            self.assertTrue(set(component).issuperset({"score", "max", "raw", "label"}))
            self.assertEqual(component["label"], labels[key])
            self.assertGreaterEqual(component["raw"], 0.0)
            self.assertLessEqual(component["raw"], 1.0)
        self.assertIsInstance(result["final_score"], int)
        self.assertAlmostEqual(result["components"]["severity"]["raw"], 0.875)
        self.assertEqual(result["factors"]["inputs"]["frequency_count"], 4)

    def test_spec_style_explanation(self):
        result = PriorityEngine().calculate({"severity_score": 70, "public_impact": 0.7, "category_safety_weight": 0.75,
                                             "location_risk": 0.2, "frequency_count": 3})
        self.assertEqual(result["priority_level"], "high")
        self.assertEqual(result["explanation"], "High priority because the issue has high severity, significant "
                                                "public impact and multiple nearby complaints.")


class LevelBoundaryTests(unittest.TestCase):
    """With only the severity weighted, final_score == severity_score, so exact boundaries can be tested."""

    def test_default_boundaries(self):
        engine = PriorityEngine(SEVERITY_ONLY)
        expected = {0: "low", 25: "low", 26: "medium", 50: "medium", 51: "high", 75: "high", 76: "critical",
                    100: "critical"}
        for score, level in expected.items():
            with self.subTest(score=score):
                result = engine.calculate({"severity_score": score})
                self.assertEqual(result["final_score"], score)
                self.assertEqual(result["priority_level"], level)

    def test_custom_thresholds(self):
        engine = PriorityEngine({**SEVERITY_ONLY, "thresholds": {"medium": 30, "high": 60, "critical": 90}})
        for score, level in {29: "low", 30: "medium", 59: "medium", 60: "high", 89: "high", 90: "critical"}.items():
            with self.subTest(score=score):
                self.assertEqual(engine.calculate({"severity_score": score})["priority_level"], level)


class WeightConfigTests(unittest.TestCase):
    def test_defaults(self):
        config = PriorityConfig.from_dict(None)
        self.assertEqual(config.weights, DEFAULT_WEIGHTS)
        self.assertAlmostEqual(sum(config.weights.values()), 100.0)
        self.assertEqual(config.thresholds, {"medium": 26, "high": 51, "critical": 76})

    def test_normalisation_preserves_ratios(self):
        weights = normalize_weights({"severity": 4, "public_impact": 2.5, "location_risk": 1.5, "frequency": 1,
                                     "duplicates": 1})
        for key, value in DEFAULT_WEIGHTS.items():
            self.assertAlmostEqual(weights[key], value)

    def test_partial_weights_use_defaults_then_normalise(self):
        weights = normalize_weights({"severity": 60})  # 60 + 25 + 15 + 10 + 10 = 120 -> x 100/120
        self.assertAlmostEqual(weights["severity"], 50.0)
        self.assertAlmostEqual(weights["public_impact"], 25 * 100 / 120)
        self.assertAlmostEqual(sum(weights.values()), 100.0)

    def test_invalid_configs_raise(self):
        invalid = [
            {"weights": {"severity": -1}},
            {"weights": {"speed": 10}},
            {"weights": {key: 0 for key in COMPONENT_KEYS}},
            {"weights": {"severity": "lots"}},
            {"weights": {"severity": True}},
            {"thresholds": {"medium": 60, "high": 50, "critical": 76}},
            {"thresholds": {"critical": 120}},
            {"frequency_k": 0},
            "not a dict",
        ]
        for config in invalid:
            with self.subTest(config=config):
                with self.assertRaises(ValueError):
                    PriorityConfig.from_dict(config)

    def test_full_engine_config_is_accepted(self):
        engine_config = {"priority": {"weights": {"severity": 50, "public_impact": 20, "location_risk": 10,
                                                  "frequency": 10, "duplicates": 10}},
                         "fusion": {"image_weight": 0.55}}
        self.assertEqual(PriorityConfig.from_dict(engine_config).weights["severity"], 50.0)

    def test_custom_weights_change_the_score(self):
        inputs = {"severity_score": 90, "public_impact": 0.1, "category_safety_weight": 0.1, "location_risk": 0.1}
        severity_heavy = PriorityEngine({"weights": {"severity": 70, "public_impact": 10, "location_risk": 10,
                                                     "frequency": 5, "duplicates": 5}}).calculate(inputs)
        impact_heavy = PriorityEngine({"weights": {"severity": 10, "public_impact": 70, "location_risk": 10,
                                                   "frequency": 5, "duplicates": 5}}).calculate(inputs)
        self.assertGreater(severity_heavy["final_score"], impact_heavy["final_score"])
        self.assertEqual(severity_heavy["weights"]["severity"], 70.0)
        self.assertEqual(severity_heavy["components"]["severity"]["max"], 70.0)

    def test_unnormalised_weights_are_rescaled_in_the_result(self):
        result = PriorityEngine({"weights": {"severity": 2, "public_impact": 1, "location_risk": 1, "frequency": 0,
                                             "duplicates": 0}}).calculate({"severity_score": 100})
        self.assertEqual(result["weights"], {"severity": 50.0, "public_impact": 25.0, "location_risk": 25.0,
                                             "frequency": 0.0, "duplicates": 0.0})
        self.assertEqual(result["final_score"], 50)


class RuleTests(unittest.TestCase):
    def test_saturating(self):
        self.assertEqual(saturating(0, 0.4), 0.0)
        values = [saturating(n, 0.4) for n in range(10)]
        self.assertEqual(values, sorted(values))
        self.assertLess(values[-1], 1.0)

    def test_frequency_and_duplicate_reasons(self):
        self.assertEqual(frequency_rule(0).reason, "no similar complaints nearby")
        self.assertEqual(frequency_rule(1).reason, "a similar complaint nearby")
        self.assertEqual(frequency_rule(5).reason, "multiple nearby complaints")
        self.assertEqual(duplicates_rule(1).reason, "a duplicate report")
        self.assertEqual(duplicates_rule(3).reason, "several duplicate reports")
        self.assertAlmostEqual(frequency_rule(4).raw, 0.798, places=3)
        self.assertAlmostEqual(duplicates_rule(3).raw, 0.699, places=3)

    def test_public_impact_blend(self):
        self.assertAlmostEqual(public_impact_rule(0.8, 0.75).raw, 0.7 * 0.8 + 0.3 * 0.775)
        self.assertAlmostEqual(public_impact_rule(None, 0.95).raw, 0.95)
        self.assertAlmostEqual(public_impact_rule(0.4, None).raw, 0.4)
        self.assertEqual(public_impact_rule(None, None).raw, 0.0)
        self.assertEqual(public_impact_rule(0.9, 0.9).reason, "significant public impact")
        self.assertEqual(public_impact_rule(0.1, 0.1).reason, "limited public impact")

    def test_location_and_severity_rules(self):
        self.assertEqual(location_risk_rule({"score": 0.7}).raw, 0.7)
        self.assertEqual(location_risk_rule(0.7).reason, "a high-risk location")
        self.assertEqual(severity_rule(150).raw, 1.0)
        self.assertEqual(severity_rule(-5).raw, 0.0)
        self.assertEqual(severity_rule(None).raw, 0.0)
        self.assertEqual(severity_rule(60).reason, "high severity")
        self.assertEqual(severity_rule(30).reason, "moderate severity")

    def test_reopen_adjustment(self):
        self.assertEqual(reopen_adjustment(False), (0.0, ""))
        self.assertEqual(reopen_adjustment(True)[0], 5.0)
        self.assertEqual(reopen_adjustment(True, 3)[0], 10.0)  # counted at most twice

    def test_public_impact_from_text(self):
        self.assertIsNone(public_impact_from_text(None))
        text = {"safety_score": 0.8, "impacts": [{"score": 0.9}, {"score": 0.5}]}
        self.assertAlmostEqual(public_impact_from_text(text), 0.95)  # 0.9 + 0.1 x 0.5
        self.assertAlmostEqual(public_impact_from_text({"safety_score": 0.6, "impacts": []}), 0.6)


class EngineBehaviourTests(unittest.TestCase):
    def test_deterministic(self):
        self.assertEqual(PriorityEngine().calculate(SPEC_INPUTS), PriorityEngine().calculate(SPEC_INPUTS))
        self.assertEqual(calculate_priority(SPEC_INPUTS), PriorityEngine().calculate(SPEC_INPUTS))

    def test_rounding(self):
        result = PriorityEngine().calculate({"severity_score": 73, "public_impact": 0.37, "location_risk": 0.41,
                                             "frequency_count": 2, "duplicate_count": 1})
        for component in result["components"].values():
            self.assertEqual(component["score"], round(component["score"], 1))
        total = sum(c["score"] for c in result["components"].values())
        self.assertEqual(result["final_score"], int(total + 0.5))

    def test_empty_inputs(self):
        result = PriorityEngine().calculate({})
        self.assertEqual(result["final_score"], 0)
        self.assertEqual(result["priority_level"], "low")
        self.assertEqual(result["explanation"],
                         "Low priority because the issue has only low severity and limited public impact.")

    def test_reopen_bump(self):
        base = PriorityEngine().calculate({"severity_score": 50})
        reopened = PriorityEngine().calculate({"severity_score": 50, "is_reopened": True})
        self.assertEqual(reopened["final_score"], base["final_score"] + 5)
        self.assertEqual(reopened["adjustments"][0]["key"], "reopened")
        self.assertIn("reopened once by the citizen (+5 points)", reopened["explanation"])

    def test_score_is_capped_at_100(self):
        result = PriorityEngine().calculate({"severity_score": 100, "public_impact": 1, "category_safety_weight": 1,
                                             "location_risk": 1, "frequency_count": 50, "duplicate_count": 50,
                                             "is_reopened": True, "reopen_count": 2})
        self.assertEqual(result["final_score"], 100)

    def test_location_risk_dict_accepted(self):
        result = PriorityEngine().calculate({"location_risk": {"score": 0.6, "level": "high"}})
        self.assertEqual(result["components"]["location_risk"]["score"], 9.0)

    def test_medium_explanation_mentions_what_holds_it_back(self):
        result = PriorityEngine().calculate({"severity_score": 60, "public_impact": 0.1, "category_safety_weight": 0.2,
                                             "location_risk": 0.1})
        self.assertEqual(result["priority_level"], "medium")
        self.assertEqual(result["explanation"], "Medium priority because the issue has high severity, but limited "
                                                "public impact and a low-risk location.")

    def test_invalid_inputs_type(self):
        with self.assertRaises(ValueError):
            PriorityEngine().calculate(["severity", 50])

    def test_junk_values_are_coerced_safely(self):
        result = PriorityEngine().calculate({"severity_score": "high", "frequency_count": "many",
                                             "public_impact": float("nan")})
        self.assertEqual(result["final_score"], 0)


if __name__ == "__main__":
    unittest.main()
