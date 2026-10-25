"""Tests for the analytics app (owner B5).

A realistic dataset is declared once (``ROWS``: 40 complaints across every status, six
neighbourhoods of Hyderabad, back-dated timestamps, SLAs, feedback, AI predictions, duplicate
pairs, verifications, timeline events, notifications and hotspot alerts) and built with the ORM
in ``setUpTestData``.  Expected values are asserted as exact literals (hand-checked against the
table) or computed by small pure-Python oracles over the same table, so the ORM + pandas code
paths are checked against an independent calculation.

Timestamps are anchored at 12:00 local time today: ``created_at = anchor - days - idx minutes``.
Every created / resolved / due time is therefore at least ~11 hours away from "now", which makes
date buckets and overdue checks deterministic whatever time the suite runs.

The DBSCAN engine (``ai.geospatial.hotspots.detect_hotspots``) and the notification service
are written in parallel by other owners, so most tests replace them with ``unittest.mock``;
one test runs the real engine and is skipped only while it is still a stub.
"""
import csv
import io
import json
import math
import re
import sys
import types
from collections import Counter
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from datetime import timezone as dt_timezone
from unittest import mock

from django.test import SimpleTestCase, TestCase
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APITestCase

from apps.accounts.models import User
from apps.analytics import reports, services
from apps.analytics.models import HotspotAlert
from apps.analytics.serializers import (
    REPORT_TYPES,
    AnalyticsFilters,
    _local_category_mini,
    _local_complaint_list,
    _local_complaint_mini,
    _local_feedback,
    _local_notification,
    _local_officer_mini,
    _local_timeline_event,
    local_list_queryset,
    local_tz,
    serialize_shared,
)
from apps.analytics.tasks import scan_hotspots
from apps.assignments.services import officer_workload
from apps.audit.models import AuditLog
from apps.complaints.models import (
    AIPrediction,
    Complaint,
    DuplicateComplaint,
    Location,
    ResolutionVerification,
    StatusHistory,
)
from apps.core.models import AIConfiguration
from apps.core.utils import haversine_m
from apps.departments.models import CivicCategory, Department
from apps.feedback.models import Feedback
from apps.notifications.models import Notification
from apps.officers.models import OfficerProfile

ENGINE_PATH = "ai.geospatial.hotspots.detect_hotspots"
NOTIFY_PATH = "apps.notifications.services.notify_admins"
KEYWORDS_PATH = "ai.nlp.keyword_extractor.extract_keywords"
DEFAULT_THRESHOLDS = {"medium": 26, "high": 51, "critical": 76}

PLACES = {
    "banjara": ("Banjara Hills", 17.4126, 78.4482),
    "ameerpet": ("Ameerpet", 17.4375, 78.4483),
    "kukatpally": ("Kukatpally", 17.4948, 78.3996),
    "madhapur": ("Madhapur", 17.4483, 78.3915),
    "charminar": ("Charminar", 17.3616, 78.4747),
    "secunderabad": ("Secunderabad", 17.4399, 78.4983),
}


@dataclass(frozen=True)
class Row:
    key: str
    citizen: str
    category: str | None
    status: str
    severity: str
    severity_score: int
    priority: int
    level: str
    officer: str | None
    days: int                 # created this many days before the anchor
    res_hours: int | None     # resolved_at - created_at
    sla_hours: int | None     # sla_due_at - created_at
    place: str
    offset: tuple = (0, 0)    # metres east / north of the place centre
    reopen: int = 0
    review: bool = False      # needs_manual_review
    overridden: bool = False  # is_ai_overridden


ROWS = [
    Row("S1", "c1", None, "submitted", "", 0, 0, "", None, 2, None, None, "banjara", (0, 0), review=True),
    Row("S2", "c2", None, "submitted", "", 0, 0, "", None, 3, None, None, "kukatpally"),
    Row("S3", "c3", None, "submitted", "", 0, 0, "", None, 1, None, None, "charminar"),
    Row("AN1", "c1", "pothole", "analyzed", "high", 65, 60, "high", None, 4, None, 120, "banjara", (50, 30)),
    Row("AN2", "c2", "garbage", "analyzed", "medium", 40, 35, "medium", None, 5, None, 48, "ameerpet"),
    Row("AN3", "c3", "streetlight", "analyzed", "low", 20, 20, "low", None, 6, None, 168, "secunderabad",
        review=True, overridden=True),
    Row("AS1", "c1", "pothole", "assigned", "critical", 85, 88, "critical", "roads1", 2, None, 24, "banjara", (-40, 60)),
    Row("AS2", "c2", "pothole", "assigned", "high", 70, 70, "high", "roads1", 3, None, 96, "banjara", (80, -50)),
    Row("AS3", "c3", "garbage", "assigned", "medium", 45, 40, "medium", "waste", 4, None, 120, "ameerpet", (60, 40)),
    Row("AS4", "c1", "drainage", "assigned", "high", 60, 55, "high", "drain", 10, None, 48, "madhapur"),
    Row("AS5", "c2", "pothole", "assigned", "medium", 50, 45, "medium", "roads2", 1, None, 54, "kukatpally", (40, 40)),
    Row("AS6", "c3", "garbage", "assigned", "low", 25, 22, "low", "waste", 7, None, 48, "charminar", (30, -30)),
    Row("AC1", "c1", "pothole", "accepted", "high", 68, 66, "high", "roads1", 5, None, 72, "banjara", (20, -80)),
    Row("AC2", "c2", "drainage", "accepted", "critical", 80, 80, "critical", "drain", 2, None, 24, "madhapur", (100, 0)),
    Row("AC3", "c3", "garbage", "accepted", "medium", 42, 38, "medium", "waste", 3, None, 96, "ameerpet", (-50, -30)),
    Row("IP1", "c2", "open_manhole", "in_progress", "critical", 90, 92, "critical", "roads1", 6, None, 168, "banjara",
        (-60, -20)),
    Row("IP2", "c3", "streetlight", "in_progress", "medium", 35, 30, "medium", "roads2", 3, None, 96, "secunderabad",
        (50, 50)),
    Row("IP3", "c3", "drainage", "in_progress", "high", 62, 58, "high", "drain", 8, None, 48, "madhapur", (0, 120)),
    Row("IP4", "c1", "garbage", "in_progress", "low", 28, 25, "low", "waste", 4, None, 120, "charminar", (80, 80)),
    Row("RO1", "c1", "pothole", "reopened", "high", 66, 72, "high", "roads2", 20, None, 72, "banjara", (30, 30), reopen=1),
    Row("RO2", "c2", "garbage", "reopened", "medium", 48, 44, "medium", "waste", 15, None, 400, "ameerpet", (0, 90),
        reopen=1),
    Row("R1", "c1", "pothole", "resolved", "high", 64, 62, "high", "roads1", 10, 10, 72, "banjara", (100, 100)),
    Row("R2", "c2", "garbage", "resolved", "medium", 44, 40, "medium", "waste", 12, 20, 48, "ameerpet", (-90, 60)),
    Row("R3", "c3", "drainage", "resolved", "medium", 48, 54, "high", "drain", 9, 6, 48, "madhapur", (-70, -60),
        overridden=True),
    Row("R4", "c1", "pothole", "resolved", "medium", 50, 48, "medium", "roads2", 14, 30, 72, "kukatpally", (-60, 20)),
    Row("R5", "c2", "streetlight", "resolved", "low", 22, 20, "low", "roads2", 16, 40, 48, "secunderabad", (-40, 0),
        review=True),
    Row("R6", "c3", "garbage", "resolved", "low", 26, 24, "low", "waste", 18, 47, 48, "charminar", (-80, 40)),
    Row("R7", "c1", "pothole", "verified", "high", 70, 68, "high", "roads1", 25, 60, 72, "kukatpally", (90, -40)),
    Row("R8", "c2", "drainage", "verified", "medium", 46, 42, "medium", "drain", 22, 24, 48, "madhapur", (60, -90)),
    Row("R9", "c3", "garbage", "verified", "medium", 40, 36, "medium", "waste", 28, 80, 48, "ameerpet", (120, 0)),
    Row("R10", "c1", "pothole", "verified", "critical", 86, 84, "critical", "roads1", 35, 100, 36, "kukatpally", (0, -100)),
    Row("R11", "c2", "drainage", "closed", "high", 60, 56, "high", "drain", 40, 120, 48, "madhapur", (-100, 50)),
    Row("R12", "c3", "garbage", "closed", "medium", 45, 41, "medium", "waste", 45, 72, 48, "charminar", (0, -120)),
    Row("R13", "c1", "pothole", "closed", "high", 72, 74, "high", "roads1", 60, 200, 72, "kukatpally", (-120, -60),
        reopen=1),
    Row("R14", "c2", "streetlight", "closed", "medium", 38, 33, "medium", "roads2", 120, 300, 48, "secunderabad",
        (0, -80)),
    Row("R15", "c3", "pothole", "closed", "low", 24, 23, "low", "roads2", 100, 12, 72, "kukatpally", (70, 70)),
    Row("R16", "c1", "garbage", "closed", "medium", 41, 37, "medium", "waste", 50, 37, 48, "charminar", (-50, -90)),
    Row("RJ1", "c2", "garbage", "rejected", "low", 20, 18, "low", "waste", 11, None, None, "ameerpet", (-110, -40)),
    Row("RJ2", "c3", "pothole", "rejected", "low", 15, 15, "low", "roads1", 13, None, None, "kukatpally", (110, -10)),
    Row("RJ3", "c1", "drainage", "rejected", "medium", 30, 28, "medium", "drain", 17, None, None, "madhapur", (-30, 110)),
]
BY_KEY = {row.key: row for row in ROWS}

