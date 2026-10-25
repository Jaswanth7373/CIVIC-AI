"""Tests of ``manage.py seed_demo`` - the demo dataset is produced by the real pipeline and is internally consistent.

``SeedDemoConsistencyTests`` builds a 24-complaint history once (real AI engine in demo mode, real services, uploads
to a temporary MEDIA_ROOT) and checks the invariants a viva audience could stumble over on any page: every complaint
was analysed and prioritised, timelines read chronologically and form a valid status chain, no timestamp precedes
the complaint, resolutions are AI- or manually verified, feedback was only given on resolved work, open work is
recent (steady state, no stale backlog), the analytics overview agrees with the database, and the printed demo
logins work. ``SeedDemoPlannerTests`` checks the plan itself: reproducible, steady weekly arrivals, re-reports.
The real-photo tests check ``scripts/import_real_photos.py`` and how real photos without repaired shots replace the
generated photos of their category.
"""
import functools
import importlib.util
import io
import json
import os
import shutil
import tempfile
from collections import Counter
from datetime import timedelta
from pathlib import Path
from unittest import mock

from PIL import Image

from django.core.management import call_command
from django.core.management.base import CommandError
from django.db.models import Q
from django.test import SimpleTestCase, TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.models import User
from apps.assignments.models import ComplaintAssignment
from apps.complaints.models import (
    AIPrediction,
    Complaint,
    ComplaintImage,
    DuplicateComplaint,
    Level,
    Location,
    PriorityScore,
    ResolutionEvidence,
    ResolutionVerification,
    StatusHistory,
)
from apps.core import demo_data as demo
from apps.core.management.commands import seed_demo
from apps.feedback.models import Feedback
from apps.notifications.models import Notification

DEMO_DOMAIN = f"@{demo.DEMO_EMAIL_DOMAIN}"
IMPORT_SCRIPT = Path(seed_demo.SAMPLE_IMAGES).parents[1] / "scripts" / "import_real_photos.py"
REAL_PHOTO_SIZE = (360, 480)  # the portrait crops write_real_photos imports


