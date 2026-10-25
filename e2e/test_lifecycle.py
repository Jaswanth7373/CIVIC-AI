"""Lifecycle actions across roles that the main flows do not reach: an officer rejects with a reason, a citizen
reopens a resolved complaint, an administrator overrides the AI result, an officer verifies a resolution manually
(REQUIREMENTS 5, 6, 7, 24, 25). Each test files its own complaint through the API and tidies up afterwards."""
from __future__ import annotations

import re

import pytest
from playwright.sync_api import expect

from support.api import results
from support.data import after_photo, jitter, sample_photo, unique_token
from support.ui import api_response, assert_healthy, expect_toast

pytestmark = [pytest.mark.mutates, pytest.mark.ai]


def file_for_officer(api, accounts, reporter, *, description: str, point: tuple[float, float], area: str, kind: str = "pothole"):
    """A complaint filed by `reporter` and held by the demo officer (roads.officer1). Returns (complaint, photo).

    Some of these complaints stay in the system (rejected / closed), so each run spreads them over ~1.5 km instead of
    stacking them on one spot, where repeated runs would form a DBSCAN hotspot of test data.
    """
    photo = sample_photo(kind)
    latitude, longitude = jitter(point, 1500)
    complaint = api.create_complaint(
        reporter, description=description, latitude=latitude, longitude=longitude, photo=photo, area=area
    )
    officer_id = api.user(accounts.officer)["id"]
    if (complaint.get("assigned_officer") or {}).get("id") != officer_id:
        api.assign(accounts.admin, complaint, officer_id, "E2E lifecycle test")
    return api.get(f"complaints/{complaint['id']}/", account=accounts.officer), photo


def test_officer_rejects_a_complaint_and_the_citizen_sees_why(open_page, settings, api, accounts):
    token = unique_token()
    complaint, _ = file_for_officer(
        api, accounts, accounts.reject_reporter,
        description=f"Pothole inside a private apartment compound parking lot, not on a public road. Automated e2e report {token}.",
        point=(17.4435, 78.3772),
        area="Kondapur",
    )
    reason = "Private property: the parking lot belongs to the apartment association, not to the municipality."
    page = open_page(accounts.officer)
    page.goto(f"/officer/complaints/{complaint['id']}")
    page.get_by_role("button", name="Reject complaint").first.click()
    dialog = page.get_by_role("dialog", name="Reject complaint")
    expect(dialog).to_be_visible()
    dialog.get_by_role("button", name="Reject complaint").click()  # empty reason -> explained, nothing sent
    expect(dialog.get_by_text("Explain why the complaint cannot be handled, so the citizen knows what to do next.")).to_be_visible()
    dialog.get_by_label("Reason for rejecting").fill(reason)
    with page.expect_response(api_response(settings.api_url, "POST", rf"complaints/{complaint['id']}/reject/")) as rejected:
        dialog.get_by_role("button", name="Reject complaint").click()
    assert rejected.value.status == 200, rejected.value.text()
    assert rejected.value.json()["status"] == "rejected"
    expect_toast(page, "Complaint rejected")
    assert_healthy(page)

    citizen = open_page(accounts.reject_reporter)
    citizen.goto(f"/citizen/complaints/{complaint['id']}")
    alert = citizen.get_by_role("alert").filter(has_text="The department could not act on this complaint")
    expect(alert).to_be_visible()
    expect(alert).to_contain_text(reason)
    assert "status_changed" in api.notification_types(accounts.reject_reporter, complaint["id"])
    assert_healthy(citizen)


def test_citizen_reopens_a_resolved_complaint(open_page, settings, api, accounts):
    token = unique_token()
    complaint, photo = file_for_officer(
        api, accounts, accounts.reopen_reporter,
        description=f"Pothole at the junction near the temple, deep enough to damage tyres. Automated e2e report {token}.",
        point=(17.4062, 78.4691),
        area="Narayanguda",
    )
    try:
        resolved = api.resolve_as_officer(accounts.officer, complaint["id"], after=after_photo(photo), remarks="Patched with cold mix.")
        assert resolved["status"] in {"resolved", "verified"}
        page = open_page(accounts.reopen_reporter)
        page.goto(f"/citizen/complaints/{complaint['id']}")
        page.get_by_role("button", name="Reopen complaint").first.click()
        dialog = page.get_by_role("dialog", name="Reopen complaint")
        expect(dialog).to_be_visible()
        dialog.get_by_label("What is still wrong?").fill("The patch broke up after one day of rain; the pothole is back.")
        with page.expect_response(api_response(settings.api_url, "POST", rf"complaints/{complaint['id']}/reopen/")) as reopened:
            dialog.get_by_role("button", name="Reopen complaint").click()
        assert reopened.value.status == 200, reopened.value.text()
        assert reopened.value.json()["status"] == "reopened"
        expect_toast(page, "Complaint reopened")
        expect(dialog).to_be_hidden()

        stored = api.get(f"complaints/{complaint['id']}/", account=accounts.admin)
        assert stored["status"] == "reopened" and stored["reopen_count"] == 1
        assert "complaint_reopened" in api.notification_types(accounts.officer, complaint["id"]), "the officer was not told"
        assert_healthy(page)
    finally:
        if not settings.keep_data:
            api.withdraw_complaint(accounts.reopen_reporter, accounts.admin, complaint["id"], f"E2E test cleanup {token}")


