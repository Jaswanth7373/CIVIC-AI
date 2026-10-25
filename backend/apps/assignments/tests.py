"""Tests for officer recommendation, assignment and the assignments REST API.

Unit tests replace ``apps.complaints.services.status`` (owner B3) with ``StatusServiceDouble`` - a faithful
stand-in that records the calls and writes the status change / timeline row the contract describes - so they test
B4's own behaviour deterministically (it was also a stub when this module was written).
``RealStatusServiceIntegrationTests`` runs the same flows end-to-end against the real module (skipped only while
it raises NotImplementedError).
"""
import math
from datetime import timedelta
from decimal import Decimal
from unittest import mock

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APITestCase

from apps.audit.models import AuditLog
from apps.complaints.models import Complaint, Location, StatusHistory
from apps.core.exceptions import ServiceError, TransitionNotAllowed
from apps.departments.models import CivicCategory, Department
from apps.feedback.models import Feedback
from apps.notifications.models import Notification
from apps.officers.models import OfficerProfile

from . import services
from .models import ComplaintAssignment

User = get_user_model()
PASSWORD = "Civic!Pass2026"
SITE = (Decimal("17.385000"), Decimal("78.486700"))  # complaint location
NEAR = (Decimal("17.389000"), Decimal("78.486700"))  # ~0.44 km north of SITE
FAR = (Decimal("17.480000"), Decimal("78.486700"))  # ~10.6 km north of SITE
ASSIGNMENT_KEYS = {
    "id", "complaint", "officer", "department", "assigned_by", "assignment_type", "assignment_type_display",
    "status", "status_display", "is_active", "recommendation_score", "recommendation_reasons", "notes",
    "assigned_at", "accepted_at", "completed_at",
}
USER_MINI_KEYS = {"id", "full_name", "email", "role", "avatar", "phone"}
OFFICER_MINI_KEYS = USER_MINI_KEYS | {"employee_id", "designation", "zone", "department", "is_available"}
DEPARTMENT_MINI_KEYS = {"id", "name", "code", "icon", "color"}
RECOMMENDATION_KEYS = {
    "officer", "score", "workload", "capacity", "utilization", "overloaded", "distance_km", "is_available",
    "same_department", "reasons", "recommended",
}


# ---------------------------------------------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------------------------------------------
def make_user(email, role="citizen", **extra):
    first, _, last = email.split("@")[0].partition(".")
    return User.objects.create_user(email=email, password=PASSWORD, first_name=first.title(),
                                    last_name=last.title(), role=role, **extra)


def make_officer(email, department, *, base=NEAR, capacity=10, available=True, active=True):
    user = make_user(email, role="officer", is_active=active)
    OfficerProfile.objects.create(
        user=user, department=department, employee_id=f"EMP-{user.pk}", designation="Field Officer",
        zone="Ward 7", base_latitude=base[0] if base else None, base_longitude=base[1] if base else None,
        max_active_complaints=capacity, is_available=available,
    )
    return user


def make_complaint(citizen, *, category=None, department=None, status="analyzed", officer=None,
                   priority_level="high", priority_score=64, point=SITE, **extra):
    location = Location.objects.create(latitude=point[0], longitude=point[1], address="Road No. 12",
                                       area="Banjara Hills", city="Hyderabad")
    return Complaint.objects.create(
        citizen=citizen, title="Pothole near Banjara Hills Road No. 12",
        description="Large pothole near the school entrance causing traffic problems.", category=category,
        department=department, status=status, assigned_officer=officer, priority_level=priority_level,
        priority_score=priority_score, severity="high", location=location, **extra,
    )


def give_workload(officer, citizen, count, *, status="accepted", **extra):
    """``count`` open complaints assigned to ``officer`` (counts towards their workload)."""
    return [make_complaint(citizen, status=status, officer=officer, **extra) for _ in range(count)]


class StatusServiceDouble:
    """Test double for apps.complaints.services.status (owner B3), mixed into TestCase classes.

    Patches ``can_change_status`` / ``change_status`` / ``add_event`` with mocks whose side effects do what the
    contract describes (apply the status, write the StatusHistory row), so tests can assert both the calls B4 makes
    and the resulting database state, without depending on B3's own notifications / audit side effects.
    """

    allow_transitions = True

    def setUp(self):
        super().setUp()
        self.can_change_status = self._patch("can_change_status", lambda complaint, new_status, user:
                                             self.allow_transitions)
        self.change_status = self._patch("change_status", self._fake_change_status)
        self.add_event = self._patch("add_event", self._fake_add_event)

    def _patch(self, name, side_effect):
        patcher = mock.patch(f"apps.complaints.services.status.{name}", side_effect=side_effect)
        self.addCleanup(patcher.stop)
        return patcher.start()

    @staticmethod
    def _fake_change_status(complaint, new_status, *, actor=None, remarks="", event=None, metadata=None,
                            notify=True):
        old_status = complaint.status
        complaint.status = new_status
        complaint.save(update_fields=["status", "updated_at"])
        return StatusHistory.objects.create(
            complaint=complaint, event=event or "status_changed", old_status=old_status, new_status=new_status,
            changed_by=actor, remarks=remarks, metadata=metadata or {},
        )

    @staticmethod
    def _fake_add_event(complaint, event, *, actor=None, remarks="", metadata=None, old_status=None,
                        new_status=None, is_public=True, timestamp=None):
        return StatusHistory.objects.create(
            complaint=complaint, event=event, old_status=old_status or "", new_status=new_status or "",
            changed_by=actor, remarks=remarks, metadata=metadata or {}, is_public=is_public,
        )


