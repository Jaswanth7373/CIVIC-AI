"""Citizen workspace: dashboard figures, the full "Report an issue" flow through the UI (photo, description,
map pin, "Analyze & Submit") on a desktop and a phone, the complaint in My complaints and its detail page, wizard
validation, notifications, duplicate detection, rating a resolved complaint and the profile
(REQUIREMENTS 5, 11, 19, 26-28, 31, 47, 48)."""
from __future__ import annotations

import random
import re
from urllib.parse import parse_qs, urlparse

import pytest
from playwright.sync_api import expect

from support.api import results
from support.data import after_photo, jitter, sample_photo, unique_token
from support.ui import api_response, assert_healthy, card, expect_toast, normalize, parse_int, row_complaint_numbers

STAT_CARDS = [("Total", "total"), ("Pending", "pending"), ("In progress", "in_progress"), ("Resolved", "resolved")]


def stat_value(page, label: str):
    """The number on the dashboard StatCard with this label (the card is a link: label, value, hint)."""
    card = page.locator("section[aria-label='Complaint counts'] a").filter(has=page.get_by_text(label, exact=True))
    expect(card).to_have_count(1)
    value = card.locator("p").nth(1)
    expect(value).to_have_text(re.compile(r"^[\d,]+$"))
    return parse_int(value.inner_text())


def test_dashboard_shows_the_real_totals(citizen_page, settings, api, accounts):
    page = citizen_page
    with page.expect_response(api_response(settings.api_url, "GET", "analytics/dashboard/")) as call:
        page.goto("/citizen/dashboard")
    assert call.value.status == 200, call.value.text()
    served = call.value.json()
    direct = api.get("analytics/dashboard/", account=accounts.citizen)
    assert served["role"] == "citizen"
    assert served["totals"] == direct["totals"], "the page received other totals than GET /analytics/dashboard/ returns"

    for label, key in STAT_CARDS:
        assert stat_value(page, label) == served["totals"][key], f"'{label}' card"
        # Each card links to My complaints filtered to that status group: the list must hold the same number.
        href = page.locator("section[aria-label='Complaint counts'] a").filter(has=page.get_by_text(label, exact=True)).get_attribute("href")
        status = parse_qs(urlparse(href).query).get("status", [None])[0]
        listed = api.get("complaints/", account=accounts.citizen, params={"status": status, "page_size": 1})["count"]
        assert listed == served["totals"][key], f"'{label}' card shows {served['totals'][key]} but its list ({href}) has {listed}"

    # Recent complaints: the five newest from the same response, in the same order.
    table = page.locator("table").filter(has=page.locator("caption", has_text="Your five most recent complaints"))
    expect(table).to_be_visible()
    expected = [row["complaint_number"] for row in served["recent_complaints"]]
    assert row_complaint_numbers(table) == expected

    # Following a card opens the filtered list with the same count.
    if served["totals"]["pending"]:
        page.locator("section[aria-label='Complaint counts'] a").filter(has=page.get_by_text("Pending", exact=True)).click()
        page.wait_for_url(re.compile(r"/citizen/complaints\?status="))
        expect(page.locator("#main-content").get_by_text(re.compile(rf"^{served['totals']['pending']} complaints? match"))).to_be_visible()
    assert_healthy(page)


