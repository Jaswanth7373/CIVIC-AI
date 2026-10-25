"""Unit tests for geospatial intelligence: distances, location risk, DBSCAN hotspots (BUILD_SPEC 2.7).

Run from backend/:  venv/Scripts/python.exe -m unittest ai.tests.test_geospatial -v
"""
import math
import unittest

import numpy as np

from ai.config import score_to_level
from ai.geospatial import assess_location_risk, detect_hotspots, haversine_m
from ai.geospatial.distance import format_distance, haversine_m_array, parse_coordinates, spherical_centroid

SCHOOL = {"name": "Govt. High School", "zone_type": "school", "latitude": 17.4107, "longitude": 78.4402,
          "radius_m": 300, "risk_level": 4}


def offset(lat, lng, north_m=0.0, east_m=0.0):
    return lat + north_m / 111195.0, lng + east_m / (111195.0 * math.cos(math.radians(lat)))


class DistanceTests(unittest.TestCase):
    def test_haversine(self):
        self.assertEqual(haversine_m(17.4, 78.4, 17.4, 78.4), 0.0)
        self.assertAlmostEqual(haversine_m(0, 0, 1, 0), 111195, delta=5)  # one degree of latitude
        self.assertAlmostEqual(haversine_m(17.41, 78.44, *offset(17.41, 78.44, north_m=250)), 250, delta=1)

    def test_vectorised_matches_scalar(self):
        lats, lngs = [17.40, 17.45, 17.30], [78.40, 78.50, 78.45]
        expected = [haversine_m(17.42, 78.43, la, ln) for la, ln in zip(lats, lngs)]
        np.testing.assert_allclose(haversine_m_array(17.42, 78.43, lats, lngs), expected, rtol=1e-9)

    def test_parse_coordinates(self):
        self.assertEqual(parse_coordinates("17.41", 78.44), (17.41, 78.44))
        for bad in [(None, 78.4), ("x", 78.4), (95, 78.4), (17.4, 181), (float("nan"), 1)]:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                parse_coordinates(*bad)

    def test_spherical_centroid_handles_the_antimeridian(self):
        lat, lng = spherical_centroid([10.0, 10.0], [179.9, -179.9])
        self.assertAlmostEqual(abs(lng), 180.0, places=6)  # naive averaging would give 0
        self.assertAlmostEqual(lat, 10.0, places=3)

    def test_format_distance(self):
        self.assertEqual(format_distance(42.4), "42 m")
        self.assertEqual(format_distance(1234), "1.2 km")