class AssignmentFixtures:
    @classmethod
    def setUpTestData(cls):
        cls.roads = Department.objects.create(name="Roads Department", code="ROADS", icon="traffic-cone",
                                              color="#D9480F")
        cls.drain = Department.objects.create(name="Drainage Department", code="DRAIN")
        cls.general = Department.objects.create(name="General Civic Department", code="GEN")
        cls.electrical = Department.objects.create(name="Electrical Department", code="ELEC")
        cls.pothole = CivicCategory.objects.create(name="Roads / Potholes", slug="pothole", department=cls.roads)
        cls.manhole = CivicCategory.objects.create(name="Open Manhole", slug="open_manhole", department=cls.roads,
                                                   secondary_department=cls.drain)
        cls.citizen = make_user("citizen@test.local")
        cls.admin = make_user("admin@test.local", role="admin")


# ---------------------------------------------------------------------------------------------------------------
# Recommendation
# ---------------------------------------------------------------------------------------------------------------
class RecommendOfficersTests(AssignmentFixtures, TestCase):
    def setUp(self):
        self.complaint = make_complaint(self.citizen, category=self.pothole, department=self.roads)

    def emails(self, results):
        return [result["officer"].email for result in results]

    def test_only_officers_of_the_complaint_department_are_ranked(self):
        make_officer("ravi@test.local", self.roads)
        make_officer("elec@test.local", self.electrical)
        make_officer("gen@test.local", self.general)
        results = services.recommend_officers(self.complaint)
        self.assertEqual(self.emails(results), ["ravi@test.local"])
        self.assertTrue(results[0]["same_department"])
        self.assertTrue(results[0]["recommended"])
        self.assertEqual(results[0]["reasons"][0], "Roads Department officer")

    def test_lower_workload_ranks_higher(self):
        light = make_officer("light@test.local", self.roads)
        busy = make_officer("busy@test.local", self.roads)
        give_workload(light, self.citizen, 1)
        give_workload(busy, self.citizen, 6)
        give_workload(busy, self.citizen, 2, status="resolved")  # resolved work is not workload
        results = services.recommend_officers(self.complaint)
        self.assertEqual(self.emails(results), ["light@test.local", "busy@test.local"])
        self.assertEqual([r["workload"] for r in results], [1, 6])
        self.assertEqual([r["utilization"] for r in results], [0.1, 0.6])
        self.assertGreater(results[0]["score"], results[1]["score"])
        self.assertIn("1/10 active complaints", results[0]["reasons"])

    def test_nearer_officer_ranks_higher(self):
        make_officer("far@test.local", self.roads, base=FAR)
        make_officer("near@test.local", self.roads, base=NEAR)
        results = services.recommend_officers(self.complaint)
        self.assertEqual(self.emails(results), ["near@test.local", "far@test.local"])
        self.assertAlmostEqual(results[0]["distance_km"], 0.44, delta=0.02)
        self.assertAlmostEqual(results[1]["distance_km"], 10.56, delta=0.05)
        self.assertIn("445 m away", results[0]["reasons"])
        self.assertIn("10.6 km away", results[1]["reasons"])

    def test_unavailable_officer_ranks_after_available_ones(self):
        make_officer("away@test.local", self.roads, base=NEAR, available=False)
        busy = make_officer("busy@test.local", self.roads, base=FAR)
        give_workload(busy, self.citizen, 3)
        results = services.recommend_officers(self.complaint)
        self.assertEqual(self.emails(results), ["busy@test.local", "away@test.local"])
        self.assertEqual([r["recommended"] for r in results], [True, False])
        self.assertIn("Marked unavailable", results[1]["reasons"])
        self.assertEqual(results[1]["components"]["availability"], 0.0)

    def test_officers_at_capacity_rank_last(self):
        full = make_officer("full@test.local", self.roads, base=NEAR, capacity=2)
        give_workload(full, self.citizen, 2)
        busy = make_officer("busy@test.local", self.roads, base=FAR)
        give_workload(busy, self.citizen, 5)
        results = services.recommend_officers(self.complaint)
        self.assertEqual(self.emails(results), ["busy@test.local", "full@test.local"])
        self.assertTrue(results[1]["at_capacity"])
        self.assertEqual(results[1]["utilization"], 1.0)
        self.assertTrue(results[1]["reasons"][1].startswith("At capacity: 2/2"))

    def test_falls_back_to_secondary_department(self):
        complaint = make_complaint(self.citizen, category=self.manhole, department=self.roads)
        make_officer("roads@test.local", self.roads, available=False)
        make_officer("drain@test.local", self.drain, base=FAR)
        make_officer("gen@test.local", self.general)
        results = services.recommend_officers(complaint)
        self.assertEqual(self.emails(results), ["drain@test.local", "roads@test.local"])
        self.assertTrue(results[0]["recommended"])
        self.assertFalse(results[0]["same_department"])
        self.assertIn("secondary department for Open Manhole", results[0]["reasons"][0])

    def test_falls_back_to_general_department_then_any_officer(self):
        make_officer("gen@test.local", self.general)
        make_officer("elec@test.local", self.electrical)
        results = services.recommend_officers(self.complaint)
        self.assertEqual(self.emails(results), ["gen@test.local"])
        self.assertEqual(results[0]["reasons"][0], "General Civic Department officer (general fallback)")

        OfficerProfile.objects.filter(department=self.general).update(is_available=False)
        results = services.recommend_officers(self.complaint)
        self.assertEqual(self.emails(results), ["elec@test.local", "gen@test.local"])
        self.assertEqual(results[0]["reasons"][0], "Electrical Department officer (outside the routed departments)")

    def test_no_officers_returns_empty_list(self):
        self.assertEqual(services.recommend_officers(self.complaint), [])

    def test_inactive_users_and_non_officer_roles_are_excluded(self):
        make_officer("gone@test.local", self.roads, active=False)
        promoted = make_officer("promoted@test.local", self.roads)
        User.objects.filter(pk=promoted.pk).update(role="admin")
        self.assertEqual(services.recommend_officers(self.complaint), [])

    def test_score_follows_the_weighted_formula(self):
        officer = make_officer("ravi@test.local", self.roads, base=NEAR)
        give_workload(officer, self.citizen, 2)
        result = services.recommend_officers(self.complaint)[0]
        distance = result["distance_km"]
        expected = 0.40 * (1 - 2 / 10) + 0.25 * math.exp(-distance / 5) + 0.15 * 1 + 0.20 * 0.5
        self.assertAlmostEqual(result["score"], expected, places=2)
        self.assertEqual(result["weights"], services.DEFAULT_WEIGHTS)
        self.assertEqual(result["components"]["track_record"], 0.5)
        self.assertIn("No track record yet (neutral score)", result["reasons"])

    def test_critical_priority_weights_track_record_higher(self):
        complaint = make_complaint(self.citizen, category=self.pothole, department=self.roads,
                                   priority_level="critical", priority_score=88)
        make_officer("ravi@test.local", self.roads, base=NEAR)
        result = services.recommend_officers(complaint)[0]
        self.assertEqual(result["weights"], services.CRITICAL_WEIGHTS)
        components = result["components"]
        expected = sum(services.CRITICAL_WEIGHTS[key] * components[key] for key in components)
        self.assertAlmostEqual(result["score"], expected, places=2)

    def test_track_record_rewards_resolved_and_well_rated_work(self):
        good = make_officer("good@test.local", self.roads)
        poor = make_officer("poor@test.local", self.roads)
        for done in give_workload(good, self.citizen, 2, status="closed"):
            Feedback.objects.create(complaint=done, citizen=self.citizen, rating=5, sentiment="positive")
        give_workload(poor, self.citizen, 2, status="rejected")
        results = services.recommend_officers(self.complaint)
        self.assertEqual(self.emails(results), ["good@test.local", "poor@test.local"])
        self.assertIn("Resolution rate 100% (2 of 2), avg rating 5.0/5 (2 ratings)", results[0]["reasons"])
        self.assertAlmostEqual(results[0]["components"]["track_record"], (0.75 + 0.75) / 2, places=3)
        self.assertAlmostEqual(results[1]["components"]["track_record"], (0.25 + 0.5) / 2, places=3)

    def test_overdue_open_complaints_count_against_the_track_record(self):
        officer = make_officer("late@test.local", self.roads)
        give_workload(officer, self.citizen, 2, sla_due_at=timezone.now() - timedelta(hours=5))
        stats = services.collect_officer_stats([officer.pk])[officer.pk]
        self.assertEqual((stats.active, stats.breached, stats.decided), (2, 2, 2))
        self.assertAlmostEqual(stats.resolution_rate, 0.25)

    def test_unknown_locations_use_neutral_proximity(self):
        make_officer("nobase@test.local", self.roads, base=None)
        result = services.recommend_officers(self.complaint)[0]
        self.assertIsNone(result["distance_km"])
        self.assertEqual(result["components"]["proximity"], 0.5)
        self.assertIn("Base location not set", result["reasons"])
        unsaved = Complaint(category=self.pothole, department=self.roads, priority_level="medium")
        preview = services.recommend_officers(unsaved)[0]
        self.assertIn("Complaint location unknown", preview["reasons"])

    def test_works_for_unsaved_draft_complaints(self):
        """The AI preview (pipeline.analyze_preview) ranks officers for a complaint that is not saved yet."""
        make_officer("ravi@test.local", self.roads, base=NEAR)
        draft = Complaint(category=self.pothole, department=self.roads, priority_level="critical")
        draft.location = Location(latitude=SITE[0], longitude=SITE[1])
        result = services.recommend_officers(draft, limit=1)[0]
        self.assertTrue(result["recommended"])
        self.assertAlmostEqual(result["distance_km"], 0.44, delta=0.02)
        self.assertEqual(result["weights"], services.CRITICAL_WEIGHTS)

    def test_limit_and_current_officer_reason(self):
        officers = [make_officer(f"officer{i}@test.local", self.roads) for i in range(4)]
        self.complaint.assigned_officer = officers[0]
        self.assertEqual(len(services.recommend_officers(self.complaint, limit=2)), 2)
        everyone = services.recommend_officers(self.complaint, limit=None)
        self.assertEqual(len(everyone), 4)
        current = next(r for r in everyone if r["officer"] == officers[0])
        self.assertIn("Currently assigned to this complaint", current["reasons"])
        self.assertEqual(sum(r["recommended"] for r in everyone), 1)


