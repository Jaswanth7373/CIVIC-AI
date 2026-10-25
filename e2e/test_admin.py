"""Administrator workspace: dashboard KPIs and charts from the database, complaint filters, reassignment with the
recommendation engine, AI configuration validation, report downloads, the hotspot map, the duplicate queue and
category management (REQUIREMENTS 2, 7, 17, 20, 21, 23, 29, 42)."""
from __future__ import annotations

import csv
import io
import re

import pytest
from playwright.sync_api import expect

from support.api import results
from support.data import Account, env, jitter, sample_photo, unique_token
from support.ui import api_response, assert_healthy, card, expect_toast, format_hours, normalize, parse_int

CONFIG_READ_ONLY = {"id", "updated_by", "updated_at"}


def officer_password() -> str:
    """Password of the seeded officer accounts (all share it in the demo data)."""
    return env("E2E_OFFICER_PASSWORD", "Officer@12345")


def kpi(page, label: str):
    """Value text of one cell of the dashboard's key-figure strip."""
    cell = page.locator("ul[aria-label='Complaint key figures'] > li").filter(has=page.get_by_text(label, exact=True))
    expect(cell).to_have_count(1)
    value = cell.locator("span.font-display")
    expect(value).to_be_visible()
    return normalize(value.inner_text())


def summary_count(page) -> int | None:
    """The number in the list summary line ("162 complaints sorted by newest first")."""
    # The count and the noun are flex items: their text content has no space after the noun ("166 complaintssorted").
    line = page.locator("#main-content p[aria-live='polite']").filter(has_text=re.compile(r"\d\s*(complaint|pair)s?")).first
    expect(line).to_be_visible()
    return parse_int(line.locator("span.font-semibold").first.inner_text())


def test_dashboard_kpis_equal_overview_totals(admin_page, settings, api, accounts):
    page = admin_page
    before = api.get("analytics/overview/", account=accounts.admin)
    with page.expect_response(api_response(settings.api_url, "GET", "analytics/overview/")) as call:
        page.goto("/admin/dashboard")
    assert call.value.status == 200, call.value.text()
    served = call.value.json()
    after = api.get("analytics/overview/", account=accounts.admin)
    if before["totals"] == after["totals"]:  # nothing changed meanwhile: the page must show exactly the API totals
        assert served["totals"] == before["totals"]

    totals = served["totals"]
    for label, key in [("Total complaints", "total"), ("Pending", "pending"), ("In progress", "in_progress"),
                       ("Resolved", "resolved"), ("Critical", "critical")]:
        assert parse_int(kpi(page, label)) == totals[key], f"KPI '{label}'"
    expected_hours = format_hours(served["avg_resolution_hours"]) if served.get("avg_resolution_hours") else "—"
    assert kpi(page, "Average resolution time") == expected_hours
    expected_rating = f"{served['avg_rating']:.1f}" if served.get("avg_rating") else "—"
    assert kpi(page, "Average rating") == expected_rating
    assert_healthy(page)


def test_all_complaints_filters_change_the_result_count(admin_page, settings, api, accounts):
    page = admin_page
    with page.expect_response(api_response(settings.api_url, "GET", "complaints/", params={"page_size": 20})) as first:
        page.goto("/admin/complaints")
    total = first.value.json()["count"]
    expect(page.locator("#main-content table tbody tr").first).to_be_visible()
    assert summary_count(page) == total

    with page.expect_response(api_response(settings.api_url, "GET", "complaints/", params={"priority_level": "critical", "page_size": 20})) as critical:
        page.get_by_label("Priority", exact=True).select_option("critical")
    critical_data = critical.value.json()
    assert critical_data["count"] < total, "the priority filter did not narrow the list"
    assert all(row["priority_level"] == "critical" for row in critical_data["results"])
    expect(page).to_have_url(re.compile(r"priority_level=critical"))
    expect(page.locator("#main-content p[aria-live='polite']").first).to_contain_text(str(critical_data["count"]))
    assert summary_count(page) == critical_data["count"]
    assert api.get("complaints/", account=accounts.admin, params={"priority_level": "critical", "page_size": 1})["count"] == critical_data["count"]

    # Clearing the filter restores the full list; another filter narrows it again. (One change at a time, like a
    # person: two changes inside ~100 ms hit the race covered by test_quick_successive_filter_changes_are_all_kept.)
    with page.expect_response(api_response(settings.api_url, "GET", "complaints/", params={"page_size": 20}, absent=("priority_level",))):
        page.get_by_label("Priority", exact=True).select_option("")
    expect(page).not_to_have_url(re.compile(r"priority_level="))
    with page.expect_response(
        api_response(settings.api_url, "GET", "complaints/", params={"category": "pothole", "page_size": 20}, absent=("priority_level",))
    ) as potholes:
        page.get_by_label("Category", exact=True).select_option("pothole")
    pothole_count = potholes.value.json()["count"]
    assert 0 < pothole_count < total
    expect(page).to_have_url(re.compile(r"category=pothole"))
    assert summary_count(page) == pothole_count
    assert api.get("complaints/", account=accounts.admin, params={"category": "pothole", "page_size": 1})["count"] == pothole_count
    assert_healthy(page)


