"""Shared building blocks of the complaint service layer.

JSON safety
    The AI engine works with numpy, so its outputs can contain ``numpy.float32``, ``numpy.int64``, arrays,
    tuples or NaN.  Django's ``JSONField`` (and MySQL's JSON column) only accept plain JSON, so
    :func:`json_safe` converts recursively before anything is persisted; :func:`compact_copy` additionally
    rounds floats and truncates very long lists (used for ``AIPrediction.raw_output``).

Step timing
    :class:`StepRecorder` measures every pipeline step with ``time.perf_counter()`` (a monotonic,
    high-resolution clock that is not affected by wall-clock changes) and records
    ``{"key", "label", "status": "done" | "skipped" | "failed", "duration_ms", "detail"}`` - exactly what the
    frontend's "AI analysis" animation replays.

Optional side effects
    Notifications, hotspot checks, civic points and audit rows are *consequences* of a business action, not
    the action itself.  :func:`run_side_effect` executes one inside a database savepoint (a
    ``transaction.atomic()`` nested in the caller's transaction): if it fails, only its own writes are rolled
    back, the failure is logged and reported, and the main action (e.g. the complaint submission) still
    succeeds.
"""
import io
import logging
import math
import os
import time
from collections import namedtuple
from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal
from pathlib import PurePath

import numpy as np
from django.db import transaction
from django.db.models import F

logger = logging.getLogger("apps.complaints")

DONE, SKIPPED, FAILED = "done", "skipped", "failed"

#: Civic points (gamification) awarded to the reporting citizen.
SUBMISSION_POINTS = 10
VERIFIED_RESOLUTION_POINTS = 15

COORDINATE_QUANTUM = Decimal("0.000001")  # Location.latitude/longitude have 6 decimal places
MAX_ERROR_TEXT = 240
TITLE_MAX_LENGTH = 160

SideEffect = namedtuple("SideEffect", ["ok", "result", "error"])