# ---------------------------------------------------------------------------------------------------------------
# Assignment
# ---------------------------------------------------------------------------------------------------------------
class AssignOfficerTests(AssignmentFixtures, StatusServiceDouble, TestCase):
    def setUp(self):
        super().setUp()
        self.officer_a = make_officer("ravi.kumar@test.local", self.roads)
        self.officer_b = make_officer("sita.rao@test.local", self.roads, base=FAR)
        self.complaint = make_complaint(self.citizen, category=self.pothole, department=None)

    def notes_for(self, user):
        return list(Notification.objects.filter(user=user).values_list("notification_type", flat=True))

    def test_first_manual_assignment(self):
        assignment = services.assign_officer(self.complaint, self.officer_a, assigned_by=self.admin,
                                             assignment_type="manual", notes="Nearest officer")
        self.assertEqual(ComplaintAssignment.objects.count(), 1)
        self.assertTrue(assignment.is_active)
        self.assertEqual((assignment.status, assignment.assignment_type), ("active", "manual"))
        self.assertEqual((assignment.assigned_by, assignment.department), (self.admin, self.roads))
        self.assertEqual(assignment.notes, "Nearest officer")
        # manual choices are still scored by the recommendation model
        self.assertIsNotNone(assignment.recommendation_score)
        self.assertEqual(assignment.recommendation_reasons[0], "Roads Department officer")

        self.complaint.refresh_from_db()
        self.assertEqual(self.complaint.assigned_officer, self.officer_a)
        self.assertEqual(self.complaint.department, self.roads)  # filled from the officer when empty
        self.assertEqual(self.complaint.status, "assigned")

        args, kwargs = self.change_status.call_args
        self.assertEqual(args[1], "assigned")
        self.assertEqual((kwargs["actor"], kwargs["event"], kwargs["notify"]), (self.admin, "officer_assigned", False))
        self.add_event.assert_not_called()
        event = StatusHistory.objects.get(complaint=self.complaint)
        self.assertEqual(event.event, "officer_assigned")
        self.assertEqual(event.metadata["officer_id"], self.officer_a.pk)
        self.assertEqual(event.metadata["officer_name"], "Ravi Kumar")
        self.assertEqual(event.metadata["score"], assignment.recommendation_score)

        self.assertEqual(self.notes_for(self.officer_a), ["new_assignment"])
        self.assertEqual(self.notes_for(self.citizen), ["officer_assigned"])
        citizen_note = Notification.objects.get(user=self.citizen)
        self.assertEqual(citizen_note.link, f"/citizen/complaints/{self.complaint.pk}")
        self.assertIn("Ravi Kumar (Roads Department)", citizen_note.message)
        self.assertEqual(Notification.objects.get(user=self.officer_a).link,
                         f"/officer/complaints/{self.complaint.pk}")
        log = AuditLog.objects.get()
        self.assertEqual((log.action, log.actor, log.entity_type), ("assign", self.admin, "Complaint"))
        self.assertEqual(log.changes["assigned_officer"], [None, self.officer_a.pk])

    def test_reassignment_deactivates_previous_assignment(self):
        first = services.assign_officer(self.complaint, self.officer_a, assigned_by=self.admin,
                                        assignment_type="manual")
        second = services.assign_officer(self.complaint, self.officer_b, assigned_by=self.admin,
                                         assignment_type="manual")
        first.refresh_from_db()
        self.assertEqual((first.status, first.is_active), ("reassigned", False))
        self.assertIsNotNone(first.completed_at)
        self.assertEqual((second.assignment_type, second.is_active), ("reassignment", True))
        self.assertEqual(ComplaintAssignment.objects.filter(complaint=self.complaint, is_active=True).count(), 1)
        self.complaint.refresh_from_db()
        self.assertEqual(self.complaint.assigned_officer, self.officer_b)

        # the complaint was already "assigned": the reassignment is an event, not a status change
        self.assertEqual(self.change_status.call_count, 1)
        args, kwargs = self.add_event.call_args
        self.assertEqual(args[1], "reassigned")
        self.assertEqual(kwargs["metadata"]["previous_officer_id"], self.officer_a.pk)

        self.assertEqual(self.notes_for(self.officer_b), ["reassignment"])
        self.assertEqual(sorted(self.notes_for(self.officer_a)), ["new_assignment", "reassignment"])
        self.assertEqual(self.notes_for(self.citizen), ["officer_assigned", "officer_assigned"])
        log = AuditLog.objects.filter(action="reassign").get()
        self.assertEqual(log.changes["assigned_officer"], [self.officer_a.pk, self.officer_b.pk])

    def test_reassigning_work_in_progress_moves_it_back_to_assigned(self):
        services.assign_officer(self.complaint, self.officer_a, assigned_by=self.admin, assignment_type="manual")
        Complaint.objects.filter(pk=self.complaint.pk).update(status="in_progress")
        self.complaint.refresh_from_db()
        services.assign_officer(self.complaint, self.officer_b, assigned_by=self.admin, assignment_type="manual")
        args, kwargs = self.change_status.call_args
        self.assertEqual((args[1], kwargs["event"]), ("assigned", "reassigned"))
        self.assertEqual(self.complaint.status, "assigned")

    def test_critical_complaint_alerts_the_officer(self):
        self.complaint.priority_level = "critical"
        self.complaint.priority_score = 91
        self.complaint.save()
        services.assign_officer(self.complaint, self.officer_a, assigned_by=self.admin, assignment_type="manual")
        critical = Notification.objects.get(user=self.officer_a, notification_type="critical_complaint")
        self.assertEqual(critical.level, "critical")
        self.assertIn("91/100", critical.message)

    def test_invalid_officers_are_rejected(self):
        inactive = make_officer("gone@test.local", self.roads, active=False)
        for candidate in (self.citizen, self.admin, inactive):
            with self.subTest(candidate=candidate.email), self.assertRaises(ServiceError):
                services.assign_officer(self.complaint, candidate, assigned_by=self.admin)
        self.assertFalse(ComplaintAssignment.objects.exists())

    def test_resolved_complaint_cannot_be_assigned(self):
        Complaint.objects.filter(pk=self.complaint.pk).update(status="resolved")
        with self.assertRaisesMessage(ServiceError, "reopen it before assigning"):
            services.assign_officer(self.complaint, self.officer_a, assigned_by=self.admin)

    def test_decisions_use_the_committed_status_not_a_stale_copy(self):
        Complaint.objects.filter(pk=self.complaint.pk).update(status="closed")  # changed by another request
        self.assertEqual(self.complaint.status, "analyzed")
        with self.assertRaises(ServiceError):
            services.assign_officer(self.complaint, self.officer_a, assigned_by=self.admin)
        self.assertEqual(self.complaint.status, "closed")

    def test_same_officer_cannot_be_assigned_twice(self):
        services.assign_officer(self.complaint, self.officer_a, assigned_by=self.admin, assignment_type="manual")
        with self.assertRaises(ServiceError):
            services.assign_officer(self.complaint, self.officer_a, assigned_by=self.admin)

    def test_disallowed_transition_creates_nothing(self):
        self.allow_transitions = False
        Complaint.objects.filter(pk=self.complaint.pk).update(status="accepted")
        with self.assertRaises(TransitionNotAllowed):
            services.assign_officer(self.complaint, self.officer_a)
        self.assertFalse(ComplaintAssignment.objects.exists())
        self.assertFalse(Notification.objects.exists())

    def test_notify_false_sends_no_notifications(self):
        services.assign_officer(self.complaint, self.officer_a, assigned_by=self.admin, notify=False)
        self.assertFalse(Notification.objects.exists())