# (complaint, rating, sentiment, score, text)
FEEDBACK = [
    ("R7", 5, "positive", 0.8, "The pothole was resolved quickly and the road is smooth now"),
    ("R8", 4, "positive", 0.6, "Drain cleaned properly, good work by the team"),
    ("R9", 2, "negative", -0.6, "Garbage still not fixed properly, slow response and no action for days"),
    ("R10", 3, "neutral", 0.0, "Work done but took a long time"),
    ("R11", 1, "negative", -0.9, "Waste of time, drain still overflowing, very slow response"),
    ("R12", 4, "positive", 0.5, "Garbage cleared, thank you for quick action"),
    ("R13", 5, "positive", 0.9, "Excellent work, road repaired quickly and properly"),
    ("R14", 3, "neutral", 0.1, "Streetlight fixed after many days"),
    ("R16", 2, "negative", -0.4, "Slow response, garbage dumped again"),
    ("R2", 4, "positive", 0.7, "Quick action and good work"),
]
DUPLICATES = [
    ("AS2", "AN1", "confirmed_duplicate"),
    ("AC3", "AS3", "confirmed_duplicate"),
    ("AS5", "S2", "not_duplicate"),
    ("S1", "AN1", "pending_review"),
    ("IP4", "AS6", "pending_review"),
]
VERIFICATIONS = [  # (complaint, status, score, manual override)
    ("R7", "likely_resolved", 90, False),
    ("R8", "likely_resolved", 80, False),
    ("R9", "partially_resolved", 55, False),
    ("R10", "not_resolved", 30, True),
]


def prediction_specs():
    """One AI prediction per analysed complaint (two for re-analysed AS2 and RO1), as plain dicts."""
    specs = []
    for row in ROWS:
        if row.category is None:
            continue
        base = {"key": row.key, "image_category": row.category, "image_confidence": 0.8,
                "text_category": row.category, "text_confidence": 0.7, "final": row.category,
                "confidence": 0.85, "needs_review": False, "ms": 100, "severity": row.severity, "minutes": 1}
        if row.key in ("AN2", "AS3", "R2"):  # text-only submissions
            base.update(image_category="", image_confidence=0.0, confidence=0.7)
        elif row.key == "AS5":
            base.update(image_category="road_crack", image_confidence=0.6, confidence=0.55, needs_review=True)
        elif row.key == "AS6":
            base.update(image_category="drainage", confidence=0.55, needs_review=True)
        elif row.key == "R9":
            base.update(image_category="pothole", confidence=0.55)
        elif row.key == "AN3":  # AI said pothole, an admin corrected it to streetlight
            base.update(image_category="pothole", text_category="pothole", final="pothole", confidence=0.6,
                        needs_review=True)
        elif row.key == "R3":   # AI said garbage, an admin corrected it to drainage
            base.update(image_category="garbage", text_category="garbage", final="garbage")
        if row.key == "AS2":
            specs.append({**base, "image_category": "road_crack", "text_category": "road_crack", "final": "road_crack",
                          "confidence": 0.5, "ms": 300, "minutes": 1})
            base["minutes"] = 5
        if row.key == "RO1":
            specs.append(dict(base))
            base["minutes"] = 5
        specs.append(base)
    return specs


def fake_dbscan(points, *, eps_m, min_samples, thresholds=None):
    """Deterministic stand-in for DBSCAN honouring the engine contract: one cluster per area with
    at least ``min_samples`` points (the test neighbourhoods are kilometres apart)."""
    by_area = {}
    for point in points:
        by_area.setdefault(point["area"], []).append(point)
    clusters, labels, noise = [], {}, []
    for area in sorted(by_area):
        members = by_area[area]
        if len(members) < min_samples:
            for point in members:
                labels[point["id"]] = -1
                noise.append(point["id"])
            continue
        cluster_id = len(clusters)
        lat = sum(p["latitude"] for p in members) / len(members)
        lng = sum(p["longitude"] for p in members) / len(members)
        breakdown = Counter(p["category"] for p in members if p["category"])
        dominant = sorted(breakdown.items(), key=lambda item: (-item[1], item[0]))[0][0] if breakdown else ""
        for point in members:
            labels[point["id"]] = cluster_id
        clusters.append({
            "cluster_id": cluster_id, "latitude": lat, "longitude": lng, "count": len(members),
            "radius_m": max(haversine_m(lat, lng, p["latitude"], p["longitude"]) for p in members),
            "dominant_category": dominant, "dominant_category_name": dominant.replace("_", " ").title(),
            "category_breakdown": dict(breakdown), "avg_severity_score": 50.0, "max_severity": "critical",
            "severity_level": "high", "avg_priority_score": 50.0,
            "open_count": sum(1 for p in members if p["status"] in services.OPEN), "area_name": area,
            "complaint_ids": [p["id"] for p in members],
            "bounds": [[lat - 0.01, lng - 0.01], [lat + 0.01, lng + 0.01]], "density_per_km2": 10.0,
        })
    return {"clusters": clusters, "noise_ids": noise, "labels": labels,
            "params": {"eps_m": eps_m, "min_samples": min_samples}, "algorithm": "DBSCAN (haversine)",
            "total_points": len(points)}


class AnalyticsDataMixin:
    """Builds the shared dataset once per test class (``setUpTestData``)."""

    @classmethod
    def setUpTestData(cls):
        cls.now_local = timezone.now().astimezone(local_tz())
        cls.today = cls.now_local.date()
        cls.anchor = cls.now_local.replace(hour=12, minute=0, second=0, microsecond=0)

        cls.departments = {}
        for code, name, active in [("ROADS", "Roads Department", True), ("WASTE", "Waste Management", True),
                                   ("DRAIN", "Drainage Department", True), ("ELEC", "Electrical Department", True),
                                   ("PARKS", "Parks & Public Works", True), ("OLD", "Old Ward Office", False)]:
            cls.departments[code] = Department.objects.create(
                name=name, code=code, icon="building-2", color="#0B6E4F", sla_hours=48, is_active=active
            )
        cls.categories = {}
        for order, (slug, name, dept, active) in enumerate([
            ("pothole", "Roads / Potholes", "ROADS", True), ("garbage", "Garbage / Waste", "WASTE", True),
            ("drainage", "Drainage / Waterlogging", "DRAIN", True), ("streetlight", "Streetlight / Electricity", "ELEC", True),
            ("open_manhole", "Open Manhole", "ROADS", True), ("fallen_tree", "Fallen Tree / Obstruction", "PARKS", True),
            ("legacy", "Legacy Category", "OLD", False),
        ], start=1):
            cls.categories[slug] = CivicCategory.objects.create(
                name=name, slug=slug, icon="circle-alert", color="#64748B", department=cls.departments[dept],
                sort_order=order, is_active=active,
            )

        cls.admin = User.objects.create_user("admin@civicai.test", "pass12345", first_name="Asha", last_name="Admin",
                                             role=User.Role.ADMIN)
        cls.citizens = {}
        for key, first in [("c1", "Ravi"), ("c2", "Sita"), ("c3", "Kiran")]:
            cls.citizens[key] = User.objects.create_user(f"{first.lower()}@citizen.test", "pass12345",
                                                         first_name=first, last_name="Citizen", phone="9876500000")
        User.objects.create_user("former@citizen.test", "pass12345", first_name="Former", is_active=False)
        cls.citizens["c1"].citizen_profile.civic_points = 30
        cls.citizens["c1"].citizen_profile.save()
        cls.officers = {}
        for key, first, last, dept, capacity, available in [
            ("roads1", "Anil", "Rao", "ROADS", 10, True), ("roads2", "Bhavana", "Reddy", "ROADS", 5, False),
            ("waste", "Chandra", "Shekar", "WASTE", 8, True), ("drain", "Divya", "Menon", "DRAIN", 6, True),
        ]:
            user = User.objects.create_user(f"{first.lower()}@officer.test", "pass12345", first_name=first,
                                            last_name=last, role=User.Role.OFFICER)
            OfficerProfile.objects.create(user=user, department=cls.departments[dept], employee_id=f"EMP-{key}",
                                          max_active_complaints=capacity, is_available=available)
            cls.officers[key] = user

        cls.complaints, cls.created, cls.resolved = {}, {}, {}
        for idx, row in enumerate(ROWS):
            area, base_lat, base_lng = PLACES[row.place]
            east, north = row.offset
            lat = base_lat + north / 111320.0
            lng = base_lng + east / (111320.0 * math.cos(math.radians(base_lat)))
            location = Location.objects.create(latitude=f"{lat:.6f}", longitude=f"{lng:.6f}",
                                               address=f"{area} main road", area=area, city="Hyderabad")
            created = cls.anchor - timedelta(days=row.days, minutes=idx)
            resolved = created + timedelta(hours=row.res_hours) if row.res_hours is not None else None
            category = cls.categories[row.category] if row.category else None
            complaint = Complaint.objects.create(
                citizen=cls.citizens[row.citizen],
                title=f"{category.name if category else 'Unclassified issue'} near {area}",
                description=f"Test complaint {row.key} in {area}",
                category=category, status=row.status, severity=row.severity, severity_score=row.severity_score,
                priority_score=row.priority, priority_level=row.level,
                department=category.department if category else None,
                assigned_officer=cls.officers[row.officer] if row.officer else None,
                location=location, incident_at=created, created_at=created, resolved_at=resolved,
                sla_due_at=created + timedelta(hours=row.sla_hours) if row.sla_hours else None,
                reopen_count=row.reopen, needs_manual_review=row.review, is_ai_overridden=row.overridden,
            )
            Complaint.objects.filter(pk=complaint.pk).update(updated_at=(resolved or created) + timedelta(hours=1))
            cls.complaints[row.key] = complaint
            cls.created[row.key] = created
            cls.resolved[row.key] = resolved
        Complaint.objects.filter(pk=cls.complaints["AC1"].pk).update(updated_at=timezone.now() - timedelta(hours=2))

        for spec in prediction_specs():
            complaint = cls.complaints[spec["key"]]
            AIPrediction.objects.create(
                complaint=complaint, image_category=spec["image_category"], image_confidence=spec["image_confidence"],
                text_category=spec["text_category"], text_confidence=spec["text_confidence"],
                final_category=cls.categories.get(spec["final"]), final_category_slug=spec["final"],
                multimodal_confidence=spec["confidence"], severity=spec["severity"],
                severity_score=BY_KEY[spec["key"]].severity_score, needs_review=spec["needs_review"],
                processing_time_ms=spec["ms"], model_version="demo-test-1.0",
                created_at=cls.created[spec["key"]] + timedelta(minutes=spec["minutes"]),
            )
        for key, rating, sentiment, score, text in FEEDBACK:
            complaint = cls.complaints[key]
            Feedback.objects.create(complaint=complaint, citizen=complaint.citizen, rating=rating, text=text,
                                    sentiment=sentiment, sentiment_score=score, sentiment_confidence=0.9,
                                    sentiment_model="demo-lexicon-sentiment-1.0",
                                    created_at=cls.resolved[key] + timedelta(hours=2))
        for newer, original, status in DUPLICATES:
            DuplicateComplaint.objects.create(complaint=cls.complaints[newer], similar_complaint=cls.complaints[original],
                                              text_similarity=0.8, location_similarity=0.9, overall_similarity=0.85,
                                              distance_m=40, category_match=True, status=status)
        for key, status, score, manual in VERIFICATIONS:
            ResolutionVerification.objects.create(
                complaint=cls.complaints[key], score=score, status=status, method="manual" if manual else "ai_assisted",
                is_manual_override=manual, verified_at=cls.resolved[key] + timedelta(hours=1),
            )

        ac1, ip1, as4 = cls.complaints["AC1"], cls.complaints["IP1"], cls.complaints["AS4"]
        now = timezone.now()
        cls.events = {
            "E1": StatusHistory.objects.create(complaint=ac1, event="submitted", new_status="submitted",
                                               timestamp=ac1.created_at),
            "E2": StatusHistory.objects.create(complaint=ac1, event="ai_analyzed", old_status="submitted",
                                               new_status="analyzed", timestamp=ac1.created_at + timedelta(minutes=1)),
            "E3": StatusHistory.objects.create(complaint=ac1, event="officer_assigned", old_status="analyzed",
                                               new_status="assigned", timestamp=ac1.created_at + timedelta(minutes=10)),
            "E4": StatusHistory.objects.create(complaint=ac1, event="accepted", old_status="assigned",
                                               new_status="accepted", changed_by=cls.officers["roads1"],
                                               timestamp=now - timedelta(hours=3)),
            "E5": StatusHistory.objects.create(complaint=ac1, event="remark", changed_by=cls.officers["roads1"],
                                               remarks="Material requisition raised", is_public=False,
                                               timestamp=now - timedelta(hours=2)),
            "E6": StatusHistory.objects.create(complaint=ip1, event="in_progress", old_status="accepted",
                                               new_status="in_progress", changed_by=cls.officers["roads1"],
                                               timestamp=now - timedelta(hours=1)),
            "E7": StatusHistory.objects.create(complaint=as4, event="officer_assigned", new_status="assigned",
                                               timestamp=now - timedelta(minutes=30)),
        }
        for hours in range(1, 7):
            Notification.objects.create(user=cls.citizens["c1"], title=f"Update {hours}", message="Status changed",
                                        notification_type="status_changed", complaint=ac1,
                                        link=f"/citizen/complaints/{ac1.pk}", created_at=now - timedelta(hours=hours))
        garbage = cls.categories["garbage"]
        cls.alerts = {
            "HA1": HotspotAlert.objects.create(cluster_key="17.437,78.448:garbage", latitude="17.437500",
                                               longitude="78.448300", radius_m=120, complaint_count=5,
                                               dominant_category=garbage, severity="medium", area_name="Ameerpet",
                                               complaint_ids=[], is_acknowledged=True,
                                               created_at=now - timedelta(days=3)),
            "HA2": HotspotAlert.objects.create(cluster_key="17.438,78.448:garbage", latitude="17.437600",
                                               longitude="78.448400", radius_m=130, complaint_count=6,
                                               dominant_category=garbage, severity="medium", area_name="Ameerpet",
                                               complaint_ids=[], created_at=now - timedelta(days=2)),
            "HA3": HotspotAlert.objects.create(cluster_key="17.362,78.475:garbage", latitude="17.361600",
                                               longitude="78.474700", radius_m=90, complaint_count=5,
                                               dominant_category=garbage, severity="low", area_name="Charminar",
                                               complaint_ids=[], created_at=now - timedelta(days=40)),
        }
        AIConfiguration.load()

    # ----- helpers -------------------------------------------------------------------------
    def ids(self, *keys):
        return [self.complaints[key].pk for key in keys]

    def get(self, name, user=None, params=None, kwargs=None):
        if user is not None:
            self.client.force_authenticate(user)
        else:
            self.client.force_authenticate(None)
        return self.client.get(reverse(f"analytics:{name}", kwargs=kwargs), params or {})

    def get_json(self, name, user, params=None):
        response = self.get(name, user, params)
        self.assertEqual(response.status_code, 200, response.content[:500])
        return response.json()

    def local_date(self, value):
        return value.astimezone(local_tz()).date()

    def rows_where(self, predicate):
        return [row for row in ROWS if predicate(row)]