def import_script():
    spec = importlib.util.spec_from_file_location("civicai_import_real_photos", IMPORT_SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_real_photos(real_root, label, severities, repaired=(), keywords=None):
    """Import portrait crops of the generated ``label`` photos as that category's real photos (one per severity;
    the photo numbers in ``repaired`` also get a repaired photo; every photo gets ``keywords`` when given).
    Returns the new manifest entries."""
    source = Path(tempfile.mkdtemp(prefix="civicai-real-source-"))
    try:
        notes = {}
        for number, severity in enumerate(severities, start=1):
            stem = f"{label}_{number:02d}"
            pairs = [(seed_demo.SAMPLE_IMAGES / label / f"{stem}.jpg", source)]
            if number in repaired:
                pairs.append((seed_demo.SAMPLE_IMAGES / "after" / f"{stem}_after.jpg", source / "repaired"))
            for generated, folder in pairs:
                folder.mkdir(exist_ok=True)
                with Image.open(generated) as image:
                    image.crop((140, 0, 500, 480)).save(folder / f"photo_{number}.jpg", quality=90)
            notes[f"photo_{number}.jpg"] = {"severity": severity, "box": [0.2, 0.3, 0.8, 0.9]}
            if keywords:
                notes[f"photo_{number}.jpg"]["keywords"] = keywords
        (source / "annotations.json").write_text(json.dumps({"source": "test photos", "photos": notes}))
        return import_script().import_category(label, source, Path(real_root))
    finally:
        shutil.rmtree(source, ignore_errors=True)


def temporary_folder(test, prefix):
    folder = Path(tempfile.mkdtemp(prefix=prefix))
    test.addCleanup(shutil.rmtree, folder, ignore_errors=True)
    return folder


def run_seed(**options):
    """Run seed_demo quietly and return the command (its ``report`` holds the summary numbers)."""
    command = seed_demo.Command()
    call_command(command, quiet=True, stdout=io.StringIO(), **options)
    return command


def media_files(root):
    """Paths (relative, POSIX) of every file stored under ``root``."""
    root = Path(root)
    return {path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_file()}


def referenced_files():
    """Paths of every upload the database refers to (complaint photos and resolution evidence)."""
    names = set(ComplaintImage.objects.values_list("image", flat=True))
    for before, after in ResolutionEvidence.objects.values_list("before_image", "after_image"):
        names |= {before, after}
    return {name for name in names if name}


class TemporaryMediaMixin:
    """Uploads go to a temporary MEDIA_ROOT. The override is entered *before* ``TestCase.setUpClass`` because that
    is where ``setUpTestData`` - which seeds, and therefore uploads - runs."""

    @classmethod
    def setUpClass(cls):
        cls.media_root = tempfile.mkdtemp(prefix="civicai-seed-media-")
        cls.addClassCleanup(shutil.rmtree, cls.media_root, ignore_errors=True)
        cls.enterClassContext(override_settings(MEDIA_ROOT=cls.media_root))
        super().setUpClass()


@mock.patch.dict(os.environ, {"MODEL_MODE": "demo"})
class SeedDemoConsistencyTests(TemporaryMediaMixin, TestCase):
    @classmethod
    def setUpTestData(cls):
        with mock.patch.dict(os.environ, {"MODEL_MODE": "demo"}):
            cls.report = run_seed(complaints=24, seed=7).report

    def complaints(self):
        return Complaint.objects.select_related("location").order_by("pk")

    # --- the run itself -------------------------------------------------------------------------------------------
    def test_every_step_ran_through_the_services(self):
        self.assertEqual(self.report["failures"], [], "seed_demo reported failed lifecycle steps")
        self.assertEqual(self.report["complaints"], 24)
        self.assertEqual(Complaint.objects.count(), 24)
        self.assertEqual(self.report["mode"], "demo")
        self.assertEqual(self.report["sla_due_corrected"], 0, "sla_due_at must already follow compute_sla_due()")
        self.assertEqual(User.objects.filter(email__endswith=DEMO_DOMAIN).count(),
                         1 + sum(len(people) for people in demo.OFFICERS.values()) + len(demo.CITIZENS))
        self.assertEqual(User.objects.filter(role="officer", officer_profile__is_available=False).count(), 1)
        self.assertTrue(all(complaint.citizen.email.endswith(DEMO_DOMAIN) for complaint in
                            Complaint.objects.select_related("citizen")))
        statuses = set(Complaint.objects.values_list("status", flat=True))
        for status in ("assigned", "in_progress", "closed", "rejected", "reopened"):
            self.assertIn(status, statuses)

    def test_main_citizen_showcase(self):
        main = self.report["main_citizen"]
        for key in ("pending", "in_progress", "awaiting_feedback", "closed_with_feedback", "reopened"):
            self.assertGreaterEqual(main[key], 1, key)

    def test_photos_are_real_uploads_in_media_root(self):
        images = list(ComplaintImage.objects.all())
        self.assertGreaterEqual(len(images), 12)
        media_root = Path(self.media_root).resolve()
        for image in images:
            path = Path(image.image.path).resolve()
            self.assertTrue(path.is_file(), path)
            self.assertTrue(path.is_relative_to(media_root), "uploads must go to the temporary MEDIA_ROOT")
            self.assertTrue(image.phash and image.width > 0 and image.height > 0 and image.file_size > 0)
            # Stored as "<random token>-IMG_<capture time>.jpg": unguessable, and no category hint in the name.
            self.assertRegex(path.name, r"^[0-9a-f]{20}-IMG_[0-9]{8}_[0-9]{6}\.jpg$")
        for evidence in ResolutionEvidence.objects.exclude(after_image=""):
            self.assertTrue(Path(evidence.after_image.path).is_file())

    def test_deliberate_re_reports_are_flagged_by_the_duplicate_engine(self):
        duplicates = self.report["duplicates"]
        self.assertGreaterEqual(duplicates["deliberate"], 1)
        self.assertEqual(duplicates["deliberate_flagged"], duplicates["deliberate"])
        pairs = DuplicateComplaint.objects.select_related("complaint__location", "similar_complaint__location")
        self.assertGreaterEqual(pairs.count(), duplicates["deliberate"])
        for pair in pairs:
            self.assertGreaterEqual(pair.overall_similarity, 0.72)
            self.assertLess(pair.similar_complaint.created_at, pair.complaint.created_at)
            self.assertLessEqual(pair.complaint.created_at - pair.similar_complaint.created_at, timedelta(days=30))
        for pair in pairs.exclude(status=DuplicateComplaint.Status.PENDING_REVIEW):
            self.assertIsNotNone(pair.reviewed_by)
            self.assertGreaterEqual(pair.reviewed_at, pair.complaint.created_at)
            if pair.status == DuplicateComplaint.Status.CONFIRMED_DUPLICATE:
                self.assertEqual(pair.complaint.status, Complaint.Status.CLOSED)
                self.assertEqual(pair.complaint.duplicate_of_id, pair.similar_complaint_id)

    # --- AI outputs -------------------------------------------------------------------------------------------------
    def test_every_complaint_has_prediction_priority_and_ordered_timeline(self):
        for complaint in self.complaints():
            with self.subTest(complaint=complaint.complaint_number):
                self.assertTrue(AIPrediction.objects.filter(complaint=complaint).exists())
                self.assertTrue(PriorityScore.objects.filter(complaint=complaint).exists())
                self.assertIsNotNone(complaint.category_id)
                self.assertIsNotNone(complaint.department_id)
                self.assertIn(complaint.priority_level, Level.values)
                rows = list(StatusHistory.objects.filter(complaint=complaint).order_by("id"))
                self.assertGreaterEqual(len(rows), 4)
                self.assertEqual(rows[0].event, StatusHistory.Event.SUBMITTED)
                stamps = [row.timestamp for row in rows]
                self.assertEqual(stamps, sorted(stamps), "timeline rows must be stored in chronological order")
                previous = ""
                for row in (row for row in rows if row.new_status):  # status changes form one valid chain
                    self.assertEqual(row.old_status, previous, f"{row.event}: {row.old_status} -> {row.new_status}")
                    previous = row.new_status
                self.assertEqual(previous, complaint.status)
                self.assertEqual(complaint.sla_due_at, complaint.compute_sla_due())

    def test_timestamps_never_precede_the_complaint_or_exceed_now(self):
        now = timezone.now()
        related = [
            (StatusHistory, ["timestamp"]), (AIPrediction, ["created_at"]), (PriorityScore, ["created_at"]),
            (ComplaintImage, ["uploaded_at"]), (ComplaintAssignment, ["assigned_at", "accepted_at", "completed_at"]),
            (ResolutionEvidence, ["uploaded_at"]), (ResolutionVerification, ["verified_at"]),
            (Feedback, ["created_at"]), (Notification, ["created_at", "read_at"]),
        ]
        for complaint in self.complaints():
            start = complaint.created_at
            self.assertLessEqual(complaint.incident_at, start)
            for name in ("accepted_at", "resolved_at", "verified_at", "closed_at", "updated_at"):
                value = getattr(complaint, name)
                if value is not None:
                    self.assertTrue(start <= value <= now, f"{complaint.complaint_number}.{name}")
            for model, names in related:
                for row in model.objects.filter(complaint=complaint).values(*names):
                    for name, value in row.items():
                        if value is not None:
                            self.assertTrue(start <= value <= now, f"{model.__name__}.{name} of "
                                                                   f"{complaint.complaint_number}")
        for pair in DuplicateComplaint.objects.select_related("complaint"):
            self.assertGreaterEqual(pair.created_at, pair.complaint.created_at)
        self.assertFalse(User.objects.filter(email__endswith=DEMO_DOMAIN, date_joined__gt=now).exists())
        earliest = Complaint.objects.order_by("created_at").first().created_at
        self.assertLess(earliest, now - timedelta(days=30), "the history spans the last --days days")

    # --- lifecycle ----------------------------------------------------------------------------------------------------
    def test_resolved_complaints_have_verification_and_evidence(self):
        resolved = Complaint.objects.filter(status__in=Complaint.RESOLVED_STATUSES, resolved_at__isnull=False)
        self.assertGreaterEqual(resolved.count(), 8)
        for complaint in resolved:
            with self.subTest(complaint=complaint.complaint_number):
                self.assertTrue(ResolutionVerification.objects.filter(complaint=complaint).exists())
                self.assertTrue(StatusHistory.objects.filter(complaint=complaint,
                                                             event=StatusHistory.Event.RESOLVED).exists())
                if complaint.status in (Complaint.Status.VERIFIED, Complaint.Status.CLOSED):
                    self.assertIsNotNone(complaint.verified_at)
        merged = Complaint.objects.filter(duplicate_of__isnull=False)
        for complaint in merged:  # confirmed duplicates are closed without a resolution of their own
            self.assertEqual(complaint.status, Complaint.Status.CLOSED)
        self.assertTrue(ResolutionVerification.objects.filter(method="ai_assisted", is_demo=True).exists())
        self.assertTrue(ResolutionVerification.objects.filter(method="manual", verified_by__role="admin").exists())

    def test_feedback_only_on_resolved_work(self):
        feedback = list(Feedback.objects.select_related("complaint"))
        self.assertGreaterEqual(len(feedback), 5)
        for item in feedback:
            with self.subTest(feedback=item.pk):
                self.assertEqual(item.citizen_id, item.complaint.citizen_id)
                self.assertIn(item.sentiment, ("positive", "neutral", "negative"))
                self.assertTrue(item.sentiment_model)
                before = (StatusHistory.objects.filter(complaint=item.complaint, timestamp__lte=item.created_at)
                          .exclude(new_status="").order_by("-timestamp", "-id").first())
                self.assertIn(before.new_status, (Complaint.Status.RESOLVED, Complaint.Status.VERIFIED))
                self.assertIn(item.complaint.status, (Complaint.Status.CLOSED, Complaint.Status.REOPENED))
                if item.complaint.status == Complaint.Status.REOPENED:
                    self.assertTrue(StatusHistory.objects.filter(complaint=item.complaint, event="reopened",
                                                                 timestamp__gt=item.created_at).exists())

    def test_open_work_is_recent(self):
        """Steady state: work keeps pace with the reports, so open complaints are a minority and - apart from reopened
        ones being reworked - were all reported in the last days (no stale backlog)."""
        now = timezone.now()
        open_complaints = Complaint.objects.filter(status__in=Complaint.OPEN_STATUSES)
        self.assertGreater(open_complaints.count(), 0)
        self.assertLess(open_complaints.count(), Complaint.objects.count() / 2)
        for complaint in open_complaints.filter(reopen_count=0):
            self.assertLess(now - complaint.created_at, timedelta(days=10), complaint.complaint_number)

    def test_assignments_and_officers(self):
        for complaint in Complaint.objects.filter(status__in=Complaint.OPEN_ASSIGNED_STATUSES):
            self.assertIsNotNone(complaint.assigned_officer_id, complaint.complaint_number)
            self.assertTrue(complaint.assigned_officer.officer_profile.is_available
                            or complaint.status == Complaint.Status.REOPENED)
        self.assertEqual(ComplaintAssignment.objects.filter(is_active=True).count(),
                         ComplaintAssignment.objects.filter(is_active=True).values("complaint").distinct().count())

    # --- what the dashboards show -----------------------------------------------------------------------------------
    def test_analytics_overview_totals_equal_orm_counts(self):
        admin = User.objects.get(email=demo.ADMIN_ACCOUNT["email"])
        client = APIClient()
        client.force_authenticate(admin)
        response = client.get("/api/analytics/overview/")
        self.assertEqual(response.status_code, 200, response.content[:300])
        totals = response.json()["totals"]
        now = timezone.now()
        complaints = Complaint.objects.all()
        open_q = Q(status__in=Complaint.OPEN_STATUSES)
        expected = {
            "total": complaints.count(),
            "pending": complaints.filter(status__in=Complaint.PENDING_STATUSES).count(),
            "in_progress": complaints.filter(status__in=Complaint.IN_PROGRESS_STATUSES).count(),
            "resolved": complaints.filter(status__in=Complaint.RESOLVED_STATUSES).count(),
            "critical": complaints.filter(open_q, priority_level=Level.CRITICAL).count(),
            "rejected": complaints.filter(status=Complaint.Status.REJECTED).count(),
            "reopened": complaints.filter(reopen_count__gt=0).count(),
            "overdue": complaints.filter(open_q, sla_due_at__lt=now).count(),
            "duplicates_pending": DuplicateComplaint.objects.filter(status="pending_review").count(),
            # open work flagged for review plus resolutions waiting for an administrator's manual verification
            "needs_review": complaints.filter(open_q | Q(status=Complaint.Status.RESOLVED),
                                              needs_manual_review=True).count(),
        }
        self.assertEqual(totals, expected)
        self.assertEqual(response.json()["feedback_count"], Feedback.objects.count())
        self.assertGreater(response.json()["sla_compliance"], 0)

    def test_demo_logins_work(self):
        logins = [(demo.ADMIN_ACCOUNT["email"], demo.ADMIN_ACCOUNT["password"], "admin"),
                  (f"roads.officer1{DEMO_DOMAIN}", demo.OFFICER_PASSWORD, "officer"),
                  (demo.MAIN_CITIZEN_EMAIL, demo.CITIZEN_PASSWORD, "citizen")]
        for email, password, role in logins:
            response = APIClient().post("/api/auth/login/", {"email": email, "password": password}, format="json")
            self.assertEqual(response.status_code, 200, email)
            self.assertEqual(response.json()["user"]["role"], role)
        main = User.objects.get(email=demo.MAIN_CITIZEN_EMAIL)
        self.assertEqual(main.full_name, "Rahul Verma")
        self.assertTrue(User.objects.get(email=demo.ADMIN_ACCOUNT["email"]).is_superuser)

    def test_notifications_partly_read(self):
        notifications = Notification.objects.filter(user__email__endswith=DEMO_DOMAIN)
        self.assertGreater(notifications.filter(is_read=True).count(), 0)
        self.assertGreater(notifications.filter(is_read=False).count(), 0)
        for notification in notifications.filter(is_read=True):
            self.assertGreaterEqual(notification.read_at, notification.created_at)


@mock.patch.dict(os.environ, {"MODEL_MODE": "demo"})
class SeedDemoResetTests(TemporaryMediaMixin, TestCase):
    def test_reset_rebuilds_the_same_dataset_without_leftovers(self):
        anchor = (timezone.now() - timedelta(hours=1)).isoformat()
        first = run_seed(complaints=12, seed=3, anchor=anchor)
        self.assertEqual(first.report["failures"], [])
        first_files = media_files(self.media_root)
        self.assertTrue(first_files)
        self.assertEqual(first_files, referenced_files())
        descriptions = sorted(Complaint.objects.values_list("description", flat=True))

        with self.assertRaises(CommandError):  # existing demo data is never duplicated silently
            run_seed(complaints=12, seed=3, anchor=anchor)

        second = run_seed(complaints=12, seed=3, anchor=anchor, reset=True)
        self.assertEqual(second.report["failures"], [])
        self.assertEqual(Complaint.objects.count(), 12)
        self.assertEqual(Location.objects.count(), 12, "no orphaned locations")
        users = first.report["users"]
        self.assertEqual(User.objects.filter(email__endswith=DEMO_DOMAIN).count(),
                         1 + users["officers"] + users["citizens"])
        # the previous run's uploads were deleted: had they survived, the re-seed's identically named uploads
        # would have been stored under new names and the old files would show up as unreferenced
        self.assertEqual(media_files(self.media_root), referenced_files())
        self.assertEqual(len(media_files(self.media_root)), len(first_files))
        self.assertEqual(sorted(Complaint.objects.values_list("description", flat=True)), descriptions)
        for key in ("by_category", "by_priority", "planned_outcomes"):
            self.assertEqual(second.report[key], first.report[key], key)

    def test_anchor_must_lie_in_the_past(self):
        with self.assertRaises(CommandError):
            run_seed(complaints=12, anchor=timezone.now().isoformat())


class ImportRealPhotosTests(SimpleTestCase):
    def test_photos_are_upright_downscaled_and_without_metadata(self):
        source, out = temporary_folder(self, "civicai-real-source-"), temporary_folder(self, "civicai-real-photos-")
        exif = Image.Exif()
        exif[0x0112] = 6  # orientation: the camera was turned, the pixels must be rotated 90 degrees
        exif[0x0110] = "Phone X"  # camera model
        exif[0x0132] = "2026:10:01 09:30:00"  # capture time
        Image.new("RGB", (1600, 1200), (120, 120, 120)).save(source / "IMG_0001.jpg", exif=exif.tobytes())
        entries = import_script().import_category("road_crack", source, out)
        self.assertEqual(entries, [{"id": "real_road_crack_01", "label": "road_crack", "index": 1,
                                    "file": "road_crack/road_crack_01.jpg", "width": 768, "height": 1024,
                                    "source_file": "IMG_0001.jpg"}])
        with Image.open(out / "road_crack" / "road_crack_01.jpg") as image:
            self.assertEqual(image.size, (768, 1024))
            self.assertEqual(dict(image.getexif()), {})
            self.assertNotIn("exif", image.info)

    def test_reimport_replaces_only_that_category(self):
        out = temporary_folder(self, "civicai-real-photos-")
        write_real_photos(out, "road_crack", ["minor", "severe"], repaired=[2])
        write_real_photos(out, "garbage", ["standard"])
        entries = write_real_photos(out, "road_crack", ["standard"])
        self.assertEqual(sorted(path.name for path in (out / "road_crack").iterdir()), ["road_crack_01.jpg"])
        self.assertEqual(list((out / "after").iterdir()), [])
        manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual([item["id"] for item in manifest["images"]], ["real_garbage_01", "real_road_crack_01"])
        self.assertEqual(manifest["sources"], {"garbage": "test photos", "road_crack": "test photos"})
        self.assertEqual(entries[0]["severity"], "standard")
        self.assertNotIn("after", entries[0])

    def test_invalid_annotations_are_refused(self):
        source = temporary_folder(self, "civicai-real-source-")
        Image.new("RGB", (64, 48)).save(source / "a.jpg")
        (source / "annotations.json").write_text(json.dumps({"photos": {"a.jpg": {"severity": "huge"}}}))
        with self.assertRaises(ValueError):
            import_script().import_category("road_crack", source, temporary_folder(self, "civicai-real-photos-"))


class CommittedRealPhotosTests(SimpleTestCase):
    """Every real photo in the repository exists, is credited (its own licence, or its category's source) and is
    listed in CREDITS.md - the attribution the CC licences require."""

    def test_every_real_photo_is_credited(self):
        root = seed_demo.REAL_SAMPLE_IMAGES
        manifest_path = root / "manifest.json"
        if not manifest_path.is_file():
            self.skipTest("no real photos imported")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        credits = (root / "CREDITS.md").read_text(encoding="utf-8")
        for item in manifest["images"]:
            with self.subTest(photo=item["file"]):
                self.assertTrue((root / item["file"]).is_file())
                self.assertTrue(item.get("license") or manifest["sources"].get(item["label"]))
                if item.get("license"):
                    self.assertTrue(item.get("author") and item.get("source_url"))
                self.assertIn(f"| {item['file']} |", credits)


class SamplePhotosTests(SimpleTestCase):
    """Real photos replace the generated photos of their category; their after photos are only the supplied ones."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.real_root = Path(tempfile.mkdtemp(prefix="civicai-real-photos-"))
        cls.addClassCleanup(shutil.rmtree, cls.real_root, ignore_errors=True)
        write_real_photos(cls.real_root, "pothole", ["severe", "minor", "standard"], repaired=[1])
        cls.photos = seed_demo.SamplePhotos(real_root=cls.real_root)

    def test_real_photos_replace_their_category_only(self):
        generated = seed_demo.SamplePhotos(real_root=None)
        self.assertEqual([item["id"] for item in self.photos.by_label["pothole"]],
                         ["real_pothole_01", "real_pothole_02", "real_pothole_03"])
        self.assertEqual(len(generated.by_label["pothole"]), 10)
        # the generated scenes stay available for the stories that show the AI before/after verification
        self.assertEqual([item["id"] for item in self.photos.generated["pothole"]],
                         [item["id"] for item in generated.by_label["pothole"]])
        self.assertTrue(all(item["generated"] for item in self.photos.generated["pothole"]))
        self.assertFalse(any(item["generated"] for item in self.photos.by_label["pothole"]))
        for label in set(generated.by_label) - {"pothole"}:
            self.assertEqual([item["id"] for item in self.photos.by_label[label]],
                             [item["id"] for item in generated.by_label[label]], label)

    def test_size_rank_follows_the_annotated_severity(self):
        ranks = {item["id"]: item["size_rank"] for item in self.photos.by_label["pothole"]}
        self.assertEqual(ranks, {"real_pothole_01": 1.0, "real_pothole_02": 0.0, "real_pothole_03": 0.5})

    def test_after_photos_are_only_the_supplied_ones(self):
        repaired, plain, _ = self.photos.by_label["pothole"]
        self.assertTrue(repaired["after"].is_file())
        self.assertEqual(self.photos.after_photo(repaired, "pothole", "repaired"), repaired["after"])
        self.assertIsNone(self.photos.after_photo(repaired, "pothole", "unchanged"))
        self.assertIsNone(self.photos.after_photo(repaired, "pothole", "angle"))  # no other scene has one
        self.assertIsNone(self.photos.after_photo(plain, "pothole", "repaired"))
        self.assertEqual(self.photos.after_photo(plain, "pothole", "angle"), repaired["after"])
        self.assertIs(self.photos.scene("pothole", None, 4), plain)  # no citizen photo: a sample scene
        self.assertIs(self.photos.scene("garbage", plain, 4), plain)
        demo_scene = self.photos.scene("pothole", None, 4, generated=True)
        self.assertIs(demo_scene, self.photos.generated["pothole"][4])
        for kind in ("repaired", "unchanged", "angle"):
            self.assertIsNotNone(self.photos.after_photo(demo_scene, "pothole", kind), kind)


@mock.patch.dict(os.environ, {"MODEL_MODE": "demo"})
class SeedDemoRealPhotoTests(TemporaryMediaMixin, TestCase):
    """Real photos without repaired shots for the two most reported categories: the citizens upload them, officers
    resolve those complaints without an after photo and the administrator verifies the work on a site visit. The
    stories that show the AI before/after verification use generated scenes, labelled as such."""

    LABELS = ("pothole", "garbage")

    @classmethod
    def setUpTestData(cls):
        real_root = Path(tempfile.mkdtemp(prefix="civicai-real-photos-"))
        cls.addClassCleanup(shutil.rmtree, real_root, ignore_errors=True)
        for label in cls.LABELS:
            write_real_photos(real_root, label, ["minor", "standard", "severe", "standard"])
        photos = functools.partial(seed_demo.SamplePhotos, real_root=real_root)
        with mock.patch.dict(os.environ, {"MODEL_MODE": "demo"}), mock.patch.object(seed_demo, "SamplePhotos", photos):
            cls.report = run_seed(complaints=24, seed=7).report

    def test_every_step_ran_through_the_services(self):
        self.assertEqual(self.report["failures"], [])
        sizes = Counter((image.width, image.height) for image in ComplaintImage.objects.all())
        self.assertGreater(sizes[REAL_PHOTO_SIZE], 0, "citizens uploaded the real photos")

    def test_resolutions_without_after_photo_are_verified_on_site(self):
        resolved = Complaint.objects.filter(status__in=Complaint.RESOLVED_STATUSES, resolved_at__isnull=False)
        without_photo = [complaint for complaint in resolved
                         if not ResolutionEvidence.objects.filter(complaint=complaint).exists()]
        self.assertTrue(without_photo)
        site_remarks = demo.SITE_VISIT_VERIFIED_REMARKS + demo.SENT_BACK_SITE_REMARKS
        for complaint in without_photo:
            with self.subTest(complaint=complaint.complaint_number):
                verifications = ResolutionVerification.objects.filter(complaint=complaint)
                self.assertTrue(verifications.exists())
                for verification in verifications:
                    self.assertEqual(verification.method, "manual")
                    self.assertIn(verification.explanation, site_remarks)
        for complaint in resolved:  # every resolution is still verified (by the AI or by the administrator)
            self.assertTrue(ResolutionVerification.objects.filter(complaint=complaint).exists(),
                            complaint.complaint_number)

    def test_ai_verification_runs_on_labelled_generated_pairs(self):
        self.assertTrue(ResolutionVerification.objects.filter(method="ai_assisted").exists())
        first_uploads = ResolutionEvidence.objects.exclude(before_image="")
        self.assertTrue(first_uploads.exists())
        for evidence in first_uploads:  # here every photo with a repaired shot is a generated one
            self.assertIn("(Demo data: generated sample photos.)", evidence.remarks)


class SeedDemoPlannerTests(SimpleTestCase):
    """The plan (who reports what, where, when and how the story ends) is a pure function of seed and anchor."""

    ANCHOR = timezone.now().replace(second=0, microsecond=0) - timedelta(hours=1)

    def build(self, seed, anchor=None, photos=None):
        anchor = anchor or self.ANCHOR
        planner = seed_demo.DemoPlanner(total=160, days=180, seed=seed, anchor=anchor,
                                        photos=photos or seed_demo.SamplePhotos())
        return anchor, planner.build()

    def test_ai_verification_stories_use_generated_pairs(self):
        """The stories that show the AI before/after verification (AI verified, other angle, sent back, waiting for
        review) need after photos, so they use generated scenes - about a tenth of the reports. Every other report of
        a category with real photos (here: pothole) shows a real photo."""
        real_root = temporary_folder(self, "civicai-real-photos-")
        write_real_photos(real_root, "pothole", ["minor", "standard", "severe"])
        photos = seed_demo.SamplePhotos(real_root=real_root)
        _, tracks = self.build(42, photos=photos)
        paired = [track for track in tracks if track.demo_pair]
        self.assertTrue(0.07 <= len(paired) / 160 <= 0.13, len(paired))
        self.assertTrue(all(track.demo_pair for track in tracks if track.path != "standard"))
        self.assertEqual({track.path for track in paired}, {"standard", "angle", "sent_back", "review_pending"})
        for track in paired:
            scene = photos.scene(track.slug, track.photo, track.index, generated=True)
            self.assertTrue(scene["generated"], track.index)
            kinds = {"sent_back": ("unchanged", "repaired"), "standard": ("repaired",)}.get(track.path, ("angle",))
            for kind in kinds:
                self.assertIsNotNone(photos.after_photo(scene, track.slug, kind), (track.index, kind))
        potholes = [track for track in tracks if track.slug == "pothole" and track.photo and not track.demo_pair]
        self.assertTrue(potholes)
        self.assertTrue(all(not track.photo["generated"] for track in potholes))

    def test_real_photos_with_keywords_only_illustrate_matching_reports(self):
        """Real "other" photos of stray animals illustrate stray-animal reports; a report about a broken bench,
        posters or an encroachment gets a generated photo instead."""
        real_root = temporary_folder(self, "civicai-real-photos-")
        write_real_photos(real_root, "other", ["minor", "standard", "severe"], keywords=["cattle", "dog"])
        photos = seed_demo.SamplePhotos(real_root=real_root)
        _, tracks = self.build(42, photos=photos)
        with_photo = [track for track in tracks if track.slug == "other" and track.photo is not None]
        real = [track for track in with_photo if not track.photo["generated"]]
        self.assertTrue(real)
        self.assertTrue(any(track.photo["generated"] for track in with_photo), "non-dog reports exist")
        for track in real:
            self.assertTrue(seed_demo.DemoPlanner.photo_fits(track.photo, track.description), track.index)

    @staticmethod
    def fingerprint(tracks):
        """{track index: what the citizen reports and how the story ends} (no absolute times)."""
        return {t.index: (t.role, t.citizen, t.slug, t.description, t.title, t.reported, t.outcome, t.path,
                          t.photo["id"] if t.photo else None, t.place["latitude"], t.place["longitude"],
                          t.original) for t in tracks}

    def test_same_seed_same_plan(self):
        _, first = self.build(42)
        _, again = self.build(42)
        _, other = self.build(43)
        self.assertEqual(self.fingerprint(first), self.fingerprint(again))
        self.assertNotEqual(self.fingerprint(first), self.fingerprint(other))

    def test_same_seed_same_reports_at_another_time_of_day(self):
        """The random draws do not depend on when the history ends: run 90 minutes later, the reports are the
        same (a complaint whose local date moves across midnight could differ, so a little slack is allowed)."""
        first = self.fingerprint(self.build(42)[1])
        later = self.fingerprint(self.build(42, anchor=self.ANCHOR + timedelta(minutes=90))[1])
        self.assertEqual(first.keys(), later.keys())
        self.assertGreaterEqual(sum(first[index] == later[index] for index in first), 156)

    def test_plan_shape(self):
        anchor, tracks = self.build(42)
        self.assertEqual(len(tracks), 160)
        self.assertTrue(all(anchor - timedelta(days=180) <= t.created_at < anchor for t in tracks))
        recent = sum(1 for t in tracks if anchor - t.created_at < timedelta(days=30))
        self.assertTrue(160 * 0.18 <= recent <= 160 * 0.27, f"steady arrivals: {recent} in the last 30 days")
        weeks = Counter(int((anchor - t.created_at) / timedelta(days=7)) for t in tracks)
        full = sorted(weeks[week] for week in range(180 // 7))  # every complete week of the history
        median = full[len(full) // 2]
        self.assertLessEqual(max(full), 2.2 * median, f"no spike in the weekly arrivals: {full}")
        with_photo = sum(1 for t in tracks if t.photo is not None)
        self.assertGreater(with_photo / 160, 0.75)
        main = [t for t in tracks if t.citizen == demo.MAIN_CITIZEN_EMAIL]
        self.assertEqual(len(main), len(seed_demo.MAIN_CITIZEN_PLAN))
        duplicates = [t for t in tracks if t.original is not None]
        self.assertEqual(len(duplicates), 12)
        by_index = {t.index: t for t in tracks}
        for track in duplicates:
            original = by_index[track.original]
            self.assertNotEqual(track.citizen, original.citizen)
            self.assertEqual(track.photo["id"], original.photo["id"])
            self.assertGreater(track.created_at, original.created_at)
            distance = seed_demo.haversine_m(track.place["latitude"], track.place["longitude"],
                                             original.place["latitude"], original.place["longitude"])
            self.assertTrue(25 <= distance <= 65, distance)
        hotspot_share = sum(1 for t in tracks if t.place.get("hotspot")) / 160
        self.assertTrue(0.55 <= hotspot_share <= 0.8, hotspot_share)
        for track in tracks:  # addresses are consistent with the neighbourhood
            self.assertIn(track.place["area"], track.place["address"])
            self.assertEqual(track.place["city"], "Hyderabad")
            self.assertRegex(track.place["pincode"], r"^500\d{3}$")
        self.assertEqual(len({t.index for t in tracks}), 160)
