"""Tests of the deployment configuration: gunicorn.conf.py, Procfile, build.sh, render.yaml and media serving."""
import importlib.util
import os
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from django.conf import settings
from django.test import SimpleTestCase, override_settings
from django.views.static import serve

try:  # PyYAML is a development-only dependency (not in requirements.txt)
    import yaml
except ImportError:  # pragma: no cover
    yaml = None

BACKEND = Path(settings.BASE_DIR)
REPOSITORY = BACKEND.parent


def load_gunicorn_config(**environ):
    """Import backend/gunicorn.conf.py as a module with the given environment."""
    with mock.patch.dict(os.environ, environ):
        spec = importlib.util.spec_from_file_location("civicai_gunicorn_conf", BACKEND / "gunicorn.conf.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    return module


class GunicornConfigTests(SimpleTestCase):
    def test_workers_threads_bind_and_timeout_come_from_the_environment(self):
        config = load_gunicorn_config(WEB_CONCURRENCY="3", GUNICORN_THREADS="2", PORT="10000")
        self.assertEqual((config.workers, config.threads, config.timeout), (3, 2, 120))
        self.assertEqual(config.bind, "0.0.0.0:10000")
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("WEB_CONCURRENCY", None)
            os.environ.pop("GUNICORN_THREADS", None)
            defaults = load_gunicorn_config()
        self.assertEqual((defaults.workers, defaults.threads), (2, 4))

    def test_post_worker_init_warms_up_only_in_production(self):
        config = load_gunicorn_config()
        worker = SimpleNamespace(pid=4242, log=mock.Mock())
        with mock.patch("apps.core.warmup.warm_up_in_background") as background:
            with mock.patch.dict(os.environ, {"MODEL_MODE": "demo"}):
                config.post_worker_init(worker)
            background.assert_not_called()
            with mock.patch.dict(os.environ, {"MODEL_MODE": "production"}):
                config.post_worker_init(worker)
            background.assert_called_once_with(name="civicai-ai-warmup-4242")
        worker.log.info.assert_called_once()


class DeploymentFilesTests(SimpleTestCase):
    @unittest.skipIf(yaml is None, "PyYAML is not installed")
    def test_procfile_and_render_blueprint_start_the_same_server(self):
        procfile = (BACKEND / "Procfile").read_text(encoding="utf-8").strip()
        self.assertEqual(procfile, "web: gunicorn config.wsgi -c gunicorn.conf.py")
        blueprint = yaml.safe_load((REPOSITORY / "render.yaml").read_text(encoding="utf-8"))
        service = blueprint["services"][0]
        self.assertEqual((service["type"], service["rootDir"], service["buildCommand"]), ("web", "backend", "bash build.sh"))
        self.assertEqual(service["startCommand"], procfile.removeprefix("web: "))
        env = {item["key"]: item for item in service["envVars"]}
        self.assertEqual((env["DEBUG"]["value"], env["MODEL_MODE"]["value"]), ("False", "demo"))
        self.assertIs(env["DATABASE_URL"]["sync"], False)  # a secret entered in the dashboard
        self.assertTrue(env["SECRET_KEY"]["generateValue"] and env["JWT_SECRET"]["generateValue"])
        example = (BACKEND / ".env.example").read_text(encoding="utf-8")
        documented = {line.split("=", 1)[0].lstrip("# ").strip() for line in example.splitlines()
                      if "=" in line and not line.startswith("# ---") and line.split("=", 1)[0].lstrip("# ").isupper()}
        local_only = {"DATABASE_NAME", "DATABASE_USER", "DATABASE_PASSWORD", "DATABASE_HOST", "DATABASE_PORT",
                      "YOLO_WEIGHTS", "TEXT_EMBEDDING_MODEL", "SENTIMENT_MODEL", "CLIP_MODEL", "AI_DEVICE",
                      "DB_ENGINE"}
        self.assertEqual(sorted(documented - local_only - set(env)), [])  # every .env.example setting is deployed

    def test_build_script_runs_the_documented_steps_in_order(self):
        script = (BACKEND / "build.sh").read_text(encoding="utf-8")
        self.assertTrue(script.startswith("#!/usr/bin/env bash"))
        self.assertNotIn("\r\n", script)  # LF line endings for the Linux build host
        steps = ["pip install -r requirements.txt", "manage.py collectstatic --noinput", "manage.py migrate --noinput",
                 "manage.py init_civicai --keep-existing"]
        positions = [script.index(step) for step in steps]
        self.assertEqual(positions, sorted(positions))
        self.assertEqual((BACKEND / ".python-version").read_text(encoding="utf-8").strip(), "3.13")


class MediaServingTests(SimpleTestCase):
    def media_patterns(self):
        from config.urls import media_urlpatterns

        return media_urlpatterns()

    @override_settings(DEBUG=False, SERVE_MEDIA=False)
    def test_media_is_not_served_in_production_unless_enabled(self):
        self.assertEqual(self.media_patterns(), [])

    @override_settings(DEBUG=False, SERVE_MEDIA=True)
    def test_serve_media_switch_serves_the_media_root(self):
        patterns = self.media_patterns()
        self.assertEqual(len(patterns), 1)
        match = patterns[0].resolve("media/complaints/2026/10/pothole_01.jpg")
        self.assertIs(match.func, serve)
        self.assertEqual(match.kwargs["path"], "complaints/2026/10/pothole_01.jpg")
        self.assertEqual(match.kwargs["document_root"], settings.MEDIA_ROOT)

    @override_settings(DEBUG=True)
    def test_development_always_serves_media(self):
        self.assertEqual(len(self.media_patterns()), 1)
