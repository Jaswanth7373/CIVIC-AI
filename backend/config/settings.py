"""
Django settings for the CivicAI backend.

All secrets and environment specific values come from environment variables
(loaded from backend/.env in development). See backend/.env.example.
"""
import os
import sys
from datetime import timedelta
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")


def env(key, default=None):
    return os.environ.get(key, default)


def env_bool(key, default=False):
    value = os.environ.get(key)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def env_int(key, default):
    try:
        return int(os.environ.get(key, default))
    except (TypeError, ValueError):
        return default


def env_list(key, default=""):
    raw = os.environ.get(key, default) or ""
    return [item.strip() for item in raw.split(",") if item.strip()]


TESTING = len(sys.argv) > 1 and sys.argv[1] == "test"

# ---------------------------------------------------------------------------
# Core security
# ---------------------------------------------------------------------------
DEBUG = env_bool("DEBUG", False)
SECRET_KEY = env("SECRET_KEY")
if not SECRET_KEY:
    if DEBUG or TESTING:
        SECRET_KEY = "dev-insecure-civicai-secret-key-change-me"  # dev/test only
    else:
        raise RuntimeError("SECRET_KEY environment variable is required when DEBUG=False")

ALLOWED_HOSTS = env_list("ALLOWED_HOSTS", "localhost,127.0.0.1")
# Render injects the public hostname of the service; accept it automatically.
if env("RENDER_EXTERNAL_HOSTNAME") and env("RENDER_EXTERNAL_HOSTNAME") not in ALLOWED_HOSTS:
    ALLOWED_HOSTS.append(env("RENDER_EXTERNAL_HOSTNAME"))
CSRF_TRUSTED_ORIGINS = env_list("CSRF_TRUSTED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173")

# ---------------------------------------------------------------------------
# Applications
# ---------------------------------------------------------------------------
INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    # Third party
    "rest_framework",
    "rest_framework_simplejwt",
    "rest_framework_simplejwt.token_blacklist",
    "corsheaders",
    "django_filters",
    # CivicAI apps
    "apps.core",
    "apps.accounts",
    "apps.departments",
    "apps.officers",
    "apps.complaints",
    "apps.assignments",
    "apps.feedback",
    "apps.notifications",
    "apps.analytics",
    "apps.audit",
]

MIDDLEWARE = [
    "corsheaders.middleware.CorsMiddleware",
    "apps.core.middleware.RequestBodyLimitMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    "apps.core.scheduler.PeriodicChecksMiddleware",
]

ROOT_URLCONF = "config.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "config.wsgi.application"
ASGI_APPLICATION = "config.asgi.application"

# ---------------------------------------------------------------------------
# Database (MySQL by default)
#   DB_ENGINE=mysql   -> uses DATABASE_NAME/USER/PASSWORD/HOST/PORT
#   DATABASE_URL=...  -> connection string, overrides the above: PostgreSQL (e.g. Supabase,
#                        postgresql://postgres:<url-encoded password>@db.<project>.supabase.co:5432/postgres
#                        ?sslmode=require) or a cloud MySQL
#   DB_ENGINE=sqlite  -> local fallback for quick experiments / CI
# ---------------------------------------------------------------------------
DB_ENGINE = (env("DB_ENGINE", "mysql") or "mysql").lower()
DATABASE_URL = env("DATABASE_URL")

# MySQL driver: mysqlclient (C extension, prebuilt wheels on Windows) is preferred. Where it is not installed
# (e.g. Linux cloud builds without MySQL client headers) the pure-Python PyMySQL driver stands in for it.
try:  # pragma: no cover - depends on the installed driver
    import MySQLdb  # noqa: F401
except ImportError:  # pragma: no cover
    try:
        import pymysql

        pymysql.version_info = (2, 2, 1, "final", 0)  # Django checks the mysqlclient version it emulates
        pymysql.install_as_MySQLdb()
    except ImportError:
        pass

if DATABASE_URL:
    import dj_database_url

    # health checks: a cloud database (Supabase, a pooler) may close idle connections between requests
    DATABASES = {"default": dj_database_url.parse(DATABASE_URL, conn_max_age=600, conn_health_checks=True)}
    if DATABASES["default"]["ENGINE"].endswith("mysql"):
        DATABASES["default"].setdefault("OPTIONS", {}).update(
            {"charset": "utf8mb4", "init_command": "SET sql_mode='STRICT_TRANS_TABLES'"}
        )