# Two filter changes before React re-renders: a fast keyboard user, or the debounced search box firing right after a
# select change. Both change events are dispatched in one task, which makes the timing deterministic.
QUICK_CHANGES_JS = """() => {
  const choose = (label, value) => {
    const select = document.querySelector(`#main-content select[aria-label="${label}"]`)
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  }
  choose('Priority', '')
  choose('Category', 'pothole')
}"""


def test_quick_successive_filter_changes_are_all_kept(admin_page):
    """Clearing the priority filter and choosing a category right after it must keep both changes."""
    page = admin_page
    page.goto("/admin/complaints?priority_level=critical")
    priority, category = page.get_by_label("Priority", exact=True), page.get_by_label("Category", exact=True)
    expect(priority).to_have_value("critical")
    expect(category.locator("option[value='pothole']")).to_be_attached()  # categories loaded: both selects exist
    expect(page.locator("#main-content table tbody tr").first).to_be_visible()
    page.evaluate(QUICK_CHANGES_JS)
    expect(page).to_have_url(re.compile(r"category=pothole"))
    page.wait_for_timeout(1000)  # let every pending navigation settle before judging the final state
    assert "priority_level=critical" not in page.url, f"the cleared priority filter came back: {page.url}"
    expect(priority).to_have_value("")
    assert_healthy(page)


@pytest.mark.mutates
@pytest.mark.ai
def test_reassign_complaint_to_a_recommended_officer(open_page, settings, api, accounts):
    token = unique_token()
    latitude, longitude = jitter((17.4401, 78.4983), 600)  # Secunderabad
    complaint = api.create_complaint(
        accounts.reassign_reporter,
        description=f"Garbage dumped beside the road for a week, bins overflowing and smelling. Automated e2e report {token}.",
        latitude=latitude,
        longitude=longitude,
        photo=sample_photo("garbage"),
        area="Secunderabad",
    )
    complaint_id = complaint["id"]
    try:
        current = (complaint.get("assigned_officer") or {}).get("id")
        page = open_page(accounts.admin)
        page.goto(f"/admin/complaints/{complaint_id}")
        expect(page.locator("#main-content")).to_contain_text(complaint["complaint_number"])

        action = "Reassign officer" if current else "Assign officer"
        with page.expect_response(api_response(settings.api_url, "GET", "assignments/recommend/")) as recommended:
            page.get_by_role("button", name=action, exact=True).click()
        drawer = page.get_by_role("dialog", name=action)
        expect(drawer).to_be_visible()
        candidates = recommended.value.json()
        assert candidates, "the recommendation engine returned no officers"
        assert any(candidate.get("recommended") for candidate in candidates), "no candidate is marked recommended"
        choice = next((c for c in candidates if c["officer"]["id"] != current), None)
        assert choice, "no recommended officer other than the current one"
        name = choice["officer"]["full_name"]
        drawer.locator(f"#candidate-{choice['officer']['id']}").check()

        verb = "Reassign to" if current else "Assign to"
        with page.expect_response(lambda r: r.request.method in {"PATCH", "PUT", "POST"} and "/assignments/" in r.url) as saved:
            drawer.get_by_role("button", name=f"{verb} {name}").click()
        assert saved.value.status in {200, 201}, saved.value.text()
        expect_toast(page, "Officer reassigned" if current else "Officer assigned")
        expect(drawer).to_be_hidden()
        section = page.locator("section").filter(has=page.get_by_role("heading", name="Assigned officer", exact=True)).last
        expect(section).to_contain_text(name)

        stored = api.get(f"complaints/{complaint_id}/", account=accounts.admin)
        assert stored["assigned_officer"]["id"] == choice["officer"]["id"]
        timeline = [event["event"] for event in stored["timeline"]]
        assert ("reassigned" if current else "officer_assigned") in timeline, f"no assignment event on the timeline: {timeline}"

        # REQUIREMENTS 28: the new officer gets the work order, the previous one hears about the reassignment.
        admin_view = {row["user"]["id"]: row["user"]["email"] for row in results(api.get("officers/", account=accounts.admin, params={"page_size": 100}))}
        new_officer = Account(admin_view[choice["officer"]["id"]], officer_password(), "officer")
        assert {"new_assignment", "reassignment"} & set(api.notification_types(new_officer, complaint_id)), "the new officer was not notified"
        if current:
            previous = Account(admin_view[current], officer_password(), "officer")
            assert "reassignment" in api.notification_types(previous, complaint_id), "the previous officer was not told"
        assert "officer_assigned" in api.notification_types(accounts.reassign_reporter, complaint_id)
        assert_healthy(page)
    finally:
        if not settings.keep_data:
            api.withdraw_complaint(accounts.reassign_reporter, accounts.admin, complaint_id, f"E2E test cleanup {token}")