class LocationRiskTests(unittest.TestCase):
    def test_contract_shape(self):
        result = assess_location_risk(17.4100, 78.4400, risk_zones=[SCHOOL])
        for key in ("score", "level", "zones", "factors", "is_high_traffic", "explanation"):
            self.assertIn(key, result)
        zone = result["zones"][0]
        for key in ("name", "zone_type", "distance_m", "risk_level"):
            self.assertIn(key, zone)
        self.assertEqual(result["level"], score_to_level(result["score"] * 100))

    def test_near_school_is_riskier_than_far_away(self):
        near = assess_location_risk(17.4100, 78.4400, risk_zones=[SCHOOL])
        edge = assess_location_risk(*offset(17.4107, 78.4402, north_m=350), risk_zones=[SCHOOL])
        far = assess_location_risk(17.4300, 78.4600, risk_zones=[SCHOOL])
        self.assertGreater(near["score"], edge["score"])
        self.assertGreater(edge["score"], far["score"])
        self.assertEqual(far["score"], 0.0)
        self.assertEqual(far["zones"], [])
        self.assertEqual(far["level"], "low")
        self.assertTrue(near["zones"][0]["inside_zone"])
        self.assertFalse(edge["zones"][0]["inside_zone"])
        self.assertTrue(near["factors"][0].startswith("Within 81 m of Govt. High School (school)"))

    def test_zone_contribution_scales_with_risk_level(self):
        low = assess_location_risk(17.4107, 78.4402, risk_zones=[{**SCHOOL, "risk_level": 1}])
        high = assess_location_risk(17.4107, 78.4402, risk_zones=[{**SCHOOL, "risk_level": 5}])
        self.assertAlmostEqual(high["score"], 1.0)  # at the centre of a level-5 zone
        self.assertAlmostEqual(low["score"], 0.2)

    def test_keywords_and_traffic(self):
        quiet = assess_location_risk(17.5, 78.5, address="Lane 4, Colony", text="Garbage not collected")
        busy = assess_location_risk(17.5, 78.5, address="Main Road, near bus stop",
                                    text="pothole at the junction")
        self.assertEqual(quiet["score"], 0.0)
        self.assertFalse(quiet["is_high_traffic"])
        self.assertTrue(busy["is_high_traffic"])
        self.assertLessEqual(busy["components"]["keywords"], 0.6)
        self.assertEqual(busy["factors"], ["Address mentions a main road and a bus stop",
                                           "Description mentions a junction"])
        self.assertIn("Low location risk", quiet["explanation"])

    def test_mapped_zone_is_not_double_counted_by_text(self):
        zone_only = assess_location_risk(17.4100, 78.4400, risk_zones=[SCHOOL])
        zone_and_text = assess_location_risk(17.4100, 78.4400, text="near the school gate", risk_zones=[SCHOOL])
        self.assertEqual(zone_only["score"], zone_and_text["score"])
        text_only = assess_location_risk(17.4100, 78.4400, text="near the school gate")
        self.assertGreater(text_only["score"], 0.0)

    def test_density_bonus_saturates(self):
        scores = [assess_location_risk(17.5, 78.5, nearby_count=n)["score"] for n in (0, 2, 6, 20, 200)]
        self.assertEqual(scores, sorted(scores))
        self.assertEqual(scores[0], 0.0)
        self.assertLessEqual(scores[-1], 0.25)
        self.assertIn("6 other complaints reported nearby",
                      assess_location_risk(17.5, 78.5, nearby_count=6)["factors"])

    def test_invalid_input(self):
        with self.assertRaises(ValueError):
            assess_location_risk(None, 78.4)
        with self.assertLogs("ai.geospatial", level="WARNING"):
            result = assess_location_risk(17.4, 78.4, risk_zones=[{"name": "broken", "latitude": None}])
        self.assertEqual(result["zones"], [])


def synthetic_points():
    """Three tight clusters (8, 6 and 5 complaints) plus 3 isolated complaints (noise)."""
    rng = np.random.default_rng(42)
    specs = [
        ((17.4100, 78.4400), 8, "pothole", "Banjara Hills", 70),
        ((17.4500, 78.5000), 6, "garbage", "Ameerpet", 40),
        ((17.3600, 78.4700), 5, "drainage", "Charminar", 55),
    ]
    points, groups, next_id = [], [], 1
    for (lat, lng), count, category, area, severity in specs:
        ids = []
        for i in range(count):
            p_lat, p_lng = offset(lat, lng, north_m=rng.normal(0, 60), east_m=rng.normal(0, 60))
            points.append({"id": next_id, "latitude": p_lat, "longitude": p_lng, "category": category,
                           "category_name": category.title(), "severity": "high" if severity >= 51 else "medium",
                           "severity_score": severity + (i % 3), "priority_score": severity - 5,
                           "status": "resolved" if i == 0 else "submitted", "area": area})
            ids.append(next_id)
            next_id += 1
        groups.append(ids)
    noise = []
    for lat, lng in [(17.50, 78.30), (17.25, 78.60), (17.60, 78.55)]:
        points.append({"id": next_id, "latitude": lat, "longitude": lng, "category": "other", "severity_score": 20,
                       "status": "submitted"})
        noise.append(next_id)
        next_id += 1
    return points, groups, noise


