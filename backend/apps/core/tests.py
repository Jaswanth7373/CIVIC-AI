"""Tests for the system endpoints: /system/config/, /ai/config/, /risk-zones/, /contact/ and the geo proxy."""
from decimal import Decimal
from unittest import mock

import requests
from django.conf import settings
from django.core.cache import cache
from django.test import override_settings
from rest_framework.test import APITestCase

from apps.accounts.models import User
from apps.audit.models import AuditLog
from apps.complaints.models import Complaint, Location

from . import geocoding
from .models import AIConfiguration, ContactMessage, RiskZone
from .throttles import CivicScopedRateThrottle

PASSWORD = "Civic#Route2026"


def make_user(email, role=User.Role.CITIZEN):
    return User.objects.create_user(email=email, password=PASSWORD, role=role, first_name=email.split("@")[0])


def make_complaint(citizen, status):
    location = Location.objects.create(latitude=Decimal("17.385"), longitude=Decimal("78.4867"))
    return Complaint.objects.create(citizen=citizen, status=status, location=location,
                                    description="Streetlight not working on the main road at night.")


class RoleUsersMixin:
    def setUp(self):
        cache.clear()
        self.admin = make_user("admin@example.com", User.Role.ADMIN)
        self.officer = make_user("officer@example.com", User.Role.OFFICER)
        self.citizen = make_user("citizen@example.com")


class SystemConfigTests(APITestCase):
    def test_public_config_shape(self):
        response = self.client.get("/api/system/config/")
        self.assertEqual(response.status_code, 200)
        data = response.data
        for key in ("app_name", "version", "model_mode", "is_demo", "demo_badge", "map", "upload",
                    "reopen_window_days", "statuses", "levels"):
            self.assertIn(key, data)
        self.assertEqual(data["app_name"], "CivicAI")
        self.assertEqual(data["map"]["zoom"], 12)
        self.assertEqual(data["map"]["center"], [settings.CIVICAI["DEFAULT_LAT"], settings.CIVICAI["DEFAULT_LNG"]])
        self.assertEqual(data["upload"]["max_image_mb"], settings.MAX_IMAGE_UPLOAD_MB)
        self.assertIn({"value": "in_progress", "label": "In Progress"}, data["statuses"])
        self.assertEqual([level["value"] for level in data["levels"]], ["low", "medium", "high", "critical"])

    def test_demo_badge_follows_the_model_mode(self):
        with mock.patch.dict("os.environ", {"MODEL_MODE": "demo"}):
            demo = self.client.get("/api/system/config/").data
        self.assertEqual((demo["model_mode"], demo["is_demo"], demo["demo_badge"]), ("demo", True, "Demo AI Mode"))
        with mock.patch.dict("os.environ", {"MODEL_MODE": "production"}):
            production = self.client.get("/api/system/config/").data
        self.assertEqual((production["model_mode"], production["is_demo"], production["demo_badge"]),
                         ("production", False, None))