elif DB_ENGINE == "sqlite":
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.sqlite3",
            "NAME": BASE_DIR / env("SQLITE_NAME", "civicai.sqlite3"),
        }
    }
else:
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.mysql",
            "NAME": env("DATABASE_NAME", "civicai"),
            "USER": env("DATABASE_USER", "root"),
            "PASSWORD": env("DATABASE_PASSWORD", ""),
            "HOST": env("DATABASE_HOST", "127.0.0.1"),
            "PORT": env("DATABASE_PORT", "3306"),
            "CONN_MAX_AGE": env_int("DATABASE_CONN_MAX_AGE", 60),
            "OPTIONS": {
                "charset": "utf8mb4",
                "init_command": "SET sql_mode='STRICT_TRANS_TABLES'",
            },
            "TEST": {"CHARSET": "utf8mb4", "COLLATION": "utf8mb4_unicode_ci"},
        }
    }

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
AUTH_USER_MODEL = "accounts.User"

# ---------------------------------------------------------------------------
# Authentication & passwords (PBKDF2 hashing - never plain text)
# ---------------------------------------------------------------------------
AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator", "OPTIONS": {"min_length": 8}},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
    {"NAME": "apps.accounts.password_validation.NotOnlyWhitespaceValidator"},
]

if TESTING:
    # Fast hashing for the test-suite only.
    PASSWORD_HASHERS = ["django.contrib.auth.hashers.MD5PasswordHasher"]

# ---------------------------------------------------------------------------
# Internationalisation
# ---------------------------------------------------------------------------
LANGUAGE_CODE = "en-us"
TIME_ZONE = env("TIME_ZONE", "Asia/Kolkata")
USE_I18N = True
USE_TZ = True

# ---------------------------------------------------------------------------
# Static & media
# ---------------------------------------------------------------------------
STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
STATICFILES_DIRS = [BASE_DIR / "static"] if (BASE_DIR / "static").exists() else []
STORAGES = {
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {
        "BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage"
        if not DEBUG and not TESTING
        else "django.contrib.staticfiles.storage.StaticFilesStorage"
    },
}

MEDIA_URL = "/media/"
MEDIA_ROOT = BASE_DIR / env("MEDIA_DIR", "media")
# Serve uploads from Django when DEBUG=False (single-instance deployments without object storage).
SERVE_MEDIA = env_bool("SERVE_MEDIA", False)

# Upload limits / validation (enforced in apps.core.validators; uploads are re-encoded by apps.core.images)
MAX_IMAGE_UPLOAD_MB = env_int("MAX_IMAGE_UPLOAD_MB", 8)
MAX_IMAGE_DIMENSION = env_int("MAX_IMAGE_DIMENSION", 8000)
# Decoded size limits: a few-KB PNG can declare 8000x8000 pixels (256 MB once decoded), so the pixel count is capped
# too, before decoding. JPEG (decoded at reduced scale): 25 Mpx keeps 24 Mpx phone photos (5712x4284). PNG / WebP
# (always decoded in full): 12 Mpx, enough for a 4000x3000 photo or a 4K screenshot.
MAX_IMAGE_PIXELS = env_int("MAX_IMAGE_PIXELS", 25_000_000)
MAX_FULL_DECODE_PIXELS = env_int("MAX_FULL_DECODE_PIXELS", 12_000_000)
# Stored copies are downscaled to this longest side (and stripped of EXIF / GPS metadata).
MAX_STORED_IMAGE_SIDE = env_int("MAX_STORED_IMAGE_SIDE", 2560)
ALLOWED_IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp"]
DATA_UPLOAD_MAX_MEMORY_SIZE = (MAX_IMAGE_UPLOAD_MB + 4) * 1024 * 1024
FILE_UPLOAD_MAX_MEMORY_SIZE = 5 * 1024 * 1024
# Whole request body (apps.core.middleware.RequestBodyLimitMiddleware): two photos (before + after) and form data.
MAX_REQUEST_BODY_BYTES = env_int("MAX_REQUEST_BODY_MB", 2 * MAX_IMAGE_UPLOAD_MB + 4) * 1024 * 1024

