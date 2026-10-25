"""``python manage.py seed_demo`` - a realistic CivicAI demo dataset produced by the REAL platform.

Nothing is written behind the platform's back. Every complaint is submitted through
``apps.complaints.services.submission.submit_complaint`` exactly like ``POST /api/complaints/`` does (the form is
validated by ``ComplaintCreateSerializer`` and the photo is a real JPEG upload), so the AI engine computes every
category, severity, priority, duplicate flag, department routing and officer recommendation. The lifecycle then
runs through the real services - ``accept_complaint`` -> ``start_work`` -> ``upload_evidence`` ->
``resolve_complaint`` (automatic AI before/after verification) -> ``manual_verification`` -> ``submit_feedback``
(sentiment analysis) -> ``reopen_complaint``, plus ``reject_complaint``, ``review_duplicate`` and
``assign_officer`` - and finally ``check_sla_breaches()`` and ``scan_hotspots()`` run.

How the history is back-dated
    The data spans the last ``--days`` days, but the services stamp their rows with ``timezone.now()``. The seeder
    therefore replays the history as a *discrete-event simulation* under a simulated clock (freezegun-style):
    events (submissions, acceptances, resolutions, reviews, feedback ...) wait in a priority queue ordered by
    their simulated time and run in that order. While an event runs, ``django.utils.timezone.now`` returns the
    event's simulated moment plus the real time elapsed inside the event, and every row whose timestamp field
    defaults to ``timezone.now`` is stamped with that time when it is inserted. Complaint, timeline, AI
    prediction, priority, assignment, evidence, verification, feedback, notification, audit and hotspot rows
    are therefore consistent by construction, and the services apply their own time-based rules (30-day
    duplicate window, nearby-complaint frequency, SLA due dates via ``compute_sla_due()``, the reopen window,
    hotspot windows, officer workload at assignment time) as they would have at that moment. A final check
    recomputes every ``sla_due_at`` with ``compute_sla_due()`` and fails loudly if any wall-clock timestamp
    leaked into the history.

The demo city: a functioning municipality in steady state
    * Arrivals are steady: report dates are stratified samples of a smooth arrival rate that grows gently as more
      citizens join (the rate at the end is ``1 + ADOPTION_GROWTH`` times the rate at the start) and is a little
      higher in the monsoon months - about a fifth of the reports fall in the last 30 days. Reports with a planned
      date (the showcase stories below, storm bursts, re-reports) replace nearby regular arrivals instead of
      piling up on top of them.
    * Work keeps pace: officers accept a report within hours and fix most within its SLA (the real SLA, which
      the AI's category and priority determine); a minority is late. Every story simply runs until the end of
      the history, so what is still open at the end is what a steady flow leaves open: the last days' reports,
      a few late jobs and the showcase cases. The weekly "submitted" and "resolved" lines therefore track each
      other with a lag of a day or two.
    * Priority varies with what citizens describe and where (``demo.TONE_WEIGHTS``): routine requests from
      residential lanes ("the bin is full again", a flickering lamp) score low, hazards described on busy roads
      and near hospitals, schools and stations score high - always computed by the AI engine from the text,
      photo and place.
    * A few short bursts of reports after storms (``demo.EVENTS``) raise DBSCAN hotspot alerts, and other citizens
      re-report some issues (deliberate duplicates flagged by the engine, reviewed by the administrator).
    * Showcase stories: the main demo citizen's complaints in every state; a critical open manhole near the
      Ameerpet metro station, re-reported by two citizens and overdue (the SLA alerts point at it); a resolution
      the AI could not confirm, waiting for the administrator's manual review; roads.officer1 with a mixed open
      queue.

Options
    --complaints N   number of complaints (default 160, including the deliberate re-reports)
    --days D         length of the history in days (default 180)
    --seed S         random seed (default 42) - the same seed rebuilds the same dataset, relative to the end of
                     the history (pin that with --anchor for an exact copy)
    --reset          delete everything a previous run created first (accounts ``@civicai.local`` and their
                     complaints, feedback, notifications, assignments, audit rows, hotspot alerts and uploaded
                     media); reference data (departments, categories, AI settings, risk zones) is kept
    --quiet          print a single result line instead of the progress, summary and credentials
    --anchor T       end of the simulated history (ISO date-time, default 20 minutes ago); with --seed it
                     reproduces a dataset exactly

Demo logins (also printed at the end): admin@civicai.local / Admin@12345, <dept>.officer<n>@civicai.local /
Officer@12345 (e.g. roads.officer1), citizen@civicai.local and citizen1..citizen15@civicai.local / Citizen@12345.
"""
import bisect
import heapq
import io
import itertools
import json
import logging
import math
import os
import random
import re
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from unittest import mock

from django.conf import settings
from django.core.files.storage import default_storage
from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.management import call_command
from django.core.management.base import BaseCommand, CommandError
from django.db import models, transaction
from django.db.models import Count, Max, Q
from django.db.models.signals import pre_save
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from django.utils.timezone import now as real_now

from ai.config import get_model_mode
from apps.accounts.models import CitizenProfile, User
from apps.analytics.models import HotspotAlert
from apps.assignments.models import ComplaintAssignment
from apps.audit.models import AuditLog
from apps.audit.services import log_action
from apps.complaints.models import (
    AIPrediction,
    Complaint,
    ComplaintImage,
    DuplicateComplaint,
    Level,
    Location,
    PriorityScore,
    ResolutionEvidence,
    ResolutionVerification,
    StatusHistory,
)
from apps.core import demo_data as demo
from apps.core.utils import haversine_m
from apps.departments.models import Department
from apps.feedback.models import Feedback
from apps.notifications.models import Notification
from apps.officers.models import OfficerProfile

logger = logging.getLogger("apps.core")

S = Complaint.Status
D = DuplicateComplaint.Status
SAMPLE_IMAGES = Path(settings.BASE_DIR) / "sample_data" / "images"
REAL_SAMPLE_IMAGES = Path(settings.BASE_DIR) / "sample_data" / "real_images"
#: Order of the annotated severity of a real photo when photos are ranked by defect size (generated photos have
#: none: they rank by box area alone).
PHOTO_SEVERITY_ORDER = {"minor": 0, "standard": 1, "severe": 2}
DEMO_DOMAIN = f"@{demo.DEMO_EMAIL_DOMAIN}"
MIN_COMPLAINTS = 12

# Shape of the dataset (shares of --complaints)
HOTSPOT_SHARE = 0.6          # reports around the hotspot centres; the rest is scattered over other localities
PHOTO_SHARE = 0.85
REJECTED_SHARE = 0.05
REOPENED_SHARE = 0.04        # reopened by the citizen within the reopen window, then reworked by the officer
ANGLE_SHARE = 0.025          # after photo from another position -> the AI asks for a manual review
SENT_BACK_SHARE = 0.02       # premature resolution -> AI "not resolved" -> the admin sends the work back
#: Resolutions the AI before/after comparison verifies. Real photos have no repaired shot of the same spot, so these
#: stories - like the angle, sent-back and review-pending ones - use a generated scene (``SamplePhotos.generated``).
AI_VERIFIED_SHARE = 0.05
DUPLICATE_SHARE = 12 / 160   # deliberate re-reports of an existing complaint
FEEDBACK_RATE = 0.72         # resolved complaints whose citizen gives feedback
#: Planned resolution times: inside the SLA with this probability (the real SLA compliance is measured, and is a
#: little lower because reworks after a reopen and storm backlogs finish late), as a share of the SLA hours.
WITHIN_SLA_RATE = 0.83
WITHIN_SLA_FRACTION = (0.3, 0.92)
LATE_SLA_FRACTION = (1.1, 2.2)
ORIGINAL_SLA_CAP = 0.7       # a re-reported complaint may move up a priority level (shorter SLA): plan with margin
MAX_RESOLUTION_HOURS = 8 * 24
#: Arrivals: a steady flow that grows gently as more citizens join the platform (the daily rate at the end of the
#: history is 1 + ADOPTION_GROWTH times the rate at its start), a little busier in the monsoon months
#: (Hyderabad: south-west monsoon June-September, retreating-monsoon rains in October) and on weekdays, with a
#: mild week-to-week variation (log-normal factor per week, sigma WEEKLY_NOISE).
ADOPTION_GROWTH = 0.6
MONTH_VOLUME = {1: 0.9, 2: 0.88, 3: 0.86, 4: 0.86, 5: 0.88, 6: 0.98, 7: 1.08, 8: 1.12, 9: 1.12, 10: 1.1, 11: 0.98,
                12: 0.92}
WEEKDAY_VOLUME = (1.1, 1.06, 1.04, 1.0, 0.98, 0.94, 0.88)  # Monday ... Sunday
WEEKLY_NOISE = 0.1
#: A report with a planned date (showcase story, storm burst, re-report) takes the place of one of the nearest
#: regular arrivals (nearest first: rank -> weight, within SLOT_WINDOW_DAYS), so planned reports do not pile up
#: on top of the steady flow.
SLOT_WINDOW_DAYS = 14.0
SLOT_RANK_WEIGHTS = {0: 3, 1: 3, 2: 2, 3: 2, 4: 1, 5: 1, 6: 1}
EVENTS_MIN_COMPLAINTS = 100  # storm bursts (demo.EVENTS) only in datasets of at least this many complaints
#: Re-reports arrive this share of the category SLA after the original (while it is usually still open) and the
#: administrator reviews the flagged pair this share of the SLA later (hours, clamped below).
RE_REPORT_SLA_SHARE = (0.1, 0.35)
RE_REPORT_HOURS = (1.5, 20.0)
REVIEW_SLA_SHARE = (0.03, 0.12)
REVIEW_HOURS = (0.5, 6.0)
REVIEW_PENDING_HOURS = (5.0, 20.0)  # the manual-review case was resolved this long before the end
#: How a citizen of each tone describes the place: the chance of a quiet residential street (demo.QUIET_PLACES)
#: instead of a busy spot (main roads, stations, markets), and which sample photo they take (defect size).
QUIET_STREET_CHANCE = {"minor": 0.85, "standard": 0.3, "severe": 0.0}
PHOTO_TIER = {"minor": "small", "standard": None, "severe": "large"}
HOTSPOT_JITTER_M = 250
LOCALITY_JITTER_M = 500
REUSE_WINDOW_DAYS = 35       # a photo / place is not reused nearby inside this window (avoids accidental duplicates)
REUSE_RADIUS_M = 600
LEAVE_DAYS_AGO = 9           # the officer marked unavailable went on leave this many days ago
EVENTS_PER_COMMIT = 12       # events committed together (each one still runs in its own savepoint)
ANCHOR_MARGIN = timedelta(minutes=20)  # the simulated history ends this long before the run started
ACK_ALERTS_OLDER_THAN = timedelta(days=3)  # older hotspot alerts were acknowledged by the admin

#: Citizens report mostly in the morning and in the evening (local time).
REPORT_HOURS = {0: 1, 1: 1, 2: 1, 3: 1, 4: 1, 5: 2, 6: 5, 7: 9, 8: 13, 9: 14, 10: 12, 11: 10, 12: 9, 13: 8, 14: 8,
                15: 8, 16: 10, 17: 13, 18: 15, 19: 15, 20: 13, 21: 9, 22: 5, 23: 3}

#: The main demo citizen's complaints: (outcome, age in days, category, hotspot, with photo). The first five cover
#: every outcome, so small datasets keep them. The open ones are recent and inside their SLA; the reopened pothole
#: was patched within hours, opened up again and is waiting for the officer.
MAIN_CITIZEN_PLAN = [
    ("pending", 0.35, "streetlight", "ameerpet", False),
    ("in_progress", 1.7, "pothole", "ameerpet", True),
    ("awaiting_feedback", 9.5, "garbage", "ameerpet", True),
    ("closed", 21.0, "water_leak", "banjara_hills", True),
    ("reopened", 1.1, "pothole", "banjara_hills", True),
    ("accepted", 1.2, "road_crack", "banjara_hills", True),
    ("closed", 33.0, "streetlight", "banjara_hills", True),
    ("awaiting_feedback", 17.5, "pothole", "banjara_hills", True),
    ("closed", 47.0, "drainage", "ameerpet", True),
    ("closed", 96.0, "fallen_tree", "banjara_hills", True),
]

#: Hazardous reports inside seeded risk zones (apps.departments.defaults.DEFAULT_RISK_ZONES) re-reported by other
#: citizens - the situation in which the AI escalates a complaint to critical priority.
#: * The Ameerpet manhole is still being fixed (barricaded, a new cover on order): overdue critical work that the
#:   SLA alerts point at. Another citizen re-reported it the same evening and a third one this morning; both
#:   re-reports wait for the duplicate review.
#: * The Secunderabad manhole was covered within its SLA after the administrator merged two re-reports; days later
#:   the new cover broke and the citizen reopened it - the reopened complaint is re-prioritised (critical) and
#:   fixed again.
#: * The fallen tree at Osmania General Hospital was reported this morning and is waiting for the officer.
#: ``photo`` is the preferred sample photo (the engine's most severe one); another photo is used if it is missing.
#: Each re-report arrives ``after_hours`` after the original or ``before_end_hours`` before the end of the
#: history; ``review`` is the administrator's decision ``review_hours`` later (None: still waiting for the review).
CRITICAL_PLAN = [
    {"outcome": "in_progress", "age": 1.6, "slug": "open_manhole", "hotspot": "ameerpet",
     "latitude": 17.43562, "longitude": 78.44491, "landmark": "Ameerpet Metro Station", "road": "Ameerpet Main Road",
     "hazard": 1, "photo": "open_manhole_01",
     "re_reports": [{"after_hours": (5.0, 14.0)}, {"before_end_hours": (1.0, 5.0)}]},
    {"outcome": "reopened", "rework": True, "age": 17.0, "slug": "open_manhole", "hotspot": "secunderabad",
     "latitude": 17.43401, "longitude": 78.50188, "landmark": "Secunderabad Railway Station", "road": "Station Road",
     "hazard": 3, "photo": "open_manhole_08",
     "re_reports": [{"after_hours": (0.8, 2.0), "review": "confirmed_duplicate", "review_hours": (0.4, 1.0)},
                    {"after_hours": (1.5, 3.0), "review": "confirmed_duplicate", "review_hours": (0.3, 0.8)}]},
    {"outcome": "pending", "age": 0.3, "slug": "fallen_tree", "hotspot": None, "area": "Afzal Gunj",
     "pincode": "500012", "latitude": 17.37321, "longitude": 78.47452, "landmark": "Osmania General Hospital",
     "road": "Afzal Gunj Main Road", "hazard": 6, "photo": "fallen_tree_05", "re_reports": []},
]
#: A critical hazard is fixed well inside its SLA (planned share of the SLA hours at most this).
CRITICAL_SLA_CAP = 0.6
#: Words of a busy place in an address (main roads, stations, markets, hospitals, schools): severe hazards are
#: reported where people and traffic are, routine requests mostly from residential lanes.
BUSY_PLACE = re.compile(r"\b(main road|highway|nh \d+|junction|x roads|circle|signal|flyover|bus (stop|stand|station|"
                        r"depot)|metro|railway|market|bazaar|hospital|school|college)\b", re.IGNORECASE)