@pytest.mark.mutates
def test_ai_settings_reject_bad_weights_and_save_a_valid_change(admin_page, settings, api, accounts):
    original = api.get("ai/config/", account=accounts.admin)
    editable = {key: value for key, value in original.items() if key not in CONFIG_READ_ONLY}
    severity, impact = float(original["weight_severity"]), float(original["weight_public_impact"])
    page = admin_page
    try:
        # The API refuses weights that do not add up to 100.
        status, body = api.status_of("PATCH", "ai/config/", account=accounts.admin, body={"weight_severity": severity + 1})
        assert status == 400, f"PATCH /ai/config/ with weights adding up to 101 answered {status}: {body}"

        page.goto("/admin/settings")
        severity_input = page.locator("#ai-weight_severity")
        expect(severity_input).to_have_value(re.compile(rf"^{severity:g}(\.0)?$"))
        save = page.get_by_role("button", name="Save", exact=True)

        severity_input.fill(f"{severity + 1:g}")
        expect(page.get_by_text(re.compile(r"The five weights must add up to 100; they add up to 101"))).to_be_visible()
        expect(save).to_be_disabled()

        page.locator("#ai-weight_public_impact").fill(f"{impact - 1:g}")
        expect(page.get_by_text(re.compile(r"The five weights must add up to 100"))).to_have_count(0)
        expect(save).to_be_enabled()
        with page.expect_response(api_response(settings.api_url, "PUT", "ai/config/")) as saved:
            save.click()
        assert saved.value.status == 200, saved.value.text()
        expect_toast(page, "AI settings saved")
        stored = api.get("ai/config/", account=accounts.admin)
        assert (float(stored["weight_severity"]), float(stored["weight_public_impact"])) == (severity + 1, impact - 1)
        for key, value in editable.items():  # the UI save must not alter anything else
            if key not in {"weight_severity", "weight_public_impact"}:
                assert stored[key] == value, f"saving the weights changed {key}: {value!r} -> {stored[key]!r}"
        assert_healthy(page)
    finally:
        api.patch("ai/config/", account=accounts.admin, body=editable)
        restored = api.get("ai/config/", account=accounts.admin)
        assert {key: restored[key] for key in editable} == editable, "the original AI configuration was not restored"


def test_reports_download_as_csv_and_pdf(admin_page, settings, tmp_path):
    page = admin_page
    with page.expect_response(api_response(settings.api_url, "GET", "analytics/reports/", params={"format": "json"})) as preview:
        page.goto("/admin/reports")
    assert preview.value.status == 200, preview.value.text()
    report = preview.value.json()
    labels = [column["label"] for column in report["columns"]]

    with page.expect_download() as csv_download:
        page.get_by_role("button", name="Download CSV").click()
    csv_file = csv_download.value
    assert csv_file.suggested_filename.lower().endswith(".csv"), csv_file.suggested_filename
    csv_path = tmp_path / csv_file.suggested_filename
    csv_file.save_as(csv_path)
    rows = list(csv.reader(io.StringIO(csv_path.read_text(encoding="utf-8-sig"))))
    assert rows and rows[0] == labels, f"CSV header {rows[:1]} differs from the report columns {labels}"
    assert len(rows) - 1 == report.get("total_rows", len(report["rows"])), "CSV row count differs from the report"
    expect_toast(page, "Report downloaded")

    with page.expect_download() as pdf_download:
        page.get_by_role("button", name="Download PDF").click()
    pdf_file = pdf_download.value
    assert pdf_file.suggested_filename.lower().endswith(".pdf"), pdf_file.suggested_filename
    pdf_path = tmp_path / pdf_file.suggested_filename
    pdf_file.save_as(pdf_path)
    content = pdf_path.read_bytes()
    assert content.startswith(b"%PDF") and len(content) > 1000, "the PDF download is not a PDF document"
    assert_healthy(page)