# ---------------------------------------------------------------------------------------------------------------
# JSON safety
# ---------------------------------------------------------------------------------------------------------------
def json_safe(value):
    """Recursively convert ``value`` into plain JSON types (dict / list / str / int / float / bool / None).

    numpy scalars become Python numbers, arrays become lists, tuples/sets become lists, NaN/inf become None,
    datetimes become ISO-8601 strings, ``Decimal`` becomes float and binary payloads (image bytes) are dropped.
    """
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, np.generic):  # numpy scalar: np.float32, np.int64, np.bool_ ...
        return json_safe(value.item())
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, Decimal):
        return json_safe(float(value))
    if isinstance(value, np.ndarray):
        return json_safe(value.tolist())
    if isinstance(value, dict):
        return {_json_key(key): json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [json_safe(item) for item in value]
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, PurePath):
        return str(value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        return None
    return str(value)


def _json_key(key):
    if isinstance(key, np.generic):
        key = key.item()
    return key if isinstance(key, str) else str(key)


def compact_copy(value, *, float_digits=4, max_list=50):
    """JSON-safe copy with floats rounded to ``float_digits`` and lists cut to ``max_list`` items."""

    def _compact(item):
        if isinstance(item, float):
            return round(item, float_digits)
        if isinstance(item, dict):
            return {key: _compact(child) for key, child in item.items()}
        if isinstance(item, list):
            return [_compact(child) for child in item[:max_list]]
        return item

    return _compact(json_safe(value))


# ---------------------------------------------------------------------------------------------------------------
# Numbers
# ---------------------------------------------------------------------------------------------------------------
def clamp(value, low, high):
    return max(low, min(high, value))


def to_float(value, default=0.0):
    """``float(value)``; ``default`` for None, garbage, NaN or infinity."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def to_unit(value, default=0.0):
    """A 0..1 factor (clamped)."""
    return clamp(to_float(value, default), 0.0, 1.0)


def to_score(value, default=0):
    """A 0..100 integer score (rounded, clamped) - the scale of severity, priority and verification scores."""
    return int(round(clamp(to_float(value, default), 0, 100)))


def quantize_coordinate(value):
    """Decimal with the 6 decimal places used by ``Location`` (about 0.1 m)."""
    return Decimal(str(float(value))).quantize(COORDINATE_QUANTUM, rounding=ROUND_HALF_UP)


# ---------------------------------------------------------------------------------------------------------------
# Errors / logging
# ---------------------------------------------------------------------------------------------------------------
def error_text(exc):
    """Short, user-presentable description of an exception (never a traceback)."""
    if isinstance(exc, NotImplementedError):
        return f"component not available yet ({exc})" if str(exc) else "component not available yet"
    message = str(exc).strip() or exc.__class__.__name__
    return message[:MAX_ERROR_TEXT]


def log_failure(what, exc):
    """Log a failed step / side effect: a warning for components that are not implemented yet, otherwise the
    full traceback (so real bugs are visible in the server log)."""
    if isinstance(exc, NotImplementedError):
        logger.warning("%s skipped: %s", what, error_text(exc))
    else:
        logger.error("%s failed: %s", what, error_text(exc), exc_info=exc)


def run_side_effect(what, func, /, *args, **kwargs):
    """Run an optional side effect in its own savepoint. Returns ``SideEffect(ok, result, error)``; never raises.

    ``what`` (a label for the log) and ``func`` are positional-only, so any keyword - including
    ``description=`` for ``log_action`` - is passed through to ``func``.
    """
    try:
        with transaction.atomic():
            result = func(*args, **kwargs)
    except Exception as exc:  # noqa: BLE001 - a side effect must never break the main action
        log_failure(what, exc)
        return SideEffect(False, None, error_text(exc))
    return SideEffect(True, result, "")


# ---------------------------------------------------------------------------------------------------------------
# Step timing
# ---------------------------------------------------------------------------------------------------------------
class StepRecorder:
    """Collects pipeline steps, in execution order, as plain dicts ready for the API.

    Usage::

        recorder = StepRecorder()
        with recorder.step("priority", "Priority scoring", capture=True) as step:
            ...                      # timed with time.perf_counter()
            step.detail = "Priority 72/100 (high)"
        recorder.steps  # [{"key": "priority", "label": ..., "status": "done", "duration_ms": 4, "detail": ...}]

    With ``capture=True`` an exception inside the block is logged, the step is reported as "failed" and the
    pipeline continues; without it the step is recorded and the exception propagates. Work done for the same
    step outside the block (e.g. read-only scoring before a transaction) is added via ``step.extra_ms``.
    """

    def __init__(self, steps=None):
        self.steps = [dict(step) for step in (steps or [])]

    def add(self, key, label, status, duration_ms=0, detail=""):
        entry = {
            "key": key,
            "label": label,
            "status": status,
            "duration_ms": max(0, int(round(to_float(duration_ms)))),
            "detail": detail or "",
        }
        self.steps.append(entry)
        return entry

    def step(self, key, label, *, capture=False):
        return TimedStep(self, key, label, capture=capture)


class TimedStep:
    """Context manager created by :meth:`StepRecorder.step`."""

    def __init__(self, recorder, key, label, *, capture):
        self.recorder = recorder
        self.key = key
        self.label = label
        self.capture = capture
        self.status = DONE
        self.detail = ""
        self.error = None
        self.extra_ms = 0.0
        self._started = 0.0

    @property
    def failed(self):
        return self.status == FAILED

    def skip(self, detail):
        self.status = SKIPPED
        self.detail = detail

    def fail(self, detail):
        self.status = FAILED
        self.detail = detail

    def __enter__(self):
        self._started = time.perf_counter()
        return self

    def __exit__(self, exc_type, exc, traceback):
        elapsed_ms = (time.perf_counter() - self._started) * 1000.0 + self.extra_ms
        suppress = False
        if isinstance(exc, Exception):
            self.error = exc
            self.status = FAILED
            self.detail = f"{self.label} failed: {error_text(exc)}"
            if self.capture:
                log_failure(self.label, exc)
                suppress = True
        self.recorder.add(self.key, self.label, self.status, elapsed_ms, self.detail)
        return suppress


def elapsed_ms(started):
    """Milliseconds since a ``time.perf_counter()`` reading."""
    return (time.perf_counter() - started) * 1000.0


# ---------------------------------------------------------------------------------------------------------------
# Persistence helpers
# ---------------------------------------------------------------------------------------------------------------
def save_fields(instance, *fields):
    """``instance.save(update_fields=...)`` that also refreshes ``updated_at`` (auto_now fields are only written
    when listed in update_fields)."""
    names = list(dict.fromkeys(fields))
    if "updated_at" not in names and any(field.name == "updated_at" for field in instance._meta.concrete_fields):
        names.append("updated_at")
    instance.save(update_fields=names)


def normalize_actor(user):
    """The acting user, or None for the system (anonymous users are never recorded as actors)."""
    if user is None or not getattr(user, "is_authenticated", False):
        return None
    return user


def award_civic_points(user, points):
    """Add civic points to a citizen with an atomic ``F()`` update (safe under concurrent requests)."""
    from apps.accounts.models import CitizenProfile

    if user is None or not points or getattr(user, "role", None) != "citizen":
        return 0
    profile, _ = CitizenProfile.objects.get_or_create(user=user)
    CitizenProfile.objects.filter(pk=profile.pk).update(civic_points=F("civic_points") + points)
    return points


def revoke_civic_points(user, points):
    """Take back civic points (never below 0), e.g. the submission points of a deleted complaint.

    The profile row is locked (``select_for_update``) and the new balance computed in Python: ``civic_points`` is
    an unsigned column on MySQL, where ``civic_points - 10`` on a balance below 10 is an out-of-range error rather
    than a negative number that could be clamped. Returns the number of points actually removed.
    """
    from apps.accounts.models import CitizenProfile

    if user is None or not points or getattr(user, "role", None) != "citizen":
        return 0
    with transaction.atomic():
        profile = CitizenProfile.objects.select_for_update().filter(user=user).first()
        if profile is None:
            return 0
        removed = min(points, profile.civic_points)
        profile.civic_points -= removed
        profile.save(update_fields=["civic_points"])
    return removed


# ---------------------------------------------------------------------------------------------------------------
# API "mini" representations used in the analysis summary (BUILD_SPEC 4.1)
# ---------------------------------------------------------------------------------------------------------------
def category_mini(category):
    if category is None:
        return None
    return {"id": category.pk, "name": category.name, "slug": category.slug, "icon": category.icon,
            "color": category.color}


def department_mini(department):
    if department is None:
        return None
    return {"id": department.pk, "name": department.name, "code": department.code, "icon": department.icon,
            "color": department.color}


def user_mini(user, request=None):
    """UserMini; a citizen viewer never receives someone else's e-mail / phone (``withholds_personal_data``)."""
    from apps.core.permissions import withholds_personal_data
    from apps.core.utils import absolute_media_url

    if user is None:
        return None
    hidden = withholds_personal_data(getattr(request, "user", None), user.pk)
    return {"id": user.pk, "full_name": user.full_name, "email": None if hidden else user.email, "role": user.role,
            "avatar": absolute_media_url(request, user.avatar), "phone": None if hidden else user.phone}


# ---------------------------------------------------------------------------------------------------------------
# Location text / titles
# ---------------------------------------------------------------------------------------------------------------
def describe_location(location):
    """Short human place name: "<landmark>, <area>", else the first part of the address, the city, or the
    coordinates."""
    if location is None:
        return ""
    parts = []
    for value in (location.landmark, location.area):
        value = (value or "").strip()
        if value and value.lower() not in {part.lower() for part in parts}:
            parts.append(value)
    if parts:
        return ", ".join(parts)
    address = (location.address or "").strip()
    if address:
        return ", ".join(piece.strip() for piece in address.split(",")[:2] if piece.strip())
    city = (location.city or "").strip()
    if city:
        return city
    if location.latitude is None or location.longitude is None:
        return ""
    return f"{float(location.latitude):.4f}, {float(location.longitude):.4f}"


def address_text(location):
    """Every address field joined - the free text the location-risk engine scans for high-traffic words."""
    if location is None:
        return ""
    fields = (location.address, location.landmark, location.area, location.city)
    return ", ".join(value.strip() for value in fields if value and value.strip())


#: Words a landmark may already start with ("Opposite the bus stop"); longest first so "in front of" wins over
#: "in". Such a landmark keeps its own preposition instead of getting "near" in front of it.
LOCATIVE_PREFIXES = (
    "in front of", "on the corner of", "at the corner of", "next to", "close to", "adjacent to", "opposite to",
    "across from", "opposite", "near", "nearby", "behind", "beside", "besides", "beneath", "under", "outside",
    "inside", "along", "across", "around", "beyond", "between", "at", "by", "in", "on", "off",
)


def place_phrase(location):
    """The place of a complaint with the right preposition: "near Banjara Hills", or - when the landmark already
    starts with one - "opposite the bus stop, Kacheguda" (never "near Opposite the bus stop"). "" when unknown."""
    place = describe_location(location)
    if not place:
        return ""
    lowered = place.lower()
    for prefix in LOCATIVE_PREFIXES:
        if lowered.startswith(prefix + " "):
            return prefix + place[len(prefix):]
    return f"near {place}"


def build_title(category, location, max_length=TITLE_MAX_LENGTH):
    """Automatic complaint title "<Category name> <place phrase>", e.g. "Roads / Potholes near Banjara Hills" or
    "Roads / Potholes opposite the bus stop, Kacheguda"."""
    name = category.name if category is not None else "Civic issue"
    phrase = place_phrase(location)
    title = f"{name} {phrase}" if phrase else name
    if len(title) > max_length:
        title = title[: max_length - 1].rstrip(" ,") + "…"
    return title


def is_automatic_title(title, category, location, max_length=TITLE_MAX_LENGTH):
    """True when ``title`` is what :func:`build_title` produces for this category and place - including the
    earlier "<Category> near <landmark>" wording that put "near" in front of every landmark - i.e. the system wrote
    it, not a person."""
    if title == build_title(category, location, max_length):
        return True
    name = category.name if category is not None else "Civic issue"
    place = describe_location(location)
    legacy = f"{name} near {place}" if place else name
    if len(legacy) > max_length:
        legacy = legacy[: max_length - 1].rstrip(" ,") + "…"
    return title == legacy


def complaint_subject(complaint):
    """What a complaint is about, with its place, for notification texts.

    Its title (the automatic one already reads "<Category> near <place>") - followed by the place only when the
    title names neither the place nor its landmark or area ("Streetlight off at Road No. 10 bus stop" already says
    where), so a message never repeats the place.
    """
    location = complaint.location if complaint.location_id else None
    subject = (complaint.title or "").strip()
    if not subject:
        return build_title(complaint.category if complaint.category_id else None, location)
    place = describe_location(location)
    if not place:
        return subject
    named = [place] + [value.strip() for value in (location.landmark, location.area) if value and value.strip()]
    if not any(name.lower() in subject.lower() for name in named):
        subject = f"{subject} {place_phrase(location)}"
    return subject


def format_duration(hours):
    """A duration in the UI's style: "45 min", "5 h", "3 d", "21 d 16 h"."""
    minutes = max(0, int(round(to_float(hours) * 60)))
    if minutes < 60:
        return f"{minutes} min"
    whole_hours = minutes // 60
    days, rest = divmod(whole_hours, 24)
    if not days:
        return f"{whole_hours} h"
    return f"{days} d {rest} h" if rest else f"{days} d"


# ---------------------------------------------------------------------------------------------------------------
# Images
# ---------------------------------------------------------------------------------------------------------------
def field_file_path(field_file):
    """Local filesystem path of a stored file, or None (no file, missing file, or remote storage)."""
    if not field_file:
        return None
    try:
        path = field_file.path
    except (NotImplementedError, ValueError):
        return None
    return path if os.path.exists(path) else None


def stored_image_input(field_file):
    """Image input for the AI engine: a filesystem path when possible, otherwise the raw bytes (or None)."""
    if not field_file:
        return None
    path = field_file_path(field_file)
    if path:
        return path
    try:
        with field_file.open("rb") as handle:
            return handle.read()
    except (OSError, ValueError):
        logger.warning("Stored image %s could not be read", getattr(field_file, "name", "?"))
        return None


def read_upload(uploaded_file):
    """Bytes of an uploaded file; the file is rewound so Django can still store it afterwards."""
    if hasattr(uploaded_file, "seek"):
        uploaded_file.seek(0)
    data = uploaded_file.read()
    if hasattr(uploaded_file, "seek"):
        uploaded_file.seek(0)
    return data


def image_hashes(image):
    """Perceptual hashes ``{"phash", "dhash", "ahash", "width", "height"}`` via ``ai.duplicate.compute_hashes``.

    pHash (DCT of a 32x32 greyscale thumbnail) and dHash (gradient signs of a 9x8 thumbnail) are 64-bit
    fingerprints that stay almost identical under resizing / recompression, so a small Hamming distance means
    "same scene". Returns {} when hashing is unavailable (logged) - duplicate detection then relies on text
    and location only.
    """
    if not image:
        return {}
    try:
        from ai.duplicate import compute_hashes

        return json_safe(compute_hashes(image)) or {}
    except Exception as exc:  # noqa: BLE001 - hashing is an enrichment, never a reason to reject an upload
        log_failure("Perceptual image hashing", exc)
        return {}


def image_size(data):
    """(width, height) of encoded image bytes read from the header with Pillow, honouring the EXIF orientation
    (rotated phone photos report swapped dimensions). (0, 0) when unreadable."""
    from PIL import Image

    try:
        with Image.open(io.BytesIO(data)) as img:
            width, height = img.size
            orientation = img.getexif().get(0x0112, 1)  # EXIF "Orientation" tag
    except (OSError, ValueError, SyntaxError):
        return 0, 0
    if orientation in (5, 6, 7, 8):  # 90/270 degree rotations
        width, height = height, width
    return int(width), int(height)