@pytest.mark.mutates
@pytest.mark.ai
@pytest.mark.parametrize("device", ["desktop", "phone"])
def test_submit_complaint_through_the_ui_then_track_it(open_page, settings, api, accounts, fresh_citizen, device):
    reporter = fresh_citizen
    phone = device == "phone"
    page = open_page(reporter, phone=phone)
    photo = sample_photo("pothole")
    token = unique_token()
    description = (
        "Deep pothole in the left lane near the bus stop, about a metre wide. Two-wheelers swerve into traffic "
        f"to avoid it. Automated e2e report {token}."
    )
    created = None
    try:
        if phone:  # citizens on phones start from the raised "Report" button of the bottom tab bar
            page.goto("/citizen/dashboard")
            page.get_by_role("navigation", name="Quick navigation").get_by_role("link", name="Report an issue").click()
            page.wait_for_url(re.compile(r"/citizen/report$"))
        else:
            page.goto("/citizen/report")
        heading = page.locator("#report-step-heading")

        # 1. Photo: the drag-and-drop zone opens the file chooser.
        expect(heading).to_have_text("Add a photo of the problem")
        with page.expect_file_chooser() as chooser:
            page.locator("#report-photo").click()
        chooser.value.set_files(str(photo))
        expect(page.get_by_role("img", name=f"Selected photo {photo.name}")).to_be_visible()
        page.get_by_role("button", name="Continue", exact=True).click()

        # 2. Description.
        expect(heading).to_have_text("Describe what is wrong")
        page.fill("#report-description", description)
        page.get_by_role("button", name="Continue", exact=True).click()

        # 3. Location: a click on the map places the pin and reverse-geocodes the address.
        expect(heading).to_have_text("Mark where it is")
        map_box = page.locator(".leaflet-container").first
        expect(map_box).to_be_visible()
        size = map_box.bounding_box()
        point = {"x": size["width"] * random.uniform(0.3, 0.7), "y": size["height"] * random.uniform(0.3, 0.7)}
        with page.expect_response(api_response(settings.api_url, "GET", "geo/reverse/"), timeout=45_000) as geocoded:
            map_box.click(position=point)
        assert geocoded.value.status == 200, geocoded.value.text()
        pin = page.get_by_text(re.compile(r"^\d{1,2}\.\d{6}, \d{2,3}\.\d{6}"))
        expect(pin).to_be_visible()
        place = geocoded.value.json()
        if place.get("display_name"):
            expect(page.get_by_text(place["display_name"], exact=True)).to_be_visible()
        if place.get("city"):
            expect(page.locator("#report-city")).to_have_value(place["city"])
        page.get_by_role("button", name="Continue", exact=True).click()

        # 4. Review -> Analyze & Submit runs the whole AI pipeline.
        expect(heading).to_have_text("Check and submit")
        with page.expect_response(api_response(settings.api_url, "POST", "complaints/"), timeout=settings.ai_timeout_ms) as submitted:
            page.get_by_role("button", name="Analyze & Submit").click()
        assert submitted.value.status == 201, submitted.value.text()
        created = submitted.value.json()
        summary = created["analysis"]["summary"]

        expect(page.get_by_role("heading", name="Complaint submitted", exact=True)).to_be_visible(timeout=30_000)
        expect_toast(page, "Complaint submitted")
        result = page.locator("section[aria-label='AI analysis result']")
        expect(result).to_be_visible(timeout=30_000)
        expect(result).to_contain_text(created["complaint_number"])
        assert summary.get("category"), f"the AI did not classify the report: {summary}"
        expect(result).to_contain_text(summary["category"]["name"])
        meter = result.get_by_role("meter", name="Priority score")
        expect(meter).to_have_attribute("aria-valuenow", str(round(summary["priority_score"])))
        if summary.get("department"):
            expect(result).to_contain_text(summary["department"]["name"])
        if summary.get("officer"):
            expect(result).to_contain_text(summary["officer"]["full_name"])
        if summary.get("is_demo"):
            expect(result.get_by_text("Demo AI Mode").first).to_be_visible()

        # "Track complaint" opens the live tracking view with the timeline.
        page.get_by_role("link", name="Track complaint").first.click()
        page.wait_for_url(re.compile(rf"/citizen/complaints/{created['id']}/track$"))
        expect(page.get_by_role("heading", level=1)).to_be_visible()
        expect(page.locator("ol[aria-label='Complaint timeline']").first).to_be_visible()

        # The new complaint is the one complaint in My complaints and opens its detail page.
        with page.expect_response(api_response(settings.api_url, "GET", "complaints/", params={"page_size": 20})) as listed:
            page.goto("/citizen/complaints")
        rows = listed.value.json()["results"]
        assert [row["id"] for row in rows] == [created["id"]], "My complaints does not list exactly the new complaint"
        # Desktop: the table row's title links to the complaint. Phone: the list shows cards that open on tap.
        number = created["complaint_number"]
        if phone:
            target = page.locator("#main-content li:visible").filter(has_text=number).last
        else:
            row = page.locator("#main-content tbody tr").filter(has_text=number)
            target = row.locator(f"a[href='/citizen/complaints/{created['id']}']").first
        expect(target).to_be_visible()
        with page.expect_response(api_response(settings.api_url, "GET", rf"complaints/{created['id']}/")) as opened:
            target.click()
        page.wait_for_url(re.compile(rf"/citizen/complaints/{created['id']}$"))
        detail = opened.value.json()
        expect(page.get_by_role("heading", level=1)).to_have_text(detail["title"] or detail["complaint_number"])

        ai_card = card(page, "AI analysis")
        for text in ("Fused confidence", "How each model voted", "Image model", "Text classifier"):
            expect(ai_card.get_by_text(text, exact=True).first, f"AI panel: {text}").to_be_visible()
        expect(ai_card).to_contain_text(detail["ai_prediction"]["final_category"]["name"])
        main = page.locator("#main-content")
        if detail.get("department"):
            expect(main).to_contain_text(detail["department"]["name"])
        if detail.get("assigned_officer"):
            expect(main).to_contain_text(detail["assigned_officer"]["full_name"])

        components = page.locator("ul[aria-label='Priority components'] > li")
        expect(components).to_have_count(len(detail["priority"]["components"]))
        for component in detail["priority"]["components"]:
            expect(components.filter(has_text=component["label"]).first).to_contain_text(re.compile(r"\d+(\.\d+)?/\d+"))

        timeline = page.locator("ol[aria-label='Complaint timeline']")
        expect(timeline).to_be_visible()
        show_all = page.get_by_role("button", name=re.compile(r"^Show all \d+ updates$"))
        if show_all.count():
            show_all.click()
        for label in ("Complaint submitted", "AI analysis completed", "Priority assigned"):
            expect(timeline.get_by_text(label, exact=True).first, f"timeline: {label}").to_be_visible()
        assert_healthy(page)
    finally:
        if created and not settings.keep_data:
            api.withdraw_complaint(reporter, accounts.admin, created["id"], f"E2E test cleanup {token}")


