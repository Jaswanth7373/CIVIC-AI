"""Tests for the AI warm-up: ``manage.py warmup_ai``, ``apps.core.warmup`` and the Celery ``worker_ready`` hook."""
import io
import os
from unittest import mock

from django.core.management import CommandError, call_command
from django.test import SimpleTestCase

from apps.core import warmup


@mock.patch.dict(os.environ, {"MODEL_MODE": "demo"})
class WarmUpTests(SimpleTestCase):
    def test_command_loads_the_models_and_prints_their_status(self):
        out = io.StringIO()
        call_command("warmup_ai", stdout=out)
        text = out.getvalue()
        self.assertIn("AI warm-up (demo mode)", text)
        self.assertRegex(text, r"nlp\s+done")
        self.assertRegex(text, r"vision\s+done")
        self.assertIn("Demo OpenCV heuristics", text)
        self.assertIn("Model status", text)

    def test_a_failing_component_is_reported_and_the_others_still_load(self):
        with mock.patch("ai.nlp.warm_up", side_effect=RuntimeError("weights corrupt")), \
                self.assertLogs("apps.core", level="WARNING"):
            report = warmup.warm_up_models()
        steps = {step["component"]: step for step in report["steps"]}
        self.assertEqual((steps["nlp"]["status"], steps["vision"]["status"]), ("failed", "done"))
        self.assertIn("weights corrupt", steps["nlp"]["detail"])
        self.assertEqual(report["mode"], "demo")
        self.assertTrue(report["models"])

    def test_strict_command_fails_when_a_component_failed(self):
        with mock.patch("ai.vision.model.get_vision_model", side_effect=RuntimeError("no model")), \
                self.assertLogs("apps.core", level="WARNING"):
            with self.assertRaises(CommandError):
                call_command("warmup_ai", "--strict", stdout=io.StringIO())

    def test_celery_worker_ready_hook_warms_up_only_in_production(self):
        from config.celery import warm_up_ai_models

        with mock.patch("apps.core.warmup.warm_up_models") as warm:
            warm_up_ai_models(sender=None)
            warm.assert_not_called()
            with mock.patch.dict(os.environ, {"MODEL_MODE": "production"}):
                warm_up_ai_models(sender=None)
            warm.assert_called_once_with()

    def test_background_warm_up_runs_in_a_daemon_thread(self):
        with mock.patch("apps.core.warmup.warm_up_models") as warm:
            thread = warmup.warm_up_in_background()
            thread.join(timeout=5)
        self.assertTrue(thread.daemon)
        warm.assert_called_once_with()