# ---------------------------------------------------------------------------
# Django REST Framework
# ---------------------------------------------------------------------------
REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": (
        "rest_framework_simplejwt.authentication.JWTAuthentication",
    ),
    "DEFAULT_PERMISSION_CLASSES": ("rest_framework.permissions.IsAuthenticated",),
    "DEFAULT_PAGINATION_CLASS": "apps.core.pagination.StandardResultsPagination",
    "PAGE_SIZE": 20,
    "DEFAULT_FILTER_BACKENDS": (
        "django_filters.rest_framework.DjangoFilterBackend",
        "rest_framework.filters.SearchFilter",
        "rest_framework.filters.OrderingFilter",
    ),
    "DEFAULT_RENDERER_CLASSES": (
        ("rest_framework.renderers.JSONRenderer", "rest_framework.renderers.BrowsableAPIRenderer")
        if DEBUG
        else ("rest_framework.renderers.JSONRenderer",)
    ),
    "DEFAULT_PARSER_CLASSES": (
        "rest_framework.parsers.JSONParser",
        "rest_framework.parsers.MultiPartParser",
        "rest_framework.parsers.FormParser",
    ),
    "EXCEPTION_HANDLER": "apps.core.exceptions.custom_exception_handler",
    "COERCE_DECIMAL_TO_STRING": False,
    # Number of trusted reverse proxies in front of the app. Rate limits and audit-log IPs identify a client by
    # REMOTE_ADDR when it is 0 (the default: X-Forwarded-For is ignored because clients can forge it), or by the
    # address the outermost trusted proxy appended to X-Forwarded-For (Render / Railway: NUM_PROXIES=1).
    # Never None: DRF would then key the throttles on the whole client-supplied header (rate-limit bypass).
    "NUM_PROXIES": max(0, env_int("NUM_PROXIES", 0)),
    "DEFAULT_THROTTLE_CLASSES": (
        "rest_framework.throttling.AnonRateThrottle",
        "rest_framework.throttling.UserRateThrottle",
    ),
    "DEFAULT_THROTTLE_RATES": {
        "anon": env("THROTTLE_ANON", "120/min"),
        "user": env("THROTTLE_USER", "600/min"),
        "auth": env("THROTTLE_AUTH", "20/min"),
        "ai": env("THROTTLE_AI", "60/min"),
        "ai_public": env("THROTTLE_AI_PUBLIC", "12/min"),
        "contact": env("THROTTLE_CONTACT", "5/min"),
        # New complaints per citizen (each one runs the full AI pipeline): a burst and a daily limit.
        "complaint_burst": env("THROTTLE_COMPLAINT_BURST", "6/min"),
        "complaint_daily": env("THROTTLE_COMPLAINT_DAILY", "40/day"),
    },
    "TEST_REQUEST_DEFAULT_FORMAT": "json",
}

if TESTING:
    REST_FRAMEWORK["DEFAULT_THROTTLE_CLASSES"] = ()

SIMPLE_JWT = {
    "ACCESS_TOKEN_LIFETIME": timedelta(minutes=env_int("JWT_ACCESS_MINUTES", 60)),
    "REFRESH_TOKEN_LIFETIME": timedelta(days=env_int("JWT_REFRESH_DAYS", 7)),
    "ROTATE_REFRESH_TOKENS": True,
    "BLACKLIST_AFTER_ROTATION": True,
    "UPDATE_LAST_LOGIN": True,
    "ALGORITHM": "HS256",
    "SIGNING_KEY": env("JWT_SECRET") or SECRET_KEY,
    "AUTH_HEADER_TYPES": ("Bearer",),
    "USER_ID_FIELD": "id",
    "USER_ID_CLAIM": "user_id",
    # Session control (apps/accounts/tokens.py): access tokens can be blacklisted at logout, and every token carries
    # a password fingerprint, so a password change ends all existing sessions immediately.
    "AUTH_TOKEN_CLASSES": ("apps.accounts.tokens.AccessToken",),
    "CHECK_REVOKE_TOKEN": True,
}

# ---------------------------------------------------------------------------
# CORS
# ---------------------------------------------------------------------------
CORS_ALLOWED_ORIGINS = env_list("CORS_ALLOWED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173")
CORS_ALLOWED_ORIGIN_REGEXES = env_list("CORS_ALLOWED_ORIGIN_REGEXES", "")
CORS_ALLOW_CREDENTIALS = True
# Lets the frontend read the download filename of report exports and the wait time of throttled (429) requests.
CORS_EXPOSE_HEADERS = ["Content-Disposition", "Retry-After"]

