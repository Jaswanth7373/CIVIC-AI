# CivicAI backend

Django REST API and AI engine of **CivicAI - a multimodal AI-based multi-department civic issue detection,
prioritization and resolution platform**. Citizens report a problem with a photo, a description and a GPS pin; the
backend classifies it (image + text + location), scores severity and priority, detects duplicates, routes it to a
department, assigns an officer, verifies the resolution from before/after photos, analyses the citizen's feedback
and serves the analytics, maps and reports of the React frontend (`../frontend`).

This file is the backend reference: settings, database, AI modes, background jobs and security. The
[project README](../README.md) covers the quick start, demo accounts and troubleshooting;
[docs/TESTING.md](../docs/TESTING.md) and [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md) cover tests and deployment.

| Part | Technology |
|---|---|
| API | Python 3.13, Django 5.2, Django REST Framework 3.18, Simple JWT (rotation + blacklist), django-filter, django-cors-headers |
| Database | **MySQL 8** (`DB_ENGINE=mysql`, the default) or SQLite (`DB_ENGINE=sqlite`, quick local start); Django ORM + migrations |
| AI engine (`ai/`, framework-independent) | OpenCV, scikit-learn, NumPy/pandas, ImageHash; in production mode also PyTorch, Sentence-Transformers, Hugging Face Transformers, CLIP (and YOLO when trained weights exist) |
| Background work | built-in scheduler (default) or Celery + Redis (optional) |
| Serving | gunicorn + WhiteNoise (Render blueprint in `../render.yaml`) |