class OverviewAndBreakdownTests(AnalyticsDataMixin, APITestCase):
    def test_overview_totals_and_distributions(self):
        data = self.get_json("overview", self.admin)
        self.assertEqual(data["totals"], {
            "total": 40, "pending": 14, "in_progress": 7, "resolved": 16, "critical": 3, "rejected": 3,
            # needs_review: 2 open complaints flagged for review + 1 resolved one awaiting manual verification
            "reopened": 3, "overdue": 8, "duplicates_pending": 2, "needs_review": 3,
        })
        # 16 resolved complaints: 1159 hours in total; 10 of 16 resolved within their SLA.
        self.assertEqual(data["avg_resolution_hours"], 72.4)
        self.assertEqual(data["sla_compliance"], 62.5)
        self.assertEqual(data["avg_rating"], 3.3)
        self.assertEqual(data["satisfaction_rate"], 50.0)
        self.assertEqual({item["status"]: item["count"] for item in data["status_distribution"]}, {
            "submitted": 3, "analyzed": 3, "assigned": 6, "accepted": 3, "in_progress": 4, "resolved": 6,
            "verified": 4, "closed": 6, "rejected": 3, "reopened": 2,
        })
        self.assertEqual([item["count"] for item in data["severity_distribution"]], [8, 15, 10, 4])
        self.assertEqual([item["level"] for item in data["priority_distribution"]], ["low", "medium", "high", "critical"])
        self.assertEqual([item["count"] for item in data["priority_distribution"]], [8, 14, 11, 4])
        self.assertEqual([item["bucket"] for item in data["priority_histogram"]][:2], ["0-9", "10-19"])
        self.assertEqual(data["priority_histogram"][-1]["bucket"], "90-100")
        self.assertEqual([item["count"] for item in data["priority_histogram"]], [0, 2, 7, 6, 7, 4, 4, 3, 3, 1])
        self.assertEqual(data["resolution_time_distribution"], [
            {"bucket": "< 24 h", "count": 4}, {"bucket": "1–3 days", "count": 6},
            {"bucket": "3–7 days", "count": 4}, {"bucket": "> 7 days", "count": 2},
        ])
        self.assertEqual([item["id"] for item in data["recent_critical"]], self.ids("AS1", "AC2", "IP1"))
        self.assertEqual(data["recent_critical"][0]["complaint_number"], self.complaints["AS1"].complaint_number)
        self.assertEqual(data["hotspot_count"], 1)
        self.assertIn("generated_at", data)

    def test_overview_oracle_for_resolution_metrics(self):
        resolved = self.rows_where(lambda row: row.res_hours is not None)
        within = [row for row in resolved if row.res_hours <= row.sla_hours]
        data = self.get_json("overview", self.admin)
        self.assertEqual(data["avg_resolution_hours"], round(sum(r.res_hours for r in resolved) / len(resolved), 1))
        self.assertEqual(data["sla_compliance"], round(100 * len(within) / len(resolved), 1))

    def test_overview_filters(self):
        def total(params):
            return self.get_json("overview", self.admin, params)["totals"]["total"]

        roads = self.departments["ROADS"]
        self.assertEqual(total({"department": "ROADS"}), 14)
        self.assertEqual(total({"department": str(roads.pk)}), 14)
        self.assertEqual(total({"category": "pothole"}), 13)
        self.assertEqual(total({"category": str(self.categories["pothole"].pk)}), 13)
        self.assertEqual(total({"severity": "critical"}), 4)
        self.assertEqual(total({"severity": "high,critical"}), 14)
        self.assertEqual(total({"status": "resolved,verified"}), 10)
        self.assertEqual(self.get_json("overview", self.admin, {"status": ["resolved", "closed"]})["totals"]["total"], 12)
        recent = (self.today - timedelta(days=10)).isoformat()
        self.assertEqual(total({"date_from": recent}), len(self.rows_where(lambda row: row.days <= 10)))
        old = (self.today - timedelta(days=30)).isoformat()
        self.assertEqual(total({"date_to": old}), len(self.rows_where(lambda row: row.days >= 30)))
        self.assertEqual(total({"date_from": recent, "date_to": recent}), len(self.rows_where(lambda row: row.days == 10)))
        self.assertEqual(total({"department": "", "status": ""}), 40)  # blank parameters are ignored

    def test_invalid_filters_return_400(self):
        cases = [
            ("overview", {"date_from": "2026-13-45"}, "date_from"),
            ("overview", {"date_from": "17-10-2026"}, "date_from"),
            ("overview", {"date_from": "1999-12-31"}, "date_from"),
            ("overview", {"date_from": "2026-10-10", "date_to": "2026-10-01"}, "date_to"),
            ("overview", {"status": "resolved,bogus"}, "status"),
            ("overview", {"severity": "extreme"}, "severity"),
            ("overview", {"category": "nope"}, "category"),
            ("overview", {"department": "99999"}, "department"),
            ("trends", {"days": "0"}, "days"),
            ("trends", {"period": "year"}, "period"),
            ("hotspots", {"eps_m": "10"}, "eps_m"),
            ("hotspots", {"min_samples": "1"}, "min_samples"),
            ("reports", {"report": "salaries"}, "report"),
            ("reports", {"format": "xml"}, "format"),
            ("alerts", {"is_acknowledged": "maybe"}, "is_acknowledged"),
        ]
        for name, params, field in cases:
            with self.subTest(name=name, params=params):
                response = self.get(name, self.admin, params)
                self.assertEqual(response.status_code, 400, response.content)
                body = response.json()
                self.assertEqual(body["code"], "validation_error")
                self.assertIn(field, body["errors"])

    def test_category_breakdown(self):
        data = self.get_json("categories", self.admin)
        self.assertEqual([item["category"]["slug"] for item in data],
                         ["pothole", "garbage", "drainage", "streetlight", "open_manhole", "fallen_tree"])
        pothole = data[0]
        self.assertEqual(pothole["category"], {"id": self.categories["pothole"].pk, "name": "Roads / Potholes",
                                               "slug": "pothole", "icon": "circle-alert", "color": "#64748B"})
        self.assertEqual({key: pothole[key] for key in ("total", "open", "resolved", "critical")},
                         {"total": 13, "open": 6, "resolved": 6, "critical": 1})
        self.assertEqual(pothole["avg_priority"], 59.6)        # 775 / 13
        self.assertEqual(pothole["avg_severity_score"], 60.4)  # 785 / 13
        self.assertEqual(pothole["avg_resolution_hours"], 68.7)  # (10+30+60+100+200+12) / 6
        self.assertEqual(pothole["resolution_rate"], 46.2)     # 6 / 13
        manhole = data[4]
        self.assertEqual((manhole["total"], manhole["open"], manhole["critical"], manhole["avg_priority"]), (1, 1, 1, 92.0))
        self.assertEqual(data[5], {"category": data[5]["category"], "total": 0, "open": 0, "resolved": 0, "critical": 0,
                                   "avg_priority": 0.0, "avg_severity_score": 0.0, "avg_resolution_hours": 0.0,
                                   "resolution_rate": 0.0})
        for item in data:  # oracle for every category
            rows = self.rows_where(lambda row, slug=item["category"]["slug"]: row.category == slug)
            with self.subTest(category=item["category"]["slug"]):
                self.assertEqual(item["total"], len(rows))
                self.assertEqual(item["resolved"], sum(1 for row in rows if row.status in services.RESOLVED))
        only_roads = self.get_json("categories", self.admin, {"department": "ROADS"})
        self.assertEqual([item["category"]["slug"] for item in only_roads], ["pothole", "open_manhole"])

    def test_department_breakdown(self):
        data = self.get_json("departments", self.admin)
        self.assertEqual([item["department"]["code"] for item in data], ["ROADS", "WASTE", "DRAIN", "ELEC", "PARKS"])
        rows = {item["department"]["code"]: {k: v for k, v in item.items() if k != "department"} for item in data}
        self.assertEqual(rows["ROADS"], {
            "total": 14, "pending": 5, "in_progress": 2, "resolved": 6, "critical": 2, "overdue": 3,
            "avg_resolution_hours": 68.7, "resolution_rate": 42.9, "sla_compliance": 66.7, "avg_rating": 4.33,
            "officer_count": 2, "active_workload": 7,
        })
        self.assertEqual(rows["WASTE"], {
            "total": 12, "pending": 4, "in_progress": 2, "resolved": 5, "critical": 0, "overdue": 2,
            "avg_resolution_hours": 51.2, "resolution_rate": 41.7, "sla_compliance": 60.0, "avg_rating": 3.0,
            "officer_count": 1, "active_workload": 5,
        })
        self.assertEqual(rows["DRAIN"], {
            "total": 7, "pending": 1, "in_progress": 2, "resolved": 3, "critical": 1, "overdue": 3,
            "avg_resolution_hours": 50.0, "resolution_rate": 42.9, "sla_compliance": 66.7, "avg_rating": 2.5,
            "officer_count": 1, "active_workload": 3,
        })
        self.assertEqual(rows["ELEC"], {
            "total": 4, "pending": 1, "in_progress": 1, "resolved": 2, "critical": 0, "overdue": 0,
            "avg_resolution_hours": 170.0, "resolution_rate": 50.0, "sla_compliance": 50.0, "avg_rating": 3.0,
            "officer_count": 0, "active_workload": 0,
        })
        self.assertEqual(rows["PARKS"]["total"], 0)
        self.assertEqual(rows["PARKS"]["sla_compliance"], 0.0)
        filtered = self.get_json("departments", self.admin, {"department": "DRAIN"})
        self.assertEqual([item["department"]["code"] for item in filtered], ["DRAIN"])

    def test_officer_performance(self):
        data = self.get_json("officers", self.admin)
        self.assertEqual([item["officer"]["email"] for item in data],
                         ["anil@officer.test", "bhavana@officer.test", "chandra@officer.test", "divya@officer.test"])
        expected = [
            {"active": 4, "capacity": 10, "utilization": 0.4, "is_available": True, "resolved_total": 4,
             "resolved_30d": 2, "avg_resolution_hours": 92.5, "avg_rating": 4.33, "critical_active": 2},
            {"active": 3, "capacity": 5, "utilization": 0.6, "is_available": False, "resolved_total": 4,
             "resolved_30d": 2, "avg_resolution_hours": 95.5, "avg_rating": 3.0, "critical_active": 0},
            {"active": 5, "capacity": 8, "utilization": 0.625, "is_available": True, "resolved_total": 5,
             "resolved_30d": 3, "avg_resolution_hours": 51.2, "avg_rating": 3.0, "critical_active": 0},
            {"active": 3, "capacity": 6, "utilization": 0.5, "is_available": True, "resolved_total": 3,
             "resolved_30d": 2, "avg_resolution_hours": 50.0, "avg_rating": 2.5, "critical_active": 1},
        ]
        for item, values in zip(data, expected):
            with self.subTest(officer=item["officer"]["email"]):
                self.assertEqual({key: item[key] for key in values}, values)
                # the same numbers as /officers/{id}/workload/ (apps.assignments.services.officer_workload)
                workload = officer_workload(User.objects.get(pk=item["officer"]["id"]))
                self.assertEqual({key: item[key] for key in ("active", "capacity", "utilization", "overloaded")},
                                 {key: workload[key] for key in ("active", "capacity", "utilization", "overloaded")})
        self.assertEqual(data[0]["officer"]["employee_id"], "EMP-roads1")
        self.assertEqual(data[0]["department"]["code"], "ROADS")
        roads = self.get_json("officers", self.admin, {"department": "ROADS"})
        self.assertEqual(len(roads), 2)

    def test_daily_trends(self):
        data = self.get_json("trends", self.admin)
        self.assertEqual(data["period"], "day")
        series = data["series"]
        self.assertEqual(len(series), 90)
        self.assertEqual(series[0]["date"], (self.today - timedelta(days=89)).isoformat())
        self.assertEqual(series[-1]["date"], self.today.isoformat())
        self.assertEqual(series[-1]["label"], f"{self.today:%b} {self.today.day}")
        in_window = self.rows_where(lambda row: row.days <= 89)
        self.assertEqual(sum(item["submitted"] for item in series), len(in_window))  # 38
        self.assertEqual(sum(item["critical"] for item in series), 4)
        start = self.today - timedelta(days=89)
        resolved_dates = {key: self.local_date(value) for key, value in self.resolved.items()
                          if value is not None and BY_KEY[key].status in services.RESOLVED}
        resolved_in_window = {key: day for key, day in resolved_dates.items() if day >= start}
        self.assertEqual(sum(item["resolved"] for item in series), len(resolved_in_window))  # 14
        by_date = {item["date"]: item for item in series}
        for row in in_window:
            day = (self.today - timedelta(days=row.days)).isoformat()
            expected = sum(1 for other in in_window if other.days == row.days)
            self.assertEqual(by_date[day]["submitted"], expected)
        trend = {item["date"]: item for item in data["resolution_time_trend"]}
        for key, day in resolved_in_window.items():
            hours = [BY_KEY[k].res_hours for k, d in resolved_in_window.items() if d == day]
            self.assertEqual(trend[day.isoformat()]["avg_hours"], round(sum(hours) / len(hours), 1))
            self.assertEqual(trend[day.isoformat()]["count"], len(hours))
        self.assertEqual([c["slug"] for c in data["categories"]],
                         ["pothole", "garbage", "drainage", "streetlight", "open_manhole"])
        two_days_ago = {item["date"]: item for item in data["category_series"]}[(self.today - timedelta(days=2)).isoformat()]
        self.assertEqual((two_days_ago["pothole"], two_days_ago["drainage"], two_days_ago["garbage"]), (1, 1, 0))

    def test_weekly_and_monthly_trends(self):
        weekly = self.get_json("trends", self.admin, {"period": "week", "days": 90})
        parsed = [date.fromisoformat(item["date"]) for item in weekly["series"]]
        self.assertTrue(all(day.weekday() == 0 for day in parsed))
        self.assertTrue(all((b - a).days == 7 for a, b in zip(parsed, parsed[1:])))
        self.assertEqual(sum(item["submitted"] for item in weekly["series"]), 38)
        week_of = {}
        for row in self.rows_where(lambda row: row.days <= 89):
            day = self.today - timedelta(days=row.days)
            monday = (day - timedelta(days=day.weekday())).isoformat()
            week_of[monday] = week_of.get(monday, 0) + 1
        self.assertEqual({item["date"]: item["submitted"] for item in weekly["series"] if item["submitted"]}, week_of)
        monthly = self.get_json("trends", self.admin, {"period": "month"})
        self.assertTrue(all(item["date"].endswith("-01") for item in monthly["series"]))
        self.assertEqual(sum(item["submitted"] for item in monthly["series"]), 38)
        explicit = self.get_json("trends", self.admin, {"date_from": (self.today - timedelta(days=6)).isoformat()})
        self.assertEqual(len(explicit["series"]), 7)
        self.assertEqual(sum(item["submitted"] for item in explicit["series"]), len(self.rows_where(lambda r: r.days <= 6)))

    def test_sentiment_analytics(self):
        with mock.patch(KEYWORDS_PATH, side_effect=NotImplementedError):
            data = self.get_json("sentiment", self.admin)
        self.assertEqual(data["distribution"], [
            {"sentiment": "positive", "label": "Positive", "count": 5, "percentage": 50.0},
            {"sentiment": "neutral", "label": "Neutral", "count": 2, "percentage": 20.0},
            {"sentiment": "negative", "label": "Negative", "count": 3, "percentage": 30.0},
        ])
        self.assertEqual((data["positive_pct"], data["neutral_pct"], data["negative_pct"]), (50.0, 20.0, 30.0))
        self.assertEqual(data["average_rating"], 3.3)
        self.assertEqual(data["total_feedback"], 10)
        self.assertEqual(data["satisfaction_rate"], 50.0)
        self.assertEqual([item["count"] for item in data["rating_distribution"]], [1, 2, 2, 3, 2])
        departments = {item["department"]["code"]: item for item in data["by_department"]}
        self.assertEqual([item["department"]["code"] for item in data["by_department"]], ["WASTE", "ROADS", "DRAIN", "ELEC"])
        self.assertEqual({k: departments["ROADS"][k] for k in ("positive", "neutral", "negative", "total", "avg_rating")},
                         {"positive": 2, "neutral": 1, "negative": 0, "total": 3, "avg_rating": 4.33})
        self.assertEqual(departments["WASTE"]["avg_rating"], 3.0)
        self.assertEqual({item["category"]["slug"]: item["total"] for item in data["by_category"]},
                         {"garbage": 4, "pothole": 3, "drainage": 2, "streetlight": 1})
        self.assertEqual(sum(item["total"] for item in data["over_time"]), 9)  # one feedback is older than 90 days
        self.assertTrue(all(item["date"] for item in data["over_time"]))
        self.assertEqual(len(data["recent"]), 10)
        newest = max(FEEDBACK, key=lambda item: self.resolved[item[0]])[0]  # feedback = resolution + 2 h
        self.assertEqual(data["recent"][0]["complaint"], self.complaints[newest].pk)
        self.assertEqual(data["recent"][0]["rating"], 4)
        self.assertEqual(data["keyword_method"], "sentiment_lexicon+word_frequency")
        positive, negative = data["top_keywords"]["positive"], data["top_keywords"]["negative"]
        self.assertEqual(positive[0], {"keyword": "work", "count": 3})
        # opinion phrases (sentiment lexicon evidence) are merged with the topical keywords; ties favour opinions
        self.assertEqual(negative[:2], [{"keyword": "slow", "count": 3}, {"keyword": "response", "count": 3}])
        self.assertIn({"keyword": "good work", "count": 2}, positive)
        self.assertIn({"keyword": "quick action", "count": 2}, positive)
        for phrase in ("still not fixed", "no action"):
            self.assertIn({"keyword": phrase, "count": 1}, negative)
        self.assertNotIn("resolved quickly", [item["keyword"] for item in negative])  # polarity must match
        self.assertTrue(all(set(item) == {"keyword", "count"} for item in positive + negative))

    def test_sentiment_uses_keyword_extractor_when_available(self):
        with mock.patch(KEYWORDS_PATH, return_value=["slow response", "garbage"]) as extractor:
            data = self.get_json("sentiment", self.admin)
        self.assertEqual(extractor.call_count, 2)
        self.assertEqual(data["keyword_method"], "sentiment_lexicon+keyword_extractor")
        self.assertEqual(data["top_keywords"]["negative"][:3], [{"keyword": "slow", "count": 3},
                                                                {"keyword": "slow response", "count": 3},
                                                                {"keyword": "garbage", "count": 2}])
        self.assertLessEqual(len(data["top_keywords"]["negative"]), services.TOP_KEYWORDS)

    def test_sentiment_with_real_keyword_extractor(self):
        from ai.nlp.keyword_extractor import extract_keywords

        try:
            extract_keywords("Pothole repaired quickly", top_k=3)
        except NotImplementedError:
            self.skipTest("ai.nlp.keyword_extractor.extract_keywords is still a stub (owner A2)")
        data = self.get_json("sentiment", self.admin)
        self.assertEqual(data["keyword_method"], "sentiment_lexicon+keyword_extractor")
        for sentiment in ("positive", "negative"):
            keywords = data["top_keywords"][sentiment]
            self.assertTrue(keywords)
            self.assertTrue(all(set(item) == {"keyword", "count"} and item["keyword"] for item in keywords))
        self.assertIn("still not fixed", [item["keyword"] for item in data["top_keywords"]["negative"]])
        self.assertIn("good work", [item["keyword"] for item in data["top_keywords"]["positive"]])

    def test_sentiment_filters(self):
        with mock.patch(KEYWORDS_PATH, side_effect=NotImplementedError):
            data = self.get_json("sentiment", self.admin, {"department": "ROADS"})
        self.assertEqual(data["total_feedback"], 3)
        self.assertEqual(data["average_rating"], 4.33)
        self.assertEqual(sum(item["percentage"] for item in data["distribution"]), 100.0)

    def test_ai_performance(self):
        specs = prediction_specs()
        data = self.get_json("ai", self.admin)
        self.assertEqual(data["total_predictions"], len(specs))  # 39
        both = [s for s in specs if s["image_category"] and s["text_category"]]
        agree = [s for s in both if s["image_category"] == s["text_category"]]
        self.assertEqual(data["modality_agreement_rate"], round(100 * len(agree) / len(both), 1))  # 91.7
        self.assertEqual(data["modality_agreement_rate"], 91.7)
        self.assertEqual(data["avg_confidence"], 0.8)
        self.assertEqual(data["avg_image_confidence"], 0.794)
        self.assertEqual(data["avg_text_confidence"], 0.7)
        self.assertEqual(data["avg_processing_ms"], 105)
        self.assertEqual(data["needs_review_count"], 3)
        self.assertEqual(data["override_count"], 2)
        self.assertEqual(data["analyzed_complaints"], 37)
        self.assertEqual(data["override_rate"], 5.4)
        self.assertEqual(data["ai_category_match_rate"], 94.6)
        self.assertEqual([item["count"] for item in data["confidence_histogram"]], [0, 0, 0, 0, 0, 4, 1, 3, 31, 0])
        self.assertEqual([(item["category"]["slug"], item["count"]) for item in data["predictions_by_category"]],
                         [("pothole", 15), ("garbage", 13), ("drainage", 6), ("streetlight", 3), ("open_manhole", 1)])
        confusion = {(item["ai"], item["final"]): item["count"] for item in data["confusion"]}
        self.assertEqual(confusion, {("pothole", "pothole"): 13, ("garbage", "garbage"): 12, ("drainage", "drainage"): 6,
                                     ("streetlight", "streetlight"): 3, ("open_manhole", "open_manhole"): 1,
                                     ("pothole", "streetlight"): 1, ("garbage", "drainage"): 1})
        self.assertEqual(data["duplicates"], {"detected": 5, "pending": 2, "confirmed": 2, "rejected": 1, "precision": 66.7})
        self.assertEqual(data["verification"]["total"], 4)
        self.assertEqual(data["verification"]["avg_score"], 63.8)
        self.assertEqual(data["verification"]["manual_overrides"], 1)
        self.assertEqual({item["status"]: item["count"] for item in data["verification"]["by_status"]},
                         {"likely_resolved": 2, "partially_resolved": 1, "not_resolved": 1, "needs_manual_review": 0})
        self.assertEqual([item["count"] for item in data["severity_distribution"]], [8, 15, 12, 4])
        self.assertIn("mode", data["model_info"])
        self.assertEqual(data["is_demo"], data["mode"] == "demo")
        roads = self.get_json("ai", self.admin, {"department": "ROADS"})
        self.assertEqual(roads["total_predictions"], len([s for s in specs if BY_KEY[s["key"]].category in
                                                          ("pothole", "open_manhole")]))