@pytest.mark.mutates
def test_notifications_page_lists_items_and_marks_all_read(open_page, settings, api, accounts, fresh_citizen):
    reporter = fresh_citizen
    created = None
    token = unique_token()
    try:
        # A new complaint produces the notifications (submitted, AI analysis, department / officer assigned).
        latitude, longitude = jitter((17.4126, 78.4071), 400)
        created = api.create_complaint(
            reporter,
            description=f"Overflowing garbage bin on the footpath, waste spilling onto the road. Automated e2e report {token}.",
            latitude=latitude,
            longitude=longitude,
            photo=sample_photo("garbage"),
            area="Banjara Hills",
        )
        assert api.get("notifications/unread-count/", account=reporter)["count"] > 0

        page = open_page(reporter)
        with page.expect_response(api_response(settings.api_url, "GET", "notifications/", params={"page_size": 20})) as listed:
            page.goto("/citizen/notifications")
        data = listed.value.json()
        main = page.locator("#main-content")
        items = main.locator("section[aria-label] > ul > li")  # one list per day group
        expect(items).to_have_count(min(data["count"], 20))
        unread_rows = sum(1 for row in data["results"] if not row["is_read"])
        unread_items = items.filter(has_text="Unread:")
        expect(unread_items).to_have_count(unread_rows)
        first = data["results"][0]
        expect(items.first).to_contain_text(normalize(first["title"]))

        mark_all = page.get_by_role("button", name="Mark all as read")
        expect(mark_all).to_be_enabled()
        expect(page.get_by_role("button", name=re.compile(r"^Notifications, \d+ unread$"))).to_be_visible()
        with page.expect_response(api_response(settings.api_url, "POST", "notifications/read-all/")) as marked:
            mark_all.click()
        assert marked.value.status == 200, marked.value.text()
        expect_toast(page, "All notifications marked as read")
        expect(unread_items).to_have_count(0)
        expect(mark_all).to_be_disabled()
        expect(page.get_by_role("button", name="Notifications", exact=True)).to_be_visible()  # the topbar bell is cleared too
        assert api.get("notifications/unread-count/", account=reporter)["count"] == 0
        assert_healthy(page)
    finally:
        if created and not settings.keep_data:
            api.withdraw_complaint(reporter, accounts.admin, created["id"], f"E2E test cleanup {token}")


