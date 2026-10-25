"""Public site: the landing page (hero copy, live AI demo, required sections, "Try your own photo"), the contact
form, citizen registration, login with every demo account, logout, the role guards and the dark theme
(REQUIREMENTS 5, 8, 9, 10, 45, 46)."""
from __future__ import annotations

import re

import pytest
from playwright.sync_api import expect

from support.api import results
from support.data import Account, unique_email, unique_token
from support.ui import api_response, assert_healthy, expect_toast, normalize

HERO_TITLE = "CivicAI"
HERO_TAGLINE = "AI-Powered Civic Issue Management"
HERO_SUBTITLE = (
    "Report civic issues using image, text and location. CivicAI uses artificial intelligence to identify, "
    "prioritize and route complaints for efficient resolution."
)
LANDING_SECTIONS = [
    "How CivicAI Works",
    "AI Issue Detection",
    "Multimodal AI",
    "Smart Prioritization",
    "Duplicate Detection",
    "Automatic Department Routing",
    "Resolution Verification",
    "Citizen Feedback",
    "Smart City Analytics",
]


def test_landing_hero_copy_and_live_ai_demo(anon_page, settings, api):
    page = anon_page
    with page.expect_response(api_response(settings.api_url, "POST", "ai/demo/"), timeout=90_000) as demo_call:
        page.goto("/")

    section = page.locator("section[aria-labelledby='hero-title']")
    hero = page.locator("#hero-title")
    expect(hero).to_be_visible()
    lines = [normalize(text) for text in hero.locator("span").all_inner_texts() if normalize(text)]
    assert lines[:2] == [HERO_TITLE, HERO_TAGLINE], f"hero headline is {lines!r}"
    subtitle = section.locator("p").first
    assert normalize(subtitle.inner_text()) == HERO_SUBTITLE

    report = section.get_by_role("link", name="Report an Issue", exact=True)
    explore = section.get_by_role("link", name="Explore Dashboard", exact=True)
    expect(report).to_be_visible()
    expect(explore).to_be_visible()
    assert report.get_attribute("href") == "/citizen/report"
    assert explore.get_attribute("href") == "/login"

    # The live demo really ran on the engine and its answer is what the work order shows.
    response = demo_call.value
    assert response.status == 200, response.text()
    result = response.json()
    assert result.get("disclaimer"), "demo answer carries no disclaimer"
    assert result.get("category"), f"demo answer has no category: {result}"
    card = page.locator("article[aria-labelledby='hero-demo-title']")
    expect(card.get_by_text(re.compile(r"^Analysed in [\d,]+ ms$"))).to_be_visible()
    expect(card).to_contain_text(result["category"]["name"])
    level = (result.get("severity_hint") or {}).get("level")
    if level:
        expect(card).to_contain_text(level.capitalize())
    category = next((row for row in api.get("categories/") if row["id"] == result["category"]["id"]), None)
    if category and category.get("department_detail"):
        expect(card).to_contain_text(category["department_detail"]["name"])
    if result.get("is_demo"):
        expect(card.get_by_text("Demo AI Mode").first).to_be_visible()

    for title in LANDING_SECTIONS:
        expect(page.get_by_role("heading", name=title, exact=True).first, f"landing section '{title}'").to_be_attached()
    assert_healthy(page)


@pytest.mark.mutates
def test_contact_form_submits(anon_page, settings, api, accounts):
    page = anon_page
    token = unique_token()
    subject = f"E2E contact form check {token}"
    page.goto("/contact")
    page.fill("#contact-name", "E2E Tester")
    page.fill("#contact-email", "qa.e2e.contact@example.com")
    page.fill("#contact-subject", subject)
    page.fill("#contact-message", "Automated end-to-end check of the public contact form. Please ignore this message.")
    with page.expect_response(api_response(settings.api_url, "POST", "contact/")) as sent:
        page.get_by_role("button", name="Send message").click()
    assert sent.value.status == 201, sent.value.text()
    expect(page.get_by_role("heading", name="Message sent")).to_be_visible()
    expect_toast(page, "Message sent")

    rows = [row for row in results(api.get("contact/", account=accounts.admin, params={"search": token})) if row["subject"] == subject]
    assert len(rows) == 1, "the message did not reach the admin inbox (GET /contact/)"
    if not settings.keep_data:
        api.patch(f"contact/{rows[0]['id']}/", account=accounts.admin, body={"is_resolved": True})
    assert_healthy(page)