def test_hotspot_map_renders_the_dbscan_clusters(admin_page, settings):
    page = admin_page
    with page.expect_response(api_response(settings.api_url, "GET", "analytics/hotspots/")) as call:
        page.goto("/admin/hotspots")
    assert call.value.status == 200, call.value.text()
    clusters = [c for c in call.value.json()["clusters"] if c.get("latitude") is not None and c.get("longitude") is not None]
    assert clusters, "GET /analytics/hotspots/ found no clusters in the seeded data"

    markers = page.locator(".leaflet-container .civic-map-hotspot")
    expect(markers).to_have_count(len(clusters))
    titles = [markers.nth(index).get_attribute("title") or "" for index in range(len(clusters))]
    shown = sorted(parse_int(re.search(r":\s*([\d,]+) complaints", title).group(1)) for title in titles if re.search(r":\s*[\d,]+ complaints", title))
    assert shown == sorted(int(c["count"]) for c in clusters), f"marker counts {shown} differ from the clusters"
    circles = page.locator(".leaflet-container path.leaflet-interactive")
    assert circles.count() >= len(clusters), "hotspot circles are missing"

    # Open a hotspot's statistics popup from the keyboard (the badges are focusable map markers).
    largest = max(clusters, key=lambda c: int(c["count"]))
    badge = markers.filter(has_text=re.compile(rf"^{largest['count']}$")).first
    badge.focus()
    page.keyboard.press("Enter")
    popup = page.locator(".leaflet-popup-content")
    expect(popup).to_be_visible()
    expect(popup).to_contain_text("Complaints")
    expect(popup).to_contain_text(str(largest["count"]))
    assert_healthy(page)


# Centre of every hotspot badge inside the visible map, and what the pointer would hit there.
COVERED_BADGES_JS = """() => {
  const map = document.querySelector('.leaflet-container').getBoundingClientRect()
  return [...document.querySelectorAll('.leaflet-container .civic-map-hotspot')].flatMap((badge) => {
    const box = badge.getBoundingClientRect()
    const x = box.left + box.width / 2, y = box.top + box.height / 2
    if (x < map.left || x > map.right || y < map.top || y > map.bottom) return []
    const hit = document.elementFromPoint(x, y)
    if (hit && badge.contains(hit)) return []
    const owner = hit && hit.closest('.leaflet-marker-icon')
    return [`${badge.title} -> covered by ${owner ? owner.className.split(' ').find((name) => name.startsWith('civic-map')) + ' "' + owner.textContent.trim() + '"' : hit && hit.tagName}`]
  })
}"""


def test_hotspot_badges_are_not_hidden_under_complaint_pins(admin_page, settings):
    """The map opens with the hotspots only; with the complaint pins switched on (grouped by default), every
    hotspot's count badge must stay clickable."""
    page = admin_page
    with page.expect_response(api_response(settings.api_url, "GET", "analytics/hotspots/")) as call:
        page.goto("/admin/hotspots")
    clusters = [c for c in call.value.json()["clusters"] if c.get("latitude") is not None]
    expect(page.locator(".leaflet-container .civic-map-hotspot")).to_have_count(len(clusters))
    pins = page.get_by_role("switch", name="Complaint pins")
    expect(pins).not_to_be_checked()
    expect(page.locator(".leaflet-container .civic-map-cluster").first).to_be_hidden()
    pins.focus()
    page.keyboard.press("Space")
    expect(pins).to_be_checked()
    expect(page.locator(".leaflet-container .civic-map-cluster").first).to_be_visible()
    covered = page.evaluate(COVERED_BADGES_JS)
    assert not covered, "hotspot badges hidden under complaint pins (the pointer hits the pin instead): " + "; ".join(covered)