#: Hours that must remain after the resolution of a showcase report for the follow-ups of its outcome (a reopened
#: story that is reworked needs days: the reopen, the second fix and the rating).
FOLLOW_UP_HOURS = {"awaiting_feedback": 0.2, "closed": 2.0, "reopened": 6.0, "reworked": 30.0}
SHOWCASE_ROLES = ("main", "critical")
WORKING_STATUSES = [S.ASSIGNED, S.ACCEPTED, S.IN_PROGRESS]


# ---------------------------------------------------------------------------------------------------------------
# Simulated clock
# ---------------------------------------------------------------------------------------------------------------
class SimulatedClock:
    """freezegun-style clock: inside ``at(moment)`` ``django.utils.timezone.now()`` returns ``moment`` plus the real
    time elapsed in the block, and inserted rows whose DateTimeField defaults to ``timezone.now`` (created_at,
    timestamp, assigned_at, verified_at ...) get that simulated time instead of the wall clock.

    ``installed()`` patches ``django.utils.timezone.now`` (every service calls it through the module, and
    ``auto_now`` fields use it too) and connects a ``pre_save`` receiver for the field defaults, which Django
    resolves to the original function object when a model instance is created.

    Simulated time never runs backwards in execution order (a high-water mark): a block that asks for a moment
    earlier than a time already handed out starts at that time instead. Rows are therefore stamped in the order
    they are inserted, so every complaint's timeline reads chronologically even when an event of one complaint
    (a re-report, a duplicate review) writes to another one.
    """

    DISPATCH_UID = "civicai.seed_demo.simulated_clock"

    def __init__(self):
        self._moment = None  # simulated start of the active block
        self._started = None  # wall-clock start of the active block
        self._high_water = None  # latest simulated time handed out
        self._default_fields = {}

    def now(self):
        if self._moment is None:
            return real_now()
        value = self._moment + (real_now() - self._started)
        if self._high_water is None or value > self._high_water:
            self._high_water = value
        return value

    @contextmanager
    def installed(self):
        with mock.patch.object(timezone, "now", self.now):
            pre_save.connect(self._stamp_defaults, weak=False, dispatch_uid=self.DISPATCH_UID)
            try:
                yield self
            finally:
                pre_save.disconnect(dispatch_uid=self.DISPATCH_UID)

    @contextmanager
    def at(self, moment):
        """Run the block at ``moment`` (or at the high-water mark when that is later); yields the start used."""
        previous = (self._moment, self._started)
        if self._high_water is not None and moment < self._high_water:
            moment = self._high_water
        self._moment, self._started = moment, real_now()
        try:
            yield moment
        finally:
            if previous[0] is None:
                self._moment, self._started = previous
            else:  # the enclosing block resumes after everything handed out inside this one
                resumed = previous[0] + (real_now() - previous[1])
                self._moment, self._started = max(resumed, self._high_water or resumed), real_now()

    def _stamp_defaults(self, sender, instance, raw=False, **kwargs):
        if self._moment is None or raw or not instance._state.adding:
            return
        for name in self._fields_with_now_default(sender):
            value = getattr(instance, name, None)
            if value is not None and value >= self._started:  # the default fired with the wall clock
                setattr(instance, name, self.now())

    def _fields_with_now_default(self, model):
        names = self._default_fields.get(model)
        if names is None:
            names = [f.attname for f in model._meta.concrete_fields
                     if isinstance(f, models.DateTimeField) and f.default is real_now]
            self._default_fields[model] = names
        return names


# ---------------------------------------------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------------------------------------------
def hours(value):
    return timedelta(hours=value)


def hours_between(start, end):
    return (end - start).total_seconds() / 3600.0


def offset_point(latitude, longitude, distance, bearing):
    """(lat, lng) ``distance`` metres away from a point (flat-earth approximation, exact enough below 2 km)."""
    dlat = distance * math.cos(bearing) / 111_320.0
    dlng = distance * math.sin(bearing) / (111_320.0 * math.cos(math.radians(latitude)))
    return latitude + dlat, longitude + dlng


def weighted_choice(rng, weights):
    """Key of ``weights`` ({key: weight}) drawn proportionally to its weight."""
    keys = list(weights)
    return rng.choices(keys, weights=[weights[key] for key in keys], k=1)[0]


def sample_weighted(rng, items, weight, k):
    """``k`` items without replacement, probability proportional to ``weight(item)`` (Efraimidis-Spirakis keys)."""
    keyed = sorted(items, key=lambda item: rng.random() ** (1.0 / max(weight(item), 1e-9)), reverse=True)
    return keyed[:max(0, k)]


def default_sla_hours():
    """{category slug: SLA hours} of the default reference data (the category's own SLA, else its department's).
    The planner only uses them to time re-reports and reviews; every lifecycle follows the complaint's real SLA."""
    from apps.departments.defaults import DEFAULT_CATEGORIES, DEFAULT_DEPARTMENTS

    departments = {spec["code"]: spec["sla_hours"] for spec in DEFAULT_DEPARTMENTS}
    return {spec["slug"]: spec.get("sla_hours") or departments.get(spec["department"]) or 72
            for spec in DEFAULT_CATEGORIES}


class SamplePhotos:
    """The sample photos per category: issue photo, repaired "after" photo of the same scene and an "unchanged"
    re-shot of it. Citizens photograph the real photographs of a category (``sample_data/real_images``, see
    ``scripts/import_real_photos.py``), else its generated photos (``sample_data/images``): ``by_label``. Real
    photos have an "after" photo only when one of the same spot was imported and never an "unchanged" one, so the
    generated scenes (``generated``, entries marked ``"generated": True``) stay available for the stories that show
    the AI before/after verification. ``size_rank`` orders the photos of a category by the size of the defect
    (annotated severity of a real photo, then the manifest box area): 0 = smallest, 1 = largest."""

    def __init__(self, root=SAMPLE_IMAGES, real_root=REAL_SAMPLE_IMAGES):
        self.root = Path(root)
        self.generated = defaultdict(list)
        self._bytes = {}
        for item in self._items():
            self._add(self.generated, self.root, item, generated=True)
        real = defaultdict(list)
        real_manifest = Path(real_root) / "manifest.json" if real_root else None
        if real_manifest is not None and real_manifest.is_file():
            for item in json.loads(real_manifest.read_text(encoding="utf-8")).get("images", []):
                self._add(real, Path(real_root), item, generated=False)
        self.by_label = defaultdict(list, {**self.generated, **real})
        for items in [*self.generated.values(), *real.values()]:
            ranked = sorted(items, key=lambda entry: (PHOTO_SEVERITY_ORDER.get(entry["severity"], 1),
                                                      entry["box_area"], entry["id"]))
            for rank, entry in enumerate(ranked):
                entry["size_rank"] = rank / max(1, len(ranked) - 1)

    @staticmethod
    def _add(by_label, root, item, *, generated):
        photo = root / item["file"]
        if not photo.is_file():
            return
        box = item.get("box") or []
        area = (box[2] - box[0]) * (box[3] - box[1]) if len(box) == 4 else 0.0
        entry = {"id": item.get("id") or photo.stem, "label": item["label"], "file": photo, "box_area": area,
                 "severity": item.get("severity"), "generated": generated,
                 "keywords": tuple(word.lower() for word in item.get("keywords") or ())}
        for kind in ("after", "unchanged"):
            candidate = root / item[kind] if item.get(kind) else None
            entry[kind] = candidate if candidate is not None and candidate.is_file() else None
        by_label[item["label"]].append(entry)

    def _items(self):
        manifest = self.root / "manifest.json"
        if manifest.is_file():
            return json.loads(manifest.read_text(encoding="utf-8")).get("images", [])
        items = []  # no manifest: fall back to the naming convention of scripts/generate_sample_images.py
        folders = sorted(path for path in self.root.iterdir() if path.is_dir()) if self.root.is_dir() else []
        for folder in folders:
            if folder.name in ("after", "unchanged"):
                continue
            for photo in sorted(folder.glob("*.jpg")):
                items.append({"id": photo.stem, "label": folder.name, "file": f"{folder.name}/{photo.name}",
                              "after": f"after/{photo.stem}_after.jpg",
                              "unchanged": f"unchanged/{photo.stem}_unchanged.jpg"})
        return items

    @property
    def total(self):
        return sum(len(items) for items in self.by_label.values())

    def read(self, path):
        data = self._bytes.get(path)
        if data is None:
            data = self._bytes[path] = Path(path).read_bytes()
        return data

    def upload(self, path, moment):
        """A real JPEG upload named like a phone camera picture (no category hint in the file name)."""
        name = f"IMG_{timezone.localtime(moment):%Y%m%d_%H%M%S}.jpg"
        return SimpleUploadedFile(name, self.read(path), content_type="image/jpeg")

    def scene(self, slug, photo, index, *, generated=False):
        """The scene the officer photographs: the citizen's photo, else a sample scene of the category (a generated
        one when the story shows the AI before/after verification)."""
        if photo is not None:
            return photo
        items = (self.generated if generated else self.by_label).get(slug) or []
        return items[index % len(items)] if items else None

    def after_photo(self, scene, slug, kind):
        """The officer's after photo of ``scene``: the scene repaired ("repaired"), re-shot without the repair
        ("unchanged") or another scene's after photo the AI cannot match ("angle"). None when the sample set has no
        such photo (real photos without a repaired shot): the officer then resolves without a photo."""
        if scene is None:
            return None
        if kind == "unchanged":
            return scene.get("unchanged")
        if kind == "angle":
            pool = (self.generated if scene["generated"] else self.by_label).get(slug, [])
            others = [item for item in pool if item["id"] != scene["id"] and item["after"]]
            return others[sum(map(ord, scene["id"])) % len(others)]["after"] if others else None
        return scene.get("after")


@dataclass
class Track:
    """One complaint of the demo: what the citizen reports (input), the planned story and runtime state."""

    index: int
    role: str  # regular | event | main | critical | duplicate
    created_at: object
    age: float  # planned age in days (independent of the time of day the history ends)
    citizen: str
    slug: str
    language: str
    place: dict
    slots: dict
    description: str
    title: str = ""
    reported: str | None = None
    photo: dict | None = None
    incident_hours: float = 1.0
    tone: str = "standard"  # how the citizen describes it: minor | standard | severe (see demo.TONE_WEIGHTS)
    event: str | None = None  # key of the storm burst (demo.EVENTS) the report belongs to
    outcome: str = ""
    rework: bool = False  # a reopened story: the officer fixes it again after the reopen
    path: str = "standard"  # resolution path: standard | angle | sent_back | review_pending
    demo_pair: bool = False  # the story shows the AI before/after verification on a generated scene
    original: int | None = None  # index of the original (deliberate re-report)
    review: str | None = None  # planned duplicate decision
    review_hours: float = 1.0  # ... taken this long after the re-report arrives
    re_reports: list = field(default_factory=list)  # indices of the deliberate re-reports of this complaint
    hold_until: object = None  # no resolution before this moment (storm backlog, a re-report under review)
    is_original: bool = False
    complaint_id: int | None = None
    rng: random.Random | None = None
    flagged: bool = False
    events: list = field(default_factory=list)


