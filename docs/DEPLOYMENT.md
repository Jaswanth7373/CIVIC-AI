# Deployment

This guide puts CivicAI on the internet with free-tier services: the Django API on **Render**, the React web app
on **Vercel** and a **Supabase PostgreSQL** database (a cloud MySQL 8 server works too). Everything it describes comes from the files in the repository
(`render.yaml`, `backend/build.sh`, `backend/gunicorn.conf.py`, `backend/Procfile`, `backend/.env.example`,
`backend/config/settings.py`, `frontend/vercel.json`) and from measurements on the development laptop.

The configuration files are checked by `backend/apps/core/test_deploy.py` (gunicorn settings, Procfile, build
script, blueprint and media serving). A live deployment needs your own Render, Vercel and database accounts, so it
was not carried out during development: treat the steps for those services as a plan that still has to be tried
once.

```mermaid
flowchart LR
    U["Browser"] -- "HTML, JS, CSS" --> V["Vercel<br/>frontend/dist + vercel.json"]
    U -- "HTTPS /api/ and /media/" --> R["Render web service<br/>gunicorn + Django (backend/)"]
    R -- "DATABASE_URL" --> M[("Supabase PostgreSQL")]
    R -- "HTTPS, geocoding" --> N["OpenStreetMap Nominatim"]
    U -- "map tiles" --> T["OpenStreetMap tile servers"]
```

## Contents

