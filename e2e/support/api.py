"""Small REST client for the CivicAI API, used to prepare and check data around the browser tests.

It runs on Playwright's APIRequestContext, so the suite needs nothing beyond pytest + playwright.
- `login(account)` caches the JWT pair per account for the session (access tokens live 60 minutes), which keeps
  the number of logins far below the `auth` rate limit (20/min by default).
- Every call retries on HTTP 429 after the server's Retry-After, so a busy shared server does not fail setup.
- Errors raise ApiError with the method, URL, status and the response body.
"""
from __future__ import annotations

import base64
import json
import mimetypes
import time
from pathlib import Path
from typing import Any

from .data import Account


class ApiError(AssertionError):
    def __init__(self, method: str, url: str, status: int, body: str):
        self.method, self.url, self.status, self.body = method, url, status, body
        super().__init__(f"{method} {url} -> HTTP {status}: {body[:800]}")


def _jwt_expiry(token: str) -> float:
    """`exp` claim of a JWT (seconds since epoch), 0 when unreadable."""
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        return float(json.loads(base64.urlsafe_b64decode(payload)).get("exp", 0))
    except (IndexError, ValueError, json.JSONDecodeError):
        return 0.0


def file_part(path: Path, name: str | None = None) -> dict[str, Any]:
    """A multipart file field for APIRequestContext (`multipart={'image': file_part(path)}`)."""
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return {"name": name or path.name, "mimeType": mime, "buffer": path.read_bytes()}


def results(payload: Any) -> list:
    """Rows of a paginated response (`{count, results}`) or of a plain array."""
    if isinstance(payload, dict) and "results" in payload:
        return payload["results"]
    return payload if isinstance(payload, list) else []


