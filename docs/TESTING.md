# Testing

CivicAI is tested in layers: Django unit and API tests, unit tests of the framework-free AI engine, an API smoke
test against a running server, Playwright browser tests that drive the whole platform, static checks of the
frontend, and evaluation scripts that measure the AI components. This page explains each layer, how to run it and
what the latest run produced.

All results below were produced on the development laptop (Windows 11, Python 3.13.3, Node.js 22.19.0,
MySQL 8.0.42) with the final demo data, on 18 October 2026 unless a section gives another date. The Summary gives
the latest runs, made on the final code; runs made before the last fixes are marked as such.

## Summary

| Layer | Where | Tests | Latest result |
|---|---|---|---|
| Backend: API, services, data rules and AI engine | `backend/apps/*/test*.py`, `backend/ai/tests/` | 707 | All passed on in-memory SQLite (55.1 s) and on MySQL 8.0.42 (61.7 s) |
| AI engine on its own, without Django | `backend/ai/tests/` | 224 (part of the 707) | All passed (17.9 s) |
| Live API smoke test | `backend/scripts/smoke_test_api.py` | 97 checks | All passed against a private copy of the demo data |
| Browser end-to-end tests | `e2e/` | 112 | All passed (3 min 46 s); see [Latest run](#latest-run) |
| Frontend static checks | `frontend/` | ESLint and production build | 0 lint problems; build without warnings |
| AI evaluation | `backend/scripts/` | Reports in `backend/ml_models/nlp/` and `backend/sample_data/` | See [Evaluation scripts](#evaluation-scripts) |

The presentation database (MySQL `civicai`) was not used for any test that writes data. Tests that create data ran
against a private copy of it, made as described in [Working on a copy of the demo database](#working-on-a-copy-of-the-demo-database).

## Final verification

Later on 18 October 2026, after the documentation was written, every test layer except the evaluation scripts was
run once more, on the code as it stood then. The fixes that followed and the runs after them are in
[After the final verification](#after-the-final-verification).

| Check | Result |
|---|---|
| `manage.py check` | No issues, with MySQL and with `DB_ENGINE=sqlite` |
| Backend suite on MySQL 8.0.42 (temporary `test_civicai`) | 706 of 706 passed in 61.5 s |
| Backend suite with `DB_ENGINE=sqlite` (in-memory) | 706 of 706 passed in 51.1 s |
| AI engine tests (`unittest discover -s ai/tests`) | 224 of 224 passed in 19.9 s |
| `npm run lint` and `npm run build` | No lint problems; 3693 modules built into `frontend\dist` in 8.6 s without warnings, and no demo password in the bundle |
| All 112 end-to-end tests against a private API | 111 passed, 1 failed ([the hotspot badge test](#the-hotspot-badge-test), fixed afterwards) in 220 s |
| The 94 read-only end-to-end tests (`-m "not mutates"`) against the presentation server | 93 passed, 1 failed (the same test) in 180 s |
| API smoke test against the private API | 97 of 97 checks passed in 4.3 s |

The private API ran on port 8299 with `DB_ENGINE=sqlite`, `SQLITE_NAME` and `MEDIA_DIR` pointing into a scratch
folder, after `migrate` and `seed_demo --reset --quiet`. The default seed (42) rebuilds the same stories and hotspots
as the presentation data, dated relative to that moment. It also had raised rate limits (`THROTTLE_AUTH=500/min`,
`THROTTLE_AI_PUBLIC=300/min`, `THROTTLE_CONTACT=100/min`, `THROTTLE_COMPLAINT_BURST=100/min`,
`THROTTLE_COMPLAINT_DAILY=10000/day`). The web app ran on separate Vite dev servers for the private API and for the
presentation server. The scratch database and photos were deleted afterwards.

Every table of the presentation database was compared before and after the read-only run. No complaint, feedback,
notification or setting changed, and user accounts changed only in their last-login time. The run added 10
audit-log entries (7 logins, 1 logout, 2 report downloads), 8 login tokens and 2 blacklisted tokens (from the logout
test).

### After the final verification

Small fixes followed the final verification, some of them found by an independent review of the first one:

- **Hotspot badges.** The hotspot map now moves overlapping count badges apart
  ([the hotspot badge test](#the-hotspot-badge-test)). The review found two follow-up problems, both fixed and
  re-checked in the browser. After a large jump in zoom (another period chosen while zoomed in), the badges could
  keep the spacing of the previous zoom level. An open hotspot popup could also stay behind when its badge moved.
- **Verification scores.** The resolution verifier now decides its status on the rounded score it stores and shows
  ([AI_ENGINE.md](AI_ENGINE.md)). A manual "partially resolved" decision made without a score now always gets a
  default score below the resolved threshold, even when the two thresholds are only 1 apart. The new test
  `test_default_manual_scores_stay_inside_their_bands` checks this, which brings the backend suite to 707 tests.

Every layer except the evaluation scripts was then run again on the final code:

| Check | Result |
|---|---|
| Backend suite on MySQL 8.0.42 (temporary `test_civicai`) | 707 of 707 passed in 61.7 s |
| Backend suite with `DB_ENGINE=sqlite` (in-memory) | 707 of 707 passed in 55.1 s |
| AI engine tests (`unittest discover -s ai/tests`) | 224 of 224 passed in 17.9 s |
| `npm run lint` and `npm run build` | No lint problems; 3693 modules built without warnings, and no demo password in the bundle |
| All 112 end-to-end tests against a private copy of the presentation data | 112 passed in 226 s |
| API smoke test against the same copy | 97 of 97 checks passed |

A run between the two rounds of fixes had also passed all 112 end-to-end tests (219 s). For these runs the
presentation data was exported with `dumpdata` (read-only) and loaded into a SQLite file with its own copy of the
photos, as in [Working on a copy of the demo database](#working-on-a-copy-of-the-demo-database). That copy was
served on port 8001 with the raised rate limits listed above, and the scratch copy was deleted afterwards. The
end-to-end run left 5 complaints and 6 deactivated test users in the copy, the same as the earlier runs.

## Working on a copy of the demo database

The smoke test and most end-to-end tests create complaints, users and notifications. To keep the presentation data
unchanged, run them against a second API instance that serves a copy. From `backend\`, in PowerShell:

```powershell
$copy = "$HOME\civicai-copy"                 # an empty folder outside the repository
New-Item -ItemType Directory -Force $copy | Out-Null
$env:PYTHONUTF8 = '1'                        # dump and load in UTF-8, whatever the Windows code page
# 1. export the presentation data (read-only; uses the database settings in .env)
venv\Scripts\python.exe manage.py dumpdata --exclude contenttypes --exclude auth.permission `
    --exclude admin.logentry --exclude sessions.session --exclude token_blacklist --output "$copy\data.json"
# 2. load it into a separate SQLite file with its own copy of the photos
$env:DB_ENGINE = 'sqlite'; $env:SQLITE_NAME = "$copy\civicai.sqlite3"; $env:MEDIA_DIR = "$copy\media"
$env:PERIODIC_CHECKS = 'False'              # no SLA or hotspot alerts in the middle of a test run
venv\Scripts\python.exe manage.py migrate --noinput
venv\Scripts\python.exe manage.py loaddata "$copy\data.json"
Copy-Item -Recurse media "$copy\media"
# 3. serve the copy on another port
venv\Scripts\python.exe manage.py runserver 8001 --noreload
```

`SQLITE_NAME` and `MEDIA_DIR` accept absolute paths, so nothing in the repository changes. Start the web app against
the copy with `$env:VITE_API_URL = 'http://localhost:8001/api'; npx vite --port 5181 --strictPort` (from
`frontend\`), and make sure the API allows that origin (see [CORS](../README.md#troubleshooting)). The
environment variables only last for that PowerShell window; close it to go back to the real settings. This is how
the copy for the results on this page was made (with the folder in a scratch directory).

## Backend test suite

From `backend/`:

```powershell
venv\Scripts\python.exe manage.py test --noinput            # the database DB_ENGINE selects
venv\Scripts\python.exe manage.py test apps.complaints -v 2  # one app, listing every test
```

The suite runs on the database that `DB_ENGINE` (or `DATABASE_URL`) selects. With `DB_ENGINE=sqlite` Django uses an
in-memory database. With MySQL it creates a temporary `test_<DATABASE_NAME>` database (here `test_civicai`) and
drops it at the end, so the MySQL user needs the right to create that database; `--noinput` lets Django replace a
leftover test database without asking. PowerShell example for a one-off MySQL run: `$env:DB_ENGINE='mysql';
venv\Scripts\python.exe manage.py test --noinput`.

While the test suite runs, `config/settings.py` switches to a fast password hasher and turns off the built-in
scheduler, the rate limits are off (the tests that check them switch them back on), and every test module that
uploads photos uses a temporary `MEDIA_ROOT`, so `backend/media` is never touched.

**Latest results:** 707 tests, all passed, none skipped: 55.1 s on in-memory SQLite and 61.7 s on MySQL 8.0.42
(`test_civicai`, created and dropped by the run).

| Module | Tests | What it covers |
|---|---|---|
| `apps.accounts.tests` | 27 | Registration, login, token refresh and logout (blacklist), profile and avatar, password change ending other sessions, admin user management |
| `apps.officers.tests` | 13 | Officer management API and the workload endpoint |
| `apps.departments.tests` | 19 | Departments, categories, the routing table and the `init_civicai` command |
| `apps.complaints.tests` | 110 | Complaint API: response shapes, role scoping, permissions, filters, ordering, the map feed, duplicate links, lifecycle actions and the `/api/ai/*` endpoints |
| `apps.complaints.test_services` | 74 | Service layer: the submission pipeline, priority, duplicates, routing, status rules, verification and notifications, plus a full lifecycle with the real AI engine |
| `apps.complaints.test_audit_fixes` | 9 | Regression tests from the QA audit: contact details stay private, civic points of deleted complaints are taken back, per-citizen complaint rate limits, no merging into closed originals, officer override after an automatic verification |
| `apps.complaints.test_demo` | 6 | The public landing-page demo: real engine, no account, no database or media writes, input validation, rate limit |
| `apps.assignments.tests` | 45 | Officer recommendation scores, assignment and reassignment, the assignments API |
| `apps.feedback.tests` | 22 | Feedback submission, sentiment handling, pending requests, the feedback, close and reopen cycle |
| `apps.notifications.tests` | 22 | Notification service and API |
| `apps.analytics.tests` | 51 | Dashboards, distributions, trends, hotspots, sentiment and reports, checked against a 40-complaint fixture with hand-checked expected values |
| `apps.audit.tests` | 4 | Audit-log API and the actions that write audit rows |
| `apps.core.tests` | 20 | System configuration, AI configuration validation, risk zones, contact form, geocoding proxy |
| `apps.core.test_api_contract` | 5 | `docs/API_ENDPOINTS.md` lists exactly the endpoints and permission levels of the live URL configuration; roles are enforced over HTTP |
| `apps.core.test_deploy` | 7 | `gunicorn.conf.py`, `Procfile`, `build.sh`, `render.yaml` and media serving |
| `apps.core.test_e2e` | 3 | API-level end-to-end runs with real logins, the real demo-mode AI engine and the sample photos |
| `apps.core.test_hardening` | 23 | Security and robustness: forged `X-Forwarded-For`, hostile query strings and bodies, image checks (real format, decompression bombs, EXIF and GPS removal), the scheduler |
| `apps.core.test_seed` | 18 | `seed_demo` produces a consistent history through the real pipeline (24-complaint run) |
| `apps.core.test_warmup` | 5 | The `warmup_ai` command and the warm-up hooks |
| `ai.tests.*` | 224 | The AI engine, see below |
| **Total** | **707** | |

## AI engine unit tests

The AI engine in `backend/ai/` has no Django imports, so its tests also run with plain `unittest`:

```powershell
cd backend
venv\Scripts\python.exe -m unittest discover -s ai/tests -t .
venv\Scripts\python.exe -m unittest ai.tests.test_priority -v     # one module
```

**Latest result:** 224 tests, all passed in 17.9 s.

| Module | Tests | What it covers |
|---|---|---|
| `test_vision` | 26 | Demo heuristics on the sample photos, boxes, image quality, production paths with a fake YOLO module and a fake CLIP encoder |
| `test_nlp` | 38 | Preprocessing (including Hinglish and Telugu words), classifier, embedder, keywords, impacts, sentiment; production paths with stand-ins and the fallback when they fail to load |
| `test_fusion` | 23 | Late fusion, agreement, priors and the review flags |
| `test_severity` | 22 | Severity factors, weights, levels and reasons |
| `test_priority` | 27 | Priority components, weights, levels, reopen adjustment and explanations |
| `test_duplicate` | 24 | Text, image and location similarity and the duplicate decision |
| `test_geospatial` | 20 | Haversine distance, location risk and DBSCAN hotspots |
| `test_verification` | 20 | Before/after verification on repaired, unchanged and different-scene photos |
| `test_pipeline` | 24 | The analysis pipeline's steps, failure handling and model information |

The production code paths are tested with fakes so that the suite stays fast and needs neither PyTorch nor a model
download. The real production models are measured by the evaluation scripts below.

## End-to-end browser tests

The `e2e/` suite drives the real platform in Chromium with Playwright for Python: the React app, the API, the AI
pipeline and the database. Each test compares what the page shows with the API response the page received, and
ends by checking that no uncaught exception, server error or failed API request happened.
[e2e/README.md](../e2e/README.md) has the full instructions and settings.

| File | Tests | Covers |
|---|---|---|
| `test_public.py` | 11 | Landing page and live AI demo, the nine landing sections, contact form, registration, login per role, logout, role guards, dark theme |
| `test_citizen.py` | 9 | Dashboard totals, reporting through the UI on a desktop and on a phone, validation, text-only report, notifications, duplicate detection, rating a fix, profile |
| `test_officer.py` | 3 | Priority-ordered queue, dashboard figures, accept, start, after photo, resolve and AI-assisted verification |
| `test_admin.py` | 11 | Dashboard KPIs and charts against the analytics API, complaint filters, reassignment, AI settings validation, CSV and PDF reports, hotspot map, duplicates, a new category being routed |
| `test_lifecycle.py` | 4 | Reject with a reason, reopen, AI override (audit-logged), manual verification |
| `test_smoke.py` | 74 | Every page of every role (7 public, 8 citizen, 7 officer, 15 administrator pages) at 1440 px and on a 390 px touch phone: a heading, no errors, no horizontal scroll |

Markers select subsets: `-m "not mutates"` runs the 94 tests that create or change no complaints, users or settings
(their logins, one logout and two report downloads still add audit-log entries), and `-m "not ai"` skips the 12
tests that wait for the AI pipeline.

### How to run it

```powershell
python -m pip install -r e2e/requirements.txt      # pytest and Playwright
python -m playwright install chromium

# terminal 1: the API on a copy of the data (backend\, see "Working on a copy of the demo database")
# terminal 2: the web app (frontend\)     $env:VITE_API_URL = 'http://localhost:8001/api'; npx vite --port 5181 --strictPort
# terminal 3: the suite (repository root)
$env:E2E_API_URL = 'http://localhost:8001/api'
python -m pytest e2e -v
```

`E2E_BASE_URL` and `E2E_API_URL` point the suite at the web app and the API (defaults `http://localhost:5181` and
`http://localhost:8000/api`). The API must accept the web app's origin (`CORS_ALLOWED_ORIGINS` or
`CORS_ALLOWED_ORIGIN_REGEXES`); the suite checks this at start-up and stops with a clear message otherwise.

**Run it against a copy, not against the presentation database.** The 18 tests marked `mutates` file complaints,
register throw-away citizens and change settings. They clean up what they can (withdraw or close complaints,
deactivate the users, restore the AI settings), but one full run on the copy left 5 closed, rejected or verified
complaints and 6 deactivated `qa.e2e.*@example.com` users behind, together with their notifications and audit
entries.

### Latest run

On 18 October 2026, on the final code, the suite ran against a fresh private copy of the presentation data (a
`dumpdata` of MySQL `civicai` loaded into SQLite as described [above](#working-on-a-copy-of-the-demo-database), API
with raised rate limits, Vite dev server): **112 passed in 226 s**. A run after the first version of the
[hotspot badge fix](#the-hotspot-badge-test) had also passed 112 of 112 (219 s). Before the fix, the same final data
gave 111 passed and 1 failed (242 s, API with the default rate limits).
On 17 October, with the previous demo data, the suite had passed 112 of 112 on both SQLite and MySQL. The full
suite was not re-run on MySQL after the final data was generated, to leave the presentation database untouched.

#### The hotspot badge test

`test_admin.py::test_hotspot_badges_are_not_hidden_under_complaint_pins` checks that every hotspot's count badge on
the hotspot map can be clicked. In the final demo data two Secunderabad hotspots, one with 9 complaints and one with
3 (high severity), lie about 750 m apart. At the map's opening zoom their centres are closer together than a badge
is wide, so before the fix the badge of the smaller one was drawn under the larger one:

```
AssertionError: hotspot badges hidden under complaint pins (the pointer hits the pin instead):
Secunderabad: 3 complaints, high severity -> covered by civic-map-hotspot "9"
```

The fix is in `frontend/src/components/maps/HotspotLayer.jsx`. At every zoom level, badges that would touch are
pushed apart along the line between their centres until 4 pixels separate them. The hotspot with fewer complaints
moves further, and the circles stay on the true centroids. The test passes now, and the screenshots
`docs/screenshots/hotspot-map.png` and `guide-admin-hotspots.png` were retaken to show the separated badges.

## Live API smoke test

`backend/scripts/smoke_test_api.py` checks a running API with plain HTTP requests (no Django imports): it logs in
as an administrator, an officer and a citizen, calls every GET endpoint of the API contract, and runs the main write
flows: submit a complaint with a photo, accept, start work, upload before/after evidence, resolve, AI verification,
citizen feedback, mark notifications read and the public AI demo. It checks status codes and response keys and
prints a PASS/FAIL table.

```powershell
cd backend
$env:SMOKE_ADMIN_PASSWORD = 'Admin@12345'; $env:SMOKE_OFFICER_PASSWORD = 'Officer@12345'; $env:SMOKE_CITIZEN_PASSWORD = 'Citizen@12345'
venv\Scripts\python.exe scripts\smoke_test_api.py --base http://127.0.0.1:8001/api `
    --admin-email admin@civicai.local --officer-email roads.officer1@civicai.local --citizen-email citizen@civicai.local
```

The example points at the copy on port 8001 from the previous section: the script creates data, so never point
`--base` at the server that holds the presentation data. The officer should work in the department the photo
routes to (Roads for the default pothole photo). The exit code is 0 when every check passed, 1 when a check failed
and 2 when the server cannot be reached or a login fails.

**Latest result:** 97 of 97 checks passed against a private copy of the demo data, on the final code
([After the final verification](#after-the-final-verification)).
[DEPLOYMENT.md](DEPLOYMENT.md#post-deploy-checks) shows how to run it against a deployed API.

## Frontend checks

```powershell
cd frontend
npm run lint      # ESLint over the whole project
npm run build     # production build into dist\
```

**Latest result:** `npm run lint` reported no problems. The production build (written to a scratch folder so that
`frontend\dist` stayed unchanged) transformed 3693 modules without warnings, and a search of the bundle found none of
the demo passwords.

## Evaluation scripts

The evaluation scripts measure the AI components on the project's own data. Most of that data is synthetic: the
generated sample photos are drawn by `scripts/generate_sample_images.py` and the training corpus is generated from
templates. Those numbers show that the pipeline works as designed; they do not predict accuracy on real street
photos or real complaints. The 134 real sample photos give a first, small real-world check for vision (below).

### Text classifier, sentiment and severity cues (`train_text_classifier.py`)

```powershell
cd backend
venv\Scripts\python.exe scripts\train_text_classifier.py --mode demo
venv\Scripts\python.exe scripts\train_text_classifier.py --mode production   # needs sentence-transformers
```

The script splits `ai/nlp/data/complaint_corpus.csv` (864 template-generated complaints, 96 per class) 80/20 with a
fixed seed, reports the hold-out scores, trains on the full corpus, saves the model cache that the application uses
(`ml_models/nlp/text_clf_demo.joblib` or `text_clf_st.joblib`) and then tests that model on
`complaint_challenge.csv`: 90 hand-written complaints, 10 per class, never used for training. It also evaluates the
sentiment analyser on `feedback_corpus.csv` (178 texts) and the held-out `feedback_challenge.csv` (60 texts), and
writes everything to `ml_models/nlp/report_<mode>.json`. Running it replaces the model cache, so it was not re-run
for this page; the numbers come from the report files generated on 17 October 2026.

| Measure | Demo mode (TF-IDF + logistic regression) | Production mode (all-MiniLM-L6-v2 + logistic regression) |
|---|---|---|
| Template hold-out, 173 complaints: accuracy / macro-F1 | 100 % / 1.000 | 98.8 % / 0.989 |
| Hand-written challenge set, 90 complaints: accuracy / macro-F1 | **91.1 %** / 0.911 | **92.2 %** / 0.924 |
| Challenge set with the default category keywords blended in | 92.2 % | 93.3 % |
| Sentiment, feedback corpus (178 texts) | 100 % (lexicon) | 96.1 % (RoBERTa) |
| Sentiment, held-out feedback challenge (60 texts) | 86.7 % (lexicon) | 96.7 % (RoBERTa) |
| Text severity cue vs the corpus label: exact / within one level | 48.4 % / 96.6 % | same text cues |

The challenge-set rows are the honest estimate; the hold-out rows only show that the model learned the templates.
The lexicon's 100 % on the feedback corpus is the same effect: that corpus was used to develop the lexicon. The
severity cue is only one input of the severity engine, which also weighs the photo, the category, the location and
nearby complaints.

### Vision (`evaluate_vision.py`)

```powershell
cd backend
venv\Scripts\python.exe scripts\evaluate_vision.py                       # demo heuristics
venv\Scripts\python.exe scripts\evaluate_vision.py --include-unchanged   # also the 90 'unchanged' after-photos
$env:MODEL_MODE='production'; venv\Scripts\python.exe scripts\evaluate_vision.py --output "$HOME\vision_eval_production.json"
```

The script analyses every photo listed in `sample_data/images/manifest.json` without file-name hints and prints
accuracy, per-class precision, recall and F1, a confusion matrix, localisation quality (overlap of the predicted box
with the drawn defect) and timings. By default it writes `sample_data/vision_eval.json`; `--output` writes
elsewhere.

| Measure (90 generated photos, 10 per class) | Demo heuristics | CLIP ViT-B/32 zero-shot (production without YOLO) |
|---|---|---|
| Top-1 accuracy | **98.9 %** (89 of 90) | **61.1 %** |
| Macro-F1 | 0.989 | 0.547 |
| Mean box overlap (IoU) of correct predictions | 0.729 (79 boxes) | 0.513 (49 boxes) |
| Boxes with IoU of at least 0.5 | 79.7 % | 61.2 % |
| Mean time per photo | 79.5 ms (58-59 ms on the 18 October re-runs) | 263 ms (282 ms in another run that day) |
| Source | `sample_data/vision_eval.json` (17 October 2026), reproduced on 18 October with the same results apart from the timings | Re-run on 18 October 2026 with `--output` to a scratch file |

The demo heuristics were designed around these generated photos, so their 98.9 % is expected and says nothing
about real photos. Including the 90 "unchanged" after-photos (the same scenes with the defect still present) gives
98.9 % on 180 photos. CLIP was not trained on these classes; it mostly confuses drainage with water leaks and open
manholes, and fallen trees with water leaks. A YOLOv8 detector trained on a real labelled dataset would be the next
step (see `scripts/train_yolo.py`); none is included, so no YOLO numbers exist.

#### Vision on the real sample photos

```powershell
cd backend
venv\Scripts\python.exe scripts\evaluate_vision.py --images sample_data\real_images --output sample_data\vision_eval_real.json
$env:MODEL_MODE='production'; venv\Scripts\python.exe scripts\evaluate_vision.py --images sample_data\real_images --output "$HOME\vision_eval_real_production.json"
```

| Measure (134 real street photos, 13-16 per class) | Demo heuristics | CLIP ViT-B/32 zero-shot |
|---|---|---|
| Top-1 accuracy | **22.4 %** (30 of 134; 95 % CI 16.2-30.2) | **64.2 %** (86 of 134; 95 % CI 55.8-71.8) |
| Macro-F1 | 0.152 | 0.626 |
| Mean time per photo | 148 ms | 300 ms |
| Source | `sample_data/vision_eval_real.json` (25 October 2026) | Re-run on 25 October 2026 with `--output` to a scratch file |

The real photos (sources and licences in `sample_data/real_images/CREDITS.md`) show what the generated set cannot:
the demo heuristics do not transfer to real streets, which is why the fusion counts them half in demo mode. CLIP
recognises garbage, open manholes and fallen trees reliably and confuses water on the road (leaks, flooded potholes)
with drainage. The photos were chosen to show their category clearly, so both numbers are optimistic.

## How QA was done

- **Specification first.** `docs/BUILD_SPEC.md` fixed the data model, the AI interfaces, the API contract and the
  design system before the code was written, and the modules were built together with their unit tests.
- **Requirement audits.** The requirements in `docs/REQUIREMENTS.md` were walked through section by section against
  the live API and the web app. The findings were fixed and, where possible, covered by regression tests (for
  example `test_audit_fixes.py` and `test_hardening.py`). [REQUIREMENTS_TRACEABILITY.md](REQUIREMENTS_TRACEABILITY.md)
  maps each requirement to its implementation and evidence.
- **Visual QA.** During development the pages were captured with Playwright at 1440 px and at 390 px, in the light
  and the dark theme, and reviewed by eye; each capture also recorded console errors, page errors, failed API
  requests and horizontal overflow. The final review on 17 October covered the main pages of every role in both
  themes and widths. `e2e/test_smoke.py` is the automated part of that check: it opens every page of every role at
  both widths.
- **Two databases.** The backend suite runs on SQLite and on MySQL; SQLite is more forgiving (for example it does
  not enforce `max_length`), so MySQL runs are the ones that count before a release.
- **Screenshots for the README.** The ten README screenshots in `docs/screenshots/` (the files without the `guide-`
  prefix) were taken on 18 October 2026 from the presentation data. After one API login per role (which records the
  login in the audit log), the capture script blocked every browser request that could write data; only the AI
  preview endpoints that store nothing were allowed. None of the captures logged a console error, a failed request
  or horizontal overflow. The report-flow screenshot needed a real submission and was taken on the private copy.
  `hotspot-map.png` was retaken after the [hotspot badge fix](#the-hotspot-badge-test), from a fresh private copy of
  the same data.

## What the tests do not cover

- Accuracy on real street photos and real complaints at scale: the text data is synthetic or hand-written by the
  project, the 134 real photos are hand-picked and few, and no YOLO model has been trained.
- Load and performance: there are timings, but no load tests.
- Browsers other than Chromium: the end-to-end suite uses Playwright's Chromium only.
- A live cloud deployment: the deployment files are checked by `test_deploy.py`, but the project was not deployed
  during development (see [DEPLOYMENT.md](DEPLOYMENT.md)).
- The 18 data-changing end-to-end tests on MySQL with the final demo data (see [Latest run](#latest-run)): only the
  94 read-only tests ran against the presentation server, before the hotspot badge fix, and 93 of them passed (see
  [Final verification](#final-verification)).