class AIConfigTests(RoleUsersMixin, APITestCase):
    url = "/api/ai/config/"

    def test_read_permissions(self):
        self.assertEqual(self.client.get(self.url).status_code, 401)
        self.client.force_authenticate(self.citizen)
        self.assertEqual(self.client.get(self.url).status_code, 403)
        self.client.force_authenticate(self.officer)
        response = self.client.get(self.url)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["weight_severity"], 40)
        self.assertIsNone(response.data["updated_by"])
        self.assertIn("updated_at", response.data)
        self.assertEqual(self.client.patch(self.url, {"weight_severity": 40}, format="json").status_code, 403)

    def test_invalid_updates_are_rejected_with_field_errors(self):
        self.client.force_authenticate(self.admin)
        bad_weights = self.client.patch(self.url, {"weight_severity": 50}, format="json")  # sum = 110
        self.assertEqual(bad_weights.status_code, 400)
        self.assertIn("weight_severity", bad_weights.data["errors"])
        self.assertIn("sum to 100", bad_weights.data["detail"])

        bad_thresholds = self.client.patch(self.url, {"threshold_high": 20}, format="json")
        self.assertEqual(bad_thresholds.status_code, 400)
        self.assertIn("threshold_medium", bad_thresholds.data["errors"])

        out_of_range = self.client.put(self.url, {"duplicate_threshold": 1.5, "hotspot_min_samples": 0}, format="json")
        self.assertEqual(out_of_range.status_code, 400)
        self.assertEqual(set(out_of_range.data["errors"]), {"duplicate_threshold", "hotspot_min_samples"})

        verification = self.client.patch(self.url, {"verification_partial_threshold": 80}, format="json")
        self.assertIn("verification_partial_threshold", verification.data["errors"])
        config = AIConfiguration.load()
        self.assertEqual((config.weight_severity, config.threshold_high), (40, 51))  # untouched
        self.assertFalse(AuditLog.objects.filter(action="config_change").exists())

    def test_valid_update_is_saved_and_audited(self):
        self.client.force_authenticate(self.admin)
        response = self.client.patch(self.url, {"weight_severity": 35, "weight_public_impact": 30,
                                                "auto_assign_officer": False}, format="json")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["weight_severity"], 35)
        self.assertEqual(response.data["updated_by"]["id"], self.admin.pk)
        self.assertNotIn("recalculated", response.data)
        config = AIConfiguration.load()
        self.assertEqual(config.to_engine_config()["priority"]["weights"]["severity"], 35.0)
        log = AuditLog.objects.get(action="config_change")
        self.assertEqual(log.actor, self.admin)
        self.assertEqual(log.changes["weight_severity"], [40.0, 35.0])
        self.assertEqual(log.changes["auto_assign_officer"], [True, False])

    def test_put_with_recalculate_recalculates_open_complaints(self):
        open_one = make_complaint(self.citizen, Complaint.Status.ASSIGNED)
        open_two = make_complaint(self.citizen, Complaint.Status.SUBMITTED)
        make_complaint(self.citizen, Complaint.Status.CLOSED)
        self.client.force_authenticate(self.admin)
        with mock.patch("apps.complaints.services.priority.recalculate_priority") as recalculate:
            response = self.client.put(f"{self.url}?recalculate=true", {"weight_frequency": 15,
                                                                        "weight_duplicates": 5}, format="json")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["recalculated"], 2)
        self.assertEqual(response.data["recalculation_failed"], 0)
        recalculated_ids = sorted(call.args[0].pk for call in recalculate.call_args_list)
        self.assertEqual(recalculated_ids, sorted([open_one.pk, open_two.pk]))
        self.assertEqual(recalculate.call_args.kwargs["trigger"], "config_change")
        self.assertEqual(recalculate.call_args.kwargs["actor"], self.admin)

    def test_recalculate_reports_unavailable_service_and_failures(self):
        make_complaint(self.citizen, Complaint.Status.ASSIGNED)
        make_complaint(self.citizen, Complaint.Status.ACCEPTED)
        self.client.force_authenticate(self.admin)
        with mock.patch("apps.complaints.services.priority.recalculate_priority", side_effect=NotImplementedError):
            response = self.client.patch(f"{self.url}?recalculate=1", {}, format="json")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["recalculated"], 0)
        self.assertIn("not implemented", response.data["recalculation_detail"])

        with mock.patch("apps.complaints.services.priority.recalculate_priority",
                        side_effect=[None, RuntimeError("boom")]), self.assertLogs("apps.core", "ERROR") as logs:
            response = self.client.patch(f"{self.url}?recalculate=true", {}, format="json")
        self.assertEqual((response.data["recalculated"], response.data["recalculation_failed"]), (1, 1))
        self.assertIn("Priority recalculation failed", logs.output[0])


