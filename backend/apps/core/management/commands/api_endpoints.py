"""``python manage.py api_endpoints`` - print every REST endpoint with its method and permission level.

The inventory is read from the live URLconf (``apps.core.api_inventory``), so it always reflects the code. The
default output is a Markdown table (``| Method | Path | Permission | View |``) that matches the columns of
docs/API_ENDPOINTS.md; ``--format tsv`` prints tab-separated rows for scripts.
"""
from django.core.management.base import BaseCommand

from apps.core.api_inventory import api_endpoints


class Command(BaseCommand):
    help = "List every /api/ endpoint with its HTTP method and permission level (from the live URLconf)."

    def add_arguments(self, parser):
        parser.add_argument("--format", choices=("markdown", "tsv"), default="markdown")

    def handle(self, *args, **options):
        endpoints = api_endpoints()
        if options["format"] == "tsv":
            for endpoint in endpoints:
                self.stdout.write(f"{endpoint.method}\t{endpoint.path}\t{endpoint.permission}\t{endpoint.view}")
            return
        self.stdout.write("| Method | Path | Permission | View |")
        self.stdout.write("|---|---|---|---|")
        for endpoint in endpoints:
            self.stdout.write(f"| {endpoint.method} | {endpoint.path} | {endpoint.permission} | {endpoint.view} |")
        self.stdout.write(f"\n{len(endpoints)} endpoints.")