- [Before you start](#before-you-start)
- [Supabase PostgreSQL](#supabase-postgresql)
- [Cloud MySQL](#cloud-mysql)
- [API on Render](#api-on-render)
- [Web app on Vercel](#web-app-on-vercel)
- [CORS, CSRF and hosts](#cors-csrf-and-hosts)
- [Production AI mode](#production-ai-mode)
- [Demo data on a deployment](#demo-data-on-a-deployment)
- [Post-deploy checks](#post-deploy-checks)
- [Updating a deployment](#updating-a-deployment)

## Before you start

- Push the repository to GitHub; Render and Vercel deploy from a Git repository. `.gitignore` keeps `.env`, the
  virtual environment, `backend/media/`, SQLite files and model weights out of Git, so no secret or upload is
  published.
- Create accounts on Render, Vercel and Supabase (or a MySQL provider).
- The examples below use the placeholder addresses `https://civicai-api.onrender.com` for the API and
  `https://civicai.vercel.app` for the web app. Replace them with the addresses your services get.

The order matters a little: create the database first (the API's build runs the migrations), then the API, then
the web app, and finally put the web app's address into the API's CORS settings.

## Supabase PostgreSQL

The project's database is a Supabase PostgreSQL 17 project (project ref `iutdabdqfkhwtrncautr`, region Tokyo,
`ap-northeast-1`). Django only needs a connection string in `DATABASE_URL`; the tables come from Django's own
migrations, so the Supabase CLI (`supabase init` / `link`), the project URL and the publishable key are not used.

| Where the API runs | `DATABASE_URL` |
|---|---|
| Development laptop (has IPv6): direct connection, used in `backend/.env` | `postgresql://postgres:PASSWORD@db.iutdabdqfkhwtrncautr.supabase.co:5432/postgres?sslmode=require` |
| Render (IPv4 only): session pooler | `postgresql://postgres.iutdabdqfkhwtrncautr:PASSWORD@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres?sslmode=require` |

- Percent-encode special characters in the password (`@` becomes `%40`).
- The direct host `db.<ref>.supabase.co` has only an IPv6 address on Supabase's free plan, so Render, which has no
  outbound IPv6, must use the session pooler. Use the session pooler on port 5432, not the transaction pooler on
  port 6543, which does not keep a session between transactions.
- The driver is `psycopg2-binary` (in `requirements.txt`). psycopg 3 was tried first, but Windows Smart App Control
  blocks its unsigned `libpq` DLL.
- `config/settings.py` keeps connections open for 600 s and checks them before reuse, since a cloud database or
  pooler may close idle connections.
- **Latency.** Measured on 25 October 2026 from the development laptop (Hyderabad) to the Tokyo region: 108 ms per
  query, against under 1 ms for MySQL on the laptop. A complaint's detail page (13 queries) took 2.1 s instead of
  0.12 s and the admin overview 3.2 s instead of 0.7 s. A project in the Mumbai region (`ap-south-1`), and an API
  hosted near it, would cut this considerably; Supabase cannot move an existing project to another region.
- **Data.** On 25 October 2026 `manage.py migrate` created the tables and the existing data (6,575 rows: reference
  data, accounts, the demo dataset and one real user's complaint) was copied from the local MySQL database with
  primary keys and timestamps kept; the row counts of all tables matched. Uploaded photos are not in the database:
  they stay in `backend/media` (see [Uploaded photos](#uploaded-photos-and-the-free-plans-disk)).
- **Compatibility.** The full backend suite (720 tests) passed on PostgreSQL 17.7 (EDB build, local) on the same day.

To go back to the local MySQL database, remove or comment out the `DATABASE_URL` line in `backend/.env`.

## Cloud MySQL

Any MySQL 8 server that Render can reach over the internet works: Railway, Aiven or another provider. Create a
database for CivicAI (the provider's default database, such as `railway` on Railway or `defaultdb` on Aiven, is fine
too) and copy its external connection details.

The API reads one variable, `DATABASE_URL`:

```
mysql://USER:PASSWORD@HOST:PORT/DATABASE
```

- Percent-encode special characters in the password (`@` becomes `%40`, `:` becomes `%3A`, `/` becomes `%2F`).
- When `DATABASE_URL` is set it wins over `DB_ENGINE` and the `DATABASE_*` variables. `config/settings.py` parses
  it with dj-database-url, keeps connections open for 600 s and adds `charset=utf8mb4` and
  `sql_mode=STRICT_TRANS_TABLES`.
- The build runs `migrate`, so the database must be reachable from Render when the first build starts.

### TLS options

Many providers require encrypted connections. Query parameters on `DATABASE_URL` are passed straight to the MySQL
driver, and the two drivers CivicAI can use accept different parameters. On Render (Linux) `requirements.txt`
installs only PyMySQL; on Windows it also installs mysqlclient, which `settings.py` then prefers. These
combinations were tried against the local MySQL 8.0.42 server on 18 October 2026 with PyMySQL 1.2.3 and
mysqlclient 2.3.0:

| Ending of `DATABASE_URL` | PyMySQL (Render, Linux) | mysqlclient (Windows) |
|---|---|---|
| no parameters | Encrypted when the server offers TLS; the certificate is not checked | Not encrypted |
| `?ssl-ca=PATH` | Encrypted; the server certificate is checked against the CA file at `PATH`, which must exist | Encrypted, but the certificate is not checked by this option alone (the test passed even with a missing CA file) |
| `?ssl_verify_cert=true` | Encrypted; the certificate is checked against the system's trusted CAs (it failed against the local server's self-signed certificate, as expected) | Fails: `connect() got an unexpected keyword argument 'ssl_verify_cert'` |
| `?ssl_mode=REQUIRED` | Fails: `Connection.__init__() got an unexpected keyword argument 'ssl_mode'` | Encrypted |
| `?ssl-mode=REQUIRED` | Fails (unknown argument) | Fails (unknown argument) |

What to use on Render:

- **Provider certificate signed by a public CA:** add `?ssl_verify_cert=true`.
- **Provider with its own CA** (Aiven, for example, offers a CA certificate to download): commit that certificate
  to the repository, for example as `backend/certs/provider-ca.pem` (a CA certificate is public, not a secret),
  and add `?ssl-ca=certs/provider-ca.pem`. The path is relative to `backend/`, where Render runs the build and the
  server.
- If the provider's connection string ends with `?ssl-mode=REQUIRED`, remove that part and use one of the two
  options above.

Do not use `?ssl_mode=REQUIRED`, which some connection guides suggest: it only works with mysqlclient, not with the
PyMySQL driver that Render uses. The comment at the top of `render.yaml` gives the same two options as above.

## API on Render

### The blueprint

`render.yaml` describes one web service:

| Setting | Value |
|---|---|
| Name | `civicai-api` |
| Runtime and plan | `python`, `free` |
| Root directory | `backend` |
| Build command | `bash build.sh` |
| Start command | `gunicorn config.wsgi -c gunicorn.conf.py` |
| Auto-deploy | on (every push to the connected branch) |

In the Render dashboard, create a new Blueprint from your repository; Render reads `render.yaml` and asks for the
values marked `sync: false` (listed below). The Python version comes from `backend/.python-version` (3.13).

`build.sh` runs, in this order:

1. `pip install -r requirements.txt` (and `requirements-ml.txt` when `MODEL_MODE=production`);
2. `python manage.py collectstatic --noinput` (WhiteNoise serves the files from `backend/staticfiles`);
3. `python manage.py migrate --noinput`;
4. `python manage.py init_civicai --keep-existing`: departments, categories, routing, AI configuration and risk
   zones, without overwriting rows an administrator has edited. When `CIVICAI_ADMIN_EMAIL` and
   `CIVICAI_ADMIN_PASSWORD` are set it also creates or updates that administrator;
5. `python manage.py warmup_ai` when `MODEL_MODE=production` (downloads and caches the models during the build).

`gunicorn.conf.py` binds to `0.0.0.0:$PORT`, starts `WEB_CONCURRENCY` worker processes (default 2, the blueprint
sets 1) with `GUNICORN_THREADS` threads each (default 4), and allows 120 s per request, because submitting a
complaint runs the whole AI pipeline synchronously. In production AI mode each new worker loads the models in a
background thread, so it can answer the health check while they load. `backend/Procfile` contains the same start
command for hosts that use Procfiles (Railway, Heroku-style platforms).

### Environment variables

The blueprint sets most values. Enter the ones marked "you" in the Render dashboard; never commit them.

| Variable | Blueprint value | Meaning |
|---|---|---|
| `SECRET_KEY` | generated by Render | Django secret; the server refuses to start without it when `DEBUG=False` |
| `JWT_SECRET` | generated by Render | Signs the login tokens (falls back to `SECRET_KEY` when empty) |
| `DEBUG` | `False` | Production mode: JSON-only API, HTTPS redirect, secure cookies, HSTS |
| `ALLOWED_HOSTS` | `.onrender.com,localhost,127.0.0.1` | Host names the API answers; Render's own host name (`RENDER_EXTERNAL_HOSTNAME`) is added automatically |
| `CSRF_TRUSTED_ORIGINS` | `https://*.onrender.com` | Needed for the Django admin login at `/admin/` |
| `CORS_ALLOWED_ORIGINS` | you | The web app's origin, for example `https://civicai.vercel.app` |
| `CORS_ALLOWED_ORIGIN_REGEXES` | you, optional | For example `^https://civicai.*\.vercel\.app$` to allow Vercel preview deployments |
| `FRONTEND_URL` | you | The web app's address; stored in the settings but not used by the current code |
| `TIME_ZONE` | `Asia/Kolkata` | Time zone for analytics buckets and dates |
| `SECURE_SSL_REDIRECT` | `True` | Redirect plain HTTP to HTTPS |
| `DATABASE_URL` | you | The session pooler URL; see [Supabase PostgreSQL](#supabase-postgresql) |
| `JWT_ACCESS_MINUTES`, `JWT_REFRESH_DAYS` | `60`, `7` | Token lifetimes |
| `MODEL_MODE` | `demo` | `production` needs more memory; see [Production AI mode](#production-ai-mode) |
| `MODEL_PATH` | `./ml_models` | Model cache folder, relative to `backend/` |
| `MAX_IMAGE_UPLOAD_MB` | `8` | Largest accepted photo |
| `SERVE_MEDIA` | `True` | Django serves `/media/` although `DEBUG=False` (single instance, no object storage) |
| `NUM_PROXIES` | `1` | Number of reverse proxies in front of the app; see below |
| `DEFAULT_CITY`, `DEFAULT_LAT`, `DEFAULT_LNG` | `Hyderabad`, `17.3850`, `78.4867` | Map centre and city |
| `GEOCODING_ENABLED` | `True` | Address lookup through Nominatim |
| `NOMINATIM_USER_AGENT` | you | Identify the deployment, for example `CivicAI/1.0 (contact: you@your-college.edu)`; Nominatim answers 403 to placeholder agents |
| `USE_CELERY` | `False` | The built-in scheduler runs the SLA check and hotspot scan |
| `REDIS_URL` | you, only with Celery | Celery broker |
| `CIVICAI_ADMIN_EMAIL`, `CIVICAI_ADMIN_PASSWORD` | you | First administrator, created by `init_civicai` during the build; the password must pass Django's password validators |
| `WEB_CONCURRENCY` | `1` | gunicorn workers; each holds its own copy of the AI models |
| `GUNICORN_THREADS` | `4` | Threads per worker |
| `LOG_LEVEL` | `INFO` | Log level of the CivicAI loggers and gunicorn |

Other settings keep their defaults unless you add them: the `THROTTLE_*` rate limits, `PERIODIC_CHECKS`,
`SLA_CHECK_INTERVAL_MINUTES` (60), `HOTSPOT_SCAN_INTERVAL_MINUTES` (360), `REOPEN_WINDOW_DAYS` (14),
`MAX_REQUEST_BODY_MB` (20), `SECURE_HSTS_SECONDS` (one year), `MEDIA_DIR` (`media`) and `FORWARDED_ALLOW_IPS`
(gunicorn, `*`). `backend/README.md` describes all of them.

### NUM_PROXIES

Rate limits and the IP addresses in the audit log are worked out from the client address. With `NUM_PROXIES=0`
(the local default) the API uses the address of the TCP connection and ignores `X-Forwarded-For`, which clients can
forge. Behind Render's proxy every connection comes from the proxy, so with 0 all visitors would share one address:
the login limit of 20 attempts per minute, for example, would apply to everybody together. `NUM_PROXIES=1` makes the
API take the address that Render's proxy added to `X-Forwarded-For`. Set it to the real number of proxies on any other
host.

### Uploaded photos and the free plan's disk

`SERVE_MEDIA=True` lets Django serve the uploaded photos from `backend/media` on the instance. The storage backend
is Django's local file system; object storage (S3 and similar) is not implemented. On Render's free plan the
instance disk is not persistent: files written while the service runs disappear when it restarts or redeploys,
while the complaint rows stay in the database. After a restart those complaints show broken photo links.

- For a short demonstration this is acceptable if you upload the photos after the last deploy.
- For a lasting deployment, use a paid instance with a persistent disk and point `MEDIA_DIR` at its mount path
  (`MEDIA_DIR` accepts an absolute path, for example `/var/data/media`), or add an object-storage backend (a code
  change).

Free instances also spin down after a period without traffic; the next request then waits while the service
starts again. The built-in scheduler only runs on requests, so the SLA check and the hotspot scan catch up on the
first request after the pause.

## Web app on Vercel

1. Import the repository in Vercel and set **Root Directory** to `frontend`. Vercel detects Vite; the commands are
   `npm install`, `npm run build` and the output directory `dist`.
2. Add the environment variable `VITE_API_URL=https://civicai-api.onrender.com/api` (the API address followed by
   `/api`). Vite writes `VITE_` variables into the bundle at build time, so redeploy after changing it.
3. Deploy. Vite 7 needs Node.js 20.19+ or 22.12+; choose such a version in the project settings if the build
   complains.

`frontend/vercel.json` adds:

- a rewrite of every path to `/index.html`, so links such as `/admin/dashboard` work when the page is reloaded
  (files that exist, such as `/assets/*`, are served as they are);
- security headers on every response: `X-Content-Type-Options: nosniff`, `Referrer-Policy:
  strict-origin-when-cross-origin` and `Permissions-Policy: geolocation=(self), camera=(self), microphone=()`
  (location and camera stay available to the app itself);
- long-lived caching for `/assets/*` (file names contain content hashes) and `no-cache` for `sw.js` and
  `manifest.webmanifest`, so a new deployment's service worker is picked up.

The service worker is registered only in production builds and never caches `/api/` or `/media/` requests. The
production bundle does not contain the demo passwords, so the login page of a deployed site shows no "Demo
accounts" panel; give testers their logins separately.

Finally, put the Vercel address into the API's `CORS_ALLOWED_ORIGINS` and let Render restart the service.

## CORS, CSRF and hosts

- **CORS.** The browser only lets the web app read API responses when the API lists the web app's origin.
  `CORS_ALLOWED_ORIGINS` takes exact origins (scheme, host and port, no trailing slash, comma-separated);
  `CORS_ALLOWED_ORIGIN_REGEXES` takes regular expressions. The API also exposes the `Content-Disposition` header
  (file names of report downloads) and `Retry-After` (wait time after HTTP 429).
- **CSRF.** The web app sends a bearer token in the `Authorization` header, not a cookie, so CSRF protection does not
  apply to its API calls. It does apply to the Django admin at `/admin/`, which uses a session cookie; the blueprint
  trusts `https://*.onrender.com` for that.
- **Hosts.** `ALLOWED_HOSTS` must contain the API's host name. `.onrender.com` covers Render's address; add your own
  domain if you attach one.
- **HTTPS.** With `DEBUG=False` the API redirects HTTP to HTTPS, marks cookies secure, sends HSTS for one year and
  trusts the `X-Forwarded-Proto` header of the proxy.

## Production AI mode

`MODEL_MODE=production` replaces the demo techniques with pretrained models (CLIP ViT-B/32 for photos when no YOLO
weights exist, all-MiniLM-L6-v2 for text, RoBERTa for sentiment). With that value `build.sh` installs
`requirements-ml.txt` and runs `warmup_ai`, which downloads the models into `ml_models/hf_cache` during the build.
On the development machine that cache holds about 1.6 GB (RoBERTa sentiment 957 MB, CLIP 579 MB, MiniLM 88 MB).

Memory and load time of the AI engine, measured on the development laptop (Windows 11, Python 3.13.3, CPU only,
models already downloaded) with one complaint analysis, one before/after verification and one image comparison
after the warm-up. The figures are for the AI engine in a plain Python process; Django and gunicorn come on top:

| | Demo mode | Production mode |
|---|---|---|
| Warm-up (load the NLP and vision models) | 2.6 s | 17.3 s |
| Memory after the three calls | 199 MB | 788 MB |
| Peak memory (working set) | 221 MB | 805 MB |

What follows from this:

- The free plan's 512 MB is enough for demo mode with one worker (the blueprint's setting), but not for production
  mode. Every gunicorn worker loads its own copy of the models, so plan memory per worker; an instance with about
  2 GB and `WEB_CONCURRENCY=1` leaves room for Django and request peaks.
- On Linux the default PyTorch package from PyPI includes CUDA libraries and is a very large download. A CPU-only
  server can use the CPU build instead (`pip install torch torchvision --index-url
  https://download.pytorch.org/whl/cpu` before `requirements-ml.txt`), which needs a change to `build.sh`.
- `python manage.py warmup_ai --strict` (for example in a shell on the instance) prints every model's status and
  fails when a model cannot be loaded. Without `--strict` it always succeeds and the engine falls back to the demo
  technique, reporting `fallback_reason`.
- A trained YOLO detector is not part of the repository: `*.pt` files are git-ignored, so
  `ml_models/yolo/civicai_yolov8.pt` would have to be downloaded during the build. Without it, production mode uses
  CLIP zero-shot classification, which reached 61.1 % on the 90 generated sample photos (see
  [TESTING.md](TESTING.md#vision-evaluate_visionpy)).
- The text classifier caches (`*.joblib`) are git-ignored as well; the engine retrains them from the bundled corpus
  on first use, which takes seconds.

## Demo data on a deployment

`build.sh` installs the reference data but no demo complaints. `seed_demo` stores its photos in the `MEDIA_ROOT`
of the machine that runs it, which leads to two cases:

- **Run from your laptop** with `DATABASE_URL` pointing at the cloud database: the rows reach the cloud database,
  but the photos stay in your local `backend/media`, so the deployed API shows broken images.
- **Run on the Render instance** (through a shell, on plans that offer one): the photos land on the instance disk,
  which on the free plan is wiped at the next restart or deploy.

For the viva it is therefore simplest to present the seeded data from the laptop and use the deployment to show
that the platform runs in the cloud, with a few complaints entered live. The free instance runs demo mode, so the
same AI techniques answer on both.

## Post-deploy checks

1. **Health.** `https://civicai-api.onrender.com/api/health/` answers
   `{"status": "ok", "service": "civicai-api", "model_mode": "demo", "demo_mode": true}`. This endpoint does not
   touch the database. `https://civicai-api.onrender.com/api/departments/` (public) lists the 7 departments that
   `init_civicai` created, which proves the database connection and the migrations, and `/api/system/config/`
   shows the AI mode and map settings the web app will use.
2. **Web app.** Open the Vercel address and log in as the administrator from `CIVICAI_ADMIN_EMAIL`. The browser's
   developer console must not show CORS errors, and the "Demo AI Mode" badge appears in the top bar in demo mode.
3. **Photos.** Report a test issue with a photo as a citizen (register one on the site) and check that the photo
   appears on the complaint page; that confirms `SERVE_MEDIA`.
4. **Smoke test.** From your machine, run the live API smoke test against the deployment. It needs an
   administrator, an officer of the Roads Department (the default photo is a pothole) and a citizen. On a fresh
   deployment create the officer on the Officers page and register the citizen on the site first. Passwords can
   come from environment variables so that they stay out of the shell history:

   ```powershell
   cd backend
   $env:SMOKE_ADMIN_PASSWORD = '...'
   $env:SMOKE_OFFICER_PASSWORD = '...'
   $env:SMOKE_CITIZEN_PASSWORD = '...'
   venv\Scripts\python.exe scripts\smoke_test_api.py --base https://civicai-api.onrender.com/api `
       --admin-email ADMIN_EMAIL --officer-email OFFICER_EMAIL --citizen-email CITIZEN_EMAIL
   ```

   It logs in with the three roles, calls every GET endpoint of the API contract and runs the main write flows
   (submit a complaint with a photo, accept, start work, upload evidence, resolve, AI verification, feedback,
   notifications, the public AI demo), checking status codes and response keys. It prints a PASS/FAIL table and
   exits with 0 when every check passed, 1 when a check failed and 2 when the server cannot be reached or a login
   fails. It **creates data** (a complaint that ends up closed, its evidence and feedback), so run it before real
   users arrive. Against a private copy of the demo data it passed 97 of 97 checks on 18 October 2026.
5. **Client addresses.** After a few logins, the administrator's Audit log page should show the real client
   addresses, not the proxy's; otherwise check `NUM_PROXIES`.

## Updating a deployment

- With auto-deploy on, every push to the connected branch rebuilds the API: migrations run and `init_civicai
  --keep-existing` adds any new reference data without touching edited rows.
- Render generates `SECRET_KEY` and `JWT_SECRET` once and keeps them; changing either signs every user out.
- Vercel rebuilds the web app on every push. Change `VITE_API_URL` only together with a new build.
- After changing `CORS_ALLOWED_ORIGINS` or other variables, Render restarts the service; on the free plan that
  also clears the uploaded photos (see above).
