"""Live smoke test of a running CivicAI API (requests only - no Django imports).

Logs in as an administrator, an officer and a citizen, calls every GET endpoint of docs/BUILD_SPEC.md section 4.2
and the main write flows - submit a complaint with a photo, accept, start work, upload before/after evidence,
resolve, AI verification, citizen feedback, mark a notification read, the public AI demo - and checks the HTTP
status code and the top-level keys of every response. Prints a PASS/FAIL table and exits with status 1 when a
check fails (2 when the server cannot be reached or a login fails).

It CREATES data (a complaint, evidence, feedback ...): run it against a development / staging server or a
throwaway database, never against production data.

Usage (from ``backend/``; passwords may also come from SMOKE_ADMIN_PASSWORD / SMOKE_OFFICER_PASSWORD /
SMOKE_CITIZEN_PASSWORD so they stay out of the shell history)::

    venv/Scripts/python.exe scripts/smoke_test_api.py --base http://127.0.0.1:8000/api \\
        --admin-email admin@civicai.local --officer-email roads.officer1@civicai.local \\
        --citizen-email citizen@civicai.local

The officer should belong to the department the photo's category routes to (ROADS for the default pothole
photo); if the complaint is auto-assigned to someone else the administrator reassigns it to that officer.
"""
import argparse
import os
import sys
import time
from pathlib import Path

import requests

BACKEND = Path(__file__).resolve().parents[1]
DEFAULT_IMAGE_DIR = BACKEND / "sample_data" / "images"
PAGINATED = {"count", "next", "previous", "page", "page_size", "total_pages", "results"}
COMPLAINT_DETAIL = {"id", "complaint_number", "status", "category", "department", "assigned_officer", "timeline",
                    "allowed_actions", "ai_prediction", "priority"}
DEFAULT_DESCRIPTION = ("Large pothole on the main road near Osmania General Hospital entrance; ambulances and "
                       "two-wheelers swerve dangerously around it. (API smoke test)")