def test_admin_overrides_the_ai_category(open_page, settings, api, accounts):
    token = unique_token()
    complaint, _ = file_for_officer(
        api, accounts, accounts.override_reporter,
        description=f"Hole in the road near the bus depot, the cover seems to be missing. Automated e2e report {token}.",
        point=(17.3984, 78.5583),
        area="Uppal",
    )
    categories = api.get("categories/")
    target = next(c for c in categories if c["slug"] == "open_manhole")
    if complaint["category"] and complaint["category"]["slug"] == "open_manhole":
        target = next(c for c in categories if c["slug"] == "pothole")
    try:
        page = open_page(accounts.admin)
        page.goto(f"/admin/complaints/{complaint['id']}")
        page.get_by_role("button", name="Override AI result").first.click()
        dialog = page.get_by_role("dialog", name="Override AI result")
        expect(dialog).to_be_visible()
        dialog.locator("#override-category").select_option(str(target["id"]))
        dialog.get_by_label("Reason").fill("The photo shows an open manhole with the cover missing, not a pothole.")
        with page.expect_response(api_response(settings.api_url, "POST", rf"complaints/{complaint['id']}/override-ai/")) as overridden:
            dialog.get_by_role("button", name="Override AI result").click()
        assert overridden.value.status == 200, overridden.value.text()
        expect_toast(page, "AI result overridden")
        expect(dialog).to_be_hidden()
        expect(page.locator("#main-content")).to_contain_text(target["name"])

        stored = api.get(f"complaints/{complaint['id']}/", account=accounts.admin)
        assert stored["category"]["id"] == target["id"] and stored["is_ai_overridden"]
        assert "ai_overridden" in [event["event"] for event in stored["timeline"]]
        audit = results(api.get("audit-logs/", account=accounts.admin, params={"action": "ai_override", "page_size": 20}))
        assert any(str(complaint["complaint_number"]) in str(row) for row in audit), "the override is not in the audit log"
        assert_healthy(page)
    finally:
        if not settings.keep_data:
            api.withdraw_complaint(accounts.override_reporter, accounts.admin, complaint["id"], f"E2E test cleanup {token}")


def test_officer_verifies_a_resolution_manually(open_page, settings, api, accounts):
    token = unique_token()
    complaint, _ = file_for_officer(
        api, accounts, accounts.manual_reporter,
        description=f"Broken road edge with a pothole beside the drain, two-wheelers fall into it. Automated e2e report {token}.",
        point=(17.3616, 78.4747),
        area="Charminar",
    )
    complaint_id = complaint["id"]
    try:
        api.post(f"complaints/{complaint_id}/accept/", account=accounts.officer, body={})
        api.post(f"complaints/{complaint_id}/start/", account=accounts.officer, body={})
        resolved = api.post(
            f"complaints/{complaint_id}/resolve/", account=accounts.officer, multipart={"remarks": "Filled and compacted; no after photo, camera failed."}
        )
        assert resolved["status"] == "resolved" and not resolved.get("latest_verification")

        page = open_page(accounts.officer)
        page.goto(f"/officer/complaints/{complaint_id}/verify")
        page.get_by_role("button", name="Verify manually").first.click()
        dialog = page.get_by_role("dialog", name="Verify manually")
        expect(dialog).to_be_visible()
        expect(dialog.get_by_role("radio", name=re.compile(r"^Likely resolved"))).to_be_checked()
        dialog.get_by_role("textbox", name="Explanation").fill("Checked on site: the pothole is filled and the road edge is level again.")
        with page.expect_response(api_response(settings.api_url, "POST", rf"complaints/{complaint_id}/manual-verification/")) as saved:
            dialog.get_by_role("button", name="Save manual verification").click()
        assert saved.value.status in {200, 201}, saved.value.text()
        verification = saved.value.json()
        assert verification["status"] == "likely_resolved" and verification["is_manual_override"]
        expect_toast(page, "Manual verification saved")
        expect(page.get_by_text("Manual override").first).to_be_visible()
        expect(page.get_by_text(f"Resolution verification score {round(float(verification['score']))}/100").first).to_be_visible()

        stored = api.get(f"complaints/{complaint_id}/", account=accounts.admin)
        assert stored["status"] == "verified", f"a manual 'likely resolved' left the complaint {stored['status']}"
        assert "feedback_requested" in api.notification_types(accounts.manual_reporter, complaint_id)
        assert_healthy(page)
    finally:
        if not settings.keep_data:
            api.withdraw_complaint(accounts.manual_reporter, accounts.admin, complaint_id, f"E2E test cleanup {token}")
