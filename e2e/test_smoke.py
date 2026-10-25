"""Every page of every role renders: a heading, no uncaught exception, no failed API call (4xx/5xx) and no
horizontal page scroll - on a desktop (1440 px) and on a phone (390 px, touch) (REQUIREMENTS 8, 9; BUILD_SPEC 5.2
quality floor "responsive 360px -> 1920px, no horizontal page scroll")."""
from __future__ import annotations

import re
from urllib.parse import urlparse

import pytest
from playwright.sync_api import expect

from support.api import results

PUBLIC = ["/", "/about", "/features", "/how-it-works", "/contact", "/login", "/register"]
CITIZEN = [
    "/citizen/dashboard",
    "/citizen/report",
    "/citizen/complaints",
    "/citizen/complaints/{citizen_complaint}",
    "/citizen/complaints/{citizen_complaint}/track",
    "/citizen/profile",
    "/citizen/notifications",
    "/citizen/feedback",
]
OFFICER = [
    "/officer/dashboard",
    "/officer/complaints",
    "/officer/complaints/{officer_complaint}",
    "/officer/complaints/{officer_complaint}/resolve",
    "/officer/complaints/{officer_resolved}/verify",
    "/officer/profile",
    "/officer/notifications",
]
ADMIN = [
    "/admin/dashboard",
    "/admin/complaints",
    "/admin/complaints/{officer_complaint}",
    "/admin/duplicates",
    "/admin/users",
    "/admin/officers",
    "/admin/departments",
    "/admin/ai-analytics",
    "/admin/hotspots",
    "/admin/feedback",
    "/admin/reports",
    "/admin/settings",
    "/admin/audit-logs",
    "/admin/profile",
    "/admin/notifications",
]
ROUTES = [("anon", path) for path in PUBLIC] + [("citizen", p) for p in CITIZEN] + [("officer", p) for p in OFFICER] + [
    ("admin", p) for p in ADMIN
]
OVERFLOW_JS = "() => document.documentElement.scrollWidth - window.innerWidth"


@pytest.fixture(scope="session")
def route_ids(api, accounts):
    """Real ids for the parametrised paths: a complaint of the demo citizen, an open and a resolved one of the officer."""
    citizen_rows = results(api.get("complaints/", account=accounts.citizen, params={"page_size": 1}))
    open_rows = results(api.get("complaints/", account=accounts.officer, params={"status": "assigned,accepted,in_progress", "page_size": 1}))
    done_rows = results(api.get("complaints/", account=accounts.officer, params={"status": "resolved,verified,closed", "page_size": 1}))
    assert citizen_rows and open_rows and done_rows, "seeded complaints are missing"
    return {"citizen_complaint": citizen_rows[0]["id"], "officer_complaint": open_rows[0]["id"], "officer_resolved": done_rows[0]["id"]}


@pytest.mark.parametrize("device", ["desktop", "phone"])
@pytest.mark.parametrize(("role", "path"), ROUTES, ids=[f"{role}:{path}" for role, path in ROUTES])
def test_page_renders_cleanly(open_page, settings, accounts, route_ids, role, path, device):
    account = None if role == "anon" else getattr(accounts, role)
    page = open_page(account, phone=device == "phone")
    api_host = urlparse(settings.api_url).netloc
    failed_calls: list[str] = []
    page.on(
        "response",
        lambda response: failed_calls.append(f"{response.status} {response.request.method} {response.url}")
        if urlparse(response.url).netloc == api_host and response.status >= 400
        else None,
    )

    url = path.format(**route_ids)
    page.goto(url, wait_until="networkidle")
    expect(page).to_have_url(re.compile(rf"{re.escape(url)}(\?.*)?$"))  # no redirect away from the page
    # Timing, not a defect: a Vite dev server compiles each lazy page chunk on first request and can take well over
    # the default 15 s when the machine is busy, while the route shows its "Loading..." fallback.
    expect(page.get_by_role("heading", level=1).first).to_be_visible(timeout=45_000)
    page.wait_for_timeout(300)  # late layout shifts (charts, maps) before measuring

    monitor = page._e2e_monitor
    assert not monitor.page_errors, f"uncaught exceptions on {url}: {monitor.page_errors}"
    assert not failed_calls, f"failed API calls on {url}: {failed_calls}"
    overflow = page.evaluate(OVERFLOW_JS)
    assert overflow <= 1, f"{url} scrolls sideways by {overflow}px at {page.viewport_size['width']}px"