class AutoAssignAndWorkloadTests(AssignmentFixtures, StatusServiceDouble, TestCase):
    def setUp(self):
        super().setUp()
        self.complaint = make_complaint(self.citizen, category=self.pothole, department=self.roads)

    def test_auto_assign_picks_the_recommended_officer(self):
        make_officer("far@test.local", self.roads, base=FAR)
        near = make_officer("near@test.local", self.roads, base=NEAR)
        expected = services.recommend_officers(self.complaint, limit=1)[0]
        assignment = services.auto_assign(self.complaint)
        self.assertEqual(assignment.officer, near)
        self.assertEqual((assignment.assignment_type, assignment.assigned_by), ("auto", None))
        self.assertEqual(assignment.recommendation_score, expected["score"])
        self.assertEqual(assignment.recommendation_reasons, expected["reasons"])
        _, kwargs = self.change_status.call_args
        self.assertIsNone(kwargs["actor"])
        self.assertTrue(kwargs["remarks"].startswith("Automatically assigned to Near"))
        self.assertEqual(AuditLog.objects.get().action, "assign")

    def test_auto_assign_returns_none_without_an_eligible_officer(self):
        self.assertIsNone(services.auto_assign(self.complaint))
        make_officer("away@test.local", self.roads, available=False)
        full = make_officer("full@test.local", self.roads, capacity=1)
        give_workload(full, self.citizen, 1)
        self.assertIsNone(services.auto_assign(self.complaint))
        self.assertFalse(ComplaintAssignment.objects.filter(complaint=self.complaint).exists())

    def test_auto_assign_keeps_an_existing_assignment(self):
        officer = make_officer("ravi@test.local", self.roads)
        make_officer("sita@test.local", self.roads)
        existing = services.assign_officer(self.complaint, officer, assigned_by=self.admin,
                                           assignment_type="manual")
        self.assertEqual(services.auto_assign(self.complaint), existing)
        self.assertEqual(ComplaintAssignment.objects.filter(complaint=self.complaint).count(), 1)

    def test_auto_assign_respects_transition_rules(self):
        make_officer("ravi@test.local", self.roads)
        self.allow_transitions = False
        self.complaint.status = "submitted"
        self.assertIsNone(services.auto_assign(self.complaint))
        self.assertFalse(ComplaintAssignment.objects.exists())

    def test_complete_active_assignment(self):
        officer = make_officer("ravi@test.local", self.roads)
        assignment = services.assign_officer(self.complaint, officer, assigned_by=self.admin)
        closed = services.complete_active_assignment(self.complaint)
        self.assertEqual(closed.pk, assignment.pk)
        assignment.refresh_from_db()
        self.assertEqual((assignment.status, assignment.is_active), ("completed", False))
        self.assertIsNotNone(assignment.completed_at)
        self.assertIsNone(services.complete_active_assignment(self.complaint))
        with self.assertRaises(ValueError):
            services.complete_active_assignment(self.complaint, status="reassigned")

    def test_officer_workload(self):
        officer = make_officer("ravi@test.local", self.roads, capacity=8)
        give_workload(officer, self.citizen, 2, status="assigned")
        give_workload(officer, self.citizen, 1, status="in_progress", priority_level="critical")
        give_workload(officer, self.citizen, 3, status="closed")
        workload = services.officer_workload(officer)
        self.assertEqual(workload, {
            "active": 3, "capacity": 8, "utilization": 0.375, "overloaded": False, "critical": 1,
            "by_status": {"assigned": 2, "accepted": 0, "in_progress": 1, "reopened": 0},
        })
        self.assertEqual(services.officer_workload(officer.officer_profile)["active"], 3)
        no_profile = make_user("plain.officer@test.local", role="officer")
        self.assertEqual(services.officer_workload(no_profile)["capacity"], services.DEFAULT_CAPACITY)

    def test_workload_figures_clamp_utilization_and_flag_overload(self):
        self.assertEqual(services.workload_figures(3, 4),
                         {"active": 3, "capacity": 4, "utilization": 0.75, "overloaded": False})
        self.assertEqual(services.workload_figures(4, 4)["overloaded"], False)  # full, not over capacity
        over = services.workload_figures(6, 4)
        self.assertEqual((over["utilization"], over["overloaded"]), (1.0, True))  # clamped to 0..1
        self.assertEqual(services.workload_figures(0, 0)["utilization"], 1.0)  # no capacity = fully utilised

    def test_workload_numbers_agree_across_services(self):
        officer = make_officer("ravi@test.local", self.roads, capacity=2)
        give_workload(officer, self.citizen, 3, status="accepted")  # over capacity
        workload = services.officer_workload(officer)
        stats = services.collect_officer_stats([officer.pk])[officer.pk]
        candidate = next(item for item in services.recommend_officers(self.complaint, limit=None)
                         if item["officer"].pk == officer.pk)
        self.assertEqual((workload["active"], stats.active, candidate["workload"]), (3, 3, 3))
        self.assertEqual((workload["utilization"], candidate["utilization"]), (1.0, 1.0))
        self.assertTrue(workload["overloaded"] and candidate["overloaded"])


