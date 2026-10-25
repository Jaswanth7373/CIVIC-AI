"""Officer workspace: the queue ordered by AI priority, and a complete work order on a complaint the test files
itself - accept -> start work -> upload the after photo -> mark as resolved -> AI-assisted verification
(REQUIREMENTS 6, 24, 25, 30)."""
from __future__ import annotations

import re
from urllib.parse import parse_qs, urlparse

import pytest
from playwright.sync_api import expect

from support.data import OFFICER_FLOW_POINT, after_photo, jitter, sample_photo, unique_token
from support.ui import api_response, assert_healthy, expect_toast, normalize, row_complaint_numbers


def test_officer_queue_is_sorted_by_priority(officer_page, settings, api, accounts):
    page = officer_page
    officer_id = api.user(accounts.officer)["id"]
    with page.expect_response(api_response(settings.api_url, "GET", "complaints/", params={"ordering": "-priority_score"})) as listed:
        page.goto("/officer/complaints")
    assert listed.value.status == 200, listed.value.text()
    rows = listed.value.json()["results"]
    assert rows, f"{accounts.officer.email} has no assigned complaints to sort"

    scores = [row["priority_score"] for row in rows]
    assert scores == sorted(scores, reverse=True), f"queue is not ordered by priority: {scores}"
    assert all((row.get("assigned_officer") or {}).get("id") == officer_id for row in rows), "the queue holds complaints of other officers"

    table = page.locator("#main-content table")
    expect(table.locator("tbody tr")).to_have_count(len(rows))
    assert row_complaint_numbers(table) == [row["complaint_number"] for row in rows]
    expect(table.get_by_role("columnheader", name=re.compile(r"^Priority"))).to_have_attribute("aria-sort", "descending")
    assert_healthy(page)


@pytest.mark.mutates
@pytest.mark.ai
def test_officer_accepts_starts_and_resolves_with_after_photo(open_page, settings, api, accounts):
    officer_id = api.user(accounts.officer)["id"]
    photo = sample_photo("pothole")
    token = unique_token()
    latitude, longitude = jitter(OFFICER_FLOW_POINT, 120)

    # Arrange (API): a citizen reports a pothole near Ameerpet; make sure roads.officer1 holds the work order.
    complaint = api.create_complaint(
        accounts.officer_flow_reporter,
        description=f"Large pothole near the school entrance causing traffic problems. Automated e2e work order {token}.",
        latitude=latitude,
        longitude=longitude,
        photo=photo,
        area="Ameerpet",
    )
    complaint_id, number = complaint["id"], complaint["complaint_number"]
    if (complaint.get("assigned_officer") or {}).get("id") != officer_id:
        api.assign(accounts.admin, complaint, officer_id, f"E2E officer flow {token}")
    detail = api.get(f"complaints/{complaint_id}/", account=accounts.officer)
    assert detail["assigned_officer"]["id"] == officer_id
    assert "accept" in detail["allowed_actions"], f"status {detail['status']}, actions {detail['allowed_actions']}"

    page = open_page(accounts.officer)
    page.goto(f"/officer/complaints/{complaint_id}")
    expect(page.get_by_role("heading", level=1)).to_be_visible()
    expect(page.locator("#main-content")).to_contain_text(number)

    # Accept, then start work - both in place on the work order.
    with page.expect_response(api_response(settings.api_url, "POST", rf"complaints/{complaint_id}/accept/")) as accepted:
        page.get_by_role("button", name="Accept complaint").click()
    assert accepted.value.status == 200, accepted.value.text()
    assert accepted.value.json()["status"] == "accepted"
    expect_toast(page, "Complaint accepted")

    with page.expect_response(api_response(settings.api_url, "POST", rf"complaints/{complaint_id}/start/")) as started:
        page.get_by_role("button", name="Start work").click()
    assert started.value.status == 200, started.value.text()
    assert started.value.json()["status"] == "in_progress"
    expect_toast(page, "Work started")

    # Resolution update: after photo + remarks, then "Mark as resolved" (confirmation dialog).
    page.get_by_role("link", name="Mark as resolved").click()
    page.wait_for_url(re.compile(rf"/officer/complaints/{complaint_id}/resolve$"))
    repaired = after_photo(photo)
    with page.expect_file_chooser() as chooser:
        page.get_by_label("After photo", exact=True).click()
    chooser.value.set_files(str(repaired))
    expect(page.get_by_role("img", name=f"Selected photo {repaired.name}")).to_be_visible()
    page.get_by_label("Resolution remarks").fill("Pothole cut, filled with hot-mix asphalt and compacted; lane reopened to traffic.")
    page.locator("#main-content").get_by_role("button", name="Mark as resolved").click()
    dialog = page.get_by_role("dialog")
    expect(dialog).to_contain_text(f"Mark {number} as resolved?")
    with page.expect_response(
        api_response(settings.api_url, "POST", rf"complaints/{complaint_id}/resolve/"), timeout=settings.ai_timeout_ms
    ) as resolved:
        dialog.get_by_role("button", name="Mark as resolved").click()
    assert resolved.value.status == 200, resolved.value.text()
    result = resolved.value.json()
    verification = result.get("latest_verification")
    assert verification, "no AI verification ran although an after photo was uploaded"
    assert result["status"] in {"resolved", "verified"}
    score = round(float(verification["score"]))

    expect_toast(page, "Complaint resolved", timeout=30_000)
    expect(page.get_by_text(re.compile(r"scored the work \d+(\.\d+)?/100"))).to_be_visible()
    expect(page.get_by_text(f"Resolution verification score {score}/100").first).to_be_visible()

    # The verification page shows the same AI-assisted result.
    page.goto(f"/officer/complaints/{complaint_id}/verify")
    expect(page.get_by_text(f"Resolution verification score {score}/100").first).to_be_visible()
    expect(page.locator("#main-content")).to_contain_text("AI-assisted")

    stored = api.get(f"complaints/{complaint_id}/", account=accounts.admin)
    assert stored["status"] == result["status"]
    assert stored["latest_verification"]["id"] == verification["id"]

    # REQUIREMENTS 28: the citizen is told about every step the officer took.
    told = set(api.notification_types(accounts.officer_flow_reporter, complaint_id))
    expected = {"status_changed", "complaint_resolved"}
    if result["status"] == "verified":
        expected |= {"resolution_verified", "feedback_requested"}
    assert expected <= told, f"citizen notifications missing: {sorted(expected - told)} (got {sorted(told)})"
    assert_healthy(page)