class SmokeTest:
    def __init__(self, base, timeout):
        self.base = base.rstrip("/")
        self.timeout = timeout
        self.results = []  # (role, method, path, code, expected, ok, note)
        self.sessions = {}

    # --- plumbing ----------------------------------------------------------------------------------
    def session(self, role):
        if role not in self.sessions:
            self.sessions[role] = requests.Session()
        return self.sessions[role]

    def call(self, role, method, path, *, expect=200, keys=None, kind=None, json=None, data=None, files=None,
             params=None, label=None):
        """Perform one request and record a PASS/FAIL row. Returns the parsed JSON body (or None)."""
        url = f"{self.base}{path}"
        started = time.perf_counter()
        try:
            response = self.session(role).request(method, url, json=json, data=data, files=files, params=params,
                                                  timeout=self.timeout)
        except requests.RequestException as exc:
            self.record(role, method, label or path, "ERR", expect, False, f"{type(exc).__name__}: {exc}")
            return None
        elapsed = int((time.perf_counter() - started) * 1000)
        body, note, ok = None, f"{elapsed} ms", response.status_code == expect
        content_type = response.headers.get("Content-Type", "")
        if "application/json" in content_type:
            try:
                body = response.json()
            except ValueError:
                ok, note = False, "invalid JSON body"
        if ok and kind == "list" and not isinstance(body, list):
            ok, note = False, f"expected a JSON list, got {type(body).__name__}"
        if ok and kind == "paginated":
            missing = PAGINATED - set(body or {}) if isinstance(body, dict) else PAGINATED
            if missing:
                ok, note = False, f"missing pagination keys {sorted(missing)}"
        if ok and keys:
            row = body[0] if isinstance(body, list) and body else body
            missing = set(keys) - set(row or {}) if isinstance(row, dict) else set(keys)
            if missing and not (isinstance(body, list) and not body):
                ok, note = False, f"missing keys {sorted(missing)}"
        if not ok and response.status_code != expect:
            detail = body.get("detail") if isinstance(body, dict) else response.text[:120]
            note = f"{note}; {detail}" if detail else note
        self.record(role, method, label or path, response.status_code, expect, ok, note)
        return body if ok else None

    def download(self, role, path, params, content_type, magic=None):
        """GET a file download (CSV / PDF report) and check its type, attachment header and signature."""
        url = f"{self.base}{path}"
        label = f"{path}?{'&'.join(f'{k}={v}' for k, v in params.items())}"
        try:
            response = self.session(role).get(url, params=params, timeout=self.timeout)
        except requests.RequestException as exc:
            self.record(role, "GET", label, "ERR", 200, False, str(exc))
            return
        ok = (response.status_code == 200 and response.headers.get("Content-Type", "").startswith(content_type)
              and "attachment" in response.headers.get("Content-Disposition", "")
              and (magic is None or response.content.startswith(magic)))
        note = f"{len(response.content)} bytes, {response.headers.get('Content-Type', '?')}"
        self.record(role, "GET", label, response.status_code, 200, ok, note)

    def record(self, role, method, path, code, expect, ok, note):
        self.results.append((role, method, path, code, expect, ok, note))

    def login(self, role, email, password):
        body = self.call(role, "POST", "/auth/login/", json={"email": email, "password": password},
                         keys={"access", "refresh", "user"}, label=f"/auth/login/ ({role})")
        if not body:
            return None
        self.session(role).headers["Authorization"] = f"Bearer {body['access']}"
        if body["user"]["role"] != role:
            self.record(role, "CHECK", "login role", body["user"]["role"], role, False,
                        f"{email} is a {body['user']['role']}, not a {role}")
            return None
        return body["user"]

    # --- the run -----------------------------------------------------------------------------------
    def run(self, args):
        if self.call("public", "GET", "/health/", keys={"status", "model_mode"}) is None:
            return False
        admin = self.login("admin", args.admin_email, args.admin_password)
        officer = self.login("officer", args.officer_email, args.officer_password)
        citizen = self.login("citizen", args.citizen_email, args.citizen_password)
        if not (admin and officer and citizen):
            return False
        self.public_reads()
        complaint = self.submit_complaint(args)
        self.common_reads(complaint)
        self.citizen_reads()
        self.officer_reads(officer, complaint)
        self.admin_reads(admin, complaint)
        if complaint:
            complaint = self.ensure_assigned(complaint, officer)
            self.lifecycle(complaint, args)
        self.notifications()
        return True

    def public_reads(self):
        self.call("public", "GET", "/system/config/", keys={"app_name", "model_mode", "is_demo", "map", "statuses"})
        departments = self.call("public", "GET", "/departments/", kind="list", keys={"id", "code", "officer_count"})
        categories = self.call("public", "GET", "/categories/", kind="list", keys={"id", "slug", "department"})
        if departments:
            self.call("public", "GET", f"/departments/{departments[0]['id']}/", keys={"id", "code"})
        if categories:
            self.call("public", "GET", f"/categories/{categories[0]['id']}/", keys={"id", "slug"})
        self.call("public", "GET", "/analytics/public/", keys={"total_complaints", "resolution_rate", "recent_resolved"})
        self.call("public", "GET", "/geo/reverse/", params={"lat": "17.3850", "lng": "78.4867"},
                  keys={"address", "city", "source"}, label="/geo/reverse/?lat&lng")
        self.call("public", "GET", "/geo/search/", params={"q": "Charminar"}, kind="list", label="/geo/search/?q")
        self.call("public", "POST", "/ai/demo/", data={"description": "Garbage dumped near the bus stop, bad smell."},
                  keys={"vision", "text", "fusion", "category", "severity_hint", "is_demo", "disclaimer"})

    def submit_complaint(self, args):
        image = Path(args.image)
        with image.open("rb") as handle:
            body = self.call("citizen", "POST", "/complaints/", expect=201, keys=COMPLAINT_DETAIL | {"analysis"},
                             data={"description": args.description, "latitude": args.latitude,
                                   "longitude": args.longitude, "address": "Afzal Gunj main road",
                                   "area": "Afzal Gunj", "city": "Hyderabad"},
                             files={"image": (image.name, handle, "image/jpeg")}, label="/complaints/ (submit)")
        if body:
            failed = [step["key"] for step in body["analysis"]["steps"] if step["status"] == "failed"]
            self.record("citizen", "CHECK", "analysis steps", "failed" if failed else "ok", "ok", not failed,
                        f"failed: {failed}" if failed else f"{len(body['analysis']['steps'])} steps, "
                        f"category {body['category']['slug'] if body['category'] else None}")
        return body

    def common_reads(self, complaint):
        for role in ("citizen", "officer", "admin"):
            self.call(role, "GET", "/auth/profile/", keys={"id", "email", "role", "stats"})
            self.call(role, "GET", "/complaints/", kind="paginated", label=f"/complaints/ ({role})")
            self.call(role, "GET", "/complaints/map/", kind="list", label=f"/complaints/map/ ({role})")
            self.call(role, "GET", "/notifications/", kind="paginated", label=f"/notifications/ ({role})")
            self.call(role, "GET", "/notifications/unread-count/", keys={"count"},
                      label=f"/notifications/unread-count/ ({role})")
            self.call(role, "GET", "/feedback/", kind="paginated", label=f"/feedback/ ({role})")
            self.call(role, "GET", "/analytics/dashboard/", keys={"role"}, label=f"/analytics/dashboard/ ({role})")
            self.call(role, "GET", "/ai/model-info/", keys={"mode", "models", "components", "config"},
                      label=f"/ai/model-info/ ({role})")
            self.call(role, "GET", "/departments/routing/", kind="list", keys={"category", "department"},
                      label=f"/departments/routing/ ({role})")
        if complaint:
            cid = complaint["id"]
            for role in ("citizen", "admin"):
                self.call(role, "GET", f"/complaints/{cid}/", keys=COMPLAINT_DETAIL, label=f"/complaints/{{id}}/ ({role})")
                self.call(role, "GET", f"/complaints/{cid}/timeline/", kind="list", keys={"event", "actor_label"},
                          label=f"/complaints/{{id}}/timeline/ ({role})")
                self.call(role, "GET", f"/complaints/{cid}/duplicates/", kind="list",
                          label=f"/complaints/{{id}}/duplicates/ ({role})")

    def citizen_reads(self):
        self.call("citizen", "GET", "/feedback/pending/", kind="list")

    def officer_reads(self, officer, complaint):
        oid = officer["id"]
        for role in ("officer", "admin"):
            self.call(role, "GET", "/officers/", kind="paginated", label=f"/officers/ ({role})")
            self.call(role, "GET", f"/officers/{oid}/", keys={"id", "user", "active_workload"},
                      label=f"/officers/{{id}}/ ({role})")
            self.call(role, "GET", f"/officers/{oid}/workload/",
                      keys={"active", "capacity", "utilization", "overloaded", "critical", "by_status", "complaints"},
                      label=f"/officers/{{id}}/workload/ ({role})")
            self.call(role, "GET", "/duplicates/", kind="paginated", label=f"/duplicates/ ({role})")
            self.call(role, "GET", "/assignments/", kind="paginated", label=f"/assignments/ ({role})")
            self.call(role, "GET", "/ai/config/", keys={"weight_severity", "duplicate_threshold", "updated_by"},
                      label=f"/ai/config/ ({role})")
            zones = self.call(role, "GET", "/risk-zones/", kind="list", keys={"id", "name", "risk_level"},
                              label=f"/risk-zones/ ({role})")
            if zones:
                self.call(role, "GET", f"/risk-zones/{zones[0]['id']}/", keys={"id", "name"},
                          label=f"/risk-zones/{{id}}/ ({role})")
            self.call(role, "GET", "/analytics/hotspots/", keys={"clusters", "points", "alerts"},
                      label=f"/analytics/hotspots/ ({role})")

    def admin_reads(self, admin, complaint):
        users = self.call("admin", "GET", "/users/", kind="paginated")
        if users and users["results"]:
            self.call("admin", "GET", f"/users/{users['results'][0]['id']}/", keys={"id", "email", "role"})
        if complaint:
            self.call("admin", "GET", "/assignments/recommend/", params={"complaint": complaint["id"], "limit": 5},
                      kind="list", keys={"officer", "score", "workload", "utilization", "overloaded", "recommended"},
                      label="/assignments/recommend/?complaint")
        self.call("admin", "GET", "/audit-logs/", kind="paginated")
        self.call("admin", "GET", "/contact/", kind="paginated")
        analytics = {
            "overview": {"totals", "status_distribution", "priority_histogram", "hotspot_count"},
            "categories": None, "departments": None, "officers": None,
            "trends": {"period", "series", "resolution_time_trend", "category_series", "categories"},
            "sentiment": {"distribution", "rating_distribution", "over_time", "top_keywords"},
            "ai": {"mode", "total_predictions", "confusion", "duplicates", "verification", "model_info"},
        }
        for name, keys in analytics.items():
            self.call("admin", "GET", f"/analytics/{name}/", keys=keys, kind=None if keys else "list")
        self.call("admin", "GET", "/analytics/alerts/", kind="list")
        self.call("admin", "GET", "/analytics/reports/", params={"report": "summary", "format": "json"},
                  keys={"report", "title", "columns", "rows", "summary"}, label="/analytics/reports/?format=json")
        self.download("admin", "/analytics/reports/", {"report": "complaints", "format": "csv"}, "text/csv")
        self.download("admin", "/analytics/reports/", {"report": "summary", "format": "pdf"}, "application/pdf",
                      magic=b"%PDF")

    def ensure_assigned(self, complaint, officer):
        if (complaint.get("assigned_officer") or {}).get("id") == officer["id"]:
            return complaint
        self.call("admin", "POST", "/assignments/", expect=201, json={"complaint": complaint["id"],
                                                                      "officer": officer["id"]},
                  keys={"id", "officer", "assignment_type"}, label="/assignments/ (assign smoke officer)")
        return self.call("officer", "GET", f"/complaints/{complaint['id']}/", keys=COMPLAINT_DETAIL) or complaint

    def lifecycle(self, complaint, args):
        url = f"/complaints/{complaint['id']}"
        self.call("officer", "POST", f"{url}/accept/", json={"remarks": "Smoke test: accepted."},
                  keys=COMPLAINT_DETAIL, label="/complaints/{id}/accept/")
        self.call("officer", "POST", f"{url}/start/", json={"remarks": "Smoke test: work started."},
                  keys=COMPLAINT_DETAIL, label="/complaints/{id}/start/")
        before, after = Path(args.image), Path(args.after_image)
        with before.open("rb") as before_file, after.open("rb") as after_file:
            self.call("officer", "POST", f"{url}/evidence/", expect=201,
                      files={"before_image": (before.name, before_file, "image/jpeg"),
                             "after_image": (after.name, after_file, "image/jpeg")},
                      data={"remarks": "Smoke test: before / after photos."},
                      keys={"id", "before_image", "after_image", "uploaded_by"}, label="/complaints/{id}/evidence/")
        resolved = self.call("officer", "POST", f"{url}/resolve/", data={"remarks": "Smoke test: resolved."},
                             keys=COMPLAINT_DETAIL | {"latest_verification"}, label="/complaints/{id}/resolve/")
        self.call("officer", "POST", f"{url}/verify/", keys={"id", "score", "status", "explanation", "metrics"},
                  label="/complaints/{id}/verify/")
        if resolved:
            status = (resolved.get("latest_verification") or {}).get("status")
            self.record("officer", "CHECK", "auto verification", resolved["status"], "resolved|verified",
                        resolved["status"] in ("resolved", "verified"), f"AI verification: {status}")
        self.call("citizen", "POST", "/feedback/", expect=201,
                  json={"complaint": complaint["id"], "rating": 5,
                        "text": "Resolved quickly, great work by the officer. Thank you!"},
                  keys={"id", "rating", "sentiment", "sentiment_score", "suggest_reopen"}, label="/feedback/ (submit)")
        closed = self.call("citizen", "GET", f"{url}/", keys=COMPLAINT_DETAIL, label="/complaints/{id}/ (after feedback)")
        if closed:
            self.record("citizen", "CHECK", "status after feedback", closed["status"], "closed",
                        closed["status"] == "closed", "")

    def notifications(self):
        page = self.call("citizen", "GET", "/notifications/", params={"is_read": "false"}, kind="paginated",
                         label="/notifications/?is_read=false")
        if page and page["results"]:
            self.call("citizen", "POST", f"/notifications/{page['results'][0]['id']}/read/",
                      keys={"id", "is_read", "read_at"}, label="/notifications/{id}/read/")
        self.call("citizen", "POST", "/notifications/read-all/", keys={"updated"})

    # --- report ------------------------------------------------------------------------------------
    def report(self):
        width = max(len(row[2]) for row in self.results) if self.results else 20
        print(f"{'#':>3}  {'RESULT':6}  {'ROLE':8}  {'METHOD':6}  {'PATH':<{width}}  {'CODE':>5}  {'WANT':>5}  NOTE")
        for index, (role, method, path, code, expect, ok, note) in enumerate(self.results, start=1):
            print(f"{index:>3}  {'PASS' if ok else 'FAIL':6}  {role:8}  {method:6}  {path:<{width}}  "
                  f"{str(code):>5}  {str(expect):>5}  {note}")
        failed = sum(1 for row in self.results if not row[5])
        print(f"\n{len(self.results) - failed} passed, {failed} failed, {len(self.results)} checks against {self.base}")
        return failed