@pytest.mark.mutates
def test_register_new_citizen_lands_on_citizen_dashboard(anon_page, settings, api, accounts):
    page = anon_page
    email = unique_email("register")
    password = "Ward-Report-2026!"
    page.goto("/register")
    page.fill("#register-first-name", "Esha")
    page.fill("#register-last-name", "Tester")
    page.fill("#register-email", email)
    page.fill("#register-phone", "+91 98765 43210")
    page.fill("#register-password", password)
    page.fill("#register-confirm-password", password)
    page.check("#register-terms")
    with page.expect_response(api_response(settings.api_url, "POST", "auth/register/")) as registered:
        page.get_by_role("button", name="Create account").click()
    assert registered.value.status == 201, registered.value.text()

    page.wait_for_url(re.compile(r"/citizen/dashboard$"))
    expect(page.get_by_role("heading", level=1)).to_contain_text("Esha")
    expect_toast(page, "Account created")
    expect(page.locator("section[aria-label='Complaint counts']")).to_be_visible()

    session = api.login(Account(email, password, "citizen"), fresh=True, cache=False)
    assert session["user"]["role"] == "citizen"
    assert_healthy(page)
    if not settings.keep_data:  # throw-away account: deactivate it (soft delete)
        api.delete(f"users/{session['user']['id']}/", account=accounts.admin)


@pytest.mark.parametrize("role", ["citizen", "officer", "admin"])
def test_demo_account_login_lands_on_role_dashboard(anon_page, settings, accounts, role):
    account = getattr(accounts, role)
    page = anon_page
    page.goto("/login")
    page.fill("#login-email", account.email)
    page.fill("#login-password", account.password)
    with page.expect_response(api_response(settings.api_url, "POST", "auth/login/")) as logged_in:
        page.get_by_role("button", name="Log in", exact=True).click()
    assert logged_in.value.status == 200, logged_in.value.text()
    page.wait_for_url(re.compile(rf"{re.escape(account.dashboard_path)}$"))
    expect(page.get_by_role("heading", level=1)).to_be_visible()
    stored = page.evaluate("() => [localStorage.getItem('civicai.access'), localStorage.getItem('civicai.refresh')]")
    assert all(stored), "the JWT pair was not stored after login"

    # Back on the landing page the hero leads a signed-in user to their own dashboard; only citizens report issues.
    page.goto("/")
    hero = page.locator("section[aria-labelledby='hero-title']")
    expect(hero.get_by_role("link", name="Explore Dashboard")).to_have_attribute("href", account.dashboard_path)
    expect(hero.get_by_role("link", name="Report an Issue")).to_have_count(1 if role == "citizen" else 0)
    assert_healthy(page)


def test_citizen_opening_admin_dashboard_is_sent_to_unauthorized(citizen_page):
    page = citizen_page
    page.goto("/admin/dashboard")
    page.wait_for_url(re.compile(r"/unauthorized$"))
    expect(page.get_by_role("heading", name="You don't have access to this page")).to_be_visible()
    assert_healthy(page)


def test_guest_opening_citizen_page_is_sent_to_login(anon_page):
    page = anon_page
    page.goto("/citizen/complaints")
    page.wait_for_url(re.compile(r"/login\?next=%2Fcitizen%2Fcomplaints$"))
    expect(page.get_by_role("heading", name="Log in to CivicAI")).to_be_visible()
    assert_healthy(page)


