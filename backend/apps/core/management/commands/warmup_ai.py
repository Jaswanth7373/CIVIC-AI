"""``python manage.py warmup_ai`` - load the AI models of the current MODEL_MODE now and print their status.

Calls ``ai.nlp.warm_up()`` (text classifier, embedder, keyword extractor, sentiment model) and
``ai.vision.model.get_vision_model()`` (YOLO / CLIP in production, the OpenCV heuristics in demo mode), each in
isolation, then prints every model's status from ``ai.model_info``. Use it after deploying with
``MODEL_MODE=production`` to download / cache the weights before the first citizen submits a complaint::

    python manage.py warmup_ai            # always exits 0; failures are reported
    python manage.py warmup_ai --strict   # exit with an error when a component failed to load (CI / build step)
"""
from django.core.management.base import BaseCommand, CommandError

from apps.core.warmup import FAILED, warm_up_models


class Command(BaseCommand):
    help = "Load the AI models of the current MODEL_MODE (NLP + vision) and print the status of every model."

    def add_arguments(self, parser):
        parser.add_argument("--strict", action="store_true",
                            help="Exit with an error when an AI component could not be loaded.")

    def handle(self, *args, **options):
        report = warm_up_models()
        self.stdout.write(self.style.MIGRATE_HEADING(f"AI warm-up ({report['mode']} mode)"))
        for step in report["steps"]:
            style = self.style.SUCCESS if step["status"] != FAILED else self.style.ERROR
            self.stdout.write(f"  {step['component']:<8} {style(step['status']):<6} {step['duration_ms']:>7} ms  "
                              f"{step['detail']}")
        if report["models"]:
            self.stdout.write(self.style.MIGRATE_HEADING("Model status"))
        for row in report["models"]:
            demo = " [demo]" if row.get("is_demo") else ""
            version = f" {row['version']}" if row.get("version") else ""
            self.stdout.write(f"  {row.get('status', '?'):<16} {row.get('name', '?')}{version}{demo}")
            if row.get("detail"):
                self.stdout.write(f"  {'':<16} {row['detail']}")
        self.stdout.write(f"Finished in {report['duration_ms']} ms.")
        failed = [step["component"] for step in report["steps"] if step["status"] == FAILED]
        if failed and options["strict"]:
            raise CommandError(f"AI warm-up failed for: {', '.join(failed)}")