class PublicAndDashboardTests(AnalyticsDataMixin, APITestCase):
    def test_public_stats_are_anonymous_and_aggregated(self):
        self.client.credentials(HTTP_AUTHORIZATION="Bearer not-a-valid-token")  # ignored on the public endpoint
        response = self.client.get(reverse("analytics:public"))
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual({key: data[key] for key in (
            "total_complaints", "resolved_complaints", "resolution_rate", "avg_resolution_hours", "departments",
            "categories", "active_officers", "citizens")},
            {"total_complaints": 40, "resolved_complaints": 16, "resolution_rate": 40.0, "avg_resolution_hours": 72.4,
             "departments": 5, "categories": 6, "active_officers": 4, "citizens": 3})
        newest = sorted((key for key, value in self.resolved.items() if value), key=lambda k: self.resolved[k],
                        reverse=True)[:5]
        self.assertEqual([item["complaint_number"] for item in data["recent_resolved"]],
                         [self.complaints[key].complaint_number for key in newest])
        self.assertEqual(set(data["recent_resolved"][0]), {"complaint_number", "title", "category", "area", "resolved_at"})
        body = response.content.decode()
        self.assertNotIn("@", body)
        self.assertNotIn("9876500000", body)
        self.assertNotIn("latitude", body)

    def test_citizen_dashboard(self):
        data = self.get_json("dashboard", self.citizens["c1"])
        self.assertEqual(data["role"], "citizen")
        self.assertEqual(data["totals"], {"total": 14, "pending": 5, "in_progress": 2, "resolved": 6, "rejected": 1})
        self.assertEqual([item["id"] for item in data["recent_complaints"]], self.ids("S1", "AS1", "AN1", "IP4", "AC1"))
        active = data["active_complaint"]
        self.assertEqual(active["complaint"]["id"], self.complaints["AC1"].pk)
        self.assertEqual([event["id"] for event in active["timeline"]],
                         [self.events[key].pk for key in ("E1", "E2", "E3", "E4")])  # private remark hidden
        self.assertEqual(active["timeline"][0]["actor_label"], "CivicAI Engine")
        self.assertEqual({item["complaint"]["id"] for item in data["feedback_requests"]}, set(self.ids("R1", "R4")))
        self.assertEqual(len(data["notifications"]), 5)
        self.assertEqual(data["notifications"][0]["title"], "Update 1")
        self.assertEqual(data["civic_points"], 30)

    def test_officer_dashboard(self):
        data = self.get_json("dashboard", self.officers["roads1"])
        self.assertEqual(data["role"], "officer")
        self.assertEqual(data["totals"], {"assigned": 4, "critical": 2, "pending": 2, "in_progress": 2, "resolved": 4,
                                          "overdue": 2})
        self.assertEqual(data["avg_resolution_hours"], 92.5)
        self.assertEqual(data["workload"], {"active": 4, "capacity": 10, "utilization": 0.4, "overloaded": False})
        self.assertEqual([item["id"] for item in data["queue"]], self.ids("IP1", "AS1", "AS2", "AC1"))
        self.assertEqual([item["id"] for item in data["recent_activity"]],
                         [self.events[key].pk for key in ("E6", "E5", "E4", "E3", "E2", "E1")])
        self.assertEqual(data["recent_activity"][0]["complaint_number"], self.complaints["IP1"].complaint_number)
        self.assertEqual(data["department"]["code"], "ROADS")

    def test_admin_dashboard_is_the_overview(self):
        data = self.get_json("dashboard", self.admin)
        self.assertEqual(data["role"], "admin")
        self.assertEqual(data["totals"]["total"], 40)
        self.assertIn("recent_critical", data)
        self.assertEqual(self.get_json("dashboard", self.admin, {"department": "WASTE"})["totals"]["total"], 12)

    def test_permissions(self):
        admin_only = ["overview", "categories", "departments", "trends", "sentiment", "officers", "ai", "reports", "alerts"]
        for name in admin_only:
            with self.subTest(name=name):
                self.assertEqual(self.get(name, self.citizens["c1"]).status_code, 403)
                self.assertEqual(self.get(name, self.officers["roads1"]).status_code, 403)
                self.assertEqual(self.get(name, None).status_code, 401)
        self.assertEqual(self.get("hotspots", self.citizens["c1"]).status_code, 403)
        self.assertEqual(self.get("hotspots", None).status_code, 401)
        self.assertEqual(self.get("dashboard", None).status_code, 401)
        self.client.force_authenticate(self.officers["roads1"])
        self.assertEqual(self.client.post(reverse("analytics:run-checks")).status_code, 403)


