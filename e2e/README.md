# CivicAI end-to-end tests

Browser tests that drive the real, running platform - React frontend, Django REST API, AI pipeline and database -
the way citizens, officers and administrators use it. They are written with **pytest** and **Playwright for
Python** (sync API, no pytest plugin required).

## What is covered

| File | Flows |
|---|---|
| `test_public.py` | Landing hero copy (verbatim) and the live AI demo (`POST /api/ai/demo/` answered and shown), the nine landing sections, "Try your own photo", contact form, citizen registration -> citizen dashboard, login with each demo account -> its dashboard (and the hero's links per role), logout (tokens cleared, refresh token blacklisted), role guards (`/unauthorized`, `/login?next=`), dark theme |
| `test_citizen.py` | Dashboard totals = `GET /api/analytics/dashboard/` (and each card's list holds the same number); "Report an issue" through the UI on a desktop and on a phone (photo, description, map click, *Analyze & Submit*, AI work order, tracking page, My complaints, detail page with AI panel, priority breakdown and timeline); wizard validation + text-only report; notifications list + *Mark all as read*; notification order of a new complaint; duplicate report detection; rating a resolved complaint (sentiment); profile edit + photo upload |
| `test_officer.py` | Queue ordered by priority; officer dashboard figures = their lists; accept -> start work -> after photo -> *Mark as resolved* -> AI-assisted verification on a complaint the test files itself |
| `test_admin.py` | Dashboard KPIs = `GET /api/analytics/overview/`; charts = analytics API (table view); All complaints filters change the count (also two quick changes in a row); reassignment with a recommended officer; AI settings reject weights that do not add up to 100 and save a valid change (then restore it); CSV + PDF reports; hotspot map clusters (and that no hotspot badge hides under complaint pins); pending duplicate pairs; a category added in the admin panel is routed and offered to citizens (then removed) |
| `test_lifecycle.py` | Officer rejects with a reason; citizen reopens; administrator overrides the AI category (audit-logged); officer verifies a resolution manually |
| `test_smoke.py` | Every page of every role renders a heading with no uncaught exception, no failed API call and no horizontal scroll, at 1440 px and on a 390 px touch phone |

## Run it

From the repository root:

```bash
python -m pip install -r e2e/requirements.txt
python -m playwright install chromium

# 1. backend with the seeded demo data. One-time setup on Windows: .\setup.ps1 (venv, migrations, reference
#    data, demo data via `manage.py seed_demo --reset`, npm install). Use a copy of the database you present
#    (see "Use a copy of the database" below). Then:
cd backend && venv/Scripts/python.exe manage.py runserver 8000      # venv/bin/python on Linux/macOS
# 2. frontend, in a second terminal (any port; tell the suite with E2E_BASE_URL)
cd frontend && npx vite --port 5181 --strictPort
# 3. the suite, in a third terminal
pytest e2e -v
```

`.\start-dev.ps1` starts both servers instead (frontend on port 5173): run the suite with
`E2E_BASE_URL=http://localhost:5173 pytest e2e -v`. A full run of the 112 tests took 3.5 to 7 minutes on the
development laptop (219 s to 242 s in the four runs on the final demo data on 18 October 2026), a large part of it
the page smoke test;
`pytest e2e -v --ignore=e2e/test_smoke.py` skips it. If `pytest` is not on the PATH, use `python -m pytest`.

**Use a copy of the database, not the one you present.** The 18 tests marked `mutates` clean up after themselves
as far as the platform allows (see "Own data" below), but a full run still leaves complaints that ended closed,
rejected or verified, deactivated `qa.e2e.*@example.com` users, notifications and audit entries behind: each full
run on the final demo data on 18 October 2026 left 5 complaints and 6 users. `pytest e2e -v -m "not mutates"` (94 tests) creates
or changes no complaints, users or settings; it only adds audit-log entries (logins, one logout, two report
downloads), login tokens and last-login times.
[docs/TESTING.md](../docs/TESTING.md#working-on-a-copy-of-the-demo-database) shows how to serve a copy of the demo
data on another port (then set `E2E_API_URL`, and `VITE_API_URL` for the web app, to that port).

**Latest result** (18 October 2026, final demo data, final code): 112 passed in 226 s, against a fresh private copy of
the presentation data. Earlier the same day one test had failed: `test_admin.py::test_hotspot_badges_are_not_hidden_under_complaint_pins`
found two Secunderabad hotspot badges overlapping at the map's opening zoom (111 passed, 1 failed). The map now moves
overlapping badges apart; [docs/TESTING.md](../docs/TESTING.md#the-hotspot-badge-test) explains the failure and the
fix. On 17 October, with the previous demo data, the suite passed 112 of 112 on SQLite and on MySQL.

The API must accept the frontend's origin. `backend/.env.example` allows only port 5173
(`CORS_ALLOWED_ORIGINS`); for another port add it there, or allow every local port in `backend/.env` with
`CORS_ALLOWED_ORIGIN_REGEXES=^http://(localhost|127\.0\.0\.1):[0-9]+$`. The suite checks at start-up that both
servers answer and that the API accepts the frontend's origin, and stops with a clear message otherwise.

Useful variations:

```bash
pytest e2e -v -m "not mutates"            # no complaints, users or settings are created or changed
pytest e2e -v -m "not ai"                 # skip the tests that wait for the AI pipeline
pytest e2e/test_officer.py -v             # one area
pytest e2e -v -k "submit and phone"       # one scenario
E2E_HEADED=1 E2E_SLOWMO=250 pytest e2e/test_citizen.py -v    # watch it run
E2E_TRACE=1 pytest e2e -v                 # keep a Playwright trace of every failing test
```

## Configuration

All settings are environment variables (defaults in `support/data.py`):

| Variable | Default | Meaning |
|---|---|---|
| `E2E_BASE_URL` | `http://localhost:5181` | Frontend under test (Vite dev server or a built preview) |
| `E2E_API_URL` | `http://localhost:8000/api` | REST API the frontend talks to |
| `E2E_HEADED`, `E2E_SLOWMO` | off, `0` | Show the browser; slow every action down (ms) |
| `E2E_TRACE` | off | Record a Playwright trace; kept for failing tests |
| `E2E_REDUCED_MOTION` | `reduce` | `reduce` renders animations in their final state (stable runs); `no-preference` plays them |
| `E2E_KEEP_DATA` | off | Keep the complaints the tests create instead of withdrawing / closing them |
| `E2E_ARTIFACTS` | `e2e/artifacts` | Failure screenshots, page logs and traces |
| `E2E_ADMIN_EMAIL` / `_PASSWORD` | `admin@civicai.local` / `Admin@12345` | Demo administrator |
| `E2E_OFFICER_EMAIL` / `_PASSWORD` | `roads.officer1@civicai.local` / `Officer@12345` | Demo officer (Roads) |
| `E2E_CITIZEN_EMAIL` / `_PASSWORD` | `citizen@civicai.local` / `Citizen@12345` | Demo citizen (read-only checks) |
| `E2E_REPORTER_PASSWORD` | `Citizen@12345` | Password of `citizen1..citizen12@civicai.local`, who file the test complaints |

## How it works

- **Sessions without typing**: fixtures log in through `POST /api/auth/login/` once per account and seed the JWT pair
  into `localStorage` (`civicai.access` / `civicai.refresh`) before the app loads; only the login, registration and
  logout tests type credentials. Tokens are cached for the run, so the suite stays far below the `auth` rate limit
  (20/min); any 429 from the API helper is retried after `Retry-After`. The whole suite passes with the API's
  default rate limits. New complaints are also limited per citizen (`complaint_daily` 40/day); a run files one
  complaint per reporter account, so for more than about 40 runs a day against one server process start the API
  with `THROTTLE_COMPLAINT_DAILY=10000/day`.
- **Own data**: tests that change state file their own complaints through the API (as `citizen1..citizen12`), or
  run on a throw-away citizen registered for that test only (`fresh_citizen` fixture, `qa.e2e.*@example.com`,
  deactivated afterwards) when they assert on a whole complaint list or notification feed. Complaints are cleaned up
  afterwards: the owner withdraws them while that is allowed, otherwise an administrator closes or rejects them. Seeded
  complaints are only read. The AI-settings test restores the original configuration in a `finally` block and
  verifies it through the API.
- **Real answers, not timers**: every step waits for the API response the page itself makes
  (`page.expect_response`) and compares what the UI shows with that response, so assertions are exact and fixed
  sleeps are rare (a short settle before measuring layout, and before judging the final URL after quick changes). AI calls (complaint analysis, verification) get a 180 s budget because the first call
  after a server start loads the models.
- **Health of every page**: each UI test ends with `assert_healthy(page)`: no uncaught exception, no API 5xx and no
  failed API request happened while it ran.
- **Failures leave evidence**: a full-page screenshot and a log (page errors, API 5xx, console errors) of every page
  of a failed test are written to `e2e/artifacts/` (git-ignored); with `E2E_TRACE=1` also a trace
  (`python -m playwright show-trace e2e/artifacts/<test>.zip`).

## Writing a test

```python
from playwright.sync_api import expect
from support.ui import api_response, assert_healthy

def test_example(admin_page, settings):
    page = admin_page                                   # or open_page(account, phone=True)
    with page.expect_response(api_response(settings.api_url, "GET", "analytics/overview/")) as call:
        page.goto("/admin/dashboard")
    totals = call.value.json()["totals"]                # what the page received ...
    expect(page.get_by_text(str(totals["total"])).first).to_be_visible()   # ... is what it shows
    assert_healthy(page)
```
