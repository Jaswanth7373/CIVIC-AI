"""Configuration, demo accounts and test data for the e2e suite.

Every value can be overridden with an environment variable, so the suite runs against any deployment:

  E2E_BASE_URL            frontend URL                         default http://localhost:5181
  E2E_API_URL             REST API base URL                    default http://localhost:8000/api
  E2E_HEADED=1            show the browser window              E2E_SLOWMO=<ms> slows every action down
  E2E_TRACE=1             record a Playwright trace per test (kept in artifacts/ when the test fails)
  E2E_REDUCED_MOTION      reduce (default) | no-preference     reduced motion renders animations' final state
  E2E_KEEP_DATA=1         keep the complaints / messages the tests create (default: withdraw or close them)
  E2E_ARTIFACTS           failure screenshots, traces, logs    default e2e/artifacts
  E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD, E2E_OFFICER_EMAIL / E2E_OFFICER_PASSWORD,
  E2E_CITIZEN_EMAIL / E2E_CITIZEN_PASSWORD             the demo accounts that log in through the UI
  E2E_REPORTER_PASSWORD   password of the citizen1..citizen15 accounts that file the test complaints
"""
from __future__ import annotations

import os
import random
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

E2E_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = E2E_DIR.parent
SAMPLE_IMAGES = REPO_ROOT / "backend" / "sample_data" / "images"

# Seeded city: Hyderabad. The officer flow files a pothole near this point (Ameerpet, Roads department).
OFFICER_FLOW_POINT = (17.4375, 78.4482)


def env(name: str, default: str) -> str:
    value = os.environ.get(name, "").strip()
    return value or default


def env_flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Account:
    email: str
    password: str
    role: str  # citizen | officer | admin

    @property
    def dashboard_path(self) -> str:
        return f"/{self.role}/dashboard"


@dataclass(frozen=True)
class Accounts:
    admin: Account
    officer: Account  # roads.officer1 (Roads Department)
    citizen: Account  # the main demo citizen with seeded history (read-only checks)
    officer_flow_reporter: Account  # files the complaint the officer resolves
    reassign_reporter: Account  # files the complaint the administrator reassigns
    feedback_reporter: Account  # files the complaint that is resolved and then rated
    original_reporter: Account  # files the original report of the duplicate check
    duplicate_reporter: Account  # reports the same issue again through the UI
    text_reporter: Account  # files a report without a photo
    reject_reporter: Account  # files the complaint the officer rejects
    reopen_reporter: Account  # files the complaint that is resolved and reopened
    override_reporter: Account  # files the complaint whose AI result the administrator corrects
    manual_reporter: Account  # files the complaint the officer verifies manually


def load_accounts() -> Accounts:
    reporter_password = env("E2E_REPORTER_PASSWORD", "Citizen@12345")
    return Accounts(
        admin=Account(env("E2E_ADMIN_EMAIL", "admin@civicai.local"), env("E2E_ADMIN_PASSWORD", "Admin@12345"), "admin"),
        officer=Account(
            env("E2E_OFFICER_EMAIL", "roads.officer1@civicai.local"), env("E2E_OFFICER_PASSWORD", "Officer@12345"), "officer"
        ),
        citizen=Account(
            env("E2E_CITIZEN_EMAIL", "citizen@civicai.local"), env("E2E_CITIZEN_PASSWORD", "Citizen@12345"), "citizen"
        ),
        officer_flow_reporter=Account("citizen1@civicai.local", reporter_password, "citizen"),
        reassign_reporter=Account("citizen3@civicai.local", reporter_password, "citizen"),
        feedback_reporter=Account("citizen4@civicai.local", reporter_password, "citizen"),
        original_reporter=Account("citizen6@civicai.local", reporter_password, "citizen"),
        duplicate_reporter=Account("citizen7@civicai.local", reporter_password, "citizen"),
        text_reporter=Account("citizen8@civicai.local", reporter_password, "citizen"),
        reject_reporter=Account("citizen9@civicai.local", reporter_password, "citizen"),
        reopen_reporter=Account("citizen10@civicai.local", reporter_password, "citizen"),
        override_reporter=Account("citizen11@civicai.local", reporter_password, "citizen"),
        manual_reporter=Account("citizen12@civicai.local", reporter_password, "citizen"),
    )


@dataclass(frozen=True)
class Settings:
    base_url: str
    api_url: str
    headed: bool
    slowmo: int
    trace: bool
    keep_data: bool
    reduced_motion: str
    artifacts: Path
    viewport: tuple[int, int] = (1440, 900)
    action_timeout_ms: int = 20_000
    navigation_timeout_ms: int = 45_000
    # Complaint submission and resolution run the whole AI pipeline; the first call after a server start loads models.
    ai_timeout_ms: int = 180_000

    @classmethod
    def from_env(cls) -> "Settings":
        motion = env("E2E_REDUCED_MOTION", "reduce")
        return cls(
            base_url=env("E2E_BASE_URL", "http://localhost:5181").rstrip("/"),
            api_url=env("E2E_API_URL", "http://localhost:8000/api").rstrip("/"),
            headed=env_flag("E2E_HEADED"),
            slowmo=int(env("E2E_SLOWMO", "0")),
            trace=env_flag("E2E_TRACE"),
            keep_data=env_flag("E2E_KEEP_DATA"),
            reduced_motion=motion if motion in {"reduce", "no-preference"} else "reduce",
            artifacts=Path(env("E2E_ARTIFACTS", str(E2E_DIR / "artifacts"))),
        )


def unique_token() -> str:
    """Short unique marker for data created by one test run, e.g. '0817-3f9a2c'."""
    return f"{time.strftime('%H%M%S')}-{uuid.uuid4().hex[:6]}"


def unique_email(purpose: str) -> str:
    """Throw-away citizen address in the agreed QA namespace (qa.<something>@example.com)."""
    return f"qa.e2e.{purpose}.{uuid.uuid4().hex[:10]}@example.com"


def sample_photo(kind: str = "pothole", index: int | None = None) -> Path:
    """One of the deterministic sample photos in backend/sample_data/images/<kind>/ (index 1-10, random if None)."""
    index = index or random.randint(1, 10)
    path = SAMPLE_IMAGES / kind / f"{kind}_{index:02d}.jpg"
    if not path.is_file():
        raise FileNotFoundError(f"Sample photo missing: {path}")
    return path


def after_photo(issue_photo: Path) -> Path:
    """The 'repaired' version of a sample photo (backend/sample_data/images/after/<name>_after.jpg)."""
    path = SAMPLE_IMAGES / "after" / f"{issue_photo.stem}_after.jpg"
    if not path.is_file():
        raise FileNotFoundError(f"After photo missing: {path}")
    return path


def jitter(point: tuple[float, float], metres: float = 120.0) -> tuple[float, float]:
    """A random point within about `metres` of `point` (keeps repeated runs from stacking on one spot)."""
    dlat = random.uniform(-1, 1) * metres / 111_320
    dlng = random.uniform(-1, 1) * metres / 106_000  # metres per degree of longitude at ~17.4 deg N
    return round(point[0] + dlat, 6), round(point[1] + dlng, 6)