BANJARA_OPEN = ("S1", "AN1", "AS1", "AS2", "AC1", "IP1", "RO1")  # open complaints of the Banjara Hills cluster


class HotspotApiTests(AnalyticsDataMixin, APITestCase):
    def test_hotspot_map_uses_config_defaults_and_enriches_clusters(self):
        with mock.patch(ENGINE_PATH, side_effect=fake_dbscan) as engine:
            data = self.get_json("hotspots", self.admin)
        engine.assert_called_once()
        points, kwargs = engine.call_args.args[0], engine.call_args.kwargs
        self.assertEqual(kwargs, {"eps_m": 400, "min_samples": 3, "thresholds": DEFAULT_THRESHOLDS})
        self.assertEqual(len(points), len(self.rows_where(lambda row: row.days <= 89)))  # 38
        self.assertEqual(set(points[0]), {"id", "latitude", "longitude", "category", "category_name", "severity",
                                          "severity_score", "priority_score", "status", "area", "created_at"})
        clusters = {cluster["area_name"]: cluster for cluster in data["clusters"]}
        self.assertEqual(len(clusters), 6)
        banjara = clusters["Banjara Hills"]
        self.assertEqual(banjara["count"], 8)
        self.assertEqual(banjara["dominant_category"]["slug"], "pothole")
        self.assertEqual(banjara["dominant_category_slug"], "pothole")
        point = next(p for p in data["points"] if p["id"] == self.complaints["AS1"].pk)
        self.assertEqual(point["cluster"], banjara["cluster_id"])
        self.assertEqual(point["category"]["slug"], "pothole")
        self.assertEqual(set(point), {"id", "complaint_number", "latitude", "longitude", "category", "severity", "status",
                                      "cluster"})
        self.assertEqual([alert["id"] for alert in data["alerts"]],
                         [self.alerts[key].pk for key in ("HA2", "HA1", "HA3")])
        self.assertEqual(data["alerts"][0]["dominant_category"]["slug"], "garbage")
        self.assertFalse(data["points_truncated"])

    def test_hotspot_parameters_and_window_override_defaults(self):
        with mock.patch(ENGINE_PATH, side_effect=fake_dbscan) as engine:
            data = self.get_json("hotspots", self.admin, {"eps_m": 250, "min_samples": 4, "days": 30})
        self.assertEqual(engine.call_args.kwargs, {"eps_m": 250, "min_samples": 4, "thresholds": DEFAULT_THRESHOLDS})
        self.assertEqual(len(engine.call_args.args[0]), len(self.rows_where(lambda row: row.days <= 29)))
        self.assertEqual(data["window"]["days"], 30)
        with mock.patch(ENGINE_PATH, side_effect=fake_dbscan) as engine:
            self.get_json("hotspots", self.admin, {"category": "garbage", "status": "assigned,accepted"})
        self.assertEqual({p["id"] for p in engine.call_args.args[0]}, set(self.ids("AS3", "AS6", "AC3")))

    def test_officer_sees_only_department_and_assigned_complaints(self):
        with mock.patch(ENGINE_PATH, side_effect=fake_dbscan) as engine:
            self.get_json("hotspots", self.officers["roads1"])
        ids = {point["id"] for point in engine.call_args.args[0]}
        expected = {self.complaints[row.key].pk for row in ROWS
                    if row.days <= 89 and (row.category in ("pothole", "open_manhole") or row.officer == "roads1")}
        self.assertEqual(ids, expected)
        self.assertEqual(len(ids), 13)

    def test_engine_unavailable_returns_503(self):
        with mock.patch(ENGINE_PATH, side_effect=NotImplementedError("stub")):
            response = self.get("hotspots", self.admin)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["detail"], "Hotspot engine unavailable")

    def test_hotspot_map_with_real_engine(self):
        from ai.geospatial.hotspots import detect_hotspots

        try:
            detect_hotspots([], eps_m=400, min_samples=3)
        except NotImplementedError:
            self.skipTest("ai.geospatial.hotspots.detect_hotspots is still a stub (owner A3)")
        data = self.get_json("hotspots", self.admin)
        clusters = {cluster["area_name"]: cluster for cluster in data["clusters"]}
        banjara = clusters["Banjara Hills"]
        self.assertEqual(banjara["count"], 8)  # 7 open + 1 resolved complaint within ~150 m
        self.assertEqual(banjara["dominant_category"]["slug"], "pothole")
        self.assertEqual(set(banjara["complaint_ids"]), set(self.ids(*BANJARA_OPEN, "R1")))
        self.assertGreater(banjara["radius_m"], 0)
        labels = {point["id"]: point["cluster"] for point in data["points"]}
        self.assertTrue(all(labels[pk] == banjara["cluster_id"] for pk in self.ids(*BANJARA_OPEN)))
        json.dumps(data)  # plain JSON, no numpy values

    def test_empty_window_does_not_call_the_engine(self):
        with mock.patch(ENGINE_PATH, side_effect=AssertionError("must not be called")):
            data = self.get_json("hotspots", self.admin, {"date_from": "2001-01-01", "date_to": "2001-01-31"})
        self.assertEqual((data["clusters"], data["points"], data["total_points"]), ([], [], 0))

    def test_alert_list_and_acknowledge(self):
        data = self.get_json("alerts", self.admin)
        self.assertEqual([item["id"] for item in data], [self.alerts[key].pk for key in ("HA2", "HA1", "HA3")])
        self.assertEqual(set(data[0]), {"id", "cluster_key", "latitude", "longitude", "radius_m", "complaint_count",
                                        "dominant_category", "severity", "area_name", "complaint_ids",
                                        "is_acknowledged", "created_at"})
        self.assertEqual(data[0]["latitude"], 17.4376)
        self.assertEqual(len(self.get_json("alerts", self.admin, {"is_acknowledged": "false"})), 2)
        page = self.get_json("alerts", self.admin, {"page": 1, "page_size": 2})
        self.assertEqual((page["count"], page["total_pages"], len(page["results"])), (3, 2, 2))
        url = reverse("analytics:alert-detail", kwargs={"pk": self.alerts["HA2"].pk})
        self.client.force_authenticate(self.admin)
        response = self.client.patch(url, {"is_acknowledged": True}, format="json")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["is_acknowledged"])
        self.alerts["HA2"].refresh_from_db()
        self.assertTrue(self.alerts["HA2"].is_acknowledged)
        self.assertTrue(AuditLog.objects.filter(action="update", entity_type="HotspotAlert",
                                                entity_id=str(self.alerts["HA2"].pk)).exists())
        self.assertEqual(self.client.patch(url, {}, format="json").status_code, 400)
        missing = reverse("analytics:alert-detail", kwargs={"pk": 999999})
        self.assertEqual(self.client.patch(missing, {"is_acknowledged": True}, format="json").status_code, 404)
        self.client.force_authenticate(self.citizens["c1"])
        self.assertEqual(self.client.patch(url, {"is_acknowledged": False}, format="json").status_code, 403)