def require_real_status_service(test_case):
    """Skip ``test_case`` while apps.complaints.services.status (owner B3) is still a stub."""
    from apps.complaints.services import status as status_service

    try:
        status_service.can_change_status(Complaint(status="analyzed"), "assigned", None)
    except NotImplementedError:
        test_case.skipTest("apps.complaints.services.status is still a stub")


class RealStatusServiceIntegrationTests(AssignmentFixtures, APITestCase):
    """End-to-end with the real apps.complaints.services.status (no test doubles)."""

    def setUp(self):
        require_real_status_service(self)

    def test_auto_assign_with_real_status_service(self):
        officer = make_officer("ravi@test.local", self.roads)
        complaint = make_complaint(self.citizen, category=self.pothole, department=self.roads)
        assignment = services.auto_assign(complaint)
        self.assertEqual(assignment.officer, officer)
        complaint.refresh_from_db()
        self.assertEqual((complaint.status, complaint.assigned_officer), ("assigned", officer))
        event = complaint.status_history.get(event="officer_assigned")
        self.assertEqual((event.old_status, event.new_status), ("analyzed", "assigned"))
        self.assertEqual(event.metadata["officer_id"], officer.pk)
        self.assertIsNone(event.changed_by)

    def test_system_cannot_auto_assign_an_unanalysed_complaint(self):
        make_officer("ravi@test.local", self.roads)
        complaint = make_complaint(self.citizen, category=self.pothole, department=self.roads, status="submitted")
        self.assertIsNone(services.auto_assign(complaint))

    def test_assign_accept_and_reassign_through_the_api(self):
        from apps.complaints.services import status as status_service

        ravi = make_officer("ravi.kumar@test.local", self.roads)
        sita = make_officer("sita.rao@test.local", self.roads)
        complaint = make_complaint(self.citizen, category=self.pothole, department=self.roads)
        self.client.force_authenticate(self.admin)

        first = self.client.post("/api/assignments/", {"complaint": complaint.pk, "officer": ravi.pk}, format="json")
        self.assertEqual(first.status_code, 201, first.data)
        complaint.refresh_from_db()
        status_service.accept_complaint(complaint, actor=ravi)
        self.assertIsNotNone(ComplaintAssignment.objects.get(pk=first.data["id"]).accepted_at)

        second = self.client.put(f"/api/assignments/{first.data['id']}/", {"officer": sita.pk}, format="json")
        self.assertEqual(second.status_code, 200, second.data)
        complaint.refresh_from_db()
        self.assertEqual((complaint.status, complaint.assigned_officer), ("assigned", sita))
        events = list(complaint.status_history.values_list("event", "old_status", "new_status"))
        self.assertEqual(events, [("officer_assigned", "analyzed", "assigned"), ("accepted", "assigned", "accepted"),
                                  ("reassigned", "accepted", "assigned")])
        self.assertEqual(ComplaintAssignment.objects.get(pk=first.data["id"]).status, "reassigned")
        self.assertEqual(set(AuditLog.objects.values_list("action", flat=True)), {"assign", "reassign",
                                                                                   "status_change"})