class RiskZoneTests(RoleUsersMixin, APITestCase):
    url = "/api/risk-zones/"
    payload = {"name": "Begumpet Metro Station", "zone_type": "transit", "latitude": 17.437512345,
               "longitude": 78.467654321, "radius_m": 300, "risk_level": 4}

    def test_permissions_and_non_paginated_list(self):
        RiskZone.objects.create(name="Zone A", latitude=Decimal("17.4"), longitude=Decimal("78.4"))
        self.assertEqual(self.client.get(self.url).status_code, 401)
        self.client.force_authenticate(self.citizen)
        self.assertEqual(self.client.get(self.url).status_code, 403)
        self.client.force_authenticate(self.officer)
        response = self.client.get(self.url)
        self.assertEqual(response.status_code, 200)
        self.assertIsInstance(response.data, list)
        self.assertEqual(self.client.post(self.url, self.payload, format="json").status_code, 403)

    def test_admin_crud_with_validation_and_audit(self):
        self.client.force_authenticate(self.admin)
        created = self.client.post(self.url, self.payload, format="json")
        self.assertEqual(created.status_code, 201, created.data)
        self.assertEqual(created.data["latitude"], 17.437512)
        self.assertEqual(created.data["zone_type_display"], "Bus / Metro / Railway station")
        zone_id = created.data["id"]

        invalid = self.client.post(self.url, {**self.payload, "risk_level": 6, "latitude": 95}, format="json")
        self.assertEqual(invalid.status_code, 400)
        self.assertEqual(set(invalid.data["errors"]), {"risk_level", "latitude"})

        updated = self.client.patch(f"{self.url}{zone_id}/", {"risk_level": 5}, format="json")
        self.assertEqual(updated.data["risk_level"], 5)
        self.assertEqual(len(self.client.get(self.url, {"zone_type": "transit"}).data), 1)
        self.assertEqual(self.client.delete(f"{self.url}{zone_id}/").status_code, 204)
        self.assertFalse(RiskZone.objects.filter(pk=zone_id).exists())
        actions = set(AuditLog.objects.filter(entity_type="RiskZone").values_list("action", flat=True))
        self.assertEqual(actions, {"create", "update", "delete"})


class ContactTests(RoleUsersMixin, APITestCase):
    url = "/api/contact/"
    payload = {"name": "Priya Sharma", "email": "Priya@Example.com", "subject": "Feedback on the app",
               "message": "The complaint tracking page is very helpful, thank you!"}

    def test_anonymous_can_submit(self):
        response = self.client.post(self.url, self.payload, format="json")
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(response.data["email"], "priya@example.com")
        self.assertFalse(response.data["is_resolved"])
        self.assertEqual(ContactMessage.objects.count(), 1)
        short = self.client.post(self.url, {**self.payload, "message": "hi"}, format="json")
        self.assertEqual(short.status_code, 400)
        self.assertIn("message", short.data["errors"])

    def test_admin_lists_and_resolves(self):
        message = ContactMessage.objects.create(name="A", email="a@example.com", subject="Help", message="Need help")
        self.assertEqual(self.client.get(self.url).status_code, 401)
        self.client.force_authenticate(self.citizen)
        self.assertEqual(self.client.get(self.url).status_code, 403)
        self.client.force_authenticate(self.admin)
        listing = self.client.get(self.url)
        self.assertEqual(listing.status_code, 200)
        self.assertEqual(listing.data["count"], 1)  # paginated
        response = self.client.patch(f"{self.url}{message.pk}/", {"is_resolved": True, "subject": "Changed"},
                                     format="json")
        self.assertEqual(response.status_code, 200)
        message.refresh_from_db()
        self.assertTrue(message.is_resolved)
        self.assertEqual(message.subject, "Help")  # read-only for admins
        self.assertEqual(self.client.get(self.url, {"is_resolved": "false"}).data["count"], 0)
        self.assertEqual(self.client.delete(f"{self.url}{message.pk}/").status_code, 405)

    @override_settings(TESTING=False)
    def test_contact_form_is_rate_limited(self):
        with mock.patch.object(CivicScopedRateThrottle, "THROTTLE_RATES", {"contact": "2/min"}):
            codes = [self.client.post(self.url, self.payload, format="json").status_code for _ in range(3)]
        self.assertEqual(codes, [201, 201, 429])