@mock.patch(NOTIFY_PATH)
class HotspotAlertServiceTests(AnalyticsDataMixin, TestCase):
    def test_alert_created_for_dense_cluster_and_admins_notified(self, notify):
        with mock.patch(ENGINE_PATH, side_effect=fake_dbscan) as engine:
            alert = services.check_hotspot_alert(self.complaints["AS1"])
        self.assertIsNotNone(alert)
        self.assertEqual({p["id"] for p in engine.call_args.args[0]}, set(self.ids(*BANJARA_OPEN)))
        self.assertEqual(engine.call_args.kwargs, {"eps_m": 400, "min_samples": 3, "thresholds": DEFAULT_THRESHOLDS})
        self.assertEqual(alert.complaint_count, 7)
        self.assertEqual(alert.area_name, "Banjara Hills")
        self.assertEqual(alert.dominant_category, self.categories["pothole"])
        self.assertEqual(alert.severity, "high")
        self.assertEqual(set(alert.complaint_ids), set(self.ids(*BANJARA_OPEN)))
        self.assertTrue(alert.cluster_key.endswith(":pothole"))
        notify.assert_called_once()
        kwargs = notify.call_args.kwargs
        self.assertEqual(kwargs["title"], "Hotspot alert: Banjara Hills")
        self.assertEqual((kwargs["notification_type"], kwargs["level"], kwargs["link"]),
                         ("hotspot_alert", "warning", "/admin/hotspots"))
        self.assertIn("7 open Roads / Potholes complaints", kwargs["message"])

    def test_same_hotspot_alerts_once_per_24_hours(self, notify):
        with mock.patch(ENGINE_PATH, side_effect=fake_dbscan):
            first = services.check_hotspot_alert(self.complaints["AS1"])
            self.assertIsNone(services.check_hotspot_alert(self.complaints["AS2"]))
            HotspotAlert.objects.filter(pk=first.pk).update(created_at=timezone.now() - timedelta(hours=25))
            again = services.check_hotspot_alert(self.complaints["AS2"])
        self.assertIsNotNone(again)
        self.assertEqual(HotspotAlert.objects.filter(dominant_category__slug="pothole").count(), 2)
        self.assertEqual(notify.call_count, 2)

    def test_no_alert_below_threshold_or_for_closed_complaints(self, notify):
        config = AIConfiguration.load()
        config.hotspot_alert_threshold = 8
        config.save()
        with mock.patch(ENGINE_PATH, side_effect=fake_dbscan) as engine:
            self.assertIsNone(services.check_hotspot_alert(self.complaints["AS1"]))
            engine.assert_not_called()  # only 7 candidate points: the threshold cannot be reached
            self.assertIsNone(services.check_hotspot_alert(self.complaints["R1"]))  # resolved complaint
        notify.assert_not_called()

    def test_never_raises(self, notify):
        before = HotspotAlert.objects.count()
        with mock.patch(ENGINE_PATH, side_effect=NotImplementedError):
            self.assertIsNone(services.check_hotspot_alert(self.complaints["AS1"]))
        with mock.patch(ENGINE_PATH, side_effect=RuntimeError("boom")):
            self.assertIsNone(services.check_hotspot_alert(self.complaints["AS1"]))
        with mock.patch(ENGINE_PATH, return_value={"clusters": "garbage"}):
            self.assertIsNone(services.check_hotspot_alert(self.complaints["AS1"]))
        self.assertIsNone(services.check_hotspot_alert(None))
        self.assertEqual(HotspotAlert.objects.count(), before)

    def test_notification_failure_does_not_block_the_alert(self, notify):
        notify.side_effect = NotImplementedError
        with mock.patch(ENGINE_PATH, side_effect=fake_dbscan):
            alert = services.check_hotspot_alert(self.complaints["AS1"])
        self.assertIsNotNone(alert)
        self.assertTrue(HotspotAlert.objects.filter(pk=alert.pk).exists())

    def test_city_wide_scan_task(self, notify):
        with mock.patch(ENGINE_PATH, side_effect=fake_dbscan) as engine:
            self.assertEqual(scan_hotspots(), 1)  # only Banjara Hills has >= 5 open complaints
            self.assertEqual(len(engine.call_args.args[0]), len(self.rows_where(lambda r: r.status in services.OPEN)))
            self.assertEqual(scan_hotspots(), 0)  # de-duplicated within 24 h
        self.assertEqual(HotspotAlert.objects.filter(area_name="Banjara Hills").count(), 1)
        with mock.patch(ENGINE_PATH, side_effect=NotImplementedError):
            self.assertEqual(scan_hotspots(), 0)
            with self.assertRaises(services.HotspotEngineUnavailable):
                scan_hotspots(raise_errors=True)

    def test_real_dbscan_engine(self, notify):
        from ai.geospatial.hotspots import detect_hotspots

        probe = [{"id": i, "latitude": 17.41 + i * 1e-4, "longitude": 78.44, "category": "pothole",
                  "category_name": "Pothole", "severity": "high", "severity_score": 60, "priority_score": 60,
                  "status": "assigned", "area": "Probe", "created_at": None} for i in range(3)]
        try:
            detect_hotspots(probe, eps_m=400, min_samples=3)
        except NotImplementedError:
            self.skipTest("ai.geospatial.hotspots.detect_hotspots is still a stub (owner A3)")
        alert = services.check_hotspot_alert(self.complaints["AS1"])
        self.assertIsNotNone(alert)
        self.assertEqual(alert.complaint_count, 7)
        self.assertEqual(set(alert.complaint_ids), set(self.ids(*BANJARA_OPEN)))