def default_image(slug="pothole"):
    files = sorted((DEFAULT_IMAGE_DIR / slug).glob("*.jpg"))
    return str(files[0]) if files else ""


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="CivicAI live API smoke test (creates test data).")
    parser.add_argument("--base", default=os.environ.get("SMOKE_BASE", "http://127.0.0.1:8000/api"),
                        help="API base URL (default %(default)s)")
    for role in ("admin", "officer", "citizen"):
        parser.add_argument(f"--{role}-email", default=os.environ.get(f"SMOKE_{role.upper()}_EMAIL"),
                            required=not os.environ.get(f"SMOKE_{role.upper()}_EMAIL"))
        parser.add_argument(f"--{role}-password", default=os.environ.get(f"SMOKE_{role.upper()}_PASSWORD"),
                            help=f"or set SMOKE_{role.upper()}_PASSWORD")
    image = default_image()
    parser.add_argument("--image", default=image, help="complaint photo (default: first sample pothole photo)")
    parser.add_argument("--after-image", default=str(DEFAULT_IMAGE_DIR / "after" / f"{Path(image).stem}_after.jpg"),
                        help="repaired 'after' photo (default: the matching sample after photo)")
    parser.add_argument("--description", default=DEFAULT_DESCRIPTION)
    parser.add_argument("--latitude", default="17.373300", help="complaint latitude (default: near a risk zone)")
    parser.add_argument("--longitude", default="78.474500")
    parser.add_argument("--timeout", type=float, default=120.0, help="seconds per request (AI calls can be slow)")
    args = parser.parse_args(argv)
    missing = [f"--{role}-password" for role in ("admin", "officer", "citizen") if not getattr(args, f"{role}_password")]
    if missing:
        parser.error(f"missing {', '.join(missing)} (or the SMOKE_*_PASSWORD environment variables)")
    for name in ("image", "after_image"):
        if not getattr(args, name) or not Path(getattr(args, name)).is_file():
            parser.error(f"--{name.replace('_', '-')} file not found: {getattr(args, name)!r}")
    return args


def main(argv=None):
    args = parse_args(argv)
    smoke = SmokeTest(args.base, args.timeout)
    completed = smoke.run(args)
    failed = smoke.report()
    if not completed:
        print("Smoke test aborted: the server is unreachable or a login failed.", file=sys.stderr)
        return 2
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