class CivicApi:
    def __init__(self, playwright, api_url: str, *, timeout_ms: int = 60_000):
        self.api_url = api_url.rstrip("/")
        self._request = playwright.request.new_context(extra_http_headers={"Accept": "application/json"}, timeout=timeout_ms)
        self._sessions: dict[str, dict] = {}

    def close(self) -> None:
        self._request.dispose()

    def url(self, path: str) -> str:
        if path.startswith(("http://", "https://")):
            return path
        return f"{self.api_url}/{path.lstrip('/')}"

    # ---- authentication ------------------------------------------------------------------------------------
    def login(self, account: Account, *, fresh: bool = False, cache: bool = True) -> dict:
        """`{access, refresh, user}` for the account (cached until 5 minutes before the access token expires).

        `cache=False` returns a separate session that nothing else uses (for tests that log out).
        """
        cached = self._sessions.get(account.email)
        if cached and cache and not fresh and _jwt_expiry(cached["access"]) - time.time() > 300:
            return cached
        session = self._send("POST", "auth/login/", body={"email": account.email, "password": account.password}, expected=(200,))
        if cache:
            self._sessions[account.email] = session
        return session

    def token(self, account: Account) -> str:
        return self.login(account)["access"]

    def user(self, account: Account) -> dict:
        return self.login(account)["user"]

    # ---- generic requests ----------------------------------------------------------------------------------
    def request(
        self,
        method: str,
        path: str,
        *,
        account: Account | None = None,
        token: str | None = None,
        params: dict | None = None,
        body: Any = None,
        multipart: dict | None = None,
        expected: tuple[int, ...] | None = (200, 201, 204),
        timeout_ms: int | None = None,
    ) -> Any:
        if account is not None:
            token = self.token(account)
        return self._send(method, path, token=token, params=params, body=body, multipart=multipart, expected=expected, timeout_ms=timeout_ms)

    def get(self, path: str, **kwargs) -> Any:
        return self.request("GET", path, **kwargs)

    def post(self, path: str, **kwargs) -> Any:
        return self.request("POST", path, **kwargs)

    def patch(self, path: str, **kwargs) -> Any:
        return self.request("PATCH", path, **kwargs)

    def put(self, path: str, **kwargs) -> Any:
        return self.request("PUT", path, **kwargs)

    def delete(self, path: str, **kwargs) -> Any:
        return self.request("DELETE", path, **kwargs)

    def cors_allows(self, origin: str) -> bool:
        """True when the API answers a request from `origin` (the frontend) with a matching CORS header."""
        response = self._fetch("GET", "health/", headers={"Origin": origin})
        return response.headers.get("access-control-allow-origin") in {origin, "*"}

    def status_of(self, method: str, path: str, **kwargs) -> tuple[int, Any]:
        """(status, parsed body) without raising - for checks that expect an error response."""
        return self._send_raw(method, path, **kwargs)

    # ---- internals -----------------------------------------------------------------------------------------
    def _send_raw(self, method: str, path: str, *, account: Account | None = None, token: str | None = None, **kwargs) -> tuple[int, Any]:
        if account is not None:
            token = self.token(account)
        response = self._fetch(method, path, token=token, **kwargs)
        return response.status, self._parse(response)

    def _send(self, method: str, path: str, *, token: str | None = None, expected: tuple[int, ...] | None = (200, 201, 204), **kwargs) -> Any:
        response = self._fetch(method, path, token=token, **kwargs)
        status = response.status
        if expected and status not in expected:
            raise ApiError(method, self.url(path), status, response.text())
        return self._parse(response)

    def _fetch(self, method: str, path: str, *, token: str | None = None, params: dict | None = None, body: Any = None,
               multipart: dict | None = None, timeout_ms: int | None = None, headers: dict | None = None):
        headers = {**(headers or {}), **({"Authorization": f"Bearer {token}"} if token else {})}
        options: dict[str, Any] = {"method": method, "headers": headers}
        if params:
            options["params"] = {key: value for key, value in params.items() if value is not None}
        if body is not None:
            headers["Content-Type"] = "application/json"
            options["data"] = json.dumps(body)
        if multipart is not None:
            options["multipart"] = multipart
        if timeout_ms:
            options["timeout"] = timeout_ms
        response = None
        for attempt in range(4):
            response = self._request.fetch(self.url(path), **options)
            if response.status != 429 or attempt == 3:
                break
            # Rate limited (shared server, production throttles): wait as told and try again.
            retry_after = response.headers.get("retry-after") or "10"
            time.sleep(min(float(retry_after) if retry_after.replace(".", "", 1).isdigit() else 10.0, 65.0) + 0.5)
        return response

    @staticmethod
    def _parse(response) -> Any:
        """JSON -> Python data, text -> str, anything else (images, PDF) -> bytes; 204 -> None."""
        if response.status == 204:
            return None
        content_type = response.headers.get("content-type") or ""
        if "json" in content_type:
            text = response.text()
            return json.loads(text) if text else None
        if not content_type or content_type.startswith("text/"):
            return response.text() or None
        return response.body()

    # ---- domain helpers ------------------------------------------------------------------------------------
    def create_complaint(
        self,
        account: Account,
        *,
        description: str,
        latitude: float,
        longitude: float,
        photo: Path | None = None,
        title: str | None = None,
        category: str | None = None,
        area: str | None = None,
        city: str | None = "Hyderabad",
        timeout_ms: int = 180_000,
    ) -> dict:
        """POST /complaints/ as a citizen (multipart, runs the whole AI pipeline) -> ComplaintDetail + analysis.

        `area` / `city` fill the address like the report form's reverse geocoding does, so the generated title
        ("Pothole near Ameerpet") and any hotspot the complaint joins carry a place name.
        """
        fields: dict[str, Any] = {
            "description": description,
            "latitude": f"{latitude:.6f}",
            "longitude": f"{longitude:.6f}",
        }
        if area:
            fields["area"] = area
            fields["address"] = f"{area}, {city}" if city else area
        if city:
            fields["city"] = city
        if title:
            fields["title"] = title
        if category:
            fields["category"] = category
        if photo is not None:
            fields["image"] = file_part(photo)
        return self.post("complaints/", account=account, multipart=fields, expected=(201,), timeout_ms=timeout_ms)

    def assign(self, admin: Account, complaint: dict, officer_id: int, notes: str) -> dict:
        """Assign (POST /assignments/) or reassign (PATCH /assignments/{active}/) a complaint to an officer."""
        current = complaint.get("current_assignment") or {}
        if current.get("is_active") and current.get("id"):
            return self.patch(f"assignments/{current['id']}/", account=admin, body={"officer": officer_id, "notes": notes})
        return self.post("assignments/", account=admin, body={"complaint": complaint["id"], "officer": officer_id, "notes": notes}, expected=(201,))

    def resolve_as_officer(self, officer: Account, complaint_id: int, *, after: Path, remarks: str) -> dict:
        """Accept -> start -> resolve with an after photo (the AI-assisted verification runs) as the assigned officer."""
        self.post(f"complaints/{complaint_id}/accept/", account=officer, body={})
        self.post(f"complaints/{complaint_id}/start/", account=officer, body={})
        return self.post(
            f"complaints/{complaint_id}/resolve/",
            account=officer,
            multipart={"remarks": remarks, "after_image": file_part(after)},
            timeout_ms=180_000,
        )

    def notification_types(self, account: Account, complaint_id: int) -> list[str]:
        """Types of the account's notifications about one complaint, newest first (first 100)."""
        rows = results(self.get("notifications/", account=account, params={"page_size": 100}))
        return [row["notification_type"] for row in rows if row.get("complaint") == complaint_id]

    def withdraw_complaint(self, owner: Account, admin: Account, complaint_id: int, reason: str) -> str:
        """Take a complaint a test created out of every queue, as far as its state allows.

        The owner deletes it while that is allowed; otherwise an administrator closes it (resolved / verified) or
        rejects it with the reason (still open, e.g. reopened). Returns "deleted", "closed", "rejected" or "kept";
        cleanup never fails a test.
        """
        try:
            detail = self.get(f"complaints/{complaint_id}/", account=owner)
            if "delete" in (detail.get("allowed_actions") or []):
                self.delete(f"complaints/{complaint_id}/", account=owner, expected=(204,))
                return "deleted"
            actions = self.get(f"complaints/{complaint_id}/", account=admin).get("allowed_actions") or []
            if "close" in actions:
                self.post(f"complaints/{complaint_id}/close/", account=admin, body={"remarks": reason})
                return "closed"
            if "reject" in actions:
                self.post(f"complaints/{complaint_id}/reject/", account=admin, body={"remarks": reason})
                return "rejected"
        except ApiError:
            pass
        return "kept"