class RunChecksTests(AnalyticsDataMixin, APITestCase):
    def _fake_tasks_module(self, **attributes):
        module = types.ModuleType("apps.complaints.tasks")
        for name, value in attributes.items():
            setattr(module, name, value)
        return mock.patch.dict(sys.modules, {"apps.complaints.tasks": module})

    def test_run_checks_reports_counts(self):
        self.client.force_authenticate(self.admin)
        with self._fake_tasks_module(check_sla_breaches=lambda: 3), \
                mock.patch(ENGINE_PATH, side_effect=fake_dbscan), mock.patch(NOTIFY_PATH):
            response = self.client.post(reverse("analytics:run-checks"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"sla_alerts": 3, "hotspot_alerts": 1})
        self.assertTrue(AuditLog.objects.filter(action="other", entity_id="run-checks").exists())

    def test_run_checks_tolerates_unfinished_services(self):
        def not_ready():
            raise NotImplementedError

        self.client.force_authenticate(self.admin)
        with self._fake_tasks_module(check_sla_breaches=not_ready), \
                mock.patch(ENGINE_PATH, side_effect=NotImplementedError):
            data = self.client.post(reverse("analytics:run-checks")).json()
        self.assertEqual((data["sla_alerts"], data["hotspot_alerts"]), (0, 0))
        self.assertEqual(data["errors"]["hotspot_scan"], "Hotspot engine unavailable")
        self.assertIn("sla_check", data["errors"])

    def test_sla_result_normalisation(self):
        from apps.analytics.views import _sla_alert_count

        self.assertEqual(_sla_alert_count(4), 4)
        self.assertEqual(_sla_alert_count([1, 2]), 2)
        self.assertEqual(_sla_alert_count({"alerts": 5}), 5)
        self.assertEqual(_sla_alert_count({"notified": [1, 2, 3]}), 3)
        self.assertEqual(_sla_alert_count(None), 0)
        self.assertEqual(_sla_alert_count("unexpected"), 0)