class HotspotTests(unittest.TestCase):
    def test_recovers_three_clusters_and_noise(self):
        points, groups, noise = synthetic_points()
        result = detect_hotspots(points, eps_m=400, min_samples=3)
        self.assertEqual(len(result["clusters"]), 3)
        self.assertEqual([c["count"] for c in result["clusters"]], [8, 6, 5])  # largest first
        for cluster, ids in zip(result["clusters"], groups):
            with self.subTest(cluster=cluster["cluster_id"]):
                self.assertEqual(sorted(cluster["complaint_ids"]), ids)
                for cid in ids:
                    self.assertEqual(result["labels"][cid], cluster["cluster_id"])
        self.assertEqual(sorted(result["noise_ids"]), noise)
        for cid in noise:
            self.assertEqual(result["labels"][cid], -1)
        self.assertEqual(result["total_points"], len(points))
        self.assertEqual(result["params"], {"eps_m": 400, "min_samples": 3})
        self.assertEqual(result["algorithm"], "DBSCAN (haversine)")

    def test_cluster_statistics(self):
        points, groups, _ = synthetic_points()
        cluster = detect_hotspots(points, eps_m=400, min_samples=3)["clusters"][0]
        members = [p for p in points if p["id"] in groups[0]]
        self.assertEqual(cluster["dominant_category"], "pothole")
        self.assertEqual(cluster["dominant_category_name"], "Pothole")
        self.assertEqual(cluster["category_breakdown"], {"pothole": 8})
        self.assertEqual(cluster["area_name"], "Banjara Hills")
        self.assertEqual(cluster["open_count"], 7)  # one resolved complaint
        self.assertAlmostEqual(cluster["avg_severity_score"],
                               round(sum(p["severity_score"] for p in members) / 8, 1))
        self.assertEqual(cluster["severity_level"], "high")
        self.assertEqual(cluster["max_severity"], "high")
        self.assertAlmostEqual(cluster["avg_priority_score"], 65.0)
        distances = [haversine_m(cluster["latitude"], cluster["longitude"], p["latitude"], p["longitude"])
                     for p in members]
        self.assertAlmostEqual(cluster["radius_m"], max(50.0, max(distances)), delta=0.2)
        area_km2 = math.pi * (cluster["radius_m"] / 1000) ** 2
        self.assertAlmostEqual(cluster["density_per_km2"], 8 / area_km2, delta=0.1)
        (min_lat, min_lng), (max_lat, max_lng) = cluster["bounds"]
        self.assertTrue(min_lat <= cluster["latitude"] <= max_lat and min_lng <= cluster["longitude"] <= max_lng)

    def test_fewer_points_than_min_samples(self):
        result = detect_hotspots([{"id": 1, "latitude": 17.41, "longitude": 78.44},
                                  {"id": 2, "latitude": 17.4101, "longitude": 78.4401}], min_samples=3)
        self.assertEqual(result["clusters"], [])
        self.assertEqual(sorted(result["noise_ids"]), [1, 2])

    def test_all_noise(self):
        points = [{"id": i, "latitude": 17.0 + i * 0.1, "longitude": 78.0} for i in range(6)]
        result = detect_hotspots(points, eps_m=400, min_samples=3)
        self.assertEqual(result["clusters"], [])
        self.assertEqual(len(result["noise_ids"]), 6)

    def test_duplicate_coordinates(self):
        points = [{"id": i, "latitude": 17.41, "longitude": 78.44, "category": "pothole"} for i in range(5)]
        cluster = detect_hotspots(points, eps_m=400, min_samples=3)["clusters"][0]
        self.assertEqual(cluster["count"], 5)
        self.assertEqual(cluster["radius_m"], 50.0)  # minimum radius
        self.assertAlmostEqual(cluster["density_per_km2"], round(5 / (math.pi * 0.05 ** 2), 1))
        self.assertAlmostEqual(cluster["latitude"], 17.41, places=6)
        self.assertEqual(cluster["avg_severity_score"], 0.0)  # no scores supplied

    def test_empty_invalid_and_missing_ids(self):
        self.assertEqual(detect_hotspots([])["clusters"], [])
        result = detect_hotspots([{"latitude": 17.41, "longitude": 78.44}] * 3
                                 + [{"id": 9, "latitude": None, "longitude": 78.44}], min_samples=3)
        self.assertEqual(result["skipped_points"], 1)
        self.assertEqual(sorted(result["clusters"][0]["complaint_ids"]), [0, 1, 2])  # list indices

    def test_invalid_parameters(self):
        for kwargs in ({"eps_m": 0}, {"eps_m": -5}, {"min_samples": 0}, {"eps_m": "wide"}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                detect_hotspots([], **kwargs)

    def test_eps_controls_cluster_size(self):
        points, _, _ = synthetic_points()
        tight = detect_hotspots(points, eps_m=20, min_samples=3)
        loose = detect_hotspots(points, eps_m=20000, min_samples=3)
        self.assertLess(sum(c["count"] for c in tight["clusters"]), 19)
        self.assertEqual(len(loose["clusters"]), 1)


if __name__ == "__main__":
    unittest.main()