# ---------------------------------------------------------------------------------------------------------------
# REST API
# ---------------------------------------------------------------------------------------------------------------
class AssignmentApiTests(AssignmentFixtures, StatusServiceDouble, APITestCase):
    def setUp(self):
        super().setUp()
        self.officer_a = make_officer("ravi.kumar@test.local", self.roads)
        self.officer_b = make_officer("sita.rao@test.local", self.roads, base=FAR)
        self.complaint = make_complaint(self.citizen, category=self.pothole, department=self.roads)
        self.client.force_authenticate(self.admin)

    def assign(self, officer, complaint=None, **extra):
        return self.client.post("/api/assignments/", {"complaint": (complaint or self.complaint).pk,
                                                      "officer": officer.pk, **extra}, format="json")

    def test_admin_assigns_and_gets_contract_shape(self):
        response = self.assign(self.officer_a, notes="Closest officer")
        self.assertEqual(response.status_code, 201, response.data)
        data = response.data
        self.assertEqual(set(data), ASSIGNMENT_KEYS)
        self.assertEqual(set(data["officer"]), OFFICER_MINI_KEYS)
        self.assertEqual(set(data["officer"]["department"]), DEPARTMENT_MINI_KEYS)
        self.assertEqual(set(data["assigned_by"]), USER_MINI_KEYS)
        self.assertEqual(set(data["department"]), DEPARTMENT_MINI_KEYS)
        self.assertEqual((data["complaint"], data["assignment_type"], data["status"]),
                         (self.complaint.pk, "manual", "active"))
        self.assertEqual(data["officer"]["employee_id"], f"EMP-{self.officer_a.pk}")
        self.assertEqual(data["notes"], "Closest officer")

    def test_second_post_reassigns(self):
        first = self.assign(self.officer_a).data
        second = self.assign(self.officer_b)
        self.assertEqual(second.status_code, 201)
        self.assertEqual(second.data["assignment_type"], "reassignment")
        self.assertFalse(ComplaintAssignment.objects.get(pk=first["id"]).is_active)

    def test_validation_errors(self):
        response = self.assign(self.citizen)
        self.assertEqual(response.status_code, 400)
        self.assertIn("officer", response.data["errors"])
        response = self.client.post("/api/assignments/", {"officer": self.officer_a.pk}, format="json")
        self.assertEqual(response.status_code, 400)
        self.assertIn("complaint", response.data["errors"])
        self.complaint.status = "closed"
        self.complaint.save()
        response = self.assign(self.officer_a)
        self.assertEqual((response.status_code, response.data["code"]), (400, "service_error"))

    def test_permissions(self):
        self.client.force_authenticate(self.officer_a)
        self.assertEqual(self.assign(self.officer_a).status_code, 403)
        self.assertEqual(self.client.get(f"/api/assignments/recommend/?complaint={self.complaint.pk}").status_code,
                         403)
        self.client.force_authenticate(self.citizen)
        self.assertEqual(self.client.get("/api/assignments/").status_code, 403)
        self.client.force_authenticate(None)
        self.assertEqual(self.client.get("/api/assignments/").status_code, 401)

    def test_officer_lists_only_own_assignments_and_filters_work(self):
        other = make_complaint(self.citizen, category=self.pothole, department=self.roads)
        self.assign(self.officer_a)
        self.assign(self.officer_b, complaint=other)
        self.assign(self.officer_b)  # reassigns self.complaint from A to B

        self.assertEqual(self.client.get("/api/assignments/").data["count"], 3)
        self.assertEqual(self.client.get("/api/assignments/", {"is_active": "false"}).data["count"], 1)
        self.assertEqual(self.client.get("/api/assignments/", {"complaint": other.pk}).data["count"], 1)
        self.assertEqual(self.client.get("/api/assignments/", {"officer": self.officer_b.pk}).data["count"], 2)

        self.client.force_authenticate(self.officer_a)
        response = self.client.get("/api/assignments/")
        self.assertEqual(response.data["count"], 1)
        own = response.data["results"][0]
        self.assertEqual((own["officer"]["id"], own["status"]), (self.officer_a.pk, "reassigned"))
        foreign = ComplaintAssignment.objects.filter(officer=self.officer_b).first()
        self.assertEqual(self.client.get(f"/api/assignments/{foreign.pk}/").status_code, 404)

    def test_put_reassigns_the_active_assignment(self):
        current = self.assign(self.officer_a).data
        response = self.client.put(f"/api/assignments/{current['id']}/", {"officer": self.officer_b.pk},
                                   format="json")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertNotEqual(response.data["id"], current["id"])
        self.assertEqual((response.data["officer"]["id"], response.data["assignment_type"]),
                         (self.officer_b.pk, "reassignment"))
        patched = self.client.patch(f"/api/assignments/{response.data['id']}/", {"officer": self.officer_a.pk},
                                    format="json")
        self.assertEqual(patched.status_code, 200)
        stale = self.client.put(f"/api/assignments/{current['id']}/", {"officer": self.officer_b.pk},
                                format="json")
        self.assertEqual(stale.status_code, 400)

    def test_recommend_endpoint(self):
        response = self.client.get("/api/assignments/recommend/", {"complaint": self.complaint.pk, "limit": 1})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.data), 1)
        top = response.data[0]
        self.assertEqual(set(top), RECOMMENDATION_KEYS)
        self.assertEqual(set(top["officer"]), OFFICER_MINI_KEYS)
        self.assertEqual(top["officer"]["id"], self.officer_a.pk)
        self.assertTrue(top["recommended"])
        self.assertTrue(top["same_department"])
        self.assertIsInstance(top["reasons"], list)
        full = self.client.get("/api/assignments/recommend/", {"complaint": self.complaint.pk})
        self.assertEqual([item["recommended"] for item in full.data], [True, False])

    def test_recommend_validates_the_query(self):
        self.assertEqual(self.client.get("/api/assignments/recommend/").status_code, 400)
        self.assertEqual(self.client.get("/api/assignments/recommend/", {"complaint": 999999}).status_code, 400)
        response = self.client.get("/api/assignments/recommend/", {"complaint": self.complaint.pk, "limit": 0})
        self.assertEqual(response.status_code, 400)