def test_duplicates_page_lists_the_pending_pairs(admin_page, settings, api, accounts):
    page = admin_page
    with page.expect_response(api_response(settings.api_url, "GET", "duplicates/", params={"status": "pending_review", "page_size": 10})) as call:
        page.goto("/admin/duplicates")
    assert call.value.status == 200, call.value.text()
    data = call.value.json()
    assert data["count"] > 0, "no pending duplicate pairs to review"
    assert api.get("duplicates/", account=accounts.admin, params={"status": "pending_review", "page_size": 1})["count"] == data["count"]

    assert summary_count(page) == data["count"]
    newer = page.locator("#main-content article[aria-label^='Newer report: ']")
    expect(newer).to_have_count(len(data["results"]))
    shown = [normalize(label).split(": ", 1)[1] for label in newer.evaluate_all("els => els.map(e => e.getAttribute('aria-label'))")]
    assert shown == [pair["complaint"]["complaint_number"] for pair in data["results"]]
    originals = page.locator("#main-content article[aria-label^='Earlier report (original): ']")
    expect(originals).to_have_count(len(data["results"]))
    expect(page.get_by_role("tab", name=re.compile(r"Pending review"))).to_contain_text(str(data["count"]))
    expect(page.get_by_role("button", name="Confirm duplicate").first).to_be_visible()
    assert_healthy(page)


def chart_rows(page, title: str) -> dict[str, int]:
    """Switch a dashboard chart to its table twin and read `{label: value}` from it."""
    panel = card(page, title)
    expect(panel).to_be_visible()
    panel.get_by_role("button", name="Table", exact=True).click()
    table = panel.locator("div:not(.sr-only) > table").first
    expect(table).to_be_visible()
    rows = {}
    for row in table.locator("tbody tr").all():
        cells = [normalize(text) for text in row.locator("th, td").all_inner_texts()]
        rows[cells[0]] = parse_int(cells[1])
    return rows


def test_dashboard_charts_show_the_database_numbers(admin_page, settings):
    """REQUIREMENTS 29 / 49: the dashboard charts are drawn from the analytics API (checked through their table view)."""
    page = admin_page
    with page.expect_response(api_response(settings.api_url, "GET", "analytics/overview/")) as overview, page.expect_response(
        api_response(settings.api_url, "GET", "analytics/categories/")
    ) as categories:
        page.goto("/admin/dashboard")
    by_category = {row["category"]["name"]: row["total"] for row in categories.value.json()}
    shown = chart_rows(page, "Complaints by category")
    assert {name: value for name, value in shown.items() if value} == {name: total for name, total in by_category.items() if total}

    severity = {row["label"]: row["count"] for row in overview.value.json()["severity_distribution"]}
    shown = chart_rows(page, "Severity distribution")
    assert {name: value for name, value in shown.items() if value} == {name: count for name, count in severity.items() if count}
    assert_healthy(page)


@pytest.mark.mutates
def test_admin_adds_a_category_that_citizens_can_report(open_page, settings, api, accounts):
    """REQUIREMENTS 2 / 7 / 20: a civic category added in the admin panel is routed to its department and offered in
    the citizen's report form at once, without changing the application. The test removes it again."""
    token = unique_token()
    name = f"E2E broken bench {token}"
    department = next(row for row in api.get("departments/") if row["code"] == "PARKS")
    created_id = None
    try:
        page = open_page(accounts.admin)
        page.goto("/admin/departments?tab=categories")
        page.get_by_role("button", name="Add category").first.click()
        dialog = page.get_by_role("dialog", name="Add category")
        expect(dialog).to_be_visible()
        dialog.locator("#category-name").fill(name)
        dialog.locator("#category-department").select_option(str(department["id"]))
        with page.expect_response(api_response(settings.api_url, "POST", "categories/")) as saved:
            dialog.get_by_role("button", name="Add category").click()
        assert saved.value.status == 201, saved.value.text()
        created_id = saved.value.json()["id"]
        expect_toast(page, "Category created")
        expect(page.locator("#main-content")).to_contain_text(name)

        routing = api.get("departments/routing/", account=accounts.admin)
        route = next((row for row in routing if row["category"]["id"] == created_id), None)
        assert route and route["department"]["id"] == department["id"], f"the new category is not routed to {department['name']}"

        citizen = open_page(accounts.citizen)  # only opens the form, files nothing
        citizen.goto("/citizen/report")
        citizen.get_by_role("button", name="Continue without a photo").click()
        expect(citizen.locator("#report-category option", has_text=name)).to_be_attached()
        assert_healthy(page)
        assert_healthy(citizen)
    finally:
        if created_id is not None:
            api.delete(f"categories/{created_id}/", account=accounts.admin, expected=(200, 204))
            remaining = api.get("categories/", account=accounts.admin, params={"include_inactive": "true"})
            assert all(row["id"] != created_id or not row.get("is_active", True) for row in remaining), "the test category was not removed"