def fake_response(payload, status_code=200):
    response = mock.Mock()
    response.status_code = status_code
    response.json.return_value = payload
    if status_code >= 400:
        response.raise_for_status.side_effect = requests.HTTPError(f"{status_code} error", response=response)
    else:
        response.raise_for_status.return_value = None
    return response


NOMINATIM_REVERSE = {
    "display_name": "Road Number 12, Banjara Hills, Hyderabad, Telangana, 500034, India",
    "address": {"road": "Road Number 12", "neighbourhood": "MLA Colony", "suburb": "Banjara Hills",
                "city": "Hyderabad", "state": "Telangana", "postcode": "500 034", "country": "India"},
}


@override_settings(CIVICAI={**settings.CIVICAI, "GEOCODING_ENABLED": True, "NOMINATIM_MIN_INTERVAL_SECONDS": 0,
                            "NOMINATIM_URL": "https://nominatim.example.test", "NOMINATIM_USER_AGENT": "CivicAI-Test"})
class GeocodingTests(APITestCase):
    reverse_url = "/api/geo/reverse/"
    search_url = "/api/geo/search/"

    def setUp(self):
        cache.clear()

    @mock.patch("apps.core.geocoding.requests.get")
    def test_reverse_parses_nominatim_and_caches(self, get):
        get.return_value = fake_response(NOMINATIM_REVERSE)
        response = self.client.get(self.reverse_url, {"lat": "17.41230", "lng": "78.44800"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, {
            "address": "Road Number 12, MLA Colony, Banjara Hills", "area": "Banjara Hills", "city": "Hyderabad",
            "pincode": "500034", "display_name": NOMINATIM_REVERSE["display_name"], "source": "nominatim",
        })
        args, kwargs = get.call_args
        self.assertEqual(args[0], "https://nominatim.example.test/reverse")
        self.assertEqual(kwargs["timeout"], 5)
        self.assertEqual(kwargs["headers"]["User-Agent"], "CivicAI-Test")
        self.assertEqual(kwargs["params"]["format"], "jsonv2")

        again = self.client.get(self.reverse_url, {"lat": "17.412301", "lon": "78.448002"})  # same ~11 m cell
        self.assertEqual(again.data["source"], "nominatim")
        self.assertEqual(get.call_count, 1)

    @mock.patch("apps.core.geocoding.requests.get", side_effect=requests.ConnectionError("offline"))
    def test_reverse_falls_back_when_offline(self, get):
        with self.assertLogs("apps.core", "WARNING"):
            response = self.client.get(self.reverse_url, {"lat": 17.4123, "lng": 78.448})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["source"], "fallback")
        self.assertEqual(response.data["address"], "17.412300, 78.448000")
        self.assertEqual(response.data["fallback_reason"], "unavailable")
        self.client.get(self.reverse_url, {"lat": 17.5, "lng": 78.5})
        self.assertEqual(get.call_count, 1)  # circuit breaker: no new upstream call during the back-off

    @mock.patch("apps.core.geocoding.requests.get")
    def test_reverse_fallback_on_http_error_and_no_result(self, get):
        get.return_value = fake_response({"error": "Unable to geocode"})
        self.assertEqual(self.client.get(self.reverse_url, {"lat": 0, "lng": 0}).data["fallback_reason"], "no_result")
        get.return_value = fake_response({}, status_code=503)
        with self.assertLogs("apps.core", "WARNING"):
            response = self.client.get(self.reverse_url, {"lat": 1, "lng": 1})
        self.assertEqual((response.status_code, response.data["source"]), (200, "fallback"))

        cache.clear()  # end the back-off window
        get.return_value = fake_response({}, status_code=403)  # Nominatim refuses placeholder User-Agents
        with self.assertLogs("apps.core", "WARNING") as logs:
            refused = self.client.get(self.reverse_url, {"lat": 2, "lng": 2})
        self.assertEqual(refused.data["source"], "fallback")
        self.assertIn("NOMINATIM_USER_AGENT", logs.output[0])

    @mock.patch("apps.core.geocoding.requests.get")
    def test_disabled_geocoding_never_calls_upstream(self, get):
        with override_settings(CIVICAI={**settings.CIVICAI, "GEOCODING_ENABLED": False}):
            reverse = self.client.get(self.reverse_url, {"lat": 17.4, "lng": 78.4})
            search = self.client.get(self.search_url, {"q": "Charminar"})
        self.assertEqual(reverse.data["fallback_reason"], "disabled")
        self.assertEqual((search.data, search["X-Geocoding-Source"]), ([], "fallback"))
        get.assert_not_called()

    def test_invalid_coordinates_are_400(self):
        self.assertEqual(self.client.get(self.reverse_url, {"lat": 95, "lng": 78}).status_code, 400)
        self.assertEqual(self.client.get(self.reverse_url, {"lat": "abc", "lng": 78}).status_code, 400)
        self.assertEqual(self.client.get(self.reverse_url).status_code, 400)
        self.assertEqual(self.client.get(self.search_url).status_code, 400)

    @mock.patch("apps.core.geocoding.requests.get")
    def test_search_returns_parsed_results_and_caches(self, get):
        get.return_value = fake_response([
            {"lat": "17.3616079", "lon": "78.4746286", "display_name": "Charminar, Hyderabad, Telangana, India",
             "address": {"road": "Charminar Road", "suburb": "Ghansi Bazaar", "city": "Hyderabad",
                         "postcode": "500002"}},
            {"display_name": "broken row without coordinates"},
        ])
        response = self.client.get(self.search_url, {"q": "  Charminar   Hyderabad "})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["X-Geocoding-Source"], "nominatim")
        self.assertEqual(response.data, [{
            "display_name": "Charminar, Hyderabad, Telangana, India", "latitude": 17.361608, "longitude": 78.474629,
            "address": "Charminar Road, Ghansi Bazaar", "area": "Ghansi Bazaar", "city": "Hyderabad",
            "pincode": "500002",
        }])
        self.assertEqual(get.call_args.kwargs["params"]["q"], "charminar hyderabad")
        self.client.get(self.search_url, {"q": "charminar hyderabad"})
        self.assertEqual(get.call_count, 1)

    @mock.patch("apps.core.geocoding.requests.get", side_effect=requests.Timeout("slow"))
    def test_search_offline_and_short_queries(self, get):
        short = self.client.get(self.search_url, {"q": "ab"})
        self.assertEqual((short.data, short["X-Geocoding-Source"]), ([], "skipped"))
        get.assert_not_called()
        with self.assertLogs("apps.core", "WARNING"):
            offline = self.client.get(self.search_url, {"q": "Secunderabad station"})
        self.assertEqual((offline.status_code, offline.data, offline["X-Geocoding-Source"]), (200, [], "fallback"))

    def test_parse_handles_towns_and_missing_parts(self):
        parsed = geocoding.parse_nominatim_address({
            "display_name": "Shamshabad, Ranga Reddy, Telangana, India",
            "address": {"town": "Shamshabad", "state_district": "Ranga Reddy"},
        })
        self.assertEqual(parsed["city"], "Shamshabad")
        self.assertEqual(parsed["area"], "")
        self.assertEqual(parsed["address"], "Shamshabad, Ranga Reddy, Telangana")