Exact installed versions are listed in the [project README](../README.md#tech-stack).

```
backend/
  manage.py
  config/          settings.py, urls.py, wsgi.py, asgi.py, celery.py
  apps/            core accounts departments officers complaints assignments feedback notifications analytics audit
  ai/              vision nlp multimodal severity priority duplicate geospatial verification (+ tests, no Django imports)
  scripts/         setup_mysql.py, train_text_classifier.py, train_yolo.py, evaluate_vision.py, generate_sample_images.py,
                   import_real_photos.py, smoke_test_api.py
  sample_data/     generated demo photos + labels, 134 credited real street photos in real_images/ (committed)
  ml_models/       model caches and weights (git-ignored) and the text classifier reports
  media/           uploads (git-ignored)
  requirements.txt, requirements-ml.txt, .env.example, build.sh, gunicorn.conf.py, Procfile, .python-version
```

API reference: [docs/API_ENDPOINTS.md](../docs/API_ENDPOINTS.md) (117 endpoints), or
`venv/Scripts/python.exe manage.py api_endpoints` for the live list with permission levels. The engineering
contract is [docs/BUILD_SPEC.md](../docs/BUILD_SPEC.md).

---

## 1. Quick start (Windows)

From the repository root, `powershell -ExecutionPolicy Bypass -File .\setup.ps1` does everything below (add `-WithML`
for the production AI packages, `-NoSeed` to skip the demo data) and `.\start-dev.ps1` starts both servers. By hand:

```bash
cd backend
python -m venv venv
venv/Scripts/python.exe -m pip install -r requirements.txt     # venv/bin/python on Linux / macOS
cp .env.example .env                                           # then edit SECRET_KEY, JWT_SECRET, DB_* (section 2)
venv/Scripts/python.exe manage.py migrate
venv/Scripts/python.exe manage.py init_civicai --keep-existing # departments, categories, routing, AI config, risk zones
venv/Scripts/python.exe manage.py seed_demo --reset            # optional demo data (real AI pipeline, about 70 s)
venv/Scripts/python.exe manage.py runserver 8000
```

Check: `http://localhost:8000/api/health/` answers `{"status": "ok", ...}`; the Django admin is at `/admin/`. The
frontend setup and the demo logins are in the [project README](../README.md#demo-accounts).

`seed_demo` builds 160 complaints over 180 days through the real services (submission, AI analysis, assignment,
resolution with AI verification, feedback with sentiment analysis, duplicates, SLA and hotspot alerts); the run that
produced the presentation data took 71 s on MySQL. `--reset` first deletes every `@civicai.local` account and
everything it owns, so a second run replaces the dataset (new complaint numbers, dates relative to the moment of the
run); `--seed` and `--anchor` reproduce a dataset exactly. The demo departments carry fictitious contacts
(`*@civicai.local`, phone numbers in the unassigned `0000` exchange) - replace them on the Departments page before
real use.

---

## 2. Configuration (`backend/.env`)

Copy `.env.example`; every value can also be given as an environment variable (the environment wins over `.env`).
Never commit `.env`.

| Variable | Default | Meaning |
|---|---|---|
| `SECRET_KEY` | none | Long random string; the server refuses to start without it when `DEBUG=False` |
| `JWT_SECRET` | `SECRET_KEY` | Signing key of the login tokens |
| `DEBUG` | `False` (`.env.example`: `True`) | `True` only for development |
| `ALLOWED_HOSTS`, `CSRF_TRUSTED_ORIGINS`, `CORS_ALLOWED_ORIGINS`, `CORS_ALLOWED_ORIGIN_REGEXES` | localhost, port 5173 | Host / origin lists (comma separated); the frontend's origin must be allowed. On Render `RENDER_EXTERNAL_HOSTNAME` is added to `ALLOWED_HOSTS` automatically |
| `DB_ENGINE` | `mysql` | `mysql` or `sqlite` |
| `DATABASE_NAME`, `DATABASE_USER`, `DATABASE_PASSWORD`, `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_CONN_MAX_AGE` | `civicai`, `root`, empty, `127.0.0.1`, `3306`, `60` | MySQL connection |
| `DATABASE_URL` | none | `mysql://user:pass@host:3306/civicai`; overrides the values above (cloud MySQL; TLS options in [DEPLOYMENT.md](../docs/DEPLOYMENT.md#tls-options)) |
| `SQLITE_NAME` | `civicai.sqlite3` | SQLite file (relative to `backend/` or absolute) |
| `JWT_ACCESS_MINUTES`, `JWT_REFRESH_DAYS` | `60`, `7` | Token lifetimes |
| `MODEL_MODE`, `MODEL_PATH` | `demo`, `./ml_models` | AI engine mode (section 4) and model folder |
| `YOLO_WEIGHTS`, `TEXT_EMBEDDING_MODEL`, `SENTIMENT_MODEL`, `CLIP_MODEL`, `HF_CACHE_DIR`, `AI_DEVICE` | `ml_models/yolo/civicai_yolov8.pt`, `sentence-transformers/all-MiniLM-L6-v2`, `cardiffnlp/twitter-roberta-base-sentiment-latest`, `clip-ViT-B-32`, `ml_models/hf_cache`, `cpu` | Production models |
| `MAX_IMAGE_UPLOAD_MB` (8), `MAX_IMAGE_DIMENSION` (8000), `MAX_IMAGE_PIXELS` (25 000 000), `MAX_FULL_DECODE_PIXELS` (12 000 000), `MAX_STORED_IMAGE_SIDE` (2560), `MAX_REQUEST_BODY_MB` (20) | as shown | Upload limits (section 6) |
| `MEDIA_DIR` | `media` | Upload folder (relative to `backend/` or absolute, e.g. a persistent disk) |
| `SERVE_MEDIA` | `False` | `True`: Django serves `/media/` when `DEBUG=False` (single instance without object storage) |
| `NUM_PROXIES` | `0` | Number of trusted reverse proxies in front of the app: `0` when clients connect directly, `1` on Render / Railway. Rate limits and audit-log IPs depend on it (section 6) |
| `THROTTLE_AUTH` (20/min), `THROTTLE_AI` (60/min), `THROTTLE_AI_PUBLIC` (12/min), `THROTTLE_CONTACT` (5/min), `THROTTLE_COMPLAINT_BURST` (6/min), `THROTTLE_COMPLAINT_DAILY` (40/day), `THROTTLE_ANON` (120/min), `THROTTLE_USER` (600/min) | as shown | Rate limits |
| `USE_CELERY`, `REDIS_URL` | `False`, `redis://127.0.0.1:6379/0` | Optional Celery worker + beat (section 5) |
| `PERIODIC_CHECKS`, `SLA_CHECK_INTERVAL_MINUTES`, `HOTSPOT_SCAN_INTERVAL_MINUTES` | on without Celery, `60`, `360` | Built-in scheduler (section 5) |
| `DEFAULT_CITY`, `DEFAULT_LAT`, `DEFAULT_LNG` | `Hyderabad`, `17.3850`, `78.4867` | Map defaults |
| `GEOCODING_ENABLED`, `NOMINATIM_URL`, `NOMINATIM_USER_AGENT` | `True`, the public Nominatim server, `CivicAI/1.0 (final-year academic project)` | OpenStreetMap Nominatim proxy; use a user agent with a real contact address |
| `REOPEN_WINDOW_DAYS` | `14` | How long a citizen can reopen a resolved complaint |
| `TIME_ZONE`, `LOG_LEVEL` | `Asia/Kolkata`, `INFO` | Time zone for dates and analytics; log level |
| `SECURE_SSL_REDIRECT`, `SECURE_HSTS_SECONDS`, `SECURE_HSTS_PRELOAD` | `True`, one year, `False` | HTTPS settings, used only when `DEBUG=False` |
| `FRONTEND_URL` | `http://localhost:5173` | Stored in the settings; not used by the current code |
| `CIVICAI_ADMIN_EMAIL`, `CIVICAI_ADMIN_PASSWORD` | none | `init_civicai` creates / updates this administrator |
| `PORT`, `WEB_CONCURRENCY`, `GUNICORN_THREADS`, `FORWARDED_ALLOW_IPS` | `8000`, `2`, `4`, `*` | gunicorn (`gunicorn.conf.py`) |

---

## 3. Database: MySQL (and SQLite)

MySQL 8 is the production database; SQLite exists for a zero-setup start and for quick experiments. The code is
written for both (no database date functions, no JSON `__contains`, no Postgres features) and the full test suite
passes on both (707 tests each, 18 October 2026).

**First MySQL setup** (the MySQL80 service must be running and `DATABASE_USER` / `DATABASE_PASSWORD` set in `.env`):

```bash
venv/Scripts/python.exe scripts/setup_mysql.py --migrate --seed   # create `civicai` (utf8mb4), migrate, reference + demo data
# or keep what you built on SQLite - every row and id is copied (the photos in media/ are shared):
venv/Scripts/python.exe scripts/setup_mysql.py --copy-sqlite      # add --replace to overwrite a non-empty MySQL database
# optional: a dedicated MySQL user with rights on civicai / test_civicai only
venv/Scripts/python.exe scripts/setup_mysql.py --create-user civicai --migrate
```

Then set `DB_ENGINE=mysql` in `.env` and restart the server. Switching back to `DB_ENGINE=sqlite` uses
`backend/civicai.sqlite3` (`SQLITE_NAME` changes the file).

**Drivers.** `requirements.txt` installs mysqlclient on Windows only and PyMySQL everywhere; `config/settings.py`
uses mysqlclient when it can be imported and otherwise installs PyMySQL in its place (Linux hosts such as Render).
Their TLS options differ: see [DEPLOYMENT.md](../docs/DEPLOYMENT.md#tls-options).

**Tests on MySQL**: `DB_ENGINE=mysql venv/Scripts/python.exe manage.py test --noinput` (PowerShell:
`$env:DB_ENGINE='mysql'; ...`). Django creates and drops `test_civicai`, so the MySQL user needs the right to create
that database. Run the suite on MySQL before every release: SQLite is more forgiving (it does not enforce
`max_length`, and returns some expressions with other types) than the production database.

---

## 4. AI engine: demo and production mode

`MODEL_MODE=demo` (default) runs the complete pipeline without trained weights and labels every result honestly
(`is_demo: true`, demo model versions, "Demo AI Mode" in the UI): OpenCV heuristics for photos, a TF-IDF + logistic
regression text classifier, a sentiment lexicon, perceptual hashes for duplicate photos. `MODEL_MODE=production`
loads the deep-learning models and falls back to the demo technique (reporting `fallback_reason`) when a model
cannot be loaded:

```bash
venv/Scripts/python.exe -m pip install -r requirements-ml.txt    # PyTorch, transformers, sentence-transformers, ultralytics
venv/Scripts/python.exe manage.py warmup_ai --strict              # download / load the models and print their status
```

| Component | Demo mode | Production mode |
|---|---|---|
| Text classification | TF-IDF + logistic regression | all-MiniLM-L6-v2 sentence embeddings + logistic regression |
| Sentiment | lexicon with negation / intensifiers | cardiffnlp twitter-roberta-base-sentiment-latest |
| Image classification | OpenCV colour / texture / shape heuristics | YOLOv8 detector if `ml_models/yolo/civicai_yolov8.pt` exists, else CLIP ViT-B/32 zero-shot |
| Duplicates | pHash / dHash / aHash + TF-IDF text similarity + GPS distance | + sentence embeddings and CLIP image embeddings |
| Verification | SSIM, histogram and region change, ORB alignment, issue re-detection | + CLIP scene similarity |

The production models take about 1.6 GB on disk (`ml_models/hf_cache`); on the development laptop they loaded in
17 s and the engine then used about 0.8 GB of memory, against about 0.2 GB in demo mode
([DEPLOYMENT.md](../docs/DEPLOYMENT.md#production-ai-mode)).

**Measured accuracy (be precise in the report and the viva).** The evaluation data is synthetic or hand-written by
the project, apart from 134 real street photos for vision; [docs/TESTING.md](../docs/TESTING.md#evaluation-scripts)
has the full tables.

* Text classifier: trained on `ai/nlp/data/complaint_corpus.csv` - 864 *synthetic*, template-generated complaints
  (`ai/nlp/data/build_corpus.py`). The honest number is the accuracy on 90 *hand-written* challenge complaints
  never used for training: **91.1 %** (demo) and **92.2 %** (production). The in-distribution template hold-out
  (100 % / 98.8 %) only shows that the model learned the templates. `scripts/train_text_classifier.py` writes both to
  `ml_models/nlp/report_<mode>.json`, and `/api/ai/model-info/` shows them.
* Vision: on the 90 generated sample photos (`scripts/evaluate_vision.py`, no file-name hints) the demo heuristics
  reach 98.9 % - the photos are drawn by `scripts/generate_sample_images.py`, so this measures the pipeline, not real
  street photos - and CLIP zero-shot (production without YOLO weights) 61.1 %. On the 134 real street photos of
  `sample_data/real_images` (`--images sample_data/real_images`): demo heuristics **22.4 %**, CLIP **64.2 %**; the demo
  fusion therefore counts the heuristic half.

**YOLO is not shipped.** `ai/vision/model.py` supports a YOLOv8 civic-issue detector, `scripts/train_yolo.py` trains
one and `ai/vision/dataset.yaml` describes the 9 classes, but no trained weights are included and the default
virtual environment does not have `ultralytics`. A detector trained only on the synthetic sample photos
(`train_yolo.py --prepare-samples`) would test the pipeline but say nothing about real photos, so it is not
presented as a model. To add one: install `requirements-ml.txt` (ultralytics brings `opencv-python`; keep only one
OpenCV wheel in the environment), convert a labelled public dataset (RDD2022 road damage, Roboflow pothole sets, TACO
litter - see the notes in `scripts/train_yolo.py`) to `ai/vision/dataset.yaml`, run
`scripts/train_yolo.py --data ai/vision/dataset.yaml --epochs 100`, and re-run `scripts/evaluate_vision.py` with
`MODEL_MODE=production`. Until then production vision is CLIP zero-shot, and the model registry
(`/api/ai/model-info/`, Admin > AI analytics) reports YOLO as "not installed".

[docs/AI_ENGINE.md](../docs/AI_ENGINE.md) explains every component of the engine.

---

## 5. Periodic checks and background jobs

Two checks run periodically: the **SLA check** (open high / critical complaints past their due date or open longer
than the configured hours alert the administrators and the assigned officer, once per complaint per 24 h) and the
**city-wide hotspot scan** (DBSCAN clusters of open complaints raise hotspot alerts).

* **Default (`USE_CELERY=False`)**: the built-in scheduler (`apps/core/scheduler.py`) starts a due check in a
  background thread on the first request after its interval (`SLA_CHECK_INTERVAL_MINUTES=60`,
  `HOTSPOT_SCAN_INTERVAL_MINUTES=360`). No worker or broker is needed; `PERIODIC_CHECKS=False` turns it off.
* **Celery (`USE_CELERY=True`, `REDIS_URL`)**: `celery -A config worker -l info --pool=solo` (Windows) and
  `celery -A config beat -l info` (hourly SLA check, hotspot scan every 6 hours). The built-in scheduler is then off.
* Manually: `manage.py check_sla [--dry-run]`, or the admin's "Run checks now" button (`POST /api/analytics/run-checks/`).

---

## 6. Security notes

* **Passwords**: Django's PBKDF2 hashing and validators (length 8, common, numeric, similarity, not only spaces).
* **JWT sessions**: access token 60 min, refresh token 7 days, rotated on every use with the used one blacklisted;
  concurrent use of one refresh token rotates it only once. Logout blacklists the refresh *and* the access token.
  Every token carries a password fingerprint (`CHECK_REVOKE_TOKEN`), so a password change (by the user or an admin)
  ends all existing sessions at once; `POST /auth/change-password/` returns a fresh `access` / `refresh` pair for
  the session that made the change.
* **Roles and scoping**: every endpoint has explicit permission classes; citizens see only their own complaints,
  officers their assignments / department. Citizens never receive officers' or other citizens' phone numbers and
  e-mail addresses, and the "similar issues nearby" check and duplicate links show other citizens' reports without
  their description, photo or exact address.
* **Uploads**: extension *and* real format (JPEG / PNG / WebP decided by Pillow), size, side and pixel-count limits
  are checked before anything is decoded (decompression bombs: a 100 KB PNG can declare 8000x8000 pixels). Accepted
  photos are re-encoded: downscaled to 2560 px, EXIF orientation applied, all EXIF / XMP metadata (GPS position,
  phone model, capture time) removed, stored as `<random token>-<name>.<real extension>`. Measured transient memory
  per upload (re-encoding + AI analysis): about 90 MB for a 24 Mpx JPEG, up to about 200 MB for a 12 Mpx WebP
  (PNG / WebP cannot be decoded at a reduced scale); size `WEB_CONCURRENCY` and `GUNICORN_THREADS` accordingly
  (512 MB instance: 1 worker). An 8000x8000 "decompression bomb" is rejected before a single pixel is decoded.
* **Rate limits** (per client IP or user): login / register, contact form, public AI demo, AI endpoints and new
  complaints per citizen. Behind a reverse proxy set `NUM_PROXIES` to the number of proxies; with the default `0`
  the client address is `REMOTE_ADDR` and a forged `X-Forwarded-For` header is ignored. The same rule decides the IP
  stored in the audit log, which only ever holds valid IP addresses.
* **Input robustness**: ids beyond 64 bits, Unicode digits, dates outside 2000-2100, oversized bodies
  (`MAX_REQUEST_BODY_MB`, answered 413 before the body is read) and form bombs get 4xx answers, never a 500.
* **Audit log**: logins (also failed ones), registrations, password changes, admin edits, assignments, status
  changes, AI overrides and configuration changes (`GET /api/audit-logs/`).

---

## 7. Tests

```bash
venv/Scripts/python.exe manage.py test --noinput                    # 707 tests on the database DB_ENGINE selects
DB_ENGINE=sqlite venv/Scripts/python.exe manage.py test --noinput   # the same on in-memory SQLite
venv/Scripts/python.exe -m unittest discover -s ai/tests -t .       # AI engine only (224 tests, no Django)
venv/Scripts/python.exe scripts/smoke_test_api.py --base http://127.0.0.1:8001/api \
    --admin-email admin@civicai.local --officer-email roads.officer1@civicai.local \
    --citizen-email citizen@civicai.local     # a running copy; passwords from SMOKE_*_PASSWORD; creates data
```

The smoke test creates data: run it against a copy of the database served on another port
([docs/TESTING.md](../docs/TESTING.md#working-on-a-copy-of-the-demo-database)), never against the data you present.

On 18 October 2026 all 707 tests passed on in-memory SQLite (55 s) and on MySQL 8.0.42 (62 s), and the smoke test
passed 97 of 97 checks against a copy of the demo data. [docs/TESTING.md](../docs/TESTING.md) lists every test
module and the evaluation scripts; the browser end-to-end tests live in `../e2e` ([e2e/README.md](../e2e/README.md)).

---

## 8. Deployment

`../render.yaml` deploys this folder to Render (`bash build.sh`, then `gunicorn config.wsgi -c gunicorn.conf.py`);
`Procfile` holds the same start command for other hosts. The free plan runs demo mode with one worker, and its disk
is not persistent, so uploaded photos are lost when the service restarts. On Render the MySQL driver is PyMySQL,
which rejects `?ssl_mode=REQUIRED` in `DATABASE_URL`. [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md) has the full
guide: environment variables, cloud MySQL with TLS, Vercel, production AI mode and post-deploy checks.