def test_logout_ends_the_session(open_page, settings, api, accounts):
    """REQUIREMENTS 5 / 45: logging out clears the tokens, blacklists the refresh token and locks the dashboard."""
    page = open_page(accounts.citizen, fresh_session=True)
    session = page._e2e_session
    page.goto("/citizen/dashboard")
    page.get_by_role("button", name=re.compile(r"^Account menu")).click()
    with page.expect_response(api_response(settings.api_url, "POST", "auth/logout/")) as logged_out:
        page.get_by_role("menuitem", name="Log out").click()
    assert logged_out.value.status == 200, logged_out.value.text()
    page.wait_for_url(re.compile(r"/login$"))
    expect_toast(page, "Logged out")
    stored = page.evaluate("() => [localStorage.getItem('civicai.access'), localStorage.getItem('civicai.refresh')]")
    assert stored == [None, None], "tokens are still stored after logging out"

    page.goto("/citizen/dashboard")
    page.wait_for_url(re.compile(r"/login\?next=%2Fcitizen%2Fdashboard$"))
    status, _ = api.status_of("POST", "auth/refresh/", body={"refresh": session["refresh"]})
    assert status == 401, f"the refresh token still works after logout (POST /auth/refresh/ -> {status})"
    assert_healthy(page)


def test_dark_theme_is_applied_and_remembered(citizen_page):
    """REQUIREMENTS 9: light and dark mode; the choice survives a reload."""
    page = citizen_page
    page.goto("/citizen/dashboard")
    light_background = page.evaluate("() => getComputedStyle(document.body).backgroundColor")
    page.get_by_role("button", name=re.compile(r"^Theme: ")).click()
    page.get_by_role("menuitemradio", name="Dark").click()
    expect(page.locator("html")).to_have_class(re.compile(r"\bdark\b"))
    dark_background = page.evaluate("() => getComputedStyle(document.body).backgroundColor")
    assert dark_background != light_background, "the page background did not change in dark mode"
    page.reload()
    expect(page.locator("html")).to_have_class(re.compile(r"\bdark\b"))
    assert page.evaluate("() => localStorage.getItem('civicai.theme')") == "dark"
    assert_healthy(page)


def test_try_your_own_photo_runs_the_public_ai_demo(anon_page, settings):
    """The landing page's "Try your own photo": a visitor sends a sample photo + description to POST /api/ai/demo/
    and sees the engine's answer with its disclaimer; nothing is stored and no account is needed."""
    page = anon_page
    page.goto("/")
    hero_card = page.locator("article[aria-labelledby='hero-demo-title']")
    expect(hero_card.get_by_text(re.compile(r"^Analysed in [\d,]+ ms$"))).to_be_visible(timeout=90_000)  # hero demo done

    hero_card.get_by_role("button", name="Try your own photo").click()
    dialog = page.get_by_role("dialog", name="Try the AI on your own photo")
    expect(dialog).to_be_visible()
    dialog.get_by_role("button", name="Analyze with AI").click()
    expect(dialog.get_by_text("Nothing to analyse yet")).to_be_visible()

    sample = dialog.get_by_role("button", name="Garbage dump")
    sample.click()
    expect(sample).to_have_attribute("aria-pressed", "true")
    dialog.get_by_label("Description").fill("Garbage has been dumped next to the bus stop for a week and it smells.")
    with page.expect_response(api_response(settings.api_url, "POST", "ai/demo/"), timeout=90_000) as analysed:
        dialog.get_by_role("button", name="Analyze with AI").click()
    assert analysed.value.status == 200, analysed.value.text()
    result = analysed.value.json()
    found = page.get_by_role("dialog", name="What the AI found")
    expect(found).to_be_visible()
    if result.get("category"):
        expect(found).to_contain_text(result["category"]["name"])
    expect(found).to_contain_text(result["disclaimer"])
    assert_healthy(page)