# ---------------------------------------------------------------------------
# Production hardening
# ---------------------------------------------------------------------------
if not DEBUG and not TESTING:
    SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
    SECURE_SSL_REDIRECT = env_bool("SECURE_SSL_REDIRECT", True)
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True
    SECURE_HSTS_SECONDS = env_int("SECURE_HSTS_SECONDS", 31536000)
    SECURE_HSTS_INCLUDE_SUBDOMAINS = True
    SECURE_HSTS_PRELOAD = env_bool("SECURE_HSTS_PRELOAD", False)
    SECURE_CONTENT_TYPE_NOSNIFF = True
    X_FRAME_OPTIONS = "DENY"

# ---------------------------------------------------------------------------
# Celery (optional). With USE_CELERY=False tasks execute eagerly in-process.
# ---------------------------------------------------------------------------
USE_CELERY = env_bool("USE_CELERY", False)
CELERY_BROKER_URL = env("REDIS_URL", "redis://127.0.0.1:6379/0")
CELERY_RESULT_BACKEND = env("REDIS_URL", "redis://127.0.0.1:6379/0")
CELERY_TASK_ALWAYS_EAGER = not USE_CELERY
CELERY_TASK_EAGER_PROPAGATES = False
CELERY_TIMEZONE = TIME_ZONE
CELERY_ACCEPT_CONTENT = ["json"]
CELERY_TASK_SERIALIZER = "json"
CELERY_RESULT_SERIALIZER = "json"
# Without Celery beat the periodic SLA check and hotspot scan are started by the built-in scheduler
# (apps/core/scheduler.py): the first request after an interval has elapsed runs the check in a background thread.
PERIODIC_CHECKS_ENABLED = env_bool("PERIODIC_CHECKS", not USE_CELERY) and not TESTING
SLA_CHECK_INTERVAL_MINUTES = env_int("SLA_CHECK_INTERVAL_MINUTES", 60)
HOTSPOT_SCAN_INTERVAL_MINUTES = env_int("HOTSPOT_SCAN_INTERVAL_MINUTES", 360)

CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        "LOCATION": "civicai-cache",
    }
}

# ---------------------------------------------------------------------------
# CivicAI domain settings
# ---------------------------------------------------------------------------
CIVICAI = {
    "VERSION": "1.0.0",
    # AI engine mode: "demo" (no trained weights required) or "production"
    "MODEL_MODE": (env("MODEL_MODE", "demo") or "demo").lower(),
    "MODEL_PATH": env("MODEL_PATH", str(BASE_DIR / "ml_models")),
    # Map defaults (Hyderabad, India) - used by seeding & frontend config endpoint
    "DEFAULT_CITY": env("DEFAULT_CITY", "Hyderabad"),
    "DEFAULT_LAT": float(env("DEFAULT_LAT", "17.3850")),
    "DEFAULT_LNG": float(env("DEFAULT_LNG", "78.4867")),
    # Citizens may reopen a resolved complaint within this many days
    "REOPEN_WINDOW_DAYS": env_int("REOPEN_WINDOW_DAYS", 14),
    # OpenStreetMap Nominatim (reverse geocoding proxy)
    "NOMINATIM_URL": env("NOMINATIM_URL", "https://nominatim.openstreetmap.org"),
    "NOMINATIM_USER_AGENT": env("NOMINATIM_USER_AGENT", "CivicAI/1.0 (final-year academic project)"),
    "GEOCODING_ENABLED": env_bool("GEOCODING_ENABLED", True),
    "FRONTEND_URL": env("FRONTEND_URL", "http://localhost:5173"),
}

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
LOG_LEVEL = env("LOG_LEVEL", "INFO")
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "simple": {"format": "[{asctime}] {levelname} {name}: {message}", "style": "{"},
    },
    "handlers": {
        "console": {"class": "logging.StreamHandler", "formatter": "simple"},
    },
    "root": {"handlers": ["console"], "level": "WARNING"},
    "loggers": {
        "django": {"handlers": ["console"], "level": "WARNING", "propagate": False},
        "civicai": {"handlers": ["console"], "level": LOG_LEVEL, "propagate": False},
        "ai": {"handlers": ["console"], "level": LOG_LEVEL, "propagate": False},
        "apps": {"handlers": ["console"], "level": LOG_LEVEL, "propagate": False},
    },
}