@pytest.mark.mutates
@pytest.mark.ai
def test_citizen_rates_a_resolved_complaint_and_it_closes(open_page, settings, api, accounts):
    """REQUIREMENTS 26-27: after the fix the citizen rates it (stars + text); the text is sentiment-analysed."""
    reporter = accounts.feedback_reporter
    token = unique_token()
    photo = sample_photo("pothole")
    latitude, longitude = jitter((17.4483, 78.3915), 1500)  # Hitech City; spread out: this complaint is kept (closed)
    complaint = api.create_complaint(
        reporter,
        description=f"Pothole on the service road, water collects in it and bikes skid. Automated e2e report {token}.",
        latitude=latitude,
        longitude=longitude,
        photo=photo,
        area="Hitech City",
    )
    officer_id = api.user(accounts.officer)["id"]
    if (complaint.get("assigned_officer") or {}).get("id") != officer_id:
        api.assign(accounts.admin, complaint, officer_id, f"E2E feedback flow {token}")
    resolved = api.resolve_as_officer(accounts.officer, complaint["id"], after=after_photo(photo), remarks="Pothole patched and levelled.")
    assert resolved["status"] in {"resolved", "verified"}, resolved["status"]
    pending = [item["complaint"]["id"] for item in api.get("feedback/pending/", account=reporter)]
    assert complaint["id"] in pending, "the resolved complaint is not among the citizen's feedback requests"

    page = open_page(reporter)
    page.goto("/citizen/feedback")
    request_card = page.locator(f"article#feedback-request-{complaint['id']}")
    expect(request_card).to_be_visible()
    expect(request_card).to_contain_text(complaint["complaint_number"])
    request_card.get_by_role("radio", name=re.compile(r"^5 stars")).click()
    request_card.get_by_label("Tell us more").fill("Road was repaired properly and quickly. Thank you!")
    with page.expect_response(api_response(settings.api_url, "POST", "feedback/")) as sent:
        request_card.get_by_role("button", name="Submit feedback").click()
    assert sent.value.status == 201, sent.value.text()
    feedback = sent.value.json()
    assert feedback["rating"] == 5
    assert feedback["sentiment"] == "positive", f"'Road was repaired properly and quickly.' scored {feedback['sentiment']}"
    expect_toast(page, "Feedback submitted")
    expect(request_card).to_be_hidden()

    page.goto(f"/citizen/complaints/{complaint['id']}")
    rated = card(page, "Your feedback")
    expect(rated).to_contain_text("Road was repaired properly and quickly.")
    expect(rated).to_contain_text("Positive")
    assert api.get(f"complaints/{complaint['id']}/", account=reporter)["status"] == "closed"
    assert_healthy(page)


LIFECYCLE_NOTIFICATIONS = ["complaint_submitted", "ai_analysis_completed", "department_assigned", "officer_assigned"]


@pytest.mark.mutates
@pytest.mark.ai
def test_new_complaint_notifications_follow_the_lifecycle_order(open_page, settings, api, accounts, fresh_citizen):
    """REQUIREMENTS 28 + 48: the citizen hears about a new complaint in lifecycle order - submitted, AI analysis
    completed, department assigned, officer assigned - and the notifications page (newest first) shows it so."""
    reporter = fresh_citizen
    token = unique_token()
    latitude, longitude = jitter((17.4239, 78.4738), 400)  # Himayatnagar
    complaint = api.create_complaint(
        reporter,
        description=f"Streetlight pole near the bus stop has been dark for three nights. Automated e2e report {token}.",
        latitude=latitude,
        longitude=longitude,
        photo=sample_photo("streetlight"),
        area="Himayatnagar",
    )
    try:
        assert complaint.get("assigned_officer"), "the new complaint was not assigned automatically"
        page = open_page(reporter)
        with page.expect_response(api_response(settings.api_url, "GET", "notifications/", params={"page_size": 20})) as listed:
            page.goto("/citizen/notifications")
        rows = [row for row in listed.value.json()["results"] if row.get("complaint") == complaint["id"]]
        types = [row["notification_type"] for row in rows if row["notification_type"] in LIFECYCLE_NOTIFICATIONS]
        assert sorted(types) == sorted(LIFECYCLE_NOTIFICATIONS), f"missing lifecycle notifications: {types}"

        # The page lists newest first, exactly as served ...
        items = page.locator("#main-content section[aria-label] > ul > li").filter(has_text=complaint["complaint_number"])
        expect(items).to_have_count(len(rows))
        displayed = [normalize(items.nth(i).locator("button").first.inner_text()).removeprefix("Unread: ") for i in range(len(rows))]
        assert displayed == [normalize(row["title"]) for row in rows]
        # ... so read from the bottom up it must tell the lifecycle in order.
        oldest_first = [row["notification_type"] for row in reversed(rows) if row["notification_type"] in LIFECYCLE_NOTIFICATIONS]
        assert oldest_first == LIFECYCLE_NOTIFICATIONS, (
            f"notifications of {complaint['complaint_number']} arrive out of lifecycle order (oldest first): {oldest_first}; "
            f"page shows (newest first): {displayed}"
        )
        assert_healthy(page)
    finally:
        if not settings.keep_data:
            api.withdraw_complaint(reporter, accounts.admin, complaint["id"], f"E2E test cleanup {token}")