OFFICER_TILES = [("Assigned to me", "assigned"), ("Critical", "critical"), ("Pending acceptance", "pending"),
                 ("In progress", "in_progress"), ("Resolved", "resolved")]
QUEUE_COLUMNS = ["Complaint ID", "Category", "Location", "Priority", "Severity", "Status", "Date", "Action"]


def test_officer_dashboard_figures_match_their_lists(officer_page, settings, api, accounts):
    """REQUIREMENTS 30: the officer dashboard figures come from the database, and each tile opens the matching list."""
    page = officer_page
    with page.expect_response(api_response(settings.api_url, "GET", "analytics/dashboard/")) as call:
        page.goto("/officer/dashboard")
    assert call.value.status == 200, call.value.text()
    served = call.value.json()
    tiles = page.locator("section[aria-label='Key numbers'] a")
    for label, key in OFFICER_TILES:
        tile = tiles.filter(has=page.get_by_text(label, exact=True))
        expect(tile).to_have_count(1)
        value = tile.locator("p").nth(1)
        expect(value).to_have_text(re.compile(r"^[\d,]+$"))
        shown = int(value.inner_text().replace(",", ""))
        assert shown == served["totals"][key], f"tile '{label}' shows {shown}, API totals.{key} = {served['totals'][key]}"
        query = parse_qs(urlparse(tile.get_attribute("href")).query)
        params = {name: values[0] for name, values in query.items() if name in {"status", "priority_level"}}
        listed = api.get("complaints/", account=accounts.officer, params={**params, "page_size": 1})["count"]
        assert listed == shown, f"tile '{label}' shows {shown} but its list ({tile.get_attribute('href')}) has {listed}"

    queue = page.locator("table").filter(has=page.locator("caption", has_text="Priority queue"))
    expect(queue).to_be_visible()
    headers = [normalize(text) for text in queue.locator("thead th").all_inner_texts()]
    assert all(any(header.startswith(column) for header in headers) for column in QUEUE_COLUMNS), f"queue columns {headers}"
    scores = [row["priority_score"] for row in served["queue"]]
    assert scores == sorted(scores, reverse=True), f"priority queue not ordered by priority: {scores}"
    assert row_complaint_numbers(queue) == [row["complaint_number"] for row in served["queue"]]
    assert_healthy(page)
