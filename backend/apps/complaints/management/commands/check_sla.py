"""``python manage.py check_sla`` - run the SLA breach check now (same logic as the hourly Celery beat task).

Useful without a Celery worker (Windows development, cron on a small server):
    python manage.py check_sla            # alert admins + assigned officers, print how many complaints
    python manage.py check_sla --dry-run  # only count the complaints that would be alerted
"""
from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = (
        "Alert administrators and assigned officers about open high/critical complaints that are past their SLA "
        "due date or open longer than the configured alert hours (at most once per complaint per 24 h)."
    )

    def add_arguments(self, parser):
        parser.add_argument("--dry-run", action="store_true",
                            help="Only count the complaints that would be alerted; send no notifications.")

    def handle(self, *args, **options):
        from apps.complaints.tasks import check_sla_breaches

        dry_run = options["dry_run"]
        count = check_sla_breaches(dry_run=dry_run)
        outcome = "would be alerted" if dry_run else "alerted"
        self.stdout.write(self.style.SUCCESS(f"SLA check complete: {count} complaint(s) {outcome}."))