@pytest.mark.mutates
@pytest.mark.ai
def test_second_report_of_the_same_issue_is_linked_as_a_duplicate(open_page, settings, api, accounts):
    """REQUIREMENTS 19: a second report of the same pothole at the same spot is flagged before and after submitting,
    linked to the original (nothing is deleted) and queued for an officer / administrator decision."""
    latitude, longitude = api.get("system/config/")["map"]["center"]  # the report map opens here: "Pin map centre"
    photo = sample_photo("pothole", 7)
    token = unique_token()
    original = api.create_complaint(
        accounts.original_reporter,
        description=f"Large pothole near the school entrance causing traffic problems. Automated e2e original {token}.",
        latitude=latitude,
        longitude=longitude,
        photo=photo,
        area="Abids",
    )
    second = None
    try:
        page = open_page(accounts.duplicate_reporter)
        page.goto("/citizen/report")
        heading = page.locator("#report-step-heading")
        with page.expect_file_chooser() as chooser:
            page.locator("#report-photo").click()
        chooser.value.set_files(str(photo))
        page.get_by_role("button", name="Continue", exact=True).click()
        expect(heading).to_have_text("Describe what is wrong")
        page.fill("#report-description", f"Big road pothole outside the school entrance, traffic is blocked around it. Automated e2e duplicate {token}.")
        page.get_by_role("button", name="Continue", exact=True).click()
        expect(heading).to_have_text("Mark where it is")
        with page.expect_response(api_response(settings.api_url, "GET", "geo/reverse/"), timeout=45_000):
            page.get_by_role("button", name="Pin map centre").click()
        with page.expect_response(api_response(settings.api_url, "POST", "ai/duplicates/"), timeout=90_000) as checked:
            page.get_by_role("button", name="Continue", exact=True).click()
        assert checked.value.status == 200, checked.value.text()
        assert original["id"] in [item["complaint"]["id"] for item in checked.value.json()], "the duplicate check missed the original"

        similar = page.locator("section[aria-labelledby='similar-reports-heading']")
        expect(similar).to_contain_text("Similar issue already reported nearby")
        expect(similar).to_contain_text(original["complaint_number"])

        with page.expect_response(api_response(settings.api_url, "POST", "complaints/"), timeout=settings.ai_timeout_ms) as submitted:
            page.get_by_role("button", name="Analyze & Submit").click()
        assert submitted.value.status == 201, submitted.value.text()
        second = submitted.value.json()
        found = second["analysis"]["summary"]["duplicates_found"]
        assert found >= 1, "the submitted report was not linked to the original"
        result = page.locator("section[aria-label='AI analysis result']")
        expect(result).to_contain_text(f"{found} possible duplicate")

        page.goto(f"/citizen/complaints/{second['id']}")
        duplicates_card = card(page, "Possible duplicates")
        expect(duplicates_card).to_contain_text(original["complaint_number"])

        pairs = results(api.get("duplicates/", account=accounts.admin, params={"complaint": second["id"], "page_size": 50}))
        pair = next((p for p in pairs if {p["complaint"]["id"], p["similar_complaint"]["id"]} == {second["id"], original["id"]}), None)
        assert pair, f"no duplicate pair {second['complaint_number']} -> {original['complaint_number']} for review"
        assert pair["status"] == "pending_review"
        assert api.get(f"complaints/{original['id']}/", account=accounts.admin)["id"] == original["id"]  # nothing deleted
        assert_healthy(page)
    finally:
        if not settings.keep_data:
            if second:
                api.withdraw_complaint(accounts.duplicate_reporter, accounts.admin, second["id"], f"E2E test cleanup {token}")
            api.withdraw_complaint(accounts.original_reporter, accounts.admin, original["id"], f"E2E test cleanup {token}")


