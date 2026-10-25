"""Browser-side helpers: API response matchers, toasts, text normalisation and the per-page error monitor."""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Callable
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import Locator, Page, Response, expect

COMPLAINT_NUMBER = re.compile(r"CIV-\d{4}-\d{6}")


def normalize(text: str | None) -> str:
    """Collapse runs of whitespace (JSX line breaks, non-breaking spaces) into single spaces."""
    return re.sub(r"\s+", " ", (text or "").replace(" ", " ")).strip()


def parse_int(text: str | None) -> int | None:
    """'1,234' / '1 234' -> 1234; None when the text holds no digits."""
    digits = re.sub(r"[^\d-]", "", text or "")
    return int(digits) if digits not in {"", "-"} else None


def format_hours(hours: float | None) -> str:
    """Python twin of frontend utils/format.formatHours (49.5 -> '2 d 2 h')."""
    if hours is None:
        return "—"
    value = abs(float(hours))
    sign = "-" if float(hours) < 0 else ""
    if value < 1:
        return f"{sign}{max(1, round(value * 60))} min"
    total = int(value + 0.5)  # Math.round
    if total < 24:
        return f"{sign}{total} h"
    days, rest = divmod(total, 24)
    return f"{sign}{days} d {rest} h" if rest else f"{sign}{days} d"


def api_response(
    api_url: str, method: str, path: str, *, params: dict | None = None, absent: tuple[str, ...] = ()
) -> Callable[[Response], bool]:
    """Predicate for page.expect_response: an API call `method` to `<api_url>/<path>` (regex, anchored).

    `params` (optional) must all be present in the query string with these values; `absent` names query
    parameters that must not be there (e.g. a filter that was just cleared).
    """
    base = urlparse(api_url)
    pattern = re.compile(rf"^{re.escape(base.path.rstrip('/'))}/{path.lstrip('/')}$")

    def matches(response: Response) -> bool:
        if response.request.method != method:
            return False
        url = urlparse(response.url)
        if url.netloc != base.netloc or not pattern.match(url.path):
            return False
        query = parse_qs(url.query)
        for key, value in (params or {}).items():
            if query.get(key, [None])[0] != str(value):
                return False
        return not any(key in query for key in absent)

    return matches


def toast(page: Page, title: str) -> Locator:
    """A toast with this exact title (toasts live in the polite live region portal)."""
    region = page.locator('[aria-live="polite"][aria-relevant="additions"]')
    return region.locator('[role="status"], [role="alert"]').filter(has=page.get_by_text(title, exact=True)).first


def expect_toast(page: Page, title: str, timeout: int = 15_000) -> None:
    expect(toast(page, title)).to_be_visible(timeout=timeout)


def card(page: Page, title: str) -> Locator:
    """The Card (a <section>) whose header title is exactly `title` (the innermost matching section)."""
    return page.locator("section").filter(has=page.get_by_role("heading", name=title, exact=True)).last


def seed_script(theme: str, session: dict | None) -> str:
    """Init script for a browser context: theme + JWT pair in localStorage (keys from utils/storage.js).

    It runs once per tab (sessionStorage flag), so a later logout or token rotation in the app is not undone by
    the next navigation.
    """
    values = {"civicai.theme": theme}
    if session:
        values["civicai.access"] = session["access"]
        values["civicai.refresh"] = session["refresh"]
    return (
        "(() => { try {"
        " if (window.sessionStorage.getItem('e2e.seeded')) return;"
        " window.sessionStorage.setItem('e2e.seeded', '1');"
        f" const values = {json.dumps(values)};"
        " for (const [key, value] of Object.entries(values)) window.localStorage.setItem(key, value);"
        " } catch (error) { /* about:blank has no storage */ } })();"
    )


class PageMonitor:
    """Collects what went wrong in a page: uncaught exceptions, console errors, API 5xx and failed requests."""

    def __init__(self, page: Page, api_url: str):
        self.api_url = api_url
        self.page_errors: list[str] = []
        self.console_errors: list[str] = []
        self.server_errors: list[str] = []
        self.failed_requests: list[str] = []
        page.on("pageerror", lambda error: self.page_errors.append(str(error)))
        page.on("console", self._on_console)
        page.on("response", self._on_response)
        page.on("requestfailed", self._on_request_failed)
        page._e2e_monitor = self  # read back by assert_healthy()

    def _on_console(self, message) -> None:
        if message.type == "error":
            self.console_errors.append(message.text)

    def _on_response(self, response: Response) -> None:
        if response.status >= 500:
            self.server_errors.append(f"{response.status} {response.request.method} {response.url}")

    def _on_request_failed(self, request) -> None:
        if request.url.startswith(self.api_url):
            failure = request.failure or "failed"
            if "ERR_ABORTED" not in str(failure):  # cancelled by the app (AbortController, navigation)
                self.failed_requests.append(f"{request.method} {request.url}: {failure}")

    def problems(self) -> list[str]:
        return [f"page error: {text}" for text in self.page_errors] + [f"server error: {text}" for text in self.server_errors] + [
            f"request failed: {text}" for text in self.failed_requests
        ]

    def write_log(self, path: Path) -> None:
        lines = ["# page errors", *self.page_errors, "", "# API 5xx", *self.server_errors, "", "# failed API requests",
                 *self.failed_requests, "", "# console errors", *self.console_errors]
        path.write_text("\n".join(lines), encoding="utf-8")


def assert_healthy(page: Page) -> None:
    """Fail when the page threw an uncaught exception, got an API 5xx or lost an API request."""
    monitor: PageMonitor | None = getattr(page, "_e2e_monitor", None)
    if monitor is None:
        return
    problems = monitor.problems()
    assert not problems, "The page reported errors:\n" + "\n".join(problems)


def complaint_numbers(text: str) -> list[str]:
    return COMPLAINT_NUMBER.findall(text or "")


def row_complaint_numbers(table: Locator) -> list[str]:
    """The complaint number of each body row of a table, in display order (first number in each row)."""
    numbers = []
    for text in table.locator("tbody tr").all_inner_texts():
        found = complaint_numbers(text)
        numbers.append(found[0] if found else "")
    return numbers