class ReportTests(AnalyticsDataMixin, APITestCase):
    def test_json_previews(self):
        summary = self.get_json("reports", self.admin, {"report": "summary"})
        self.assertEqual(summary["report"], "summary")
        self.assertEqual(summary["title"], "CivicAI - Summary report")
        self.assertEqual(summary["summary"]["total_complaints"], 40)
        metrics = {(row["section"], row["metric"]): row["value"] for row in summary["rows"]}
        self.assertEqual(metrics[("Complaints", "Total complaints")], 40)
        self.assertEqual(metrics[("Performance", "SLA compliance (%)")], 62.5)
        self.assertEqual(metrics[("Department", "Roads Department")], 14)
        complaints = self.get_json("reports", self.admin, {"report": "complaints", "limit": 5})
        self.assertEqual((len(complaints["rows"]), complaints["total_rows"], complaints["truncated"]), (5, 40, True))
        self.assertEqual(complaints["columns"][0], {"key": "complaint_number", "label": "Complaint No."})
        first = complaints["rows"][0]
        self.assertEqual(first["complaint_number"], self.complaints["S3"].complaint_number)  # newest complaint
        self.assertEqual(first["status"], "Submitted")
        roads = self.get_json("reports", self.admin, {"report": "complaints", "department": "ROADS"})
        self.assertEqual(roads["total_rows"], 14)
        self.assertEqual(roads["filters"]["department"], self.departments["ROADS"].pk)
        resolved_row = next(row for row in roads["rows"] if row["complaint_number"] == self.complaints["R1"].complaint_number)
        self.assertEqual(resolved_row["resolution_hours"], 10.0)
        self.assertEqual(resolved_row["officer"], "Anil Rao")
        departments = self.get_json("reports", self.admin, {"report": "departments"})
        self.assertEqual([row["code"] for row in departments["rows"]], ["ROADS", "WASTE", "DRAIN", "ELEC", "PARKS"])
        officers = self.get_json("reports", self.admin, {"report": "officers"})
        self.assertEqual(officers["rows"][2]["utilization"], 62.5)
        with mock.patch(KEYWORDS_PATH, side_effect=NotImplementedError):
            feedback = self.get_json("reports", self.admin, {"report": "feedback"})
        self.assertEqual(feedback["total_rows"], 10)
        self.assertEqual(feedback["summary"]["satisfaction_rate"], 50.0)
        self.assertFalse(AuditLog.objects.filter(action="export").exists())  # previews are not exports

    def test_csv_export(self):
        response = self.get("reports", self.admin, {"report": "complaints", "format": "csv"})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response["Content-Type"].startswith("text/csv"))
        self.assertEqual(response["Content-Disposition"],
                         f'attachment; filename="civicai-complaints-{self.today.isoformat()}.csv"')
        self.assertTrue(response.content.startswith(b"\xef\xbb\xbf"))
        rows = list(csv.reader(io.StringIO(response.content.decode("utf-8-sig"))))
        self.assertEqual(rows[0][:3], ["Complaint No.", "Submitted", "Title"])
        self.assertEqual(len(rows), 41)
        log = AuditLog.objects.get(action="export")
        self.assertEqual((log.entity_type, log.entity_id, log.actor), ("report", "complaints", self.admin))
        self.assertEqual(log.changes["format"], "csv")

    def test_csv_neutralises_formula_injection(self):
        Complaint.objects.filter(pk=self.complaints["S3"].pk).update(title="=HYPERLINK(\"http://evil\")")
        response = self.get("reports", self.admin, {"report": "complaints", "format": "csv"})
        rows = list(csv.reader(io.StringIO(response.content.decode("utf-8-sig"))))
        self.assertEqual(rows[1][2], "'=HYPERLINK(\"http://evil\")")

    def test_pdf_export(self):
        response = self.get("reports", self.admin, {"report": "departments", "format": "pdf"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Content-Type"], "application/pdf")
        self.assertEqual(response["Content-Disposition"],
                         f'attachment; filename="civicai-departments-{self.today.isoformat()}.pdf"')
        self.assertTrue(response.content.startswith(b"%PDF"))
        self.assertGreater(len(response.content), 1500)
        self.assertTrue(AuditLog.objects.filter(action="export", entity_id="departments").exists())

    def test_every_report_renders_in_every_format(self):
        with mock.patch(KEYWORDS_PATH, side_effect=NotImplementedError):
            for report in REPORT_TYPES:
                for output in ("csv", "pdf"):
                    with self.subTest(report=report, format=output):
                        response = self.get("reports", self.admin, {"report": report, "format": output})
                        self.assertEqual(response.status_code, 200)
                        self.assertGreater(len(response.content), 100)
        self.assertEqual(set(reports.REPORTS), set(REPORT_TYPES))

    def test_pdf_with_no_rows_and_many_pages(self):
        empty = self.get("reports", self.admin, {"report": "complaints", "format": "pdf", "date_from": "2001-01-01",
                                                 "date_to": "2001-01-02"})
        self.assertEqual(empty.status_code, 200)
        self.assertTrue(empty.content.startswith(b"%PDF"))
        filters = AnalyticsFilters()
        report = reports.build_report("complaints", filters, limit=1000)
        report.rows = report.rows * 10  # 400 rows -> several pages with a repeated header
        report.total_rows = len(report.rows)
        pdf = reports.render_pdf(report)
        self.assertTrue(pdf.startswith(b"%PDF"))
        self.assertGreaterEqual(len(re.findall(rb"/Type /Page[^s]", pdf)), 2)  # page objects, not the /Pages tree


class EmptyDatabaseTests(APITestCase):
    """Empty platform: every endpoint answers with zeros / empty lists - never errors or NaN."""

    @classmethod
    def setUpTestData(cls):
        cls.admin = User.objects.create_user("solo@civicai.test", "pass12345", first_name="Solo", role=User.Role.ADMIN)

    def test_all_endpoints_with_no_data(self):
        self.client.force_authenticate(self.admin)
        with mock.patch(ENGINE_PATH, side_effect=AssertionError("engine must not run without points")):
            for name in ("dashboard", "overview", "categories", "departments", "trends", "sentiment", "officers", "ai",
                         "public", "hotspots", "alerts", "reports"):
                with self.subTest(name=name):
                    response = self.client.get(reverse(f"analytics:{name}"))
                    self.assertEqual(response.status_code, 200, response.content[:300])
                    self.assertNotIn(b"NaN", response.content)
        overview = self.client.get(reverse("analytics:overview")).json()
        self.assertEqual(set(overview["totals"].values()), {0})
        self.assertEqual((overview["avg_resolution_hours"], overview["avg_rating"], overview["satisfaction_rate"]),
                         (0.0, 0.0, 0.0))
        self.assertEqual(overview["recent_critical"], [])
        trends = self.client.get(reverse("analytics:trends")).json()
        self.assertEqual(len(trends["series"]), 90)
        self.assertEqual(trends["categories"], [])
        sentiment = self.client.get(reverse("analytics:sentiment")).json()
        self.assertEqual((sentiment["total_feedback"], sentiment["positive_pct"]), (0, 0.0))
        self.assertEqual(sentiment["top_keywords"], {"positive": [], "negative": []})
        ai = self.client.get(reverse("analytics:ai")).json()
        self.assertEqual((ai["total_predictions"], ai["avg_confidence"], ai["duplicates"]["precision"]), (0, 0.0, 0.0))
        public = self.client.get(reverse("analytics:public")).json()
        self.assertEqual((public["total_complaints"], public["resolution_rate"], public["recent_resolved"]), (0, 0.0, []))
        for report in REPORT_TYPES:
            for output in ("csv", "pdf"):
                with self.subTest(report=report, format=output):
                    self.assertEqual(self.client.get(reverse("analytics:reports"),
                                                     {"report": report, "format": output}).status_code, 200)
        with mock.patch.dict(sys.modules, {"apps.complaints.tasks": types.SimpleNamespace(check_sla_breaches=lambda: 0)}):
            checks = self.client.post(reverse("analytics:run-checks")).json()
        self.assertEqual(checks, {"sla_alerts": 0, "hotspot_alerts": 0})


class HelperTests(SimpleTestCase):
    def test_percentages_sum_to_100(self):
        self.assertEqual(services.percentages([1, 1, 1]), [33.4, 33.3, 33.3])
        self.assertEqual(services.percentages([5, 2, 3]), [50.0, 20.0, 30.0])
        self.assertEqual(services.percentages([0, 0, 0]), [0.0, 0.0, 0.0])
        self.assertAlmostEqual(sum(services.percentages([7, 5, 1])), 100.0)

    def test_clean_json_removes_nan_and_numpy(self):
        import numpy as np

        cleaned = services.clean_json({"a": float("nan"), "b": np.int64(3), "c": [np.float64(1.5), float("inf")],
                                       np.int64(7): np.bool_(True)})
        self.assertEqual(cleaned, {"a": 0.0, "b": 3, "c": [1.5, 0.0], 7: True})
        self.assertEqual(json.loads(json.dumps(cleaned)), {"a": 0.0, "b": 3, "c": [1.5, 0.0], "7": True})

    def test_bucket_helpers(self):
        self.assertEqual(services.bucket_range(date(2026, 10, 1), date(2026, 10, 3), "day"),
                         [date(2026, 10, 1), date(2026, 10, 2), date(2026, 10, 3)])
        self.assertEqual(services.bucket_range(date(2026, 10, 1), date(2026, 10, 14), "week"),
                         [date(2026, 9, 28), date(2026, 10, 5), date(2026, 10, 12)])
        self.assertEqual(services.bucket_range(date(2026, 11, 20), date(2027, 1, 5), "month"),
                         [date(2026, 11, 1), date(2026, 12, 1), date(2027, 1, 1)])
        self.assertEqual(services.bucket_label(date(2026, 10, 1), "day"), "Oct 1")
        self.assertEqual(services.bucket_label(date(2026, 10, 1), "month"), "Oct 2026")
        # 2026-10-17 20:00 UTC is already 2026-10-18 01:30 in Asia/Kolkata
        with self.settings(TIME_ZONE="Asia/Kolkata"):
            local = services.to_local([datetime(2026, 10, 17, 20, 0, tzinfo=dt_timezone.utc), None])
            self.assertTrue(local.isna().iloc[1])
            self.assertEqual(list(services.bucket_dates(local.dropna(), "day")), [date(2026, 10, 18)])
            self.assertEqual(list(services.bucket_dates(local.dropna(), "week")), [date(2026, 10, 12)])
            self.assertEqual(list(services.bucket_dates(local.dropna(), "month")), [date(2026, 10, 1)])

    def test_resolve_window(self):
        today = services.local_today()
        self.assertEqual(services.resolve_window(AnalyticsFilters(), 7), (today - timedelta(days=6), today))
        window = AnalyticsFilters(date_from=date(2026, 1, 1), date_to=date(2026, 1, 31))
        self.assertEqual(services.resolve_window(window, 90), (date(2026, 1, 1), date(2026, 1, 31)))


class FallbackShapeTests(AnalyticsDataMixin, TestCase):
    """The local fallbacks emit exactly the BUILD_SPEC 4.1 shapes."""

    def test_complaint_shapes(self):
        complaint = local_list_queryset(Complaint.objects.filter(pk=self.complaints["AS1"].pk)).get()
        data = _local_complaint_list(complaint)
        self.assertEqual(set(data), {
            "id", "complaint_number", "title", "description", "category", "status", "status_display", "severity",
            "severity_score", "priority_score", "priority_level", "department", "assigned_officer", "citizen",
            "location", "thumbnail", "duplicate_count", "has_pending_duplicates", "is_overdue", "sla_due_at",
            "ai_is_demo", "ai_confidence", "needs_manual_review", "created_at", "updated_at", "resolved_at",
        })
        self.assertEqual(set(data["location"]), {"latitude", "longitude", "address", "landmark", "area", "city", "pincode"})
        self.assertEqual(set(data["citizen"]), {"id", "full_name", "email", "role", "avatar", "phone"})
        self.assertEqual(set(data["department"]), {"id", "name", "code", "icon", "color"})
        self.assertEqual(data["ai_confidence"], 0.85)
        self.assertTrue(data["is_overdue"])
        s1 = local_list_queryset(Complaint.objects.filter(pk=self.complaints["S1"].pk)).get()
        self.assertTrue(_local_complaint_list(s1)["has_pending_duplicates"])
        self.assertEqual(_local_complaint_list(Complaint.objects.get(pk=s1.pk))["ai_confidence"], None)
        self.assertEqual(set(_local_complaint_mini(complaint)), {
            "id", "complaint_number", "title", "description", "status", "status_display", "category", "thumbnail",
            "created_at", "location", "priority_score", "priority_level", "severity",
        })
        self.assertEqual(set(_local_category_mini(self.categories["pothole"])), {"id", "name", "slug", "icon", "color"})

    def test_other_shapes(self):
        officer = _local_officer_mini(self.officers["roads1"])
        self.assertEqual(set(officer), {"id", "full_name", "email", "role", "avatar", "phone", "employee_id",
                                        "designation", "zone", "department", "is_available"})
        event = _local_timeline_event(self.events["E4"])
        self.assertEqual(set(event), {"id", "event", "event_display", "old_status", "new_status", "changed_by",
                                      "actor_label", "remarks", "metadata", "is_public", "timestamp"})
        self.assertEqual(event["actor_label"], "Anil Rao (Officer)")
        feedback = _local_feedback(Feedback.objects.select_related("complaint").first())
        self.assertEqual(set(feedback), {"id", "complaint", "complaint_number", "complaint_title", "citizen", "rating",
                                         "text", "sentiment", "sentiment_display", "sentiment_score",
                                         "sentiment_confidence", "sentiment_model", "is_demo", "department",
                                         "category", "created_at"})
        notification = _local_notification(Notification.objects.select_related("complaint").first())
        self.assertEqual(set(notification), {"id", "title", "message", "notification_type", "type_display", "level",
                                             "complaint", "complaint_number", "link", "is_read", "read_at",
                                             "created_at"})

    def test_serialize_shared_falls_back(self):
        category = self.categories["garbage"]
        with mock.patch("apps.analytics.serializers.shared_serializer", return_value=None):
            self.assertEqual(serialize_shared("category_mini", category), _local_category_mini(category))
        broken = mock.Mock(side_effect=RuntimeError("serializer bug"))
        with mock.patch("apps.analytics.serializers.shared_serializer", return_value=broken):
            self.assertEqual(serialize_shared("category_mini", category), _local_category_mini(category))
        self.assertIsNone(serialize_shared("category_mini", None))


class QueryCountTests(AnalyticsDataMixin, APITestCase):
    """Aggregations run in the database: the number of SQL queries does not grow with the rows."""

    def test_endpoints_do_not_query_per_row(self):
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        calls = [("overview", self.admin), ("categories", self.admin), ("departments", self.admin),
                 ("officers", self.admin), ("trends", self.admin), ("sentiment", self.admin), ("ai", self.admin),
                 ("public", None), ("dashboard", self.citizens["c1"]), ("dashboard", self.officers["roads1"])]
        with mock.patch(KEYWORDS_PATH, side_effect=NotImplementedError):
            for name, user in calls:
                with self.subTest(name=name, user=getattr(user, "email", None)):
                    with CaptureQueriesContext(connection) as queries:
                        self.get_json(name, user)
                    self.assertLess(len(queries), 40, [q["sql"][:120] for q in queries.captured_queries])
