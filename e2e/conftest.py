"""Fixtures of the CivicAI end-to-end suite (pytest + Playwright sync API, no pytest plugin needed).

- `settings`: URLs and switches from the environment - E2E_BASE_URL (frontend, default http://localhost:5181),
  E2E_API_URL (default http://localhost:8000/api) and the others listed in support/data.py.
- `api`: REST client (support/api.py) used to log in, prepare data and check results.
- `open_page(account=None)`: a fresh browser context + page; with an account the JWT pair from an API login is
  seeded into localStorage (`civicai.access` / `civicai.refresh`), so the app starts signed in without typing.
  `anon_page`, `citizen_page`, `officer_page` and `admin_page` are shortcuts.
- On a failed test every page of the test is saved as a full-page screenshot plus a log of page errors, API
  5xx and console errors in e2e/artifacts/ (git-ignored); with E2E_TRACE=1 a Playwright trace as well.
"""
from __future__ import annotations

import re

import pytest
from playwright.sync_api import expect, sync_playwright

from support.api import CivicApi
from support.data import Account, Settings, load_accounts, unique_email
from support.ui import PageMonitor, seed_script


def pytest_report_header(config):
    settings = Settings.from_env()
    return [f"CivicAI e2e: frontend {settings.base_url}  api {settings.api_url}  artifacts {settings.artifacts}"]


@pytest.hookimpl(hookwrapper=True, tryfirst=True)
def pytest_runtest_makereport(item, call):
    """Keep each phase's report on the test item, so fixtures know in teardown whether the test failed."""
    outcome = yield
    report = outcome.get_result()
    setattr(item, f"rep_{report.when}", report)


@pytest.fixture(scope="session")
def settings() -> Settings:
    settings = Settings.from_env()
    settings.artifacts.mkdir(parents=True, exist_ok=True)
    # Generous on purpose: a Vite dev server compiles each lazy page on its first request and can be slow on a busy
    # machine. Passing assertions return at once; only a real failure waits this long.
    expect.set_options(timeout=30_000)
    return settings


@pytest.fixture(scope="session")
def accounts():
    return load_accounts()


@pytest.fixture(scope="session")
def playwright_instance():
    with sync_playwright() as playwright:
        yield playwright


@pytest.fixture(scope="session")
def browser(playwright_instance, settings):
    browser = playwright_instance.chromium.launch(headless=not settings.headed, slow_mo=settings.slowmo)
    yield browser
    browser.close()


@pytest.fixture(scope="session")
def api(playwright_instance, settings):
    client = CivicApi(playwright_instance, settings.api_url)
    status, body = client.status_of("GET", "health/")
    if status != 200:
        pytest.exit(f"The CivicAI API is not reachable at {settings.api_url} (GET /health/ -> {status}: {body}). "
                    "Start the backend first (see e2e/README.md).", returncode=3)
    page_status, _ = client.status_of("GET", settings.base_url + "/", headers={"Accept": "text/html"})
    if page_status != 200:
        pytest.exit(f"The frontend is not reachable at {settings.base_url} (HTTP {page_status}). "
                    "Start it first, e.g. cd frontend && npx vite --port 5181 --strictPort", returncode=3)
    if not client.cors_allows(settings.base_url):
        pytest.exit(f"The API does not allow requests from {settings.base_url} (CORS). Add the origin to "
                    "CORS_ALLOWED_ORIGINS in backend/.env, or see e2e/README.md.", returncode=3)
    yield client
    client.close()


def _test_failed(node) -> bool:
    return any(getattr(node, f"rep_{phase}", None) is not None and getattr(node, f"rep_{phase}").failed for phase in ("setup", "call"))


def _artifact_stem(node, index: int) -> str:
    stem = re.sub(r"[^A-Za-z0-9._-]+", "_", node.nodeid.split("::", 1)[-1]).strip("_")
    return f"{node.module.__name__}__{stem}" + (f"__page{index + 1}" if index else "")


@pytest.fixture
def open_page(browser, api, settings, request):
    """Factory: open_page(account=None, *, viewport=(w, h), theme='light', phone=False, fresh_session=False) -> Page.

    The page's base URL is the frontend. `phone=True` emulates a 390x844 touch phone; `fresh_session=True` logs in
    separately instead of reusing the session-wide cached tokens (for tests that log out).
    """
    opened = []

    def factory(account=None, *, viewport: tuple[int, int] | None = None, theme: str = "light", phone: bool = False,
                fresh_session: bool = False):
        width, height = viewport or ((390, 844) if phone else settings.viewport)
        context = browser.new_context(
            base_url=settings.base_url,
            viewport={"width": width, "height": height},
            reduced_motion=settings.reduced_motion,
            timezone_id="Asia/Kolkata",
            locale="en-IN",
            accept_downloads=True,
            # A phone: touch screen + coarse pointer (the app switches to its mobile controls on `pointer: coarse`).
            is_mobile=phone,
            has_touch=phone,
        )
        if settings.trace:
            context.tracing.start(screenshots=True, snapshots=True)
        context.set_default_timeout(settings.action_timeout_ms)
        context.set_default_navigation_timeout(settings.navigation_timeout_ms)
        session = api.login(account, cache=not fresh_session) if account else None
        context.add_init_script(seed_script(theme, session))
        page = context.new_page()
        PageMonitor(page, settings.api_url)
        page._e2e_session = session  # the JWT pair the page started with
        opened.append((context, page))
        return page

    yield factory

    failed = _test_failed(request.node)
    for index, (context, page) in enumerate(opened):
        stem = _artifact_stem(request.node, index)
        if failed:
            try:
                page.screenshot(path=str(settings.artifacts / f"{stem}.png"), full_page=True)
            except Exception:  # noqa: BLE001 - a closed page must not hide the real failure
                pass
            monitor = getattr(page, "_e2e_monitor", None)
            if monitor is not None:
                monitor.write_log(settings.artifacts / f"{stem}.log")
        if settings.trace:
            try:
                context.tracing.stop(path=str(settings.artifacts / f"{stem}.zip") if failed else None)
            except Exception:  # noqa: BLE001
                pass
        context.close()


@pytest.fixture
def fresh_citizen(api, settings, accounts, request):
    """A citizen registered through the API for this test only (qa.e2e.<test>.<id>@example.com).

    Nobody else uses the account, so its complaint list and notifications contain exactly what the test created.
    It is deactivated afterwards (DELETE /api/users/{id}/ is a soft delete) unless E2E_KEEP_DATA is set.
    """
    purpose = re.sub(r"[^a-z0-9]+", "-", request.node.originalname.lower().removeprefix("test_"))[:24].strip("-")
    account = Account(unique_email(purpose), "Ward-Report-2026!", "citizen")
    created = api.post(
        "auth/register/",
        body={"first_name": "E2E", "last_name": "Citizen", "email": account.email, "password": account.password,
              "confirm_password": account.password},
        expected=(201,),
    )
    yield account
    if not settings.keep_data:
        api.status_of("DELETE", f"users/{created['user']['id']}/", account=accounts.admin)


@pytest.fixture
def anon_page(open_page):
    return open_page()


@pytest.fixture
def citizen_page(open_page, accounts):
    return open_page(accounts.citizen)


@pytest.fixture
def officer_page(open_page, accounts):
    return open_page(accounts.officer)


@pytest.fixture
def admin_page(open_page, accounts):
    return open_page(accounts.admin)