# ---------------------------------------------------------------------------------------------------------------
# Planning (pure Python: who reports what, where and when, and how each story should end)
# ---------------------------------------------------------------------------------------------------------------
class DemoPlanner:
    """Plans every report of the demo: date, citizen, place, category, description, photo and the story's outcome.

    The structural draws (arrival dates, outcomes) use one generator seeded with ``seed``; the content of each
    report uses its own generator seeded with (seed, role, index), so the plan is a pure function of seed and
    anchor and one report never shifts the random draws of the others."""

    def __init__(self, *, total, days, seed, anchor, photos):
        self.total, self.days, self.seed, self.anchor, self.photos = total, days, seed, anchor, photos
        self.rng = random.Random(seed)
        self.tz = timezone.get_current_timezone()
        self.hotspots = {spot["key"]: spot for spot in demo.HOTSPOTS}
        self.citizens = [dict(spec, email=self.citizen_email(i)) for i, spec in enumerate(demo.CITIZENS)]
        self.sla_hint = default_sla_hours()
        self._free = []  # unclaimed arrival slots (ages in days)
        self._photo_uses = defaultdict(list)  # photo id -> [(lat, lng, time)]
        self._place_uses = defaultdict(list)  # (slug, landmark) -> [time]
        self._template_uses = defaultdict(list)  # (slug, area, template) -> [time]

    @staticmethod
    def citizen_email(index):
        return demo.MAIN_CITIZEN_EMAIL if index == 0 else f"citizen{index}{DEMO_DOMAIN}"

    def track_rng(self, role, index):
        return random.Random(f"{self.seed}:plan:{role}:{index}")

    # --- arrivals -------------------------------------------------------------------------------------------------
    def arrival_slots(self, count):
        """``count`` report ages (days before the end of the history), youngest first: one stratified sample per
        equal share of the arrival rate, so every stretch of the history receives its share of reports (no random
        clumps or gaps). The rate per hour is growth x month x weekday x week factor (see the constants); the
        calendar factors are taken per whole day counted back from the anchor's date, so the slots do not move
        with the time of day the history ends."""
        rng = self.rng
        noise = [math.exp(rng.gauss(0.0, WEEKLY_NOISE)) for _ in range(self.days // 7 + 2)]
        end_date = timezone.localtime(self.anchor, self.tz).date()
        weights = []
        for step in range(self.days * 24):
            age = (step + 0.5) / 24.0
            day = end_date - timedelta(days=int(age))
            weights.append((1.0 + ADOPTION_GROWTH * (1.0 - age / self.days)) * MONTH_VOLUME[day.month]
                           * WEEKDAY_VOLUME[day.weekday()] * noise[int(age // 7)])
        cumulative = list(itertools.accumulate(weights))
        ages = []
        for position in range(count):
            target = (position + rng.random()) / count * cumulative[-1]
            step = min(bisect.bisect_left(cumulative, target), len(weights) - 1)
            before = cumulative[step - 1] if step else 0.0
            ages.append((step + min(1.0, max(0.0, (target - before) / weights[step]))) / 24.0)
        return ages

    def take_slot(self, age):
        """Claim the regular arrival a report with a planned date replaces: one of the nearest free slots."""
        if not self._free:
            return
        near = sorted((abs(slot - age), position) for position, slot in enumerate(self._free)
                      if abs(slot - age) <= SLOT_WINDOW_DAYS)
        if not near:
            near = [min((abs(slot - age), position) for position, slot in enumerate(self._free))]
        rank = min(len(near) - 1, weighted_choice(self.rng, SLOT_RANK_WEIGHTS))
        self._free.pop(near[rank][1])

    # --- time ---------------------------------------------------------------------------------------------------
    def report_time(self, age_days, rng):
        """A moment ``age_days`` before the anchor, moved to a plausible local reporting hour.

        The random draws never depend on the anchor, so the same seed produces the same reports whenever it runs
        (only the absolute dates move with the end of the history)."""
        hour, minute, second = weighted_choice(rng, REPORT_HOURS), rng.randrange(60), rng.randrange(60)
        local = timezone.localtime(self.anchor - timedelta(days=age_days), self.tz)
        candidate = local.replace(hour=hour, minute=minute, second=second, microsecond=0)
        if abs(hours_between(candidate, local)) > 12:  # keep the requested age within half a day
            candidate = local.replace(minute=minute, second=second, microsecond=0)
        return self.clamp(candidate)

    def clamp(self, moment):
        return min(max(moment, self.anchor - timedelta(days=self.days)), self.anchor - timedelta(minutes=20))

    def age_of(self, moment):
        return max(0.01, hours_between(moment, self.anchor) / 24.0)

    # --- places -------------------------------------------------------------------------------------------------
    def place_in(self, spot, *, jitter_m, rng, quiet=False, busy=False):
        """A point around the spot centre with a landmark and road: one of the neighbourhood's spots, with ``busy``
        one on a main road or at a station, market, hospital or school (``BUSY_PLACE``), with ``quiet`` one of its
        residential lanes (demo.QUIET_PLACES)."""
        lat, lng = offset_point(spot["latitude"], spot["longitude"], abs(rng.gauss(0, jitter_m)),
                                rng.uniform(0, 2 * math.pi))
        pool = (demo.QUIET_PLACES.get(spot.get("key") or spot["area"]) if quiet else None) or spot["places"]
        if busy:
            pool = [place for place in pool if BUSY_PLACE.search(" ".join(place))] or pool
        landmark, road = pool[rng.randrange(len(pool))]
        return {
            "latitude": round(lat, 6), "longitude": round(lng, 6), "landmark": landmark, "road": road,
            "address": f"{road}, near {landmark}, {spot['area']}"[:255], "area": spot["area"], "city": demo.CITY,
            "pincode": spot["pincode"], "hotspot": spot.get("key"),
        }

    def choose_spot(self, rng):
        """(spot, jitter in metres, kind): a hotspot (weighted) or another locality of the city."""
        if rng.random() < HOTSPOT_SHARE:
            key = weighted_choice(rng, {spot["key"]: spot["weight"] for spot in demo.HOTSPOTS})
            return self.hotspots[key], HOTSPOT_JITTER_M, "hotspot"
        return dict(rng.choice(demo.LOCALITIES), key=None), LOCALITY_JITTER_M, "locality"

    # --- content ------------------------------------------------------------------------------------------------
    def category_for(self, spot, moment, rng):
        weights = dict(demo.CATEGORY_WEIGHTS)
        for slug, factor in (spot.get("bias") or {}).items():
            weights[slug] *= factor
        for slug, factor in demo.SEASONAL_FACTORS.get(timezone.localtime(moment, self.tz).month, {}).items():
            weights[slug] *= factor
        return weighted_choice(rng, weights)

    @staticmethod
    def tone_for(slug, kind, rng):
        """How the citizen describes the problem (minor / standard / severe), by category and kind of place."""
        factors = demo.TONE_SPOT_FACTORS.get(kind, {})
        weights = {tone: share * factors.get(tone, 1.0) for tone, share in demo.TONE_WEIGHTS[slug].items()
                   if share > 0}
        return weighted_choice(rng, weights)

    def citizen_for(self, place, rng, exclude=()):
        """A citizen living near the place is the most likely reporter (the main demo citizen is reserved)."""
        weights = {}
        for spec in self.citizens[1:]:
            if spec["email"] in exclude:
                continue
            home = self.hotspots[spec["home"]]
            km = haversine_m(place["latitude"], place["longitude"], home["latitude"], home["longitude"]) / 1000
            weights[spec["email"]] = math.exp(-km / 4.0) + 0.08
        return weighted_choice(rng, weights)

    def language_for(self, email, rng):
        preferred = next(spec["language"] for spec in self.citizens if spec["email"] == email)
        mix = {"te": {"en": 0.55, "te": 0.35, "hi": 0.10}, "hi": {"en": 0.62, "hi": 0.38},
               "en": {"en": 0.86, "hi": 0.07, "te": 0.07}}[preferred]
        return weighted_choice(rng, mix)

    def write_text(self, slug, place, language, moment, rng, *, tone="standard", hazard_index=None, durations=None):
        """(description, slots, hours since the issue began | None) from a template of the tone (minor and severe
        reports are written in English) that was not used nearby recently."""
        duration = rng.choice(durations or demo.DURATIONS)
        hazards = demo.HAZARDS[slug]
        slots = {"landmark": place["landmark"], "road": place["road"], "area": place["area"],
                 "duration": duration[0], "hi_duration": duration[2], "te_duration": duration[3],
                 "hazard": hazards[hazard_index if hazard_index is not None else rng.randrange(len(hazards))]}
        if tone == "minor":
            templates = demo.MINOR_TEMPLATES.get(slug) or demo.COMPLAINT_TEMPLATES[slug]["en"]
        elif tone == "severe":
            templates = demo.SEVERE_TEMPLATES.get(slug) or demo.COMPLAINT_TEMPLATES[slug]["en"]
        else:
            templates = demo.COMPLAINT_TEMPLATES[slug][language]
        fresh = [template for template in templates
                 if not self._recent(self._template_uses[(slug, place["area"], template)], moment)]
        template = rng.choice(fresh or templates)
        self._template_uses[(slug, place["area"], template)].append(moment)
        return demo.fill(template, slots), slots, (duration[1] if "duration}" in template else None)

    @staticmethod
    def title_for(slug, slots, rng):
        """Most citizens leave the title blank (CivicAI generates one); about a quarter write their own."""
        if rng.random() >= 0.25:
            return ""
        return demo.fill(rng.choice(demo.TITLE_TEMPLATES[slug]), slots)[:160]

    @staticmethod
    def reported_for(slug, rng):
        """The category the citizen picks in the form (optional; usually right)."""
        if rng.random() >= 0.55:
            return None
        return slug if rng.random() < 0.9 else rng.choice([key for key in demo.CATEGORY_WEIGHTS if key != slug])

    def photo_for(self, slug, place, moment, rng, *, required=False, preferred=None, tier=None, generated=False,
                  text=None):
        """A sample photo of the category not used nearby within weeks (so photos never fake a duplicate);
        ``preferred`` names a specific photo to use when it exists; ``tier`` prefers a small ("small") or a large
        ("large") defect - someone reporting a routine problem photographs a small one; ``generated`` picks a
        generated scene (with repaired and unchanged shots) instead of a real photo. A real photo with
        ``keywords`` (e.g. stray dogs, cattle) only illustrates a ``text`` that mentions one of them; when no real
        photo fits, a generated one is used."""
        if not required and rng.random() >= PHOTO_SHARE:
            return None
        items = (self.photos.generated if generated else self.photos.by_label).get(slug) or []
        if text is not None:
            items = [item for item in items if self.photo_fits(item, text)] or self.photos.generated.get(slug) or []
        if not items:
            return None

        def clashes(item):
            return sum(1 for lat, lng, when in self._photo_uses[item["id"]]
                       if abs((when - moment).days) < REUSE_WINDOW_DAYS
                       and haversine_m(lat, lng, place["latitude"], place["longitude"]) < REUSE_RADIUS_M)

        def off_tier(item):
            if tier == "small":
                return item["size_rank"] > 0.5
            if tier == "large":
                return item["size_rank"] < 0.5
            return False

        # only nearby recent uses count, so one report's choice never ripples through the rest of the history
        chosen = next((item for item in items if item["id"] == preferred), None) or min(
            items, key=lambda item: (clashes(item), off_tier(item), rng.random()))
        self._photo_uses[chosen["id"]].append((place["latitude"], place["longitude"], moment))
        return chosen

    @staticmethod
    def photo_fits(photo, text):
        """Whether ``photo`` can illustrate a complaint described as ``text`` (photos without keywords fit any)."""
        lowered = text.lower()
        return not photo["keywords"] or any(word in lowered for word in photo["keywords"])

    def _pairable(self, track):
        """Whether the story can show the AI before/after verification: the category has generated scenes with
        repaired and unchanged shots, and the citizen's photo may be swapped for one (an original keeps the real
        photo its re-reports share)."""
        if track.is_original and track.photo is not None and not track.photo["generated"]:
            return False
        return any(item["after"] and item["unchanged"] for item in self.photos.generated.get(track.slug, []))

    def _use_demo_pair(self, track):
        """The story shows the AI before/after verification, so the citizen photographs a generated scene: real
        photos have no repaired shot of the same spot."""
        track.demo_pair = True
        if track.photo is None or track.photo["generated"]:
            return
        uses = self._photo_uses[track.photo["id"]]
        use = (track.place["latitude"], track.place["longitude"], track.created_at)
        if use in uses:
            uses.remove(use)
        track.photo = self.photo_for(track.slug, track.place, track.created_at, self.track_rng("pair", track.index),
                                     required=True, tier=PHOTO_TIER.get(track.tone), generated=True)

    @staticmethod
    def _recent(times, moment):
        return any(abs((when - moment).days) < REUSE_WINDOW_DAYS for when in times)

    @staticmethod
    def incident_hours(duration_hours, rng):
        if duration_hours:
            return max(0.5, duration_hours * rng.uniform(0.85, 1.1))
        return rng.uniform(0.3, 10.0)

    # --- tracks -------------------------------------------------------------------------------------------------
    def build(self):
        total = self.total
        n_duplicates = max(1, round(total * DUPLICATE_SHARE))
        n_main = min(len(MAIN_CITIZEN_PLAN), max(5, total // 16))
        n_critical = len(CRITICAL_PLAN) if total >= 60 else 1
        events = [event for event in demo.EVENTS if event["age"] < self.days * 0.95] \
            if total >= EVENTS_MIN_COMPLAINTS else []
        self._free = self.arrival_slots(total)
        counter = itertools.count()
        tracks = []
        for outcome, age, slug, spot_key, with_photo in MAIN_CITIZEN_PLAN[:n_main]:
            tracks.append(self._main_track(next(counter), outcome, age, slug, self.hotspots[spot_key], with_photo))
        budget = n_duplicates // 2  # at most half of the re-reports go to the critical showcase
        for spec in CRITICAL_PLAN[:n_critical]:
            original = self._critical_track(next(counter), spec)
            tracks.append(original)
            for re_report in spec["re_reports"][:budget]:
                tracks.append(self._critical_re_report(next(counter), original, re_report, tracks))
            budget -= min(budget, len(spec["re_reports"]))
        for event in events:
            tracks.extend(self._event_tracks(counter, event))
        for age in sorted(self._free, reverse=True):  # the steady flow fills every unclaimed arrival slot
            tracks.append(self._regular_track(next(counter), max(age, 0.02)))
        regular_re_reports = n_duplicates - sum(1 for track in tracks if track.role == "duplicate")
        tracks = self._regular_re_reports(tracks, regular_re_reports, counter)
        self._assign_outcomes(tracks)
        tracks.sort(key=lambda track: (track.created_at, track.index))
        for track in tracks:
            track.rng = random.Random(f"{self.seed}:{track.role}:{track.index}")
        return tracks

    def _main_track(self, index, outcome, age, slug, spot, with_photo):
        rng = self.track_rng("main", index)
        age = min(age, self.days * 0.9)
        self.take_slot(age)
        moment = self.report_time(age, rng)
        place = self.place_in(spot, jitter_m=HOTSPOT_JITTER_M, rng=rng)
        text, slots, duration_hours = self.write_text(slug, place, "en", moment, rng)
        photo = self.photo_for(slug, place, moment, rng, required=True, text=text) if with_photo else None
        return Track(index=index, role="main", created_at=moment, age=age, citizen=demo.MAIN_CITIZEN_EMAIL, slug=slug,
                     language="en", place=place, slots=slots, description=text, title=self.title_for(slug, slots, rng),
                     reported=self.reported_for(slug, rng), photo=photo,
                     incident_hours=self.incident_hours(duration_hours, rng), outcome=outcome)

    def _critical_track(self, index, spec):
        rng = self.track_rng("critical", index)
        spot = self.hotspots.get(spec["hotspot"]) or {"key": None, "area": spec["area"], "pincode": spec["pincode"]}
        lat, lng = offset_point(spec["latitude"], spec["longitude"], abs(rng.gauss(0, 15)),
                                rng.uniform(0, 2 * math.pi))
        place = {"latitude": round(lat, 6), "longitude": round(lng, 6), "landmark": spec["landmark"],
                 "road": spec["road"], "address": f"{spec['road']}, near {spec['landmark']}, {spot['area']}",
                 "area": spot["area"], "city": demo.CITY, "pincode": spot["pincode"], "hotspot": spot["key"]}
        age = min(spec["age"], self.days * 0.9)
        self.take_slot(age)
        moment = self.report_time(age, rng)
        text, slots, duration_hours = self.write_text(spec["slug"], place, "en", moment, rng,
                                                      hazard_index=spec["hazard"])
        return Track(index=index, role="critical", created_at=moment, age=age, citizen=self.citizen_for(place, rng),
                     slug=spec["slug"], language="en", place=place, slots=slots, description=text,
                     title=self.title_for(spec["slug"], slots, rng), reported=self.reported_for(spec["slug"], rng),
                     photo=self.photo_for(spec["slug"], place, moment, rng, required=True, preferred=spec["photo"],
                                          tier="large", text=text),
                     incident_hours=self.incident_hours(duration_hours, rng), outcome=spec["outcome"],
                     rework=bool(spec.get("rework")))

    def _critical_re_report(self, index, original, spec, tracks):
        """Another citizen re-reports the hazard: ``spec`` times it after the original (``after_hours``) or before
        the end of the history (``before_end_hours``) and names the administrator's review decision, if any."""
        rng = self.track_rng("duplicate", index)
        room = hours_between(original.created_at, self.anchor) - 0.2
        if spec.get("before_end_hours"):
            offset = room - rng.uniform(*spec["before_end_hours"])
        else:
            offset = rng.uniform(*spec["after_hours"])
        offset = min(max(0.3, offset), max(0.3, room))
        review = spec.get("review")
        review_hours = rng.uniform(*spec["review_hours"]) if review else 1.0
        outcome = "merged" if review == D.CONFIRMED_DUPLICATE else "pending"
        return self._re_report(index, original, tracks, rng=rng, offset_hours=offset, review=review,
                               review_hours=review_hours, outcome=outcome, claim_slot=True)

    def _re_report(self, index, original, tracks, *, rng, offset_hours, review, review_hours, outcome, claim_slot):
        """A deliberate re-report: another citizen reports the same issue 30-60 m away with the same photo and a
        paraphrase of the description. A planned merge keeps the original open until the review."""
        moment = min(original.created_at + hours(offset_hours), self.anchor - timedelta(minutes=10))
        lat, lng = offset_point(original.place["latitude"], original.place["longitude"], rng.uniform(30, 60),
                                rng.uniform(0, 2 * math.pi))
        place = dict(original.place, latitude=round(lat, 6), longitude=round(lng, 6))
        slots = dict(original.slots, duration=rng.choice(demo.DURATIONS)[0])
        reporters = {track.citizen for track in tracks if track.index in original.re_reports}
        citizen = self.citizen_for(place, rng, exclude={original.citizen} | reporters)
        age = max(0.01, original.age - offset_hours / 24.0)  # planned ages do not move with the anchor's time
        if claim_slot:
            self.take_slot(age)
        original.re_reports.append(index)
        original.is_original = True
        if review == D.CONFIRMED_DUPLICATE:
            ready = moment + hours(review_hours + rng.uniform(0.3, 1.0))
            original.hold_until = max(original.hold_until or ready, ready)
        return Track(index=index, role="duplicate", created_at=moment, age=age, citizen=citizen, slug=original.slug,
                     language="en", place=place, slots=slots,
                     description=demo.fill(rng.choice(demo.DUPLICATE_TEMPLATES[original.slug]), slots),
                     reported=self.reported_for(original.slug, rng), photo=original.photo,
                     incident_hours=rng.uniform(1, 30), original=original.index, review=review,
                     review_hours=review_hours, outcome=outcome)

    def _event_tracks(self, counter, event):
        """A storm burst: several reports of different kinds within a day or so around one neighbourhood. The
        crews start once the storm has passed, so the first reports are still open when the fifth arrives - the
        situation in which the platform raises a hotspot alert."""
        spot = self.hotspots[event["spot"]]
        rng = random.Random(f"{self.seed}:plan:event:{event['key']}")
        centre = offset_point(spot["latitude"], spot["longitude"], abs(rng.gauss(0, 120)), rng.uniform(0, 2 * math.pi))
        start = self.anchor - timedelta(days=event["age"])
        count = len(event["reports"])
        times = sorted(self.clamp(start + hours(event["hours"] * (k + rng.random()) / count)) for k in range(count))
        tracks, reporters = [], set()
        for moment, slug in zip(times, event["reports"]):
            index = next(counter)
            trng = self.track_rng("event", index)
            lat, lng = offset_point(centre[0], centre[1], event["radius_m"] * math.sqrt(trng.random()),
                                    trng.uniform(0, 2 * math.pi))
            tone = weighted_choice(trng, {"standard": 0.55, "severe": 0.45})
            pool = [p for p in spot["places"] if BUSY_PLACE.search(" ".join(p))] if tone == "severe" else None
            landmark, road = trng.choice(pool or spot["places"])
            place = {"latitude": round(lat, 6), "longitude": round(lng, 6), "landmark": landmark, "road": road,
                     "address": f"{road}, near {landmark}, {spot['area']}"[:255], "area": spot["area"],
                     "city": demo.CITY, "pincode": spot["pincode"], "hotspot": spot["key"]}
            self.take_slot(self.age_of(moment))
            email = self.citizen_for(place, trng, exclude=reporters)
            reporters.add(email)
            language = self.language_for(email, trng) if tone == "standard" else "en"
            text, slots, duration_hours = self.write_text(slug, place, language, moment, trng, tone=tone,
                                                          durations=demo.DURATIONS[:2])
            tracks.append(Track(index=index, role="event", created_at=moment, age=self.age_of(moment), citizen=email,
                                slug=slug, language=language, place=place, slots=slots, description=text,
                                title=self.title_for(slug, slots, trng), reported=self.reported_for(slug, trng),
                                photo=self.photo_for(slug, place, moment, trng, tier=PHOTO_TIER[tone], text=text),
                                incident_hours=trng.uniform(0.3, 6.0), tone=tone, event=event["key"]))
        hold = times[min(4, count - 1)] + hours(rng.uniform(0.5, 3.0))
        for track in tracks[:4]:
            track.hold_until = hold
        return tracks

    def _regular_track(self, index, age):
        rng = self.track_rng("regular", index)
        moment = self.report_time(age, rng)
        spot, jitter, kind = self.choose_spot(rng)
        slug = self.category_for(spot, moment, rng)
        tone = self.tone_for(slug, kind, rng)
        quiet = rng.random() < QUIET_STREET_CHANCE[tone]
        busy = tone == "severe"
        place = self.place_in(spot, jitter_m=jitter, rng=rng, quiet=quiet, busy=busy)
        for _ in range(4):  # avoid a second report of the same category at the same landmark within weeks
            if not self._recent(self._place_uses[(slug, place["landmark"])], moment):
                break
            place = self.place_in(spot, jitter_m=jitter, rng=rng, quiet=quiet, busy=busy)
        self._place_uses[(slug, place["landmark"])].append(moment)
        email = self.citizen_for(place, rng)
        language = self.language_for(email, rng) if tone == "standard" else "en"
        text, slots, duration_hours = self.write_text(slug, place, language, moment, rng, tone=tone)
        title = self.title_for(slug, slots, rng) if tone != "minor" else ""  # a routine request has no headline
        return Track(index=index, role="regular", created_at=moment, age=age, citizen=email, slug=slug,
                     language=language, place=place, slots=slots, description=text, title=title,
                     reported=self.reported_for(slug, rng),
                     photo=self.photo_for(slug, place, moment, rng, tier=PHOTO_TIER[tone], text=text),
                     incident_hours=self.incident_hours(duration_hours, rng), tone=tone)

    def _regular_re_reports(self, tracks, count, counter):
        """Re-reports of regular complaints, one per stretch of the history: each takes the place of the nearest
        regular arrival. The administrator reviews them within hours, alternately confirming the duplicate (merged
        into the original) and deciding it is a separate issue. Returns the new track list."""
        if count <= 0:
            return tracks

        def eligible(track, strict):
            """An original another citizen notices too: a noticeable problem (standard tone: its description names
            the consequence that the paraphrase repeats, so the texts are comparable) with a photo. Not the catch-all
            "other": its paraphrases (stray dogs, encroachment) would describe a different issue than the original."""
            if track.role != "regular" or track.photo is None or track.age < (1.5 if strict else 0.7):
                return False
            if track.slug == "other":
                return False
            return not strict or (track.place.get("hotspot") and track.language == "en"
                                  and track.tone == "standard")

        candidates = [track for track in tracks if eligible(track, True)]
        if len(candidates) < count:
            candidates = [track for track in tracks if eligible(track, False)]
        candidates.sort(key=lambda track: (-track.age, track.index))
        originals = []
        for k in range(min(count, len(candidates))):
            group = candidates[k * len(candidates) // count:(k + 1) * len(candidates) // count]
            if group:
                originals.append(self.rng.choice(group))
        chosen, removed = {original.index for original in originals}, set()
        for position, original in enumerate(originals):
            index = next(counter)
            rng = self.track_rng("duplicate", index)
            if original.language != "en" or original.tone != "standard":  # comparable wording for the paraphrase
                original.description, original.slots, _ = self.write_text(original.slug, original.place, "en",
                                                                           original.created_at, rng)
                original.language, original.tone, original.title = "en", "standard", ""
                if not self.photo_fits(original.photo, original.description):  # e.g. a stray-dog photo
                    original.photo = self.photo_for(original.slug, original.place, original.created_at, rng,
                                                    required=True, text=original.description)
            sla = self.sla_hint.get(original.slug, 72)
            offset = min(RE_REPORT_HOURS[1], max(RE_REPORT_HOURS[0], sla * rng.uniform(*RE_REPORT_SLA_SHARE)))
            review_hours = min(REVIEW_HOURS[1], max(REVIEW_HOURS[0], sla * rng.uniform(*REVIEW_SLA_SHARE)))
            review = D.CONFIRMED_DUPLICATE if position % 2 == 0 else D.NOT_DUPLICATE
            outcome = "merged" if review == D.CONFIRMED_DUPLICATE else (
                "closed" if rng.random() < FEEDBACK_RATE else "awaiting_feedback")
            track = self._re_report(index, original, tracks, rng=rng, offset_hours=offset, review=review,
                                    review_hours=review_hours, outcome=outcome, claim_slot=False)
            tracks.append(track)
            replaceable = [other for other in tracks if other.role == "regular" and not other.is_original
                           and other.index not in removed and other.index not in chosen]
            if replaceable:
                removed.add(min(replaceable, key=lambda other: (abs(other.age - track.age), other.index)).index)
        return [track for track in tracks if track.index not in removed]

    def _assign_outcomes(self, tracks):
        """The stories of the regular reports: some are rejected, some reopened by the citizen (and reworked),
        the rest resolved - rated by the citizen or still awaiting feedback. How far each story got is decided by
        the timeline (a recent report is simply still open at the end of the history)."""
        rng, total = self.rng, self.total
        plain = [track for track in tracks if track.role == "regular" and not track.is_original]
        for track in sample_weighted(rng, [t for t in plain if t.age >= 1.0], lambda t: 1.0,
                                     max(1, round(REJECTED_SHARE * total))):
            track.outcome = "rejected"
        planned_reopens = sum(1 for track in tracks if track.role in SHOWCASE_ROLES and track.outcome == "reopened")
        reopened = max(1, round(REOPENED_SHARE * total)) - planned_reopens
        for track in sample_weighted(rng, [t for t in plain if not t.outcome and 6.0 <= t.age <= 150.0],
                                     lambda t: 1.0, reopened):
            track.outcome, track.rework = "reopened", True
        for track in tracks:
            if track.role in ("regular", "event") and not track.outcome:
                track.outcome = "closed" if rng.random() < FEEDBACK_RATE else "awaiting_feedback"
        if total >= 20:
            resolvable = [t for t in tracks if t.role == "regular" and t.outcome in ("closed", "awaiting_feedback")
                          and t.age >= 4]
            for share, path in ((ANGLE_SHARE, "angle"), (SENT_BACK_SHARE, "sent_back"), (AI_VERIFIED_SHARE, None)):
                pairable = [t for t in resolvable if t.path == "standard" and not t.demo_pair and self._pairable(t)]
                for track in sample_weighted(rng, pairable, lambda t: 1.0, max(1, round(share * total))):
                    track.path = path or track.path
                    self._use_demo_pair(track)
        if total >= 60:  # a recent resolution the AI could not confirm, still waiting for the admin's review
            candidates = [t for t in tracks if t.role == "regular" and t.outcome in ("closed", "awaiting_feedback")
                          and t.path == "standard" and t.photo is not None and not t.is_original
                          and self._pairable(t)]
            recent = [t for t in candidates if 1.0 <= t.age <= 6.0] or sorted(
                (t for t in candidates if t.age >= 1.0), key=lambda t: t.age)[:3]
            for track in sample_weighted(rng, recent, lambda t: 1.0, 1):
                track.outcome, track.path = "awaiting_feedback", "review_pending"
                self._use_demo_pair(track)


# ---------------------------------------------------------------------------------------------------------------
# The command
# ---------------------------------------------------------------------------------------------------------------
class Command(BaseCommand):
    help = ("Build a realistic CivicAI demo dataset through the real AI pipeline and services "
            "(users, complaints, lifecycle, duplicates, feedback, hotspots).")

    def add_arguments(self, parser):
        parser.add_argument("--complaints", type=int, default=160, help="Number of complaints (default 160).")
        parser.add_argument("--days", type=int, default=180, help="Length of the history in days (default 180).")
        parser.add_argument("--seed", type=int, default=42, help="Random seed (default 42).")
        parser.add_argument("--reset", action="store_true",
                            help="Delete the data of a previous run (accounts @civicai.local and everything "
                                 "they own) before seeding.")
        parser.add_argument("--quiet", action="store_true", help="Only print a one-line result.")
        parser.add_argument("--anchor", default=None,
                            help="End of the simulated history as an ISO date-time (default: 20 minutes ago). "
                                 "Together with --seed it reproduces a dataset exactly.")

    # --- entry point ----------------------------------------------------------------------------------------------
    def handle(self, *args, **options):
        total, days = options["complaints"], options["days"]
        if total < MIN_COMPLAINTS:
            raise CommandError(f"--complaints must be at least {MIN_COMPLAINTS}.")
        if days < 14:
            raise CommandError("--days must be at least 14.")
        self.quiet = options["quiet"] or options["verbosity"] == 0
        self.started = time.perf_counter()
        self.timings = {}
        self.failures = []

        with self._quiet_service_logs(options["verbosity"]):
            self._phase("reference", self._reference_data)
            existing = User.objects.filter(email__iendswith=DEMO_DOMAIN).count()
            if existing and not options["reset"]:
                raise CommandError(f"Demo data already exists ({existing} accounts {DEMO_DOMAIN}). "
                                   "Run `manage.py seed_demo --reset` to rebuild it.")
            if options["reset"]:
                self._phase("reset", self.reset)

            self.anchor = self._anchor(options["anchor"])
            self.photos = SamplePhotos()
            if not self.photos.total:
                self._warn(f"No sample photos found in {SAMPLE_IMAGES}; complaints will be text-only.")
            planner = DemoPlanner(total=total, days=days, seed=options["seed"], anchor=self.anchor,
                                  photos=self.photos)
            self.tracks = planner.build()
            self.by_index = {track.index: track for track in self.tracks}
            self.clock = SimulatedClock()
            self.rng = random.Random(f"{options['seed']}:lifecycle")
            self.launch = self.anchor - timedelta(days=days + 25)
            self.last_seen = {}

            with self.clock.installed():
                self._phase("staff", self._create_staff)
                self._phase("simulation", self._simulate)
                self._phase("showcase", self._showcase_guarantees, total)
                self._phase("housekeeping", self._housekeeping)
            self._phase("checks", self._final_checks)
            self.report = self._summary(options)
        self.report["seconds"] = round(time.perf_counter() - self.started, 1)
        self.report["timings"] = {key: round(value, 1) for key, value in self.timings.items()}
        self._print_report()

    # --- infrastructure ---------------------------------------------------------------------------------------------
    @contextmanager
    def _quiet_service_logs(self, verbosity):
        """The services log every business action at INFO; keep the seeding output readable (warnings stay)."""
        if verbosity >= 2:
            yield
            return
        loggers = [logging.getLogger(name) for name in ("apps", "ai")]
        levels = [item.level for item in loggers]
        for item in loggers:
            item.setLevel(logging.WARNING)
        try:
            yield
        finally:
            for item, level in zip(loggers, levels):
                item.setLevel(level)

    def _phase(self, name, func, *args):
        started = time.perf_counter()
        result = func(*args)
        self.timings[name] = time.perf_counter() - started
        return result

    def _say(self, message):
        if not self.quiet:
            self.stdout.write(message)

    def _warn(self, message):
        if not self.quiet:
            self.stdout.write(self.style.WARNING(message))

    def _reference_data(self):
        call_command("init_civicai", keep_existing=True, admin_email="", stdout=io.StringIO())
        self._say("Reference data ready (departments, categories, AI settings, risk zones).")

    @staticmethod
    def _anchor(value):
        """End of the simulated history: ``--anchor`` (ISO date-time, local time when naive) or 20 minutes ago. It
        must lie at least that far in the past - the clock tells simulated from wall-clock stamps by it."""
        latest = (real_now() - ANCHOR_MARGIN).replace(second=0, microsecond=0)
        if not value:
            return latest
        anchor = value if isinstance(value, datetime) else parse_datetime(str(value))
        if anchor is None:
            raise CommandError(f"--anchor '{value}' is not an ISO date-time (e.g. 2026-10-17T09:00).")
        if timezone.is_naive(anchor):
            anchor = timezone.make_aware(anchor, timezone.get_current_timezone())
        if anchor > latest:
            raise CommandError(f"--anchor must be at least {ANCHOR_MARGIN.seconds // 60} minutes in the past.")
        return anchor.replace(second=0, microsecond=0)

    # --- reset ------------------------------------------------------------------------------------------------------
    def reset(self):
        """Delete what a previous run created. Reference data and other accounts' complaints stay; duplicate counts
        of other complaints that were linked to demo complaints are recounted."""
        users = User.objects.filter(email__iendswith=DEMO_DOMAIN)
        user_ids = list(users.values_list("pk", flat=True))
        complaints = Complaint.objects.filter(citizen_id__in=user_ids)
        complaint_ids = set(complaints.values_list("pk", flat=True))
        location_ids = list(complaints.values_list("location_id", flat=True))
        files = [name for name in ComplaintImage.objects.filter(complaint_id__in=complaint_ids)
                 .values_list("image", flat=True) if name]
        for before, after in ResolutionEvidence.objects.filter(complaint_id__in=complaint_ids).values_list(
                "before_image", "after_image"):
            files += [name for name in (before, after) if name]
        files += [name for name in users.values_list("avatar", flat=True) if name]
        pairs = DuplicateComplaint.objects.filter(Q(complaint_id__in=complaint_ids)
                                                  | Q(similar_complaint_id__in=complaint_ids))
        pair_ids = [str(pk) for pk in pairs.values_list("pk", flat=True)]
        linked = set(pairs.values_list("complaint_id", flat=True)) | set(
            pairs.values_list("similar_complaint_id", flat=True))
        existing = set(Complaint.objects.values_list("pk", flat=True))
        alert_ids = [alert.pk for alert in HotspotAlert.objects.only("pk", "complaint_ids")
                     if alert.complaint_ids and all(int(pk) in complaint_ids or int(pk) not in existing
                                                    for pk in alert.complaint_ids)]
        with transaction.atomic():
            audit = Q(actor_id__in=user_ids) | Q(entity_type="User", entity_id__in=[str(pk) for pk in user_ids])
            audit |= Q(entity_type="Complaint", entity_id__in=[str(pk) for pk in complaint_ids])
            audit |= Q(entity_type="DuplicateComplaint", entity_id__in=pair_ids)
            audit |= Q(entity_type="HotspotAlert", entity_id__in=[str(pk) for pk in alert_ids])
            deleted_audit = AuditLog.objects.filter(audit).delete()[0]
            HotspotAlert.objects.filter(pk__in=alert_ids).delete()
            Complaint.objects.filter(pk__in=complaint_ids).delete()
            Location.objects.filter(pk__in=location_ids).delete()
            users.delete()
            linked_statuses = [DuplicateComplaint.Status.PENDING_REVIEW, DuplicateComplaint.Status.CONFIRMED_DUPLICATE]
            for complaint_id in linked - complaint_ids:
                count = DuplicateComplaint.objects.filter(
                    Q(complaint_id=complaint_id) | Q(similar_complaint_id=complaint_id),
                    status__in=linked_statuses).count()
                Complaint.objects.filter(pk=complaint_id).update(duplicate_count=count)
        removed = 0
        for name in files:
            try:
                default_storage.delete(name)
                removed += 1
            except OSError:
                logger.warning("Could not delete demo upload %s", name)
        self._say(f"Reset: removed {len(user_ids)} demo accounts, {len(complaint_ids)} complaints, "
                  f"{deleted_audit} audit rows, {len(alert_ids)} hotspot alerts and {removed} uploaded files.")

    # --- users ------------------------------------------------------------------------------------------------------
    def _prepare_accounts(self):
        """Unsaved demo accounts with their password hashes. Django's PBKDF2 hasher deliberately costs about half a
        second per password and ``hashlib`` releases the GIL while it runs, so ``set_password`` is called for all
        accounts in parallel threads; every account is saved later, at its simulated creation time."""
        accounts = []
        spec = demo.ADMIN_ACCOUNT
        accounts.append((User(email=spec["email"], first_name=spec["first_name"], last_name=spec["last_name"],
                              phone=spec["phone"], role=User.Role.ADMIN, is_staff=True, is_superuser=True),
                         spec["password"]))
        for code, people in demo.OFFICERS.items():
            prefix = demo.DEPARTMENT_PREFIXES[code][0]
            for number, person in enumerate(people, start=1):
                accounts.append((User(email=f"{prefix}.officer{number}{DEMO_DOMAIN}", role=User.Role.OFFICER,
                                      first_name=person["first_name"], last_name=person["last_name"],
                                      phone=person["phone"]), demo.OFFICER_PASSWORD))
        for index, person in enumerate(demo.CITIZENS):
            accounts.append((User(email=DemoPlanner.citizen_email(index), role=User.Role.CITIZEN,
                                  first_name=person["first_name"], last_name=person["last_name"],
                                  phone=person["phone"]), demo.CITIZEN_PASSWORD))
        with ThreadPoolExecutor(max_workers=min(8, os.cpu_count() or 1)) as pool:
            list(pool.map(lambda account: account[0].set_password(account[1]), accounts))
        self.accounts = {user.email: user for user, _ in accounts}

    def _save_account(self, email):
        """Save a prepared account now (simulated time): it joins the platform at this moment."""
        user = self.accounts[email]
        user.date_joined = timezone.now()
        user.save()
        return user

    def _create_staff(self):
        """The administrator and the officers exist from the platform launch (before the simulated history);
        citizens register during the history (``register`` events, just before their first complaint)."""
        rng = self.rng
        self._prepare_accounts()
        with self.clock.at(self.launch):
            self.admin = self._save_account(demo.ADMIN_ACCOUNT["email"])
        departments = {department.code: department for department in Department.objects.all()}
        self.officers = {}  # e-mail -> User
        self.officer_rows = []
        moment = self.launch + hours(2)
        for code, people in demo.OFFICERS.items():
            prefix, id_prefix, id_base = demo.DEPARTMENT_PREFIXES[code]
            for number, person in enumerate(people, start=1):
                moment += timedelta(minutes=rng.randint(4, 12))
                email = f"{prefix}.officer{number}{DEMO_DOMAIN}"
                with self.clock.at(moment), transaction.atomic():
                    user = self._save_account(email)
                    profile = OfficerProfile.objects.create(
                        user=user, department=departments.get(code), employee_id=f"{id_prefix}-{id_base + number}",
                        designation=person["designation"], zone=person["zone"],
                        base_latitude=Decimal(f"{person['base'][0]:.6f}"),
                        base_longitude=Decimal(f"{person['base'][1]:.6f}"),
                        max_active_complaints=person["capacity"], is_available=True, skills=person["skills"],
                        joined_on=date.fromisoformat(person["joined_on"]))
                    log_action(self.admin, AuditLog.Action.CREATE, entity=user,
                               description=f"Created officer {email} ({profile.employee_id})",
                               changes={"department": code, "employee_id": profile.employee_id,
                                        "designation": profile.designation, "zone": profile.zone,
                                        "max_active_complaints": profile.max_active_complaints})
                self.officers[email] = user
                self.officer_rows.append((user, profile, person))
        self._say(f"Staff: 1 admin and {len(self.officers)} officers in {len(demo.OFFICERS)} departments.")

    def _citizen_join_times(self):
        """{citizen index: registration moment} - shortly (hours to weeks) before the citizen's first complaint."""
        rng = self.rng
        first_report = {}
        for track in self.tracks:
            first_report.setdefault(track.citizen, track.created_at)
        joins = {}
        for index in range(len(demo.CITIZENS)):
            first = first_report.get(DemoPlanner.citizen_email(index),
                                     self.anchor - timedelta(days=rng.uniform(1, 30)))
            joins[index] = max(self.launch + timedelta(days=1), first - timedelta(days=rng.uniform(0.05, 25)))
        return joins

    def _on_register(self, moment, track, citizen_index):
        """A citizen creates an account (as ``POST /api/auth/register/`` does) and fills in the profile."""
        person = demo.CITIZENS[citizen_index]
        email = DemoPlanner.citizen_email(citizen_index)
        user = self._save_account(email)
        CitizenProfile.objects.filter(user=user).update(
            address=person["address"], area=person["area"], city=demo.CITY, pincode=person["pincode"],
            gender=person["gender"], date_of_birth=date.fromisoformat(person["date_of_birth"]),
            preferred_language=person["language"], updated_at=timezone.now())
        log_action(user, AuditLog.Action.REGISTER, entity=user, description=f"Citizen account registered: {email}")
        self.citizens[email] = user
        self._touch(moment, user)

    # --- simulation -------------------------------------------------------------------------------------------------
    def _simulate(self):
        self._queue = []
        self._sequence = itertools.count()
        self.citizens = {}
        for citizen_index, joined in self._citizen_join_times().items():
            self._schedule(joined, "register", None, citizen_index=citizen_index)
        for track in self.tracks:
            self._schedule(track.created_at, "submit", track)
        leave = next((user for user, _, person in self.officer_rows if person.get("on_leave")), None)
        if leave is not None:
            self._schedule(self.anchor - timedelta(days=LEAVE_DAYS_AGO, hours=self.rng.uniform(0, 5)), "leave",
                           None, officer_id=leave.pk)
        self._submitted = 0
        while self._queue:
            with transaction.atomic():  # one commit per batch (an SQLite commit costs ~30 ms on Windows)
                for _ in range(EVENTS_PER_COMMIT):
                    if not self._queue:
                        break
                    self._run_event(*heapq.heappop(self._queue))

    def _run_event(self, moment, _sequence, kind, index, payload):
        """Run one event under the simulated clock in its own savepoint: a failing step is rolled back on its own,
        reported, and the rest of the history is still built."""
        track = self.by_index.get(index)
        try:
            with self.clock.at(moment) as started, transaction.atomic():
                getattr(self, f"_on_{kind}")(started, track, **payload)
        except Exception as exc:  # noqa: BLE001 - report every failed step, keep building the dataset
            label = f"{kind} of {track.complaint_id or f'track {track.index}'}" if track is not None else kind
            self.failures.append(f"{label}: {exc.__class__.__name__}: {exc}")
            logger.warning("seed_demo step %s failed", label, exc_info=True)
            return
        if kind == "submit":
            self._submitted += 1
            total = len(self.tracks)
            if self._submitted % max(1, total // 8) == 0 or self._submitted == total:
                self._say(f"  [{self._submitted:>4}/{total}] complaints submitted; simulated date "
                          f"{timezone.localtime(moment):%d %b %Y} ({time.perf_counter() - self.started:.0f} s)")

    def _schedule(self, moment, kind, track, **payload):
        """Queue an event; events after the end of the simulated history are dropped (the story stops there)."""
        if moment is None or moment > self.anchor:
            return False
        heapq.heappush(self._queue, (moment, next(self._sequence), kind, track.index if track else None, payload))
        if track is not None:
            track.events.append(kind)
        return True

    def _complaint(self, track):
        return Complaint.objects.select_related(
            "citizen", "assigned_officer", "category", "department", "location").get(pk=track.complaint_id)

    def _touch(self, moment, *users):
        """Remember each user's latest activity (becomes ``last_login``)."""
        for user in users:
            if user is not None:
                self.last_seen[user.pk] = max(self.last_seen.get(user.pk, moment), moment)

    # --- event handlers ---------------------------------------------------------------------------------------------
    def _on_submit(self, moment, track):
        """The citizen submits the complaint form (ComplaintCreateSerializer -> submit_complaint -> AI pipeline)."""
        from apps.complaints.serializers import ComplaintCreateSerializer
        from apps.complaints.services.submission import submit_complaint

        citizen = self.citizens[track.citizen]
        place = track.place
        payload = {
            "description": track.description, "latitude": place["latitude"], "longitude": place["longitude"],
            "address": place["address"], "landmark": place["landmark"], "area": place["area"],
            "city": place["city"], "pincode": place["pincode"], "title": track.title,
            "incident_at": moment - hours(track.incident_hours),
        }
        if track.reported:
            payload["category"] = track.reported
        if track.photo is not None:
            payload["image"] = self.photos.upload(track.photo["file"], moment - hours(min(track.incident_hours, 0.5)))
        last_alert = HotspotAlert.objects.aggregate(last=Max("pk"))["last"] or 0
        serializer = ComplaintCreateSerializer(data=payload)
        serializer.is_valid(raise_exception=True)
        data = dict(serializer.validated_data)
        image = data.pop("image", None)
        complaint, _ = submit_complaint(citizen=citizen, data=data, image=image)
        track.complaint_id = complaint.pk
        self._touch(moment, citizen)
        original = self.by_index[track.original] if track.original is not None else None
        same_issue = set()  # the original and its other re-reports report the same issue
        if original is not None:
            track.flagged = DuplicateComplaint.objects.filter(
                complaint_id=complaint.pk, similar_complaint_id=original.complaint_id).exists()
            same_issue = {original.complaint_id} | {self.by_index[index].complaint_id for index in original.re_reports}
        # pairs the engine flagged with a different issue nearby: the administrator marks them "not a duplicate"
        # after a look at both reports
        incidental = DuplicateComplaint.objects.filter(complaint_id=complaint.pk, status=D.PENDING_REVIEW).exclude(
            similar_complaint_id__in=[pk for pk in same_issue if pk])
        for pair_id in incidental.values_list("pk", flat=True):
            self._schedule(moment + hours(track.rng.uniform(*REVIEW_HOURS)), "dismiss", track, pair_id=pair_id)
        for alert in HotspotAlert.objects.filter(pk__gt=last_alert):  # raised by this submission's hotspot check
            if alert.created_at < self.anchor - ACK_ALERTS_OLDER_THAN:
                self._schedule(alert.created_at + hours(self.rng.uniform(3, 48)), "acknowledge", None,
                               alert_id=alert.pk)
        self._plan_lifecycle(track, self._complaint(track))

    def _plan_lifecycle(self, track, complaint, *, begin=None):
        """Schedule the rest of a complaint's story from ``begin`` (default: just after its submission). Durations
        follow its real SLA (which depends on the AI's category and priority): most resolutions land inside the
        SLA, some are late. Events after the end of the history are dropped, so a recent report simply is still
        open (assigned, accepted or in progress) at the end."""
        rng = track.rng
        t0 = complaint.created_at
        window = hours_between(t0, self.anchor)
        sla = hours_between(t0, complaint.sla_due_at) if complaint.sla_due_at else 72.0
        outcome = track.outcome
        if begin is None:
            begin = t0
            if not complaint.assigned_officer_id and outcome != "merged":
                self._schedule(t0 + hours(rng.uniform(0.4, 3.0)), "assign", track)
            if track.review:
                review_at = t0 + hours(track.review_hours)
                self._schedule(review_at, "review", track)
                if outcome == "merged":  # the administrator merges it into the original
                    return
                begin = review_at + hours(rng.uniform(0.2, 1.0))
        if outcome in ("merged", "pending"):
            return
        if outcome == "rejected":
            self._schedule(begin + hours(rng.uniform(1.0, max(1.2, min(30.0, window * 0.8)))), "reject", track)
            return
        if outcome in ("accepted", "in_progress"):  # showcase stages still open at the end of the history
            accept = begin + hours(rng.uniform(0.2, 0.55) * min(window, 20.0))
            self._schedule(accept, "accept", track)
            if outcome == "in_progress":
                remaining = min(hours_between(accept, self.anchor), 30.0)
                self._schedule(accept + hours(rng.uniform(0.25, 0.9) * remaining), "start", track)
            return

        if track.role == "critical":  # crews rush to a critical hazard
            resolution = max(1.2, sla * rng.uniform(WITHIN_SLA_FRACTION[0] * 0.5, CRITICAL_SLA_CAP))
        else:
            resolution = self._resolution_hours(rng, sla, cap=ORIGINAL_SLA_CAP if track.re_reports else None)
        earliest = hours_between(t0, begin) + 1.0
        if track.hold_until is not None:
            earliest = max(earliest, hours_between(t0, track.hold_until))
        resolution = max(resolution, earliest)
        if track.role in SHOWCASE_ROLES:  # showcase stories reach their planned end inside the history
            room = window - FOLLOW_UP_HOURS["reworked" if track.rework else outcome]
            if room < max(1.5, earliest) and outcome in ("reopened", "closed"):
                outcome = track.outcome = "awaiting_feedback"
                room = window - FOLLOW_UP_HOURS[outcome]
            if room < max(1.0, earliest):  # too recent to have been fixed already
                track.outcome = "in_progress"
                self._schedule(t0 + hours(window * 0.3), "accept", track)
                self._schedule(t0 + hours(window * 0.6), "start", track)
                return
            if resolution > room:
                resolution = max(earliest, room * rng.uniform(0.7, 0.97))
        if track.path == "review_pending":
            resolution = max(earliest, window - rng.uniform(*REVIEW_PENDING_HOURS))
        resolve_at = t0 + hours(resolution)
        accept = begin + (resolve_at - begin) * rng.uniform(0.04, 0.2)
        start = accept + (resolve_at - accept) * rng.uniform(0.15, 0.55)
        self._schedule(accept, "accept", track)
        self._schedule(start, "start", track)
        if track.path == "sent_back":
            first = start + (resolve_at - start) * rng.uniform(0.35, 0.6)
            self._schedule(first, "resolve", track, after="unchanged")
            self._schedule(first + (resolve_at - first) * rng.uniform(0.2, 0.45), "send_back", track)
        self._schedule(resolve_at, "resolve", track,
                       after="angle" if track.path in ("angle", "review_pending") else "repaired", final=True)

    @staticmethod
    def _resolution_hours(rng, sla, *, cap=None):
        """Planned hours from submission to resolution: inside the SLA (a share of it) or late."""
        if rng.random() < WITHIN_SLA_RATE:
            low, high = WITHIN_SLA_FRACTION
            return max(1.2, sla * rng.uniform(low, min(high, cap) if cap else high))
        return min(MAX_RESOLUTION_HOURS, max(sla + 1.0, sla * rng.uniform(*LATE_SLA_FRACTION)))

    def _assign_now(self, complaint, moment):
        """The administrator assigns the recommended officer (when nobody could be assigned automatically)."""
        from apps.assignments.services import assign_officer, recommend_officers

        with self.clock.at(moment):
            ranked = [item for item in recommend_officers(complaint, limit=None)
                      if item["officer"].pk != complaint.assigned_officer_id]
            best = next((item for item in ranked if item["recommended"]), None) or next(
                (item for item in ranked if item["is_available"]), None)
            if best is None:
                return None
            note = demo.LEAVE_REASSIGN_NOTE if complaint.assigned_officer_id else "Assigned by the administrator."
            assignment = assign_officer(complaint, best["officer"], assigned_by=self.admin,
                                        assignment_type=ComplaintAssignment.Type.MANUAL, notes=note)
        self._touch(moment, self.admin)
        return assignment

    def _work_on(self, track, moment, target):
        """Bring an open complaint forward to ``target`` (accepted / in progress): assignment by the admin when
        nobody is assigned, then the officer's acceptance and start of work, a few minutes apart. Returns the
        simulated time of the last step, or None when the complaint cannot be worked on."""
        from apps.complaints.services.status import accept_complaint, start_work

        rng = track.rng
        for _ in range(6):
            complaint = self._complaint(track)
            status = complaint.status
            if status == target or (target == S.ACCEPTED and status == S.IN_PROGRESS):
                return moment
            if status not in Complaint.OPEN_STATUSES:
                return None
            on_leave = complaint.assigned_officer_id and not OfficerProfile.objects.filter(
                user_id=complaint.assigned_officer_id, is_available=True).exists()
            if not complaint.assigned_officer_id or status in (S.SUBMITTED, S.ANALYZED) or on_leave:
                if self._assign_now(complaint, moment) is None:
                    return None
            else:
                officer = complaint.assigned_officer
                slug = complaint.category.slug if complaint.category_id else track.slug
                with self.clock.at(moment):
                    if status in (S.ASSIGNED, S.REOPENED):
                        accept_complaint(complaint, actor=officer, remarks=rng.choice(demo.ACCEPT_REMARKS))
                    else:
                        start_work(complaint, actor=officer, remarks=rng.choice(demo.START_REMARKS[slug]))
                self._touch(moment, officer)
            moment += timedelta(minutes=rng.uniform(2, 6))
        return None

    def _on_assign(self, moment, track):
        complaint = self._complaint(track)
        if not complaint.assigned_officer_id and complaint.status in (S.ANALYZED, S.REOPENED):
            self._assign_now(complaint, moment)

    def _on_accept(self, moment, track):
        self._work_on(track, moment, S.ACCEPTED)

    def _on_start(self, moment, track):
        self._work_on(track, moment, S.IN_PROGRESS)

    def _on_resolve(self, moment, track, after="repaired", final=False):
        """The officer uploads before/after photos and resolves; the AI verification runs automatically."""
        from apps.complaints.services.status import resolve_complaint
        from apps.complaints.services.verification import upload_evidence

        if self._complaint(track).status in (S.RESOLVED, S.VERIFIED, S.CLOSED, S.REJECTED):
            return
        moment = self._work_on(track, moment, S.IN_PROGRESS)
        if moment is None:
            return
        complaint = self._complaint(track)
        officer = complaint.assigned_officer
        rng = track.rng
        slug = complaint.category.slug if complaint.category_id else track.slug
        scene = self.photos.scene(slug, track.photo, track.index, generated=track.demo_pair)
        after_photo = self.photos.after_photo(scene, slug, after)
        if after_photo is not None:
            first_upload = not ResolutionEvidence.objects.filter(complaint=complaint).exists()
            remarks = "Before and after photos from the site." if first_upload else "New after photo."
            if scene["generated"]:
                remarks += " (Demo data: generated sample photos.)"
            with self.clock.at(moment):
                upload_evidence(
                    complaint, actor=officer,
                    before_image=self.photos.upload(scene["file"], moment) if first_upload else None,
                    after_image=self.photos.upload(after_photo, moment + timedelta(minutes=1)), remarks=remarks)
        resolved_at = moment + timedelta(minutes=rng.uniform(2, 8))
        with self.clock.at(resolved_at):
            resolve_complaint(complaint, actor=officer, remarks=rng.choice(demo.RESOLVE_REMARKS[slug]))
        self._touch(resolved_at, officer)
        complaint = self._complaint(track)
        if complaint.status == S.VERIFIED:
            self._schedule_follow_ups(track, complaint.verified_at)
        elif complaint.status == S.RESOLVED and final and after_photo is None:
            # no after photo, so no AI verification: the administrator verifies the work on a site visit, before
            # the end of the history (every resolution has a verification)
            visit = resolved_at + hours(rng.uniform(1.0, 8.0))
            if visit > self.anchor:
                visit = resolved_at + max(self.anchor - resolved_at, timedelta(0)) * rng.uniform(0.3, 0.8)
            self._schedule(visit, "admin_verify", track, explanation=rng.choice(demo.SITE_VISIT_VERIFIED_REMARKS))
        elif complaint.status == S.RESOLVED and final and track.path != "review_pending":
            self._schedule(resolved_at + hours(rng.uniform(2, 18)), "admin_verify", track,
                           explanation=rng.choice(demo.MANUAL_VERIFIED_REMARKS))

    def _on_admin_verify(self, moment, track, explanation):
        """The administrator reviews a resolution the AI could not confirm and verifies it manually."""
        from apps.complaints.services.verification import manual_verification

        complaint = self._complaint(track)
        if complaint.status != S.RESOLVED:
            return
        manual_verification(complaint, actor=self.admin, status=ResolutionVerification.Status.LIKELY_RESOLVED,
                            explanation=explanation)
        self._touch(moment, self.admin)
        complaint = self._complaint(track)
        if complaint.status == S.VERIFIED:
            self._schedule_follow_ups(track, complaint.verified_at)

    def _on_send_back(self, moment, track):
        """The AI found the issue still visible (or, without an after photo, the site visit did); the administrator
        sends the work back."""
        from apps.complaints.services.verification import current_after_evidence, manual_verification

        complaint = self._complaint(track)
        if complaint.status != S.RESOLVED:
            return
        remarks = demo.SENT_BACK_REMARKS if current_after_evidence(complaint) else demo.SENT_BACK_SITE_REMARKS
        manual_verification(complaint, actor=self.admin, status=ResolutionVerification.Status.NOT_RESOLVED,
                            explanation=track.rng.choice(remarks))
        self._touch(moment, self.admin)

    def _schedule_follow_ups(self, track, verified_at):
        """What the citizen does after a verified fix: rate it (the complaint closes), or - for a reopened story -
        reopen it within the reopen window (a regular one is then reworked and rated after the second fix)."""
        rng = track.rng
        outcome = track.outcome
        showcase = track.role in SHOWCASE_ROLES
        if outcome == "reopened" and "reopen" not in track.events:
            if not track.rework:  # reopened during the last day and waiting for the officer
                reopen_at = max(verified_at + hours(1.0), self.anchor - hours(rng.uniform(4.0, 20.0)))
            elif showcase:  # reopened after a few days, leaving time for the second fix
                reopen_at = verified_at + timedelta(days=rng.uniform(1.5, 3.5))
            else:
                reopen_at = verified_at + timedelta(days=rng.uniform(1.0, 6.0))
            if rng.random() < 0.5:
                self._schedule(verified_at + (reopen_at - verified_at) * rng.uniform(0.2, 0.6), "feedback", track,
                               unhappy=True)
            self._schedule(reopen_at, "reopen", track)
            return
        if outcome == "closed" or (outcome == "reopened" and (showcase or rng.random() < 0.8)):
            delay = rng.uniform(1.0, 48.0)
            if showcase:
                delay = min(delay, max(0.3, hours_between(verified_at, self.anchor) * 0.8))
            self._schedule(verified_at + hours(delay), "feedback", track)

    def _on_feedback(self, moment, track, unhappy=False):
        """The citizen rates the resolution (sentiment by the AI); the complaint closes."""
        from apps.feedback.services import submit_feedback

        complaint = self._complaint(track)
        if complaint.status not in (S.RESOLVED, S.VERIFIED):
            return
        rng = track.rng
        hours_taken = hours_between(complaint.created_at, complaint.resolved_at or moment)
        sla = hours_between(complaint.created_at, complaint.sla_due_at) if complaint.sla_due_at else 72.0
        rating = self._rating(rng, hours_taken / max(sla, 1.0), unhappy=unhappy, reopened=complaint.reopen_count > 0)
        submit_feedback(complaint, citizen=complaint.citizen, rating=rating, text=self._feedback_text(rng, rating))
        self._touch(moment, complaint.citizen)

    @staticmethod
    def _rating(rng, ratio, *, unhappy=False, reopened=False):
        """Star rating correlated with how fast the issue was fixed relative to its SLA (even a quick fix gets an
        average rating now and then - the quality of the repair matters too)."""
        if unhappy:
            table = {1: 45, 2: 40, 3: 15}
        elif reopened:
            table = {2: 30, 3: 40, 4: 25, 5: 5}
        elif ratio <= 0.5:
            table = {5: 52, 4: 32, 3: 13, 2: 3}
        elif ratio <= 1.0:
            table = {5: 30, 4: 38, 3: 22, 2: 8, 1: 2}
        elif ratio <= 2.0:
            table = {5: 8, 4: 25, 3: 35, 2: 22, 1: 10}
        else:
            table = {4: 10, 3: 25, 2: 35, 1: 30}
        return weighted_choice(rng, table)

    @staticmethod
    def _feedback_text(rng, rating):
        if rng.random() < 0.08:
            return ""
        if rating >= 4:
            tone = weighted_choice(rng, {"positive": 88, "neutral": 12})
        elif rating == 3:
            tone = weighted_choice(rng, {"neutral": 75, "positive": 15, "negative": 10})
        else:
            tone = weighted_choice(rng, {"negative": 85, "neutral": 15})
        return rng.choice(demo.FEEDBACK_TEXTS[tone])

    def _on_reopen(self, moment, track):
        """The citizen reopens within the reopen window (the issue came back); the officer reworks it."""
        from apps.complaints.services.status import reopen_complaint

        complaint = self._complaint(track)
        if complaint.status not in (S.RESOLVED, S.VERIFIED, S.CLOSED) or complaint.resolved_at is None:
            return
        slug = complaint.category.slug if complaint.category_id else track.slug
        reopen_complaint(complaint, actor=complaint.citizen, reason=track.rng.choice(demo.REOPEN_REASONS[slug]))
        self._touch(moment, complaint.citizen)
        if track.rework:
            rng = track.rng
            accept = moment + hours(rng.uniform(1.5, 12))
            start = accept + hours(rng.uniform(1, 8))
            self._schedule(accept, "accept", track)
            self._schedule(start, "start", track)
            self._schedule(start + hours(rng.uniform(3, 30)), "resolve", track, after="repaired", final=True)

    def _on_reject(self, moment, track):
        """The assigned officer rejects a complaint outside the department's remit (with remarks)."""
        from apps.complaints.services.status import reject_complaint

        complaint = self._complaint(track)
        if complaint.status not in Complaint.OPEN_STATUSES:
            return
        officer = complaint.assigned_officer
        actor = officer if officer is not None and complaint.status in (S.ASSIGNED, S.ACCEPTED) else self.admin
        reject_complaint(complaint, actor=actor, remarks=track.rng.choice(demo.REJECT_REMARKS))
        self._touch(moment, actor)

    def _on_review(self, moment, track):
        """The administrator reviews the potential duplicate flagged by the AI (confirmed / not a duplicate). An
        original that was already fixed cannot absorb a new report, so such a re-report is kept as a recurrence
        and handled on its own."""
        from apps.complaints.services.duplicates import review_duplicate

        original = self.by_index[track.original]
        link = DuplicateComplaint.objects.filter(
            complaint_id=track.complaint_id, similar_complaint_id=original.complaint_id,
            status=D.PENDING_REVIEW).first()
        decision = track.review
        if link is not None:
            notes = track.rng.choice(demo.DUPLICATE_CONFIRMED_NOTES if decision == D.CONFIRMED_DUPLICATE
                                     else demo.NOT_DUPLICATE_NOTES)
            if decision == D.CONFIRMED_DUPLICATE and Complaint.objects.filter(
                    pk=original.complaint_id, status__in=Complaint.RESOLVED_STATUSES).exists():
                decision, notes = D.NOT_DUPLICATE, demo.RECURRENCE_NOTE
            review_duplicate(link, status=decision, actor=self.admin, notes=notes)
            self._touch(moment, self.admin)
        if track.outcome == "merged" and (link is None or decision == D.NOT_DUPLICATE):
            track.outcome = "closed" if track.rng.random() < FEEDBACK_RATE else "awaiting_feedback"
            self._plan_lifecycle(track, self._complaint(track), begin=moment + hours(track.rng.uniform(0.2, 1.0)))

    def _on_dismiss(self, moment, track, pair_id):
        """The administrator marks a pair the engine flagged by coincidence as "not a duplicate"."""
        from apps.complaints.services.duplicates import review_duplicate

        link = DuplicateComplaint.objects.filter(pk=pair_id, status=D.PENDING_REVIEW).first()
        if link is None:
            return
        review_duplicate(link, status=D.NOT_DUPLICATE, actor=self.admin,
                         notes=track.rng.choice(demo.NOT_DUPLICATE_NOTES))
        self._touch(moment, self.admin)

    def _on_acknowledge(self, moment, track, alert_id):
        """The administrator acknowledges a hotspot alert (as ``PATCH /api/analytics/alerts/{id}/`` does)."""
        alert = HotspotAlert.objects.filter(pk=alert_id, is_acknowledged=False).first()
        if alert is None:
            return
        alert.is_acknowledged = True
        alert.save(update_fields=["is_acknowledged"])
        log_action(self.admin, AuditLog.Action.UPDATE, entity=alert,
                   description=f"Hotspot alert acknowledged: {alert.area_name}"[:255],
                   changes={"is_acknowledged": [False, True]})
        self._touch(moment, self.admin)

    def _on_leave(self, moment, track, officer_id):
        """An officer goes on leave: marked unavailable, and the admin reassigns the open work orders."""
        from apps.assignments.services import assign_officer, recommend_officers

        profile = OfficerProfile.objects.select_related("user").get(user_id=officer_id)
        profile.is_available = False
        profile.save(update_fields=["is_available", "updated_at"])
        log_action(self.admin, AuditLog.Action.UPDATE, entity=profile.user,
                   description=f"Updated officer {profile.user.email}", changes={"is_available": [True, False]})
        open_work = Complaint.objects.filter(assigned_officer_id=officer_id,
                                             status__in=Complaint.OPEN_ASSIGNED_STATUSES).order_by("created_at")
        for position, complaint in enumerate(open_work):
            with self.clock.at(moment + timedelta(minutes=2 + 1.5 * position)) as when:
                best = next((item for item in recommend_officers(complaint, limit=None)
                             if item["recommended"] and item["officer"].pk != officer_id), None)
                if best is None:
                    continue
                assign_officer(complaint, best["officer"], assigned_by=self.admin,
                               assignment_type=ComplaintAssignment.Type.MANUAL, notes=demo.LEAVE_REASSIGN_NOTE)
            self._touch(when, self.admin)

    # --- after the simulation -----------------------------------------------------------------------------------------
    def _showcase_guarantees(self, total):
        """The officer walkthrough uses roads.officer1: in the full dataset the administrator rebalances work so that
        officer has a mixed open queue (assigned, accepted, in progress) of at least six including a critical one."""
        if total < 100:
            return
        from apps.assignments.services import assign_officer
        from apps.complaints.services.status import accept_complaint, start_work

        officer = self.officers[f"roads.officer1{DEMO_DOMAIN}"]
        moment = self.anchor - hours(2)

        def queue():
            return Complaint.objects.filter(assigned_officer=officer, status__in=WORKING_STATUSES)

        def others():
            return Complaint.objects.filter(department__code="ROADS", status__in=WORKING_STATUSES).exclude(
                assigned_officer=officer)

        def step():
            nonlocal moment
            moment += timedelta(minutes=7)
            return moment

        def take(complaint):
            if complaint is None:
                return False
            with self.clock.at(step()) as when:
                assign_officer(complaint, officer, assigned_by=self.admin,
                               assignment_type=ComplaintAssignment.Type.MANUAL, notes=demo.WORKLOAD_REASSIGN_NOTE)
            self._touch(when, self.admin)
            return True

        if not queue().filter(priority_level=Level.CRITICAL).exists():
            take(others().filter(priority_level=Level.CRITICAL).order_by("created_at").first())
        while queue().count() < 6 and take(others().order_by("-priority_score", "created_at").first()):
            pass
        if not queue().filter(status=S.IN_PROGRESS).exists():
            target = queue().filter(status=S.ACCEPTED).first() or queue().filter(status=S.ASSIGNED).first()
            if target is not None and target.status == S.ASSIGNED:
                with self.clock.at(step()):
                    accept_complaint(target, actor=officer)
            if target is not None:
                with self.clock.at(step()) as when:
                    start_work(target, actor=officer)
                self._touch(when, officer)
        if not queue().filter(status=S.ACCEPTED).exists():
            if queue().filter(status=S.ASSIGNED).count() < 2:
                take(others().order_by("-created_at").first())
            target = queue().filter(status=S.ASSIGNED).order_by("created_at").first()
            if target is not None:
                with self.clock.at(step()) as when:
                    accept_complaint(target, actor=officer)
                self._touch(when, officer)
        if not queue().filter(status=S.ASSIGNED).exists():
            take(others().order_by("-created_at").first())

    def _housekeeping(self):
        """Users have read most of their older notifications; last logins follow each user's latest activity."""
        rng = self.rng
        cutoff = self.anchor - hours(24)
        updates = []
        for user in User.objects.filter(email__iendswith=DEMO_DOMAIN).order_by("pk"):
            older = list(Notification.objects.filter(user=user, is_read=False, created_at__lt=cutoff).order_by("pk"))
            for notification in rng.sample(older, round(len(older) * 0.6)):
                notification.is_read = True
                notification.read_at = min(notification.created_at + hours(rng.uniform(0.15, 30)),
                                           self.anchor - timedelta(minutes=5))
                updates.append(notification)
        Notification.objects.bulk_update(updates, ["is_read", "read_at"], batch_size=500)
        for user_id, seen in self.last_seen.items():
            User.objects.filter(pk=user_id).update(last_login=seen)
        self.notifications_marked_read = len(updates)

    def _final_checks(self):
        """SLA due dates recomputed with ``compute_sla_due()``, no wall-clock timestamp leaked into the history, then
        the periodic tasks run for real (now): SLA breach alerts and the city-wide DBSCAN hotspot scan."""
        from apps.analytics.tasks import scan_hotspots
        from apps.complaints.tasks import check_sla_breaches

        corrected = 0
        for complaint in Complaint.objects.filter(citizen__email__iendswith=DEMO_DOMAIN).select_related(
                "category__department", "department"):
            due = complaint.compute_sla_due()
            if complaint.sla_due_at != due:
                Complaint.objects.filter(pk=complaint.pk).update(sla_due_at=due)
                corrected += 1
        self.sla_corrected = corrected
        leaks = self._timestamp_leaks()
        if leaks:
            raise CommandError("Wall-clock timestamps leaked into the simulated history: " + ", ".join(leaks))
        self.sla_alerts = check_sla_breaches()
        self.hotspot_alerts = scan_hotspots()

    def _timestamp_leaks(self):
        """Demo rows stamped after the end of the simulated history (a code path that bypassed the clock)."""
        limit = self.anchor + ANCHOR_MARGIN / 2
        seeded = Q(complaint__citizen__email__iendswith=DEMO_DOMAIN)
        checks = [
            (Complaint, Q(citizen__email__iendswith=DEMO_DOMAIN),
             ["created_at", "updated_at", "accepted_at", "resolved_at", "verified_at", "closed_at"]),
            (StatusHistory, seeded, ["timestamp"]), (AIPrediction, seeded, ["created_at"]),
            (PriorityScore, seeded, ["created_at"]), (DuplicateComplaint, seeded, ["created_at", "reviewed_at"]),
            (ComplaintAssignment, seeded, ["assigned_at", "accepted_at", "completed_at"]),
            (ResolutionEvidence, seeded, ["uploaded_at"]), (ResolutionVerification, seeded, ["verified_at"]),
            (Feedback, seeded, ["created_at"]),
            (Notification, Q(user__email__iendswith=DEMO_DOMAIN), ["created_at", "read_at"]),
            (AuditLog, Q(actor__email__iendswith=DEMO_DOMAIN), ["created_at"]),
            (User, Q(email__iendswith=DEMO_DOMAIN), ["date_joined", "last_login"]),
        ]
        leaks = []
        for model, scope, names in checks:
            for name in names:
                count = model.objects.filter(scope, **{f"{name}__gt": limit}).count()
                if count:
                    leaks.append(f"{model.__name__}.{name} ({count} rows)")
        return leaks

    # --- report -------------------------------------------------------------------------------------------------------
    def _summary(self, options):
        from apps.analytics.services import active_alerts, mean_hours, resolution_frame, sla_compliance

        complaints = Complaint.objects.filter(citizen__email__iendswith=DEMO_DOMAIN)
        now = timezone.now()
        month_ago = now - timedelta(days=30)

        def counts(queryset, field_name):
            return dict(queryset.order_by().values_list(field_name).annotate(n=Count("id")))

        def share(part, whole):
            return round(100.0 * part / whole, 1) if whole else 0.0

        pairs = DuplicateComplaint.objects.filter(complaint__in=complaints)
        deliberate = [t for t in self.tracks if t.original is not None]
        feedback = Feedback.objects.filter(complaint__in=complaints)
        ratings = list(feedback.values_list("rating", flat=True))
        frame = resolution_frame(complaints)
        open_q = Q(status__in=Complaint.OPEN_STATUSES)
        total = complaints.count()
        open_count = complaints.filter(open_q).count()
        overdue = complaints.filter(open_q, sla_due_at__lt=now).count()
        recent = complaints.filter(created_at__gte=month_ago).count()
        officer1 = self.officers[f"roads.officer1{DEMO_DOMAIN}"]
        officer1_queue = Complaint.objects.filter(assigned_officer=officer1, status__in=WORKING_STATUSES)
        main = self.citizens[demo.MAIN_CITIZEN_EMAIL]
        mine = Complaint.objects.filter(citizen=main)
        rated = set(Feedback.objects.filter(citizen=main).values_list("complaint_id", flat=True))
        return {
            "seed": options["seed"], "days": options["days"], "mode": get_model_mode(),
            "complaints": total,
            "users": {"officers": len(self.officers), "citizens": len(self.citizens),
                      "unavailable_officers": OfficerProfile.objects.filter(user__email__iendswith=DEMO_DOMAIN,
                                                                            is_available=False).count()},
            "by_status": counts(complaints, "status"), "by_category": counts(complaints, "category__slug"),
            "by_department": counts(complaints, "department__code"),
            "by_priority": counts(complaints, "priority_level"),
            "planned_outcomes": dict(Counter(t.outcome for t in self.tracks)),
            "planned_roles": dict(Counter(t.role for t in self.tracks)),
            "planned_tones": dict(Counter(t.tone for t in self.tracks if t.role in ("regular", "event"))),
            "photos": ComplaintImage.objects.filter(complaint__in=complaints).count(),
            "planned_photos": dict(Counter(("generated" if t.photo["generated"] else "real") if t.photo else "none"
                                           for t in self.tracks)),
            "duplicates": {"flagged": pairs.count(), "by_status": counts(pairs, "status"),
                           "deliberate": len(deliberate), "deliberate_flagged": sum(t.flagged for t in deliberate)},
            "feedback": {"total": len(ratings), "by_sentiment": counts(feedback, "sentiment"),
                         "avg_rating": round(sum(ratings) / len(ratings), 2) if ratings else 0.0,
                         "satisfaction_rate": round(100.0 * sum(r >= 4 for r in ratings) / len(ratings), 1)
                         if ratings else 0.0},
            "history": {"start": complaints.order_by("created_at").values_list("created_at", flat=True).first(),
                        "end": self.anchor},
            "last_30_days": {"submitted": recent, "submitted_share": share(recent, total),
                             "resolved": complaints.filter(status__in=Complaint.RESOLVED_STATUSES,
                                                           resolved_at__gte=month_ago).count()},
            "resolution": {"resolved": len(frame), "avg_hours": mean_hours(frame),
                           "sla_compliance": sla_compliance(frame)},
            "open": open_count, "open_share": share(open_count, total),
            "overdue": overdue, "overdue_share": share(overdue, open_count),
            "overdue_critical": complaints.filter(open_q, sla_due_at__lt=now, priority_level=Level.CRITICAL).count(),
            "needs_review": complaints.filter(needs_manual_review=True).count(),
            "verifications": counts(ResolutionVerification.objects.filter(complaint__in=complaints), "status"),
            "hotspots": {"alerts_total": HotspotAlert.objects.count(), "created_by_final_scan": self.hotspot_alerts,
                         "active": active_alerts().count()},
            "sla_alerts": self.sla_alerts, "sla_due_corrected": self.sla_corrected,
            "notifications": Notification.objects.filter(user__email__iendswith=DEMO_DOMAIN).count(),
            "notifications_marked_read": self.notifications_marked_read,
            "roads_officer1": {"open": counts(officer1_queue, "status"),
                               "critical_open": officer1_queue.filter(priority_level=Level.CRITICAL).count(),
                               "resolved": Complaint.objects.filter(assigned_officer=officer1,
                                                                    status__in=Complaint.RESOLVED_STATUSES).count()},
            "main_citizen": {
                "pending": mine.filter(status__in=[S.SUBMITTED, S.ANALYZED, S.ASSIGNED]).count(),
                "in_progress": mine.filter(status__in=Complaint.IN_PROGRESS_STATUSES).count(),
                "awaiting_feedback": mine.filter(status__in=[S.RESOLVED, S.VERIFIED]).exclude(pk__in=rated).count(),
                "closed_with_feedback": mine.filter(status=S.CLOSED, pk__in=rated).count(),
                "reopened": mine.filter(status=S.REOPENED).count(),
            },
            "failures": list(self.failures),
        }

    def _print_report(self):
        report = self.report
        if self.quiet:
            self.stdout.write(f"seed_demo: {report['complaints']} complaints, SLA compliance "
                              f"{report['resolution']['sla_compliance']}%, {len(report['failures'])} failed steps, "
                              f"{report['seconds']} s")
            return
        out = self.stdout.write
        out(self.style.MIGRATE_HEADING(
            f"\nCivicAI demo data - seed {report['seed']}, {report['complaints']} complaints over {report['days']} "
            f"days, AI mode '{report['mode']}' ({report['seconds']} s)"))
        users = report["users"]
        if report["history"]["start"]:
            start, end = (timezone.localtime(report["history"][key]) for key in ("start", "end"))
            out(f"  History        {start:%d %b %Y %H:%M} - {end:%d %b %Y %H:%M} "
                f"({timezone.get_current_timezone_name()})")
        out(f"  Users          1 admin, {users['officers']} officers ({users['unavailable_officers']} unavailable), "
            f"{users['citizens']} citizens")
        sources = report["planned_photos"]
        out(f"  Complaints     {report['complaints']} ({report['photos']} with a photo: {sources.get('real', 0)} real, "
            f"{sources.get('generated', 0)} generated)")
        out("  Reports        " + self._pairs(report["planned_roles"], ["regular", "event", "main", "critical",
                                                                       "duplicate"])
            + "; regular/storm tone " + self._pairs(report["planned_tones"], ["minor", "standard", "severe"]))
        recent = report["last_30_days"]
        out(f"  Last 30 days   {recent['submitted']} submitted ({recent['submitted_share']}% of all), "
            f"{recent['resolved']} resolved")
        out("  By status      " + self._pairs(report["by_status"], [value for value, _ in S.choices]))
        out("  By category    " + self._pairs(report["by_category"]))
        out("  By department  " + self._pairs(report["by_department"]))
        out("  By priority    " + self._pairs(report["by_priority"], [value for value, _ in Level.choices]))
        duplicates = report["duplicates"]
        out(f"  Duplicates     {duplicates['flagged']} pairs flagged by the AI "
            f"({self._pairs(duplicates['by_status'])}); deliberate re-reports flagged "
            f"{duplicates['deliberate_flagged']}/{duplicates['deliberate']}")
        hotspots = report["hotspots"]
        out(f"  Hotspots       {hotspots['alerts_total']} alerts in total, {hotspots['created_by_final_scan']} "
            f"raised by the final scan, {hotspots['active']} active (unacknowledged, last 30 days)")
        feedback = report["feedback"]
        out(f"  Feedback       {feedback['total']} ({self._pairs(feedback['by_sentiment'])}), average rating "
            f"{feedback['avg_rating']}, satisfaction (4-5 stars) {feedback['satisfaction_rate']}%")
        resolution = report["resolution"]
        out(f"  Resolution     {resolution['resolved']} resolved, average {resolution['avg_hours']} h, SLA compliance "
            f"{resolution['sla_compliance']}%")
        out(f"  Open           {report['open']} ({report['open_share']}% of all; {report['overdue']} overdue = "
            f"{report['overdue_share']}% of open, {report['overdue_critical']} overdue critical); "
            f"{report['needs_review']} flagged for manual review; SLA alerts sent now: {report['sla_alerts']}")
        out("  Verifications  " + self._pairs(report["verifications"]))
        officer1 = report["roads_officer1"]
        out(f"  roads.officer1 open: {self._pairs(officer1['open'])} (critical {officer1['critical_open']}); "
            f"resolved {officer1['resolved']}")
        out("  Main citizen   " + self._pairs(report["main_citizen"]))
        out(f"  Notifications  {report['notifications']} ({report['notifications_marked_read']} marked read)")
        out("  Timings        " + ", ".join(f"{key} {value} s" for key, value in report["timings"].items()))
        if report["failures"]:
            out(self.style.ERROR(f"  {len(report['failures'])} steps failed:"))
            for failure in report["failures"][:20]:
                out(f"    - {failure}")
        self._print_credentials()

    @staticmethod
    def _pairs(counts, order=None):
        keys = [key for key in (order or sorted(counts, key=lambda k: (-counts[k], str(k)))) if counts.get(key)]
        return ", ".join(f"{key or 'none'} {counts[key]}" for key in keys) or "none"

    def _print_credentials(self):
        header = ("Role", "Name", "E-mail", "Password", "Details")
        rows = [("Admin", self.admin.full_name, self.admin.email, demo.ADMIN_ACCOUNT["password"], "superuser")]
        available = dict(OfficerProfile.objects.filter(user__email__iendswith=DEMO_DOMAIN).values_list(
            "user_id", "is_available"))
        for user, profile, _ in self.officer_rows:
            details = f"{profile.department.code if profile.department else '-'} {profile.employee_id}"
            if not available.get(user.pk, True):
                details += " (unavailable)"
            rows.append(("Officer", user.full_name, user.email, demo.OFFICER_PASSWORD, details))
        for index, person in enumerate(demo.CITIZENS):
            email = DemoPlanner.citizen_email(index)
            if email not in self.citizens:
                continue
            note = "main demo citizen" if index == 0 else person["area"]
            rows.append(("Citizen", self.citizens[email].full_name, email, demo.CITIZEN_PASSWORD, note))
        widths = [max(len(str(row[column])) for row in [header, *rows]) for column in range(len(header))]
        line = "  " + "  ".join("{:<%d}" % width for width in widths)
        self.stdout.write(self.style.MIGRATE_HEADING("\nDemo logins"))
        self.stdout.write(line.format(*header))
        self.stdout.write("  " + "  ".join("-" * width for width in widths))
        for row in rows:
            self.stdout.write(line.format(*row))