@pytest.mark.mutates
@pytest.mark.ai
def test_report_wizard_validates_input_and_accepts_a_text_only_report(open_page, settings, api, accounts):
    """REQUIREMENTS 11: form validation on each step; a report without a photo is classified from its text alone and
    the result replays the real pipeline steps (image analysis skipped)."""
    reporter = accounts.text_reporter
    token = unique_token()
    created = None
    page = open_page(reporter)
    try:
        page.goto("/citizen/report")
        heading = page.locator("#report-step-heading")
        page.get_by_role("button", name="Continue without a photo").click()

        expect(heading).to_have_text("Describe what is wrong")
        page.fill("#report-description", "Pothole")
        page.get_by_role("button", name="Continue", exact=True).click()
        expect(page.get_by_text("Add a little more detail: at least 10 characters (7 so far).")).to_be_visible()
        expect(heading).to_have_text("Describe what is wrong")
        page.fill("#report-description", f"Garbage dumped on the footpath for days, it smells and blocks people walking. Automated e2e report {token}.")
        page.get_by_role("button", name="Continue", exact=True).click()

        expect(heading).to_have_text("Mark where it is")
        page.get_by_role("button", name="Continue", exact=True).click()
        expect(page.get_by_text("Place the pin on the map, search for a place or use your location.").first).to_be_visible()
        expect(heading).to_have_text("Mark where it is")
        map_box = page.locator(".leaflet-container").first
        size = map_box.bounding_box()
        with page.expect_response(api_response(settings.api_url, "GET", "geo/reverse/"), timeout=45_000):
            map_box.click(position={"x": size["width"] * random.uniform(0.25, 0.75), "y": size["height"] * random.uniform(0.25, 0.75)})
        page.get_by_role("button", name="Continue", exact=True).click()

        expect(heading).to_have_text("Check and submit")
        with page.expect_response(api_response(settings.api_url, "POST", "complaints/"), timeout=settings.ai_timeout_ms) as submitted:
            page.get_by_role("button", name="Analyze & Submit").click()
        assert submitted.value.status == 201, submitted.value.text()
        created = submitted.value.json()
        analysis = created["analysis"]
        assert analysis["summary"].get("category"), "a text-only report was not classified"
        assert next(step for step in analysis["steps"] if step["key"] == "image_analysis")["status"] == "skipped"

        steps = page.locator("ol[aria-label='AI analysis steps'] > li")
        expect(steps).to_have_count(len(analysis["steps"]))
        for index, step in enumerate(analysis["steps"]):
            row = steps.nth(index)
            expect(row).to_contain_text(step["label"])
            if step["status"] in {"skipped", "failed"}:
                expect(row).to_contain_text(step["status"].capitalize())
        expect(page.locator("section[aria-label='AI analysis result']")).to_contain_text(analysis["summary"]["category"]["name"])

        page.goto(f"/citizen/complaints/{created['id']}")
        expect(page.get_by_text("No photo was attached. The AI classified this report from the description.")).to_be_visible()
        assert_healthy(page)
    finally:
        if created and not settings.keep_data:
            api.withdraw_complaint(reporter, accounts.admin, created["id"], f"E2E test cleanup {token}")


@pytest.mark.mutates
def test_citizen_edits_the_profile_and_uploads_a_photo(open_page, settings, api, fresh_citizen):
    """REQUIREMENTS 5: view profile, edit profile, upload profile image (on a fresh qa.* citizen account)."""
    account = fresh_citizen
    page = open_page(account)
    page.goto("/citizen/profile")
    expect(page.locator("#profile-email")).to_have_value(account.email)
    page.fill("#profile-first-name", "Pavani")
    page.fill("#profile-phone", "9876501234")
    with page.expect_response(lambda r: r.request.method in {"PATCH", "PUT"} and r.url.rstrip("/").endswith("/auth/profile")) as saved:
        page.get_by_role("button", name="Save changes").click()
    assert saved.value.status == 200, saved.value.text()
    expect_toast(page, "Profile updated")
    profile = api.get("auth/profile/", account=account)
    assert (profile["first_name"], profile["phone"]) == ("Pavani", "9876501234")
    expect(page.get_by_role("button", name=re.compile(r"^Account menu, signed in as Pavani"))).to_be_visible()

    photo = sample_photo("other", 1)
    with page.expect_file_chooser() as chooser:
        page.get_by_role("button", name="Upload photo").click()
    chooser.value.set_files(str(photo))
    expect(page.get_by_text(f"New photo: {photo.name}")).to_be_visible()
    with page.expect_response(lambda r: r.request.method in {"PATCH", "PUT"} and r.url.rstrip("/").endswith("/auth/profile")) as uploaded:
        page.get_by_role("button", name="Save photo").click()
    assert uploaded.value.status == 200, uploaded.value.text()
    expect_toast(page, "Profile photo updated")
    avatar = api.get("auth/profile/", account=account)["avatar"]
    assert avatar, "the profile has no avatar after the upload"
    status, _ = api.status_of("GET", avatar, headers={"Accept": "image/*"})
    assert status == 200, f"the uploaded avatar is not served ({avatar} -> {status})"
    expect(page.locator(f"img[src='{avatar}']").first).to_be_visible()
    assert_healthy(page)
