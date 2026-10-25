# Requirements traceability

This document maps every numbered section and bullet of [REQUIREMENTS.md](REQUIREMENTS.md), the student's original
specification, to its status and to where it lives: the backend module or endpoint, the frontend page or component,
and the tests that cover it.

**How it was checked (18 October 2026).** Every row was checked against the code. The backend test suite was run for
this document (`manage.py test` on in-memory SQLite: 706 tests, all passed; 707 after a regression test was added
later that day). Read-only checks were made against the
running demo system (MySQL 8.0.42, database `civicai`, `MODEL_MODE=demo`), for example the AI settings, the hotspot
clusters and the notification types in the demo data. The phase-4 compliance audits were the starting point; every
problem they reported was re-checked against the current code, and the statuses below describe the code as it is now
(see [Problems found by the phase-4 audits](#problems-found-by-the-phase-4-audits)). Test runs on MySQL and the
browser test results are documented in [TESTING.md](TESTING.md).

**Status values**

| Status | Meaning |
|---|---|
| Implemented | Works end to end through the API and the web app, and is covered by tests or verified on the running system |
| Partially | Works, but part of the bullet is missing or depends on a step outside the code (noted in the row) |
| Not implemented | Missing |

**Where to look**: backend paths are relative to `backend/`, frontend paths to `frontend/src/`. Test ids are written
`file::Class::method`; backend test files are under `backend/` (`apps/.../tests.py`, `apps/.../test_*.py`,
`ai/tests/test_*.py`), browser tests under `e2e/`. "SPA" means the React single-page app.

## Summary

| Area | Rows | Implemented | Partially | Not implemented |
|---|---|---|---|---|
| 1. Objective and lifecycle | 16 | 16 | 0 | 0 |
| 2. Categories | 2 | 2 | 0 | 0 |
| 3. Technology stack | 8 | 5 | 3 | 0 |
| 4. Real, integrated, runnable | 3 | 3 | 0 | 0 |
| 5-7. Roles | 34 | 34 | 0 | 0 |
| 8. Frontend pages | 31 | 31 | 0 | 0 |
| 9-11. UI, landing page, submission | 14 | 14 | 0 | 0 |
| 12-19. AI engines | 28 | 27 | 1 | 0 |
| 20-31. Routing to dashboards | 38 | 38 | 0 | 0 |
| 32-49. Data, API, security, structure, pages | 38 | 38 | 0 | 0 |
| **Total** | **212** | **208** | **4** | **0** |

The four partial rows are the YOLO detector (no trained weights are shipped; rows 3.5 and 12.2), the Git / GitHub
workflow (the repository has no commits or remote yet; row 3.7) and the cloud deployment (configuration is complete,
but a live deployment was not verified; row 3.8). They are explained in [Known gaps](#known-gaps-and-partial-items).

---

## 1. Project objective and lifecycle

| # | Requirement | Status | Backend | Frontend | Tests |
|---|---|---|---|---|---|
| 1.0 | Citizens report with image, text description and GPS / location | Implemented | `POST /api/complaints/` (`apps/complaints/views.py`, `apps/complaints/services/submission.py`) | `pages/citizen/SubmitComplaint.jsx`, `pages/citizen/components/report/` | `apps/complaints/test_services.py::SubmissionTests::test_full_submission_flow`; `e2e/test_citizen.py::test_submit_complaint_through_the_ui_then_track_it` |
| 1.1 | Identify the civic issue | Implemented | `ai/vision/inference.py` (`analyze_image`), `ai/nlp/__init__.py` (`analyze_text`) | `components/ai/AIAnalysisPanel.jsx`, `components/ai/ImageWithBoxes.jsx` | `ai/tests/test_vision.py::VisionContractTests`, `ai/tests/test_nlp.py::AnalyzeTextTests` |
| 1.2 | Classify the issue | Implemented | `ai/multimodal/fusion.py` (confidence-weighted late fusion) | `components/ai/AIAnalysisPanel.jsx` | `ai/tests/test_fusion.py` (23 tests) |
| 1.3 | Estimate severity | Implemented | `ai/severity/severity_engine.py` | `components/complaints/SeverityBadge.jsx`, severity factors in `AIAnalysisPanel.jsx` | `ai/tests/test_severity.py` (22 tests) |
| 1.4 | Calculate priority | Implemented | `ai/priority/`, `apps/complaints/services/priority.py` | `components/complaints/PriorityBreakdown.jsx`, `PriorityMeter.jsx` | `ai/tests/test_priority.py`, `apps/complaints/test_services.py::PriorityTests` |
| 1.5 | Detect duplicate complaints | Implemented | `ai/duplicate/`, `apps/complaints/services/duplicates.py` | `components/complaints/DuplicatePanel.jsx`, `pages/admin/DuplicateReview.jsx` | `ai/tests/test_duplicate.py`, `apps/complaints/test_services.py::DuplicateTests`; `e2e/test_citizen.py::test_second_report_of_the_same_issue_is_linked_as_a_duplicate` |
| 1.6 | Identify the appropriate department | Implemented | `apps/complaints/services/routing.py` (routing table in `CivicCategory.department`) | `pages/admin/manage/departments/RoutingTab.jsx` | `apps/complaints/test_services.py::RoutingTests`, `apps/core/test_e2e.py::EndToEndApiTests::test_category_routing` |
| 1.7 | Recommend / assign an officer | Implemented | `apps/assignments/services.py` (`recommend_officers`, `auto_assign`) | `pages/admin/manage/complaint/ReassignDrawer.jsx` | `apps/assignments/tests.py::RecommendOfficersTests`, `AutoAssignAndWorkloadTests`; `e2e/test_admin.py::test_reassign_complaint_to_a_recommended_officer` |
| 1.8 | Track complaint progress | Implemented | `StatusHistory` (`apps/complaints/models.py`), `apps/complaints/services/status.py` | `pages/citizen/ComplaintTracking.jsx`, `components/complaints/ComplaintTimeline.jsx` | `apps/complaints/test_services.py::StatusTransitionTests`; `e2e/test_citizen.py::test_submit_complaint_through_the_ui_then_track_it` |
| 1.9 | Monitor resolution | Implemented | SLA due dates (`Complaint.compute_sla_due`), `apps/complaints/services/sla.py` (`check_sla_breaches`), built-in scheduler `apps/core/scheduler.py` | `components/complaints/SLAIndicator.jsx`, "Overdue" filters and chips | `apps/complaints/test_services.py::SlaTests`, `apps/core/test_hardening.py::SchedulerTests` |
| 1.10 | Verify resolution with before / after images | Implemented | `ai/verification/`, `apps/complaints/services/verification.py` | `pages/officer/ResolutionUpdate.jsx`, `pages/officer/ResolutionVerification.jsx`, `components/complaints/VerificationResult.jsx` | `ai/tests/test_verification.py`, `apps/complaints/test_services.py::VerificationTests`; `e2e/test_officer.py::test_officer_accepts_starts_and_resolves_with_after_photo` |
| 1.11 | Collect citizen feedback | Implemented | `POST /api/feedback/` (`apps/feedback/services.py`) | `pages/citizen/FeedbackPage.jsx`, `components/complaints/FeedbackForm.jsx` | `apps/feedback/tests.py::SubmitFeedbackTests`; `e2e/test_citizen.py::test_citizen_rates_a_resolved_complaint_and_it_closes` |
| 1.12 | Perform sentiment analysis | Implemented | `ai/nlp/sentiment.py` | `components/complaints/FeedbackCard.jsx`, `pages/admin/FeedbackAnalytics.jsx` | `ai/tests/test_nlp.py::SentimentTests`, `apps/feedback/tests.py::RealSentimentTests` |
| 1.13 | Identify geographical hotspots | Implemented | `ai/geospatial/hotspots.py` (DBSCAN), `apps/analytics/services.py` (`hotspot_map`, `check_hotspot_alert`, `scan_city_hotspots`) | `pages/admin/HotspotMap.jsx` | `ai/tests/test_geospatial.py::HotspotTests`, `apps/analytics/tests.py::HotspotApiTests`, `HotspotAlertServiceTests`; `e2e/test_admin.py::test_hotspot_map_renders_the_dbscan_clusters` |
| 1.14 | Provide analytics to administrators | Implemented | `apps/analytics/` (`/api/analytics/*`) | `pages/admin/AdminDashboard.jsx`, `AIAnalytics.jsx`, `FeedbackAnalytics.jsx`, `Reports.jsx` | `apps/analytics/tests.py::OverviewAndBreakdownTests`; `e2e/test_admin.py::test_dashboard_kpis_equal_overview_totals` |
| 1.15 | Complete lifecycle: report, image + text + GPS, preprocessing, multimodal analysis, classification, severity, priority, duplicates, routing, assignment, resolution, before / after verification, feedback, sentiment, analytics | Implemented | All of the above, in order; submission steps in `apps/complaints/services/pipeline.py` | Citizen, officer and admin pages | `apps/complaints/test_services.py::EndToEndDemoTest::test_full_lifecycle_in_demo_mode`, `apps/core/test_e2e.py::EndToEndApiTests::test_complaint_lifecycle_end_to_end` |

## 2. Civic issue categories

| # | Requirement | Status | Backend | Frontend | Tests |
|---|---|---|---|---|---|
| 2.1 | The nine initial categories (Roads / Potholes ... Other) | Implemented | `apps/departments/defaults.py`, `manage.py init_civicai` | Category select of the report wizard, `components/complaints/CategoryBadge.jsx` | `apps/departments/tests.py::InitCivicAICommandTests::test_is_idempotent_and_matches_the_spec` |
| 2.2 | New categories can be added from the admin panel without changing the application | Implemented | `POST /api/categories/`; the text classifier blends in DB keywords (`ai/nlp/classifier.py`), vision labels map detector classes (`ai/vision/postprocessing.py`), fusion and routing read the active categories | `pages/admin/manage/departments/CategoriesTab.jsx`, `CategoryFormModal.jsx` | `ai/tests/test_nlp.py::AnalyzeTextTests::test_admin_category_keywords_win`, `ai/tests/test_fusion.py::CategoryTests::test_admin_defined_category_can_win`, `ai/tests/test_vision.py::CategoryMappingTests`; `e2e/test_admin.py::test_admin_adds_a_category_that_citizens_can_report` |

## 3. Technology stack

| # | Requirement | Status | Where | Notes |
|---|---|---|---|---|
| 3.1 | Frontend: React, Vite, Tailwind CSS, React Router, Axios, Framer Motion, Recharts, Leaflet, React-Leaflet, Lucide React | Implemented | `frontend/package.json`: react 19.3, vite 7.3, tailwindcss 4.3, react-router-dom 7.18, axios 1.20, framer-motion 12.43, recharts 3.10, leaflet 1.9.4, react-leaflet 5.0, lucide-react 1.59 | `npm run lint` and `npm run build`, see [TESTING.md](TESTING.md) |
| 3.2 | Backend: Python, Django, DRF, JWT, Django CORS Headers, Pillow | Implemented | `backend/requirements.txt`; installed: Python 3.13, Django 5.2.18, DRF 3.18.3, djangorestframework-simplejwt, django-cors-headers, Pillow | |
| 3.3 | Celery + Redis only where genuinely useful | Implemented | Optional (`USE_CELERY=True`): `config/celery.py`, `apps/complaints/tasks.py`, `apps/analytics/tasks.py`. Default: the built-in scheduler `apps/core/scheduler.py` runs the SLA check hourly and the hotspot scan every 6 hours without a broker | `apps/core/test_hardening.py::SchedulerTests`, `apps/analytics/tests.py::HotspotAlertServiceTests::test_city_wide_scan_task` |
| 3.4 | Database: MySQL, Django ORM, migrations | Implemented | `config/settings.py` (`DB_ENGINE=mysql` is the default, `DATABASE_URL` for cloud MySQL), `apps/*/migrations/`, `scripts/setup_mysql.py`; the demo data runs on MySQL 8.0.42. SQLite remains a quick-start option | The suite passes on MySQL too ([TESTING.md](TESTING.md)) |
| 3.5 | AI / ML: PyTorch, YOLO, OpenCV, scikit-learn, Pandas, NumPy, Hugging Face Transformers, Sentence Transformers | Partially | OpenCV, scikit-learn, NumPy, ImageHash: demo engines. Pandas: time bucketing in `apps/analytics/services.py`. Transformers, Sentence-Transformers (all-MiniLM-L6-v2, CLIP ViT-B/32) and PyTorch underneath them: production mode (`requirements-ml.txt`, `ai/nlp/backends.py`, `ai/vision/model.py`); `ml_models/nlp/report_production.json` records the trained MiniLM + logistic-regression classifier and the RoBERTa sentiment evaluation. **YOLO**: code path (`ai/vision/model.py`), training script `scripts/train_yolo.py` and `ai/vision/dataset.yaml` exist, but no trained weights are shipped and `ultralytics` is not installed by default | `ai/tests/test_vision.py::ModeTests::test_yolo_path_maps_detector_labels` (mocked detector), `test_clip_zero_shot_path`, `ai/tests/test_nlp.py::ProductionModeTests` |
| 3.6 | Maps: Leaflet, OpenStreetMap | Implemented | OSM tiles in `components/maps/`; geocoding proxy `apps/core/geocoding.py` (`GET /api/geo/reverse/`, `GET /api/geo/search/`, Nominatim) | `apps/core/tests.py::GeocodingTests` |
| 3.7 | Development: VS Code, Git, GitHub | Partially | `.vscode/`, `.gitignore`, `.gitattributes` and an initialised `.git/` exist; the repository has **no commits and no GitHub remote yet** | Student step |
| 3.8 | Deployment: Vercel (frontend), Render / Railway (backend), MySQL-compatible cloud database | Partially | `render.yaml`, `backend/build.sh`, `backend/gunicorn.conf.py`, `backend/Procfile`, `frontend/vercel.json`, `DATABASE_URL`; steps in [DEPLOYMENT.md](DEPLOYMENT.md). A live deployment was not verified for this document | `apps/core/test_deploy.py` checks the build script, Procfile, blueprint and media serving |

## 4. "A real, integrated, runnable project"

| # | Requirement | Status | Where | Tests |
|---|---|---|---|---|
| 4.1 | No pseudocode, fake buttons, static dashboards, hardcoded analytics or HTML mockups | Implemented | Every number comes from the API; every action button comes from the server's `allowed_actions` (`apps/complaints/services/status.py::get_allowed_actions`) | `e2e/test_smoke.py::test_page_renders_cleanly` (every page, no failed API call), `apps/analytics/tests.py::EmptyDatabaseTests`, `apps/core/test_seed.py::SeedDemoConsistencyTests::test_analytics_overview_totals_equal_orm_counts` |
| 4.2 | APIs connected to the frontend; models match the APIs; pages connected to the backend | Implemented | `frontend/src/services/*.js` call every resource; the documented endpoint list is checked against the live URL configuration | `apps/core/test_api_contract.py::ApiContractTests::test_documentation_matches_the_live_url_configuration` |
| 4.3 | The example flow: submit, save to MySQL, upload image, AI analysis, severity, priority, duplicates, routing, notification, display result | Implemented | `apps/complaints/services/submission.py` and `pipeline.py` (14 timed steps returned as `analysis.steps`) | `apps/complaints/tests.py::ComplaintCreateTests::test_create_end_to_end_with_real_services`; `e2e/test_citizen.py::test_submit_complaint_through_the_ui_then_track_it` |

## 5. Citizen role

| # | Requirement | Status | Backend | Frontend | Tests |
|---|---|---|---|---|---|
| 5.1 | Register, login, logout | Implemented | `/api/auth/register/`, `login/`, `logout/` (`apps/accounts/views.py`) | `pages/public/RegisterPage.jsx`, `LoginPage.jsx`, `components/layout/UserMenu.jsx` | `apps/accounts/tests.py::AuthFlowTests`; `e2e/test_public.py::test_register_new_citizen_lands_on_citizen_dashboard`, `test_logout_ends_the_session` |
| 5.2 | View profile, edit profile, upload profile image | Implemented | `GET`, `PATCH /api/auth/profile/` | `pages/shared/ProfilePage.jsx` | `apps/accounts/tests.py::ProfileTests`; `e2e/test_citizen.py::test_citizen_edits_the_profile_and_uploads_a_photo` |
| 5.3 | Submit complaint, upload image, enter description | Implemented | See 1.0 | See 1.0 | See 1.0 |
| 5.4 | Capture GPS location, select location manually | Implemented | `/api/geo/reverse/`, `/api/geo/search/` | `components/maps/LocationPicker.jsx`, `hooks/useGeolocation.js` | `apps/core/tests.py::GeocodingTests`; e2e submit test (pin placed by a map click) |
| 5.5 | View complaint, AI analysis, severity, priority, department | Implemented | `GET /api/complaints/{id}/` | `pages/citizen/ComplaintDetails.jsx` | `apps/complaints/tests.py::ComplaintShapeTests::test_detail_shape` |
| 5.6 | Track complaint, view complaint history | Implemented | `GET /api/complaints/` (own only), timeline | `pages/citizen/ComplaintTracking.jsx`, `MyComplaints.jsx` | `apps/complaints/tests.py::ScopingAndPermissionTests::test_citizen_sees_only_own_complaints` |
| 5.7 | Receive notifications | Implemented | `apps/notifications/` | `components/layout/NotificationBell.jsx`, `pages/shared/NotificationsPage.jsx` | `apps/notifications/tests.py`; `e2e/test_citizen.py::test_notifications_page_lists_items_and_marks_all_read` |
| 5.8 | Submit feedback, rate resolution | Implemented | See 1.11 | See 1.11 | See 1.11 |
| 5.9 | View resolution evidence | Implemented | `evidence`, `latest_verification` in ComplaintDetail | `components/complaints/EvidencePanel.jsx`, `BeforeAfterSlider.jsx` | `apps/complaints/tests.py::ComplaintShapeTests::test_resolved_detail_has_evidence_verification_feedback_and_reopen_deadline` |
| 5.10 | Reopen complaint where applicable | Implemented | `POST /api/complaints/{id}/reopen/` (14-day window) | `pages/citizen/components/ComplaintActionModals.jsx` | `apps/complaints/test_services.py::StatusTransitionTests::test_citizen_reopen_within_window`, `test_reopen_window_closed_for_citizen_but_not_for_admin`; `e2e/test_lifecycle.py::test_citizen_reopens_a_resolved_complaint` |
| 5.11 | Citizen dashboard: totals, pending, in progress, resolved, recent complaints, timeline, notifications, feedback requests | Implemented | `GET /api/analytics/dashboard/` (citizen shape) | `pages/citizen/CitizenDashboard.jsx` | `apps/analytics/tests.py::PublicAndDashboardTests::test_citizen_dashboard`; `e2e/test_citizen.py::test_dashboard_shows_the_real_totals` |

## 6. Officer role

| # | Requirement | Status | Backend | Frontend | Tests |
|---|---|---|---|---|---|
| 6.1 | Login | Implemented | `/api/auth/login/` | `pages/public/LoginPage.jsx` | `e2e/test_public.py::test_demo_account_login_lands_on_role_dashboard` |
| 6.2 | View assigned complaints, search, filter, sort by priority | Implemented | `GET /api/complaints/` (assigned by default, `?scope=department`), `apps/complaints/filters.py` | `pages/officer/AssignedComplaints.jsx` | `apps/complaints/tests.py::ScopingAndPermissionTests::test_officer_default_scope_is_assigned_complaints`, `ComplaintFilterTests`; `e2e/test_officer.py::test_officer_queue_is_sorted_by_priority` |
| 6.3 | View details, citizen description, image, GPS location, map, AI prediction, severity, priority | Implemented | `GET /api/complaints/{id}/`, `GET /api/complaints/map/` | `pages/officer/OfficerComplaintDetails.jsx` (with `ReportedIssueCard`, `LocationCard`); queue map `?view=map` (`pages/officer/components/ComplaintsMapCard.jsx`) | `apps/complaints/tests.py::ComplaintShapeTests`, `ComplaintMapTests` |
| 6.4 | Accept complaint, update status, add remarks | Implemented | `/accept/`, `/start/`, `/reject/`, `/update-status/`, `/remarks/` | `pages/officer/components/ComplaintActions.jsx`, `ActionModals.jsx` | `apps/complaints/tests.py::ComplaintActionTests::test_accept`, `test_start_work`, `test_reject_requires_remarks`, `test_update_status`, `test_add_remark_returns_timeline_event`; `e2e/test_lifecycle.py::test_officer_rejects_a_complaint_and_the_citizen_sees_why` |
| 6.5 | Upload before image, upload after image, mark complaint resolved | Implemented | `/evidence/`, `/resolve/` | `pages/officer/ResolutionUpdate.jsx` | `apps/complaints/tests.py::ComplaintActionTests::test_upload_evidence`, `test_resolve_with_after_image`; `e2e/test_officer.py::test_officer_accepts_starts_and_resolves_with_after_photo` |
| 6.6 | Request manual verification | Implemented | `/request-manual-verification/` | `pages/officer/components/VerificationModals.jsx` | `apps/complaints/tests.py::ComplaintActionTests::test_request_manual_verification`, `apps/complaints/test_services.py::VerificationTests::test_request_manual_review` |
| 6.7 | Statuses Assigned, Accepted, In Progress, Resolved, Rejected, Reopened | Implemented | `Complaint.Status`, `TRANSITIONS` in `apps/complaints/services/status.py` | `components/complaints/StatusBadge.jsx`, `LifecycleStepper.jsx` | `apps/complaints/test_services.py::StatusTransitionTests::test_role_table` |

## 7. Admin role

| # | Requirement | Status | Backend | Frontend | Tests |
|---|---|---|---|---|---|
| 7.1 | Login, view all complaints | Implemented | `GET /api/complaints/` (admin scope = all) | `pages/admin/AllComplaints.jsx` | `apps/complaints/tests.py::ScopingAndPermissionTests::test_admin_sees_everything`; `e2e/test_admin.py::test_all_complaints_filters_change_the_result_count` |
| 7.2 | Manage citizens | Implemented | `/api/users/` | `pages/admin/UserManagement.jsx` | `apps/accounts/tests.py::UserManagementTests` |
| 7.3 | Manage officers | Implemented | `/api/officers/` | `pages/admin/OfficerManagement.jsx` | `apps/officers/tests.py::OfficerApiTests` |
| 7.4 | Manage departments | Implemented | `/api/departments/` | `pages/admin/manage/departments/DepartmentsTab.jsx` | `apps/departments/tests.py::DepartmentApiTests` |
| 7.5 | Manage civic categories | Implemented | `/api/categories/` | `CategoriesTab.jsx`, `CategoryFormModal.jsx` | `apps/departments/tests.py::CategoryApiTests` |
| 7.6 | Assign officers, reassign complaints | Implemented | `/api/assignments/`, `/api/assignments/recommend/` | `pages/admin/manage/complaint/ReassignDrawer.jsx` | `apps/assignments/tests.py::AssignmentApiTests`, `AssignOfficerTests`; `e2e/test_admin.py::test_reassign_complaint_to_a_recommended_officer` |
| 7.7 | View AI predictions | Implemented | `ai_prediction` in ComplaintDetail, `/api/analytics/ai/` | `pages/admin/ComplaintManagement.jsx`, `AIAnalytics.jsx` | `apps/analytics/tests.py::OverviewAndBreakdownTests::test_ai_performance` |
| 7.8 | View critical complaints | Implemented | `recent_critical` in `/api/analytics/overview/`, `?priority_level=critical` | Dashboard "Recent critical complaints", **Critical** chip | `apps/analytics/tests.py::OverviewAndBreakdownTests::test_overview_totals_and_distributions` |
| 7.9 | View duplicate complaints | Implemented | `/api/duplicates/` | `pages/admin/DuplicateReview.jsx` | `apps/complaints/tests.py::DuplicateTests::test_review_queue_shape_for_admin`; `e2e/test_admin.py::test_duplicates_page_lists_the_pending_pairs` |
| 7.10 | View hotspot maps | Implemented | `/api/analytics/hotspots/` | `pages/admin/HotspotMap.jsx` | See 1.13 |
| 7.11 | View analytics, department performance, officer workload | Implemented | `/api/analytics/departments/`, `/api/analytics/officers/` | `pages/admin/insights/DepartmentPerformanceTable.jsx`, `OfficerWorkloadTable.jsx` | `apps/analytics/tests.py::OverviewAndBreakdownTests::test_department_breakdown`, `test_officer_performance` |
| 7.12 | View citizen feedback, sentiment analytics | Implemented | `/api/feedback/`, `/api/analytics/sentiment/` | `pages/admin/FeedbackAnalytics.jsx` | `apps/analytics/tests.py::OverviewAndBreakdownTests::test_sentiment_analytics`, `test_sentiment_filters` |
| 7.13 | Manage AI configuration | Implemented | `GET`, `PUT`, `PATCH /api/ai/config/` (validated, audit-logged, optional recalculation) | `pages/admin/manage/settings/AIConfigTab.jsx` | `apps/core/tests.py::AIConfigTests`; `e2e/test_admin.py::test_ai_settings_reject_bad_weights_and_save_a_valid_change` |
| 7.14 | View model information | Implemented | `GET /api/ai/model-info/` (`ai/model_info.py`) | `pages/admin/manage/settings/ModelInfoTab.jsx`, `pages/admin/insights/AIModeBanner.jsx` | `apps/complaints/tests.py::AIEndpointTests::test_model_info_components_show_the_live_configuration`, `ai/tests/test_pipeline.py::ModelInfoTests` |
| 7.15 | Override AI predictions | Implemented | `POST /api/complaints/{id}/override-ai/` (`apps/complaints/services/overrides.py`) | `pages/admin/manage/complaint/OverrideAIModal.jsx` | `apps/complaints/test_services.py::OverrideTests`; `e2e/test_lifecycle.py::test_admin_overrides_the_ai_category` |
| 7.16 | Generate reports | Implemented | `GET /api/analytics/reports/` (JSON preview, CSV, PDF; `apps/analytics/reports.py`) | `pages/admin/Reports.jsx` | `apps/analytics/tests.py::ReportTests`; `e2e/test_admin.py::test_reports_download_as_csv_and_pdf` |

## 8. Frontend pages

All 31 pages are routed in `frontend/src/App.jsx`. `e2e/test_smoke.py::test_page_renders_cleanly` opens every page of
every role at 1440 px and on a 390 px touch phone and checks for a heading, no errors and no horizontal scroll.

| # | Page | Route | File (`pages/`) | Status |
|---|---|---|---|---|
| 1 | Landing Page | `/` | `public/LandingPage.jsx` | Implemented |
| 2 | About | `/about` | `public/AboutPage.jsx` | Implemented |
| 3 | Features | `/features` | `public/FeaturesPage.jsx` | Implemented |
| 4 | How It Works | `/how-it-works` | `public/HowItWorksPage.jsx` | Implemented |
| 5 | Contact | `/contact` | `public/ContactPage.jsx` | Implemented |
| 6 | Login | `/login` | `public/LoginPage.jsx` | Implemented |
| 7 | Register | `/register` | `public/RegisterPage.jsx` | Implemented |
| 8 | Citizen Dashboard | `/citizen/dashboard` | `citizen/CitizenDashboard.jsx` | Implemented |
| 9 | Submit Complaint | `/citizen/report` | `citizen/SubmitComplaint.jsx` | Implemented |
| 10 | My Complaints | `/citizen/complaints` | `citizen/MyComplaints.jsx` | Implemented |
| 11 | Complaint Details | `/citizen/complaints/:id` | `citizen/ComplaintDetails.jsx` | Implemented |
| 12 | Complaint Tracking | `/citizen/complaints/:id/track` | `citizen/ComplaintTracking.jsx` | Implemented |
| 13 | Profile | `/citizen/profile` (also `/officer/profile`, `/admin/profile`) | `shared/ProfilePage.jsx` | Implemented |
| 14 | Notifications | `/citizen/notifications` (also for officers and admins) | `shared/NotificationsPage.jsx` | Implemented |
| 15 | Feedback | `/citizen/feedback` | `citizen/FeedbackPage.jsx` | Implemented |
| 16 | Officer Dashboard | `/officer/dashboard` | `officer/OfficerDashboard.jsx` | Implemented |
| 17 | Assigned Complaints | `/officer/complaints` | `officer/AssignedComplaints.jsx` | Implemented |
| 18 | Complaint Details (officer) | `/officer/complaints/:id` | `officer/OfficerComplaintDetails.jsx` | Implemented |
| 19 | Resolution Update | `/officer/complaints/:id/resolve` | `officer/ResolutionUpdate.jsx` | Implemented |
| 20 | Resolution Verification | `/officer/complaints/:id/verify` | `officer/ResolutionVerification.jsx` | Implemented |
| 21 | Admin Dashboard | `/admin/dashboard` | `admin/AdminDashboard.jsx` | Implemented |
| 22 | All Complaints | `/admin/complaints` | `admin/AllComplaints.jsx` | Implemented |
| 23 | Complaint Management | `/admin/complaints/:id` | `admin/ComplaintManagement.jsx` | Implemented |
| 24 | User Management | `/admin/users` | `admin/UserManagement.jsx` | Implemented |
| 25 | Officer Management | `/admin/officers` | `admin/OfficerManagement.jsx` | Implemented |
| 26 | Department Management | `/admin/departments` (departments, categories, routing tabs) | `admin/DepartmentManagement.jsx` | Implemented |
| 27 | AI Analytics | `/admin/ai-analytics` | `admin/AIAnalytics.jsx` | Implemented |
| 28 | Hotspot Map | `/admin/hotspots` | `admin/HotspotMap.jsx` | Implemented |
| 29 | Feedback Analytics | `/admin/feedback` | `admin/FeedbackAnalytics.jsx` | Implemented |
| 30 | Reports | `/admin/reports` | `admin/Reports.jsx` | Implemented |
| 31 | System / AI Settings | `/admin/settings` (AI configuration, priority simulator, model information, model playground, risk zones, contact messages) | `admin/SystemSettings.jsx` | Implemented |

Extra pages beyond the list: Duplicate review (`/admin/duplicates`), Audit logs (`/admin/audit-logs`), Unauthorized
and Not found.

## 9. UI / UX

| # | Requirement | Status | Where | Evidence |
|---|---|---|---|---|
| 9.1 | Professional smart-city look, not a basic CRUD project | Implemented | "Civic signage" design system (BUILD_SPEC section 5.2): tokens in `index.css`, `components/ui/`, lane-line timeline, work-order cards | Screenshots in [USER_GUIDE.md](USER_GUIDE.md) |
| 9.2 | Cards, tables, charts, maps, filters, search, modals, toasts, loading animations, empty states, error states, confirmation dialogs, responsive layouts, icons | Implemented | `components/ui/` (Card, DataTable, Modal, ConfirmDialog, Drawer, EmptyState, ErrorState, Skeleton, Spinner, SearchInput), `context/ToastContext.jsx`, `components/charts/`, `components/maps/` | `e2e/test_smoke.py` |
| 9.3 | Tailwind CSS, Framer Motion, Lucide icons, Recharts | Implemented | `frontend/package.json`; `MotionConfig` in `App.jsx` respects reduced motion | |
| 9.4 | Light mode and dark mode | Implemented | `context/ThemeContext.jsx`, `components/ui/ThemeToggle.jsx` | `e2e/test_public.py::test_dark_theme_is_applied_and_remembered` |
| 9.5 | Works on desktop, laptop, tablet and mobile | Implemented | Responsive layouts, phone tab bar `components/layout/MobileTabBar.jsx`, tables become cards | `e2e/test_smoke.py` (1440 px and 390 px, no horizontal scroll); for this document eight key pages were also measured at 768, 1024 and 1280 px with no horizontal scroll |

## 10. Landing page

| # | Requirement | Status | Where | Tests |
|---|---|---|---|---|
| 10.1 | Hero "CivicAI" / "AI-Powered Civic Issue Management" and the subtitle, verbatim | Implemented | `pages/public/components/landing/HeroSection.jsx` | `e2e/test_public.py::test_landing_hero_copy_and_live_ai_demo` |
| 10.2 | Buttons "Report an Issue" and "Explore Dashboard" | Implemented | `HeroSection.jsx` (guests pass through login; officers and admins only get "Explore Dashboard" because they cannot file complaints) | Same test |
| 10.3 | Sections How CivicAI Works, AI Issue Detection, Multimodal AI, Smart Prioritization, Duplicate Detection, Automatic Department Routing, Resolution Verification, Citizen Feedback, Smart City Analytics | Implemented | `pages/public/components/landing/` (one component per section); the hero runs a live `POST /api/ai/demo/`, public numbers come from `/api/analytics/public/` | Same test (checks the nine sections); `e2e/test_public.py::test_try_your_own_photo_runs_the_public_ai_demo` |

## 11. Complaint submission

| # | Requirement | Status | Backend | Frontend | Tests |
|---|---|---|---|---|---|
| 11.1 | Fields: image, description, category, GPS location, address, date / time | Implemented | `ComplaintCreateSerializer` (`apps/complaints/serializers.py`), `incident_at` | `pages/citizen/components/report/ReportSteps.jsx` | `apps/complaints/tests.py::ComplaintCreateTests::test_validation_errors`, `test_optional_fields_can_be_omitted` |
| 11.2 | Drag-and-drop image, image preview, remove image | Implemented | | `components/ui/FileDropzone.jsx` (also "Take photo" with the rear camera) | e2e submit test (photo upload) |
| 11.3 | GPS detection, manual map selection, address display | Implemented | `/api/geo/reverse/` | `components/maps/LocationPicker.jsx` | `apps/core/tests.py::GeocodingTests` |
| 11.4 | Form validation | Implemented | Serializer + `apps/complaints/services/submission.py::_validate` (400 before anything is saved); upload checks `apps/core/validators.py` | `pages/citizen/components/report/reportForm.js` (`validateStep`) | `apps/complaints/test_services.py::SubmissionTests::test_invalid_input_is_rejected_before_anything_is_saved`, `apps/complaints/tests.py::ComplaintCreateTests::test_image_validation`; `e2e/test_citizen.py::test_report_wizard_validates_input_and_accepts_a_text_only_report` |
| 11.5 | "Analyze & Submit": validate, upload image, save complaint, image AI, text NLP, multimodal classification, severity, priority, duplicates, routing, officer recommendation, database save, notification, display | Implemented | Steps `validate, upload, save, preprocess, image_analysis, text_analysis, multimodal_fusion, severity, priority, duplicate_detection, department_routing, officer_assignment, database_save, notification` (`apps/complaints/services/pipeline.py`) | Button "Analyze & Submit" in `SubmitComplaint.jsx` | `ai/tests/test_pipeline.py::ContractTests::test_steps_order_labels_and_status`, `apps/complaints/test_services.py::SubmissionTests::test_full_submission_flow` |
| 11.6 | Display the AI result | Implemented | `analysis.summary` in the 201 response | `components/complaints/AnalysisProgress.jsx` (step replay + "AI work order") | e2e submit test |

## 12. Computer vision

| # | Requirement | Status | Where | Tests / evidence |
|---|---|---|---|---|
| 12.1 | AI-based civic image analysis | Implemented | `ai/vision/`: demo OpenCV heuristics (`heuristics.py`); production CLIP ViT-B/32 zero-shot with approximate regions (`model.py`) | `ai/tests/test_vision.py` (26 tests); `sample_data/vision_eval.json`: 98.9 % top-1 on the 90 generated sample photos (demo, no file-name hints) |
| 12.2 | YOLO where appropriate | Partially | `ai/vision/model.py` loads a YOLOv8 detector lazily when `ultralytics` is installed and `ml_models/yolo/civicai_yolov8.pt` exists; `scripts/train_yolo.py` and `ai/vision/dataset.yaml` train one. No weights are shipped and `ultralytics` is not installed, so the model registry reports YOLO as "Not installed" and production vision is CLIP zero-shot | `ai/tests/test_vision.py::ModeTests::test_yolo_path_maps_detector_labels`, `test_yolo_crash_during_inference_falls_back` (mocked detector) |
| 12.3 | Classes pothole, garbage, drainage, streetlight, water_leak, open_manhole, road_crack, fallen_tree, other | Implemented | `ai/config.py` (`CIVIC_CLASSES`), `ai/vision/config.py` | `ai/tests/test_vision.py::CategoryMappingTests` |
| 12.4 | Returns `{category, confidence, detected_objects, bounding_boxes}` | Implemented | `ai/vision/inference.py::analyze_image` (plus probabilities, visual severity, quality, model version, mode, explanation) | `ai/tests/test_vision.py::VisionContractTests::test_result_follows_the_contract` |
| 12.5 | `backend/ai/vision/` with model.py, inference.py, preprocessing.py, postprocessing.py, config.py | Implemented | All five present (plus `heuristics.py`, `dataset.yaml`) | |

## 13. Demo AI mode

| # | Requirement | Status | Where | Tests |
|---|---|---|---|---|
| 13.1 | Works without trained models (`MODEL_MODE=demo`) | Implemented | `ai/config.py::get_model_mode`; the whole platform and the demo data run in demo mode | `ai/tests/test_pipeline.py::RealPipelineIntegrationTest::test_end_to_end`, `apps/complaints/test_services.py::EndToEndDemoTest` |
| 13.2 | `MODEL_MODE=production` loads trained models | Implemented | `ai/vision/model.py` (YOLO if present, else CLIP), `ai/nlp/backends.py` (Sentence-Transformers, Hugging Face pipeline); every module falls back to the demo technique with a `fallback_reason`; `manage.py warmup_ai` | `ai/tests/test_vision.py::ModeTests`, `ai/tests/test_nlp.py::ProductionModeTests`, `apps/core/test_warmup.py` |
| 13.3 | Never pretend demo predictions are trained-model predictions | Implemented | Every result carries `is_demo`, `mode` and a demo `model_version`; explanations end with the demo disclaimer; a file-name hint is always disclosed and the public demo ignores file names; the model registry quotes the accuracy on the hand-written challenge set first and labels the template hold-out as in-distribution | `ai/tests/test_fusion.py::ReliabilityTests::test_demo_results_carry_the_disclaimer`, `ai/tests/test_vision.py::FilenameHintTests::test_matching_hint_raises_confidence_and_is_disclosed`, `apps/complaints/test_demo.py::PublicDemoEndpointTests::test_photo_only_uses_pixels_not_the_file_name` |
| 13.4 | Clearly display "Demo AI Mode" | Implemented | `/api/system/config/` (`demo_badge`); `components/ui/DemoModeBadge.jsx` (top bar; a strip under the top bar on phones), `components/ai/AIModeBadge.jsx` on every AI result, `pages/admin/insights/AIModeBanner.jsx` | `apps/core/tests.py::SystemConfigTests::test_demo_badge_follows_the_model_mode` |

## 14. NLP analysis

| # | Requirement | Status | Where | Tests / evidence |
|---|---|---|---|---|
| 14.1 | "Large pothole near the school entrance causing traffic problems." gives Pothole, High, Public Safety, keywords pothole, school, traffic | Implemented | `ai/nlp/` | `ai/tests/test_nlp.py::AnalyzeTextTests::test_spec_example`, `KeywordTests::test_spec_keywords`. Output in demo mode: pothole 96 %, severity hint high, primary impact Public Safety, keywords pothole, traffic, school, entrance |
| 14.2 | `backend/ai/nlp/` with text_preprocessor.py, classifier.py, embedding.py, sentiment.py, keyword_extractor.py | Implemented | All present (plus `impact.py`, `lexicons.py`, `sentiment_lexicon.py`, `backends.py`, the corpora in `data/`) | |
| 14.3 | Sentence Transformers, Hugging Face Transformers, NLP preprocessing | Implemented | Production: all-MiniLM-L6-v2 embeddings + logistic regression, `cardiffnlp/twitter-roberta-base-sentiment-latest`; demo: TF-IDF + logistic regression; preprocessing with Hinglish / Telugu synonym normalisation | `ai/tests/test_nlp.py::TextPreprocessorTests`, `ProductionModeTests`; `ml_models/nlp/report_demo.json`, `report_production.json`: 91.1 % / 92.2 % on 90 hand-written challenge complaints |

## 15. Multimodal AI

| # | Requirement | Status | Where | Tests |
|---|---|---|---|---|
| 15.1 | Image + text + location in one pipeline | Implemented | `ai/pipeline.py::run_analysis`: fusion uses the nearby complaints' categories as a weak location prior, and location risk feeds severity and priority. The specification's example through the admin "Full pipeline" playground gives Roads / Potholes, high severity, priority 55 (high), Roads Department (screenshot in [USER_GUIDE.md](USER_GUIDE.md), section 5.11) | `ai/tests/test_pipeline.py::ContractTests` |
| 15.2 | The final category uses image and text instead of blindly trusting one modality | Implemented | `ai/multimodal/fusion.py`: weights scale with each model's confidence and photo quality, each modality keeps at least 20 % of the weight, confident disagreement is flagged for review | `ai/tests/test_fusion.py::AgreementTests::test_trust_floor_keeps_both_modalities`, `test_confident_disagreement_needs_review`, `test_unconfident_image_is_outweighed` |

## 16. Severity assessment

| # | Requirement | Status | Where | Tests |
|---|---|---|---|---|
| 16.1 | Levels Low, Medium, High, Critical | Implemented | `ai/config.py::score_to_level`, thresholds 26 / 51 / 76 from the AI configuration | `ai/tests/test_severity.py::ScoringTests::test_custom_thresholds_and_weights` |
| 16.2 | Factors: visual severity, issue type, public safety, location, potential impact, nearby complaints, complaint frequency | Implemented | `ai/severity/severity_config.py`: the seven factors with weights 0.25 / 0.20 / 0.20 / 0.10 / 0.10 / 0.08 / 0.07 | `ai/tests/test_severity.py::ScoringTests`, `MissingEvidenceTests` |
| 16.3 | Returns `{severity, score, reason}` | Implemented | `ai/severity/severity_engine.py::assess_severity` (level as a lower-case key, shown as "High" in the UI; plus the factor breakdown) | `ai/tests/test_severity.py::ContractTests::test_shape_and_ranges`, `ReasonTests` |

## 17. Priority engine

| # | Requirement | Status | Where | Tests |
|---|---|---|---|---|
| 17.1 | Dedicated priority engine, 0-100 | Implemented | `ai/priority/priority_engine.py::PriorityEngine` | `ai/tests/test_priority.py::EngineBehaviourTests::test_score_is_capped_at_100` |
| 17.2 | Factors: severity, public safety impact, location risk, frequency, duplicate count, issue category | Implemented | `ai/priority/priority_rules.py`: five components; the issue category enters through its public-safety weight in the public-impact blend (and through severity's issue-type factor) | `ai/tests/test_priority.py::RuleTests::test_public_impact_blend` |
| 17.3 | Configurable weights, suggested 40 / 25 / 15 / 10 / 10 | Implemented | Defaults in `ai/priority/priority_config.py`, stored in `AIConfiguration`, edited on the admin AI configuration tab, "what-if" in the priority simulator | `ai/tests/test_priority.py::WeightConfigTests`, `apps/core/tests.py::AIConfigTests::test_put_with_recalculate_recalculates_open_complaints` |
| 17.4 | `backend/ai/priority/` with priority_engine.py, priority_rules.py, priority_config.py | Implemented | All three present | |
| 17.5 | Levels 0-25 Low, 26-50 Medium, 51-75 High, 76-100 Critical | Implemented | `DEFAULT_LEVEL_THRESHOLDS` in `ai/config.py` | `ai/tests/test_priority.py::LevelBoundaryTests::test_default_boundaries` |
| 17.6 | Calculation not hardcoded inside a Django view | Implemented | Views call `apps/complaints/services/priority.py::recalculate_priority`, which calls `ai.priority` | `apps/complaints/test_services.py::PriorityTests::test_recalculation_gathers_facts_from_the_database` |

## 18. Priority explanation

| # | Requirement | Status | Where | Tests |
|---|---|---|---|---|
| 18.1 | Every score has an explanation with the component breakdown, e.g. "Priority Score: 87/100 - Severity: 35/40 ..." | Implemented | `ai/priority/priority_engine.py::build_explanation` (sentence), `summary` and `breakdown`; stored on every `PriorityScore`; `components/complaints/PriorityBreakdown.jsx` | `ai/tests/test_priority.py::SpecExampleTests::test_breakdown_reproduces_the_spec`, `test_spec_style_explanation`. The specification's example breakdown is reproduced exactly (87/100). Its sentence calls 87 "High priority", but its own level table puts 76-100 in Critical; the engine follows the table and says "Critical priority because ..." |

## 19. Duplicate complaint detection

| # | Requirement | Status | Where | Tests |
|---|---|---|---|---|
| 19.1 | Text, image and location similarity using Sentence Transformer embeddings, cosine similarity, perceptual hashing and GPS distance | Implemented | `ai/duplicate/text_similarity.py` (embedding cosine: TF-IDF in demo, all-MiniLM-L6-v2 in production), `image_similarity.py` (pHash / dHash / aHash + colour histogram, CLIP in production), `location_similarity.py` (haversine distance kernel) | `ai/tests/test_duplicate.py` (24 tests) |
| 19.2 | `backend/ai/duplicate/` with text_similarity.py, image_similarity.py, location_similarity.py, duplicate_engine.py | Implemented | All four present | |
| 19.3 | "Large pothole near school." vs "Big road pothole outside school." nearby: potential duplicate, about 89 % | Implemented | Demo engine at 40 m: overall 90 %, flagged as a duplicate | `ai/tests/test_duplicate.py::FindDuplicatesTests::test_spec_example_pair_is_a_duplicate`, `RealEmbedderTests::test_spec_example_with_real_embedder` |
| 19.4 | Do not delete duplicates: link them, show similarity and the original, allow admin / officer confirmation | Implemented | `DuplicateComplaint` rows (pending review), `PATCH /api/duplicates/{id}/`; a confirmed duplicate is closed with `duplicate_of` pointing to the original; never merged into an already resolved original | `apps/complaints/test_services.py::DuplicateTests::test_confirmed_duplicate_is_merged_and_closed`, `test_not_duplicate_decrements_counts_and_recalculates`, `apps/complaints/test_audit_fixes.py::DuplicateRecurrenceTests` |

## 20. Department routing

| # | Requirement | Status | Where | Tests |
|---|---|---|---|---|
| 20.1 | Configurable mapping stored in the database and modifiable by the admin | Implemented | `CivicCategory.department` / `secondary_department`; `GET`, `PUT /api/departments/routing/`; `pages/admin/manage/departments/RoutingTab.jsx`; inactive departments are skipped, then the General Civic Department | `apps/departments/tests.py::RoutingApiTests::test_admin_updates_routing_atomically_with_audit`, `apps/complaints/test_services.py::RoutingTests::test_routing_chain_primary_secondary_general` |
| 20.2 | Default mapping (Pothole and Road Crack to Roads, Garbage to Waste Management, Drainage / Waterlogging to Drainage, Streetlight to Electrical, Water Leakage to Water Supply, Open Manhole to Roads / Drainage, Fallen Tree to Parks / Public Works, Other to General Civic) | Implemented | `apps/departments/defaults.py` (Open Manhole: Roads, falling back to Drainage) | `apps/departments/tests.py::InitCivicAICommandTests::test_is_idempotent_and_matches_the_spec` |

## 21. Officer assignment

| # | Requirement | Status | Where | Tests |
|---|---|---|---|---|
| 21.1 | Factors: department, workload, availability, location, priority | Implemented | `apps/assignments/services.py::recommend_officers`: candidates follow the routing chain; score = 0.40 spare capacity + 0.25 proximity + 0.15 availability + 0.20 track record, with 0.30 / 0.30 for capacity / track record on critical complaints | `apps/assignments/tests.py::RecommendOfficersTests` (16 tests) |
| 21.2 | Admin sees the recommended officer and workload; can assign, reassign and override the recommendation | Implemented | `GET /api/assignments/recommend/`, `POST /api/assignments/`, `PUT /api/assignments/{id}/`; `ReassignDrawer.jsx` | `apps/assignments/tests.py::AssignmentApiTests::test_recommend_endpoint`; `e2e/test_admin.py::test_reassign_complaint_to_a_recommended_officer` |

## 22. Map and GPS

| # | Requirement | Status | Where | Tests |
|---|---|---|---|---|
| 22.1 | Detect current location | Implemented | `hooks/useGeolocation.js`, "Use my location" in `LocationPicker.jsx` | e2e submit tests |
| 22.2 | Select location | Implemented | Click, drag, place search, "Pin map centre" (`LocationPicker.jsx`) | e2e submit tests |
| 22.3 | Display marker and complaint details | Implemented | `components/maps/ComplaintMap.jsx` (popups), `MiniMap.jsx` | `apps/complaints/tests.py::ComplaintMapTests::test_map_shape_scope_and_filters` |
| 22.4 | Complaint clustering | Implemented | `components/maps/ClusterLayer.jsx` (leaflet.markercluster) | |
| 22.5 | Filters; category, severity and status filtering | Implemented | `GET /api/complaints/map/` with the list filters; map views of `AllComplaints.jsx` and `AssignedComplaints.jsx` | `apps/complaints/tests.py::ComplaintMapTests` |
| 22.6 | Hotspot map | Implemented | See section 23 | |

## 23. Hotspot analysis

| # | Requirement | Status | Where | Tests |
|---|---|---|---|---|
| 23.1 | DBSCAN (or similar) on latitude / longitude | Implemented | `ai/geospatial/hotspots.py`: scikit-learn DBSCAN, `metric="haversine"` on radians, `eps = eps_m / 6 371 000`, ball tree | `ai/tests/test_geospatial.py::HotspotTests::test_recovers_three_clusters_and_noise`, `test_eps_controls_cluster_size` |
| 23.2 | Output: cluster, complaint count, dominant issue, severity, area | Implemented | Each cluster: centroid, count, radius, dominant category and breakdown, severity statistics, open count, area name, bounds, density per km² | `ai/tests/test_geospatial.py::HotspotTests::test_cluster_statistics` |
| 23.3 | Admin filters: date, category, severity, department | Implemented | `HotspotQuerySerializer` (`apps/analytics/serializers.py`): filters + `days`, `eps_m`, `min_samples` | `apps/analytics/tests.py::HotspotApiTests::test_hotspot_parameters_and_window_override_defaults` |
| 23.4 | Display: interactive map, cluster markers, complaint density, statistics | Implemented | `pages/admin/HotspotMap.jsx`, `pages/admin/insights/HotspotMapLayers.jsx`, `HotspotPanel.jsx`; admin dashboard mini map | `e2e/test_admin.py::test_hotspot_map_renders_the_dbscan_clusters`, `test_hotspot_badges_are_not_hidden_under_complaint_pins` (badges of nearby hotspots are moved apart so each stays clickable; [TESTING.md](TESTING.md#the-hotspot-badge-test)) |

## 24. Resolution tracking

| # | Requirement | Status | Where | Tests |
|---|---|---|---|---|
| 24.1 | Lifecycle submitted, AI analysis, assigned, accepted, in progress, resolved, verified, feedback | Implemented | Statuses `submitted, analyzed, assigned, accepted, in_progress, resolved, verified, closed` (feedback closes the complaint), plus `rejected` and `reopened`; finite-state machine in `apps/complaints/services/status.py` | `apps/complaints/test_services.py::StatusTransitionTests::test_officer_lifecycle_sets_timestamps_history_and_assignment_bookkeeping` |
| 24.2 | Store every status change with old_status, new_status, changed_by, timestamp, remarks | Implemented | `StatusHistory` (`event`, `old_status`, `new_status`, `changed_by`, `remarks`, `metadata`, `is_public`, `timestamp`), written by `change_status` | Same test; `apps/core/test_seed.py::SeedDemoConsistencyTests::test_every_complaint_has_prediction_priority_and_ordered_timeline` |

## 25. Before / after resolution verification

| # | Requirement | Status | Where | Tests / evidence |
|---|---|---|---|---|
| 25.1 | The officer uploads before and after images | Implemented | See 6.5 | See 6.5 |
| 25.2 | OpenCV, image similarity, structural comparison, image embeddings | Implemented | `ai/verification/preprocessing.py` (ORB features + RANSAC homography alignment), `metrics.py` (SSIM, histogram correlation, edge density, region change in the detected boxes), issue re-detection with the vision model; CLIP scene similarity in production | `ai/tests/test_verification.py::MetricsTests`, `AlignmentTests`, `ProductionModeTests::test_clip_scene_similarity_is_used_and_can_veto` |
| 25.3 | Output Likely Resolved / Partially Resolved / Not Resolved / Needs Manual Review, with a score and an explanation | Implemented | `ai/verification/verifier.py::verify_resolution` | `ai/tests/test_verification.py::VerificationRulesTests`, `ExpectedBehaviourTests`. Sweep over the 90 synthetic scenes in demo mode (run for this document): repaired photos 86 likely resolved, 3 partially, 1 not resolved; all 90 unchanged photos not resolved; all 90 different-scene photos need manual review |
| 25.4 | Called AI-assisted verification, not guaranteed | Implemented | Disclaimer in every result: "AI-assisted verification - not a guarantee. Officers and admins can override the result." | `components/complaints/VerificationResult.jsx` shows it |
| 25.5 | Admin / officer manual override | Implemented | `POST /api/complaints/{id}/manual-verification/` (`manual_verification`): the assigned officer while resolved and after an AI auto-verification; admins on resolved and verified complaints | `apps/complaints/test_services.py::VerificationTests::test_manual_verification_decisions`, `apps/complaints/test_audit_fixes.py::OfficerVerificationOverrideTests`; `e2e/test_lifecycle.py::test_officer_verifies_a_resolution_manually` |

## 26. Citizen feedback

| # | Requirement | Status | Where | Tests |
|---|---|---|---|---|
| 26.1 | After resolution the citizen submits a 1-5 star rating and text | Implemented | `apps/feedback/services.py::submit_feedback` (owner only, resolved or verified, once per resolution cycle) | `apps/feedback/tests.py::SubmitFeedbackTests::test_invalid_ratings_are_rejected`, `test_complaint_must_be_resolved_or_verified`, `test_feedback_only_once_per_resolution_cycle` |
| 26.2 | Store rating, feedback, citizen, complaint, timestamp | Implemented | `Feedback` model (`apps/feedback/models.py`) with sentiment, score, confidence and model | `apps/feedback/tests.py::FeedbackApiTests::test_citizen_submits_feedback` |

## 27. Sentiment analysis

| # | Requirement | Status | Where | Tests |
|---|---|---|---|---|
| 27.1 | Positive / Neutral / Negative; "The issue was resolved quickly." is positive | Implemented | `ai/nlp/sentiment.py` (demo: VADER-style lexicon with negation and civic phrases; production: RoBERTa); demo output +0.59, positive | `ai/tests/test_nlp.py::SentimentTests::test_spec_examples` |
| 27.2 | Admin view: positive %, neutral %, negative %, average rating, by department, by category, over time | Implemented | `GET /api/analytics/sentiment/`; `pages/admin/FeedbackAnalytics.jsx`; sentiment donut and satisfaction on the admin dashboard | `apps/analytics/tests.py::OverviewAndBreakdownTests::test_sentiment_analytics` |

## 28. Notification system

| # | Requirement | Status | Where | Tests |
|---|---|---|---|---|
| 28.1 | In-app notifications | Implemented | `Notification` model, `/api/notifications/` | `apps/notifications/tests.py::NotificationApiTests` |
| 28.2 | Citizen: complaint submitted, AI analysis completed, department assigned, officer assigned, status changed, complaint resolved, resolution verified, feedback requested | Implemented | `apps/complaints/services/notify.py`, `status.py`; all eight types are present in the demo citizen's notifications | `apps/notifications/tests.py::NotifyServiceTests`; `e2e/test_citizen.py::test_new_complaint_notifications_follow_the_lifecycle_order` |
| 28.3 | Officer: new assignment, critical complaint, reassignment | Implemented | `apps/assignments/services.py` (`_notify_assignment`) | `apps/assignments/tests.py::AssignOfficerTests::test_critical_complaint_alerts_the_officer`, `test_reassignment_deactivates_previous_assignment` |
| 28.4 | Admin: critical complaint, high-priority unresolved complaint, hotspot alert | Implemented | Critical: `apps/complaints/services/priority.py`; high-priority unresolved: `apps/complaints/services/sla.py::check_sla_breaches` (built-in scheduler or Celery beat, or "Run checks now"); hotspot: `apps/analytics/services.py` | `apps/complaints/test_services.py::PriorityTests::test_becoming_critical_alerts_admins_and_officer_once`, `SlaTests::test_alerts_once_per_complaint_per_day`, `apps/analytics/tests.py::HotspotAlertServiceTests::test_alert_created_for_dense_cluster_and_admins_notified` |
| 28.5 | Notification bell and notification page | Implemented | `/api/notifications/unread-count/`, `read/`, `read-all/`; `components/layout/NotificationBell.jsx` (polls every 30 s), `pages/shared/NotificationsPage.jsx` | `apps/notifications/tests.py::NotificationApiTests::test_mark_read_with_post_and_put`; `e2e/test_citizen.py::test_notifications_page_lists_items_and_marks_all_read` |

## 29. Admin dashboard

| # | Requirement | Status | Where | Tests |
|---|---|---|---|---|
| 29.1 | Cards: total, pending, in progress, resolved, critical, average resolution time, average rating | Implemented | `GET /api/analytics/overview/`; `pages/admin/AdminDashboard.jsx` KPI strip | `e2e/test_admin.py::test_dashboard_kpis_equal_overview_totals` |
| 29.2 | Recharts charts: by category, by department, over time, status, severity, priority, sentiment, satisfaction, resolution time, hotspots | Implemented | `components/charts/` wrappers on the dashboard; hotspots as a mini map | `e2e/test_admin.py::test_dashboard_charts_show_the_database_numbers` |
| 29.3 | All values from the database | Implemented | Aggregations in `apps/analytics/services.py` (time buckets computed in Python for MySQL compatibility) | `apps/analytics/tests.py::OverviewAndBreakdownTests::test_overview_oracle_for_resolution_metrics`, `apps/core/test_seed.py::SeedDemoConsistencyTests::test_analytics_overview_totals_equal_orm_counts` |

## 30. Officer dashboard

| # | Requirement | Status | Where | Tests |
|---|---|---|---|---|
| 30.1 | Assigned, critical, pending, in progress, resolved, average resolution time | Implemented | `GET /api/analytics/dashboard/` (officer shape); `pages/officer/OfficerDashboard.jsx` | `apps/analytics/tests.py::PublicAndDashboardTests::test_officer_dashboard`; `e2e/test_officer.py::test_officer_dashboard_figures_match_their_lists` |
| 30.2 | Table: Complaint ID, Category, Location, Priority, Severity, Status, Date, Action | Implemented | `pages/officer/components/OfficerComplaintTable.jsx` (all eight columns); phone cards `OfficerComplaintCard.jsx` include severity | `e2e/test_officer.py::test_officer_queue_is_sorted_by_priority` |

## 31. Citizen dashboard

| # | Requirement | Status | Where | Tests |
|---|---|---|---|---|
| 31.1 | Total, pending, in progress, resolved | Implemented | `pages/citizen/CitizenDashboard.jsx` | `e2e/test_citizen.py::test_dashboard_shows_the_real_totals` |
| 31.2 | Recent complaints: Complaint ID, Category, Priority, Status, Date | Implemented | `components/complaints/ComplaintTable.jsx` | `apps/analytics/tests.py::PublicAndDashboardTests::test_citizen_dashboard` |
| 31.3 | Notifications, tracking timeline, feedback requests | Implemented | `pages/citizen/components/DashboardPanels.jsx` (Latest updates, Active complaint, fixes waiting for a rating) | Same tests |

## 32-40. Database, models and fields

| # | Requirement | Status | Where |
|---|---|---|---|
| 32.1 | MySQL with the Django ORM | Implemented | See 3.4 |
| 32.2 | Models User, CitizenProfile, OfficerProfile, Department, CivicCategory, Complaint, ComplaintImage, Location, AIPrediction, PriorityScore, DuplicateComplaint, ComplaintAssignment, StatusHistory, ResolutionEvidence, ResolutionVerification, Feedback, Notification, AuditLog | Implemented | `apps/accounts/models.py` (User, CitizenProfile), `apps/officers/models.py` (OfficerProfile), `apps/departments/models.py` (Department, CivicCategory), `apps/complaints/models.py` (Location, Complaint, ComplaintImage, AIPrediction, PriorityScore, DuplicateComplaint, StatusHistory, ResolutionEvidence, ResolutionVerification), `apps/assignments/models.py` (ComplaintAssignment), `apps/feedback/models.py` (Feedback), `apps/notifications/models.py` (Notification), `apps/audit/models.py` (AuditLog); extra: HotspotAlert, AIConfiguration, RiskZone, ContactMessage |
| 33 | Complaint: id, complaint_number, citizen, category, description, status, severity, severity_score, priority_score, priority_level, department, assigned_officer, location, created_at, updated_at, resolved_at | Implemented | All present in `Complaint` (number `CIV-YYYY-000123` derived from the id) |
| 34 | Location: latitude, longitude, address, city, area, pincode | Implemented | `Location` (also `landmark`) |
| 35 | AIPrediction: complaint, image_category, image_confidence, text_category, text_confidence, final_category, multimodal_confidence, explanation, model_version, created_at | Implemented | All present, plus severity, factors, boxes, keywords, impacts, probabilities, modality weights, location risk, mode flags |
| 36 | PriorityScore: complaint, severity_component, impact_component, location_component, frequency_component, duplicate_component, final_score, priority_level, explanation | Implemented | All present, plus weights, factors, trigger, override flag, author |
| 37 | DuplicateComplaint: complaint, similar_complaint, text / image / location / overall similarity, status Pending Review / Confirmed Duplicate / Not Duplicate | Implemented | All present, plus distance, category match, explanation, reviewer, review notes |
| 38 | Resolution: complaint, before_image, after_image, uploaded_by, remarks, uploaded_at; verification: score, status, explanation, verified_by, verified_at | Implemented | `ResolutionEvidence` and `ResolutionVerification` (plus metrics, method, override flags, model version) |
| 39 | Feedback: complaint, citizen, rating, text, sentiment, sentiment_score, created_at | Implemented | `Feedback` |
| 40 | Notification: user, title, message, notification_type, is_read, created_at | Implemented | `Notification` (plus level, complaint, link, read_at) |

Models and migrations agree: `manage.py makemigrations --check` reports "No changes detected".

## 41. Database indexing

| # | Requirement | Status | Where |
|---|---|---|---|
| 41.1 | Indexes on complaint status, category, department, priority, severity, created_at, latitude, longitude | Implemented | `apps/complaints/models.py`: `db_index` on status, severity, priority_score, priority_level, created_at; composite indexes (status, -priority_score), (department, status), (category, status), (assigned_officer, status), (severity, created_at), (priority_level, created_at); `Location` latitude, longitude and (latitude, longitude) |
| 41.2 | Proper foreign keys and relationships | Implemented | Foreign keys (indexed automatically) for category, department, officer, citizen, location (one-to-one) and every child table |

## 42. Backend API

Every endpoint of the requirements exists with the documented methods and permission levels;
`apps/core/test_api_contract.py::ApiContractTests::test_every_specified_endpoint_exists_with_its_permission_level`
fails if one goes missing and `RoleEnforcementTests::test_levels_are_enforced` checks the permission levels. The full
list (117 endpoints) is [API_ENDPOINTS.md](API_ENDPOINTS.md).

| # | Endpoints | Status | Tests |
|---|---|---|---|
| 42.1 | Auth: `POST /api/auth/register/`, `login/`, `refresh/`, `logout/`, `GET /api/auth/profile/` | Implemented | `apps/accounts/tests.py::AuthFlowTests`, `ProfileTests` |
| 42.2 | Complaints: `POST`, `GET /api/complaints/`, `GET`, `PUT`, `DELETE /api/complaints/{id}/` | Implemented | `apps/complaints/tests.py::ComplaintCreateTests`, `ComplaintShapeTests`, `ComplaintUpdateDeleteTests` |
| 42.3 | AI: `POST /api/ai/analyze/`, `classify/`, `priority/`, `duplicates/`, `verify-resolution/` | Implemented | `apps/complaints/tests.py::AIEndpointTests` (23 tests) |
| 42.4 | Departments: `GET`, `POST /api/departments/`, `PUT /api/departments/{id}/` | Implemented | `apps/departments/tests.py::DepartmentApiTests` |
| 42.5 | Officers: `GET`, `POST /api/officers/`, `PUT /api/officers/{id}/` | Implemented | `apps/officers/tests.py::OfficerApiTests` |
| 42.6 | Assignments: `POST /api/assignments/`, `PUT /api/assignments/{id}/` | Implemented | `apps/assignments/tests.py::AssignmentApiTests` |
| 42.7 | Feedback: `POST`, `GET /api/feedback/` | Implemented | `apps/feedback/tests.py::FeedbackApiTests` |
| 42.8 | Analytics: `GET /api/analytics/overview/`, `categories/`, `departments/`, `trends/`, `hotspots/`, `sentiment/` | Implemented | `apps/analytics/tests.py::OverviewAndBreakdownTests`, `HotspotApiTests` |
| 42.9 | Notifications: `GET /api/notifications/`, `PUT /api/notifications/{id}/read/` | Implemented | `apps/notifications/tests.py::NotificationApiTests` |

## 43. Authentication and security

| # | Requirement | Status | Where | Tests |
|---|---|---|---|---|
| 43.1 | JWT | Implemented | simplejwt: 60-minute access and 7-day refresh tokens, rotation with blacklisting, logout blacklists both tokens, a password fingerprint in every token (`apps/accounts/tokens.py`) | `apps/accounts/tests.py::AuthFlowTests::test_refresh_rotates_and_blacklists_the_used_token`, `test_change_password_ends_every_other_session_at_once` |
| 43.2 | Password hashing; never plain-text passwords | Implemented | Django PBKDF2 via `set_password` / `create_user`, password validators in `config/settings.py` | `apps/accounts/tests.py::AuthFlowTests::test_whitespace_only_passwords_are_rejected` |
| 43.3 | Role-based permissions | Implemented | `apps/core/permissions.py` on every view; object scoping (citizens: own data, officers: assigned / department; out of scope answers 404) | `apps/core/test_api_contract.py::RoleEnforcementTests::test_levels_are_enforced`, `apps/complaints/tests.py::ScopingAndPermissionTests` (14 tests) |
| 43.4 | Protected routes | Implemented | `components/layout/ProtectedRoute.jsx`, `GuestRoute.jsx` | `e2e/test_public.py::test_citizen_opening_admin_dashboard_is_sent_to_unauthorized`, `test_guest_opening_citizen_page_is_sent_to_login` |
| 43.5 | CORS | Implemented | django-cors-headers with an allow-list (`CORS_ALLOWED_ORIGINS`, `CORS_ALLOWED_ORIGIN_REGEXES`) | |
| 43.6 | Input validation | Implemented | DRF serializers and service checks; ids, dates and oversized bodies answer 4xx, never 500 | `apps/core/test_hardening.py::HostileInputTests` |
| 43.7 | File validation and image size restrictions | Implemented | `apps/core/validators.py`, `apps/core/images.py`: real format JPEG / PNG / WebP, 8 MB, 32-8000 px, pixel-count limits checked before decoding, re-encoded without metadata under a random name | `apps/core/test_hardening.py::ImageUploadTests`, `StoredPhotoTests` |
| 43.8 | Environment variables; `.env` and `.env.example` with SECRET_KEY, DEBUG, DATABASE_NAME, DATABASE_USER, DATABASE_PASSWORD, DATABASE_HOST, DATABASE_PORT, JWT_SECRET, MODEL_PATH | Implemented | `backend/.env.example` has all nine keys (and more); `.env` is git-ignored | |
| 43.9 | Never expose secrets | Implemented | Secrets only in `.env`; API responses never contain password hashes; the demo-account passwords on the login page exist only in development builds (`pages/public/components/authUtils.js`); citizens never receive other people's contact details | `apps/complaints/test_audit_fixes.py::ContactPrivacyTests` |

## 44. Project structure

| # | Requirement | Status | Where |
|---|---|---|---|
| 44.1 | Backend: `manage.py`, `config/` (settings, urls, wsgi, asgi), `apps/` (accounts, complaints, departments, officers, assignments, feedback, notifications, analytics, audit), `ai/` (vision, nlp, priority, duplicate, geospatial, verification), `scripts/`, `media/`, `static/`, `requirements.txt`, `.env.example`, `README.md` | Implemented | All present; extra `apps/core`, `ai/multimodal`, `ai/severity`, `ai/common`, `sample_data/`, `ml_models/` |
| 44.2 | Frontend: `package.json`, `vite.config.js`, `src/` (components, pages/{public, citizen, officer, admin}, services, context, hooks, utils, assets, App.jsx) | Implemented | All present; extra `pages/shared` |

## 45-49. Authentication flow, routing, detail page, timeline, analytics

| # | Requirement | Status | Where | Tests |
|---|---|---|---|---|
| 45.1 | Register, login, JWT access token, refresh token, protected routes, role verification, dashboard | Implemented | `context/AuthContext.jsx`, `services/api.js` (refreshes once on 401, queues concurrent requests) | `apps/accounts/tests.py::AuthFlowTests` |
| 45.2 | After login: citizen, officer and admin dashboards | Implemented | `ROLE_HOME` in `utils/constants.js`, `GuestRoute.jsx` (also honours `?next=`) | `e2e/test_public.py::test_demo_account_login_lands_on_role_dashboard` |
| 46.1 | `/citizen/*`, `/officer/*`, `/admin/*`; unauthorized users cannot open other dashboards | Implemented | `roleArea()` in `App.jsx` with `ProtectedRoute roles=[...]`; the API enforces the same roles | `e2e/test_public.py::test_citizen_opening_admin_dashboard_is_sent_to_unauthorized` |
| 47.1 | Detail page: ID, category, description, image, location, map, date, citizen, severity, priority, AI confidence, AI explanation, department, officer, status, timeline, duplicates, evidence, verification, feedback | Implemented | `pages/citizen/ComplaintDetails.jsx`, `pages/officer/OfficerComplaintDetails.jsx`, `pages/admin/ComplaintManagement.jsx` (ComplaintDetail API shape) | `apps/complaints/tests.py::ComplaintShapeTests::test_detail_shape` |
| 48.1 | Timeline: submitted, AI analysis, priority, department, officer, accepted, in progress, resolved, verified, feedback, each with a timestamp | Implemented | `StatusHistory.Event`; `components/complaints/ComplaintTimeline.jsx` shows the remaining steps as upcoming stops | `apps/complaints/test_services.py::StatusTransitionTests` |
| 49.1 | All analytics calculated dynamically from the database | Implemented | `apps/analytics/services.py` | `apps/analytics/tests.py::OverviewAndBreakdownTests::test_overview_oracle_for_resolution_metrics`, `QueryCountTests::test_endpoints_do_not_query_per_row` |

---

## Known gaps and partial items

1. **No trained YOLO detector (rows 3.5, 12.2).** The YOLOv8 path is written, tested with a mocked detector and has a
   training script, but no weights trained on real civic photos are shipped and `ultralytics` is not in the default
   environment. Production mode therefore uses CLIP zero-shot classification (61.1 % top-1 on the 90 generated sample
   photos, see [AI_ENGINE.md](AI_ENGINE.md), section 13), and demo mode uses OpenCV heuristics. Training a detector
   needs a labelled real dataset (the notes in `scripts/train_yolo.py` name RDD2022, Roboflow pothole sets and
   TACO).
2. **Git and GitHub (row 3.7).** The folder is a Git repository, but nothing is committed and there is no remote.
   Committing and pushing is left to the student.
3. **Cloud deployment (row 3.8).** The Render blueprint, the Vercel configuration and cloud-MySQL support
   (`DATABASE_URL`) are in place and checked by `apps/core/test_deploy.py`; a live deployment was not verified for
   this document. On Render's free plan the local disk is not persistent, so uploaded photos disappear on a redeploy
   unless a persistent disk or object storage is used ([DEPLOYMENT.md](DEPLOYMENT.md)).

Further limitations that do not break a requirement but matter for the defence:

- **Evaluation data is synthetic.** The 864-row text corpus is template-generated and the 90 sample photos are
  procedurally drawn, so the high demo scores on them say little about real complaints. The honest numbers are the
  hand-written challenge sets (text 91.1 % demo / 92.2 % production; feedback sentiment 86.7 % / 96.7 %); see
  [AI_ENGINE.md](AI_ENGINE.md), section 13.
- **The demo data is generated by the real pipeline from synthetic texts and real photos** (134 credited real street
  photos; about a tenth of the reports keep generated before/after scenes for the AI verification), so analytics such
  as the image / text agreement on the AI analytics page describe the seeded inputs, not real citizens. On real
  photos the demo image heuristic reaches only 22.4 % (CLIP 64.2 %), so the demo fusion counts it half.
- **E-mail**: the citizen profile stores an "Email me about my complaints" preference, but the platform sends in-app
  notifications only (the requirement asks for in-app notifications).

## Problems found by the phase-4 audits

The two compliance audits of 17 October 2026 reported the problems below. Each was re-checked for this document.

| Audit finding | Status now | How it was checked |
|---|---|---|
| `GET /api/feedback/pending/` failed with HTTP 500 on MySQL (breaking the Feedback page) | Fixed | The Feedback page on the MySQL demo system lists the 2 complaints waiting for a rating (screenshot in [USER_GUIDE.md](USER_GUIDE.md), section 3.8) |
| The platform had never run on MySQL | Fixed | The demo system runs on MySQL 8.0.42; suite results on MySQL in [TESTING.md](TESTING.md) |
| `/admin/dashboard` scrolled horizontally at 768-1366 px | Fixed | No horizontal scroll at 390, 768, 1024 and 1280 px (measured for this document) |
| "Demo AI Mode" text hidden on phones | Fixed | `DemoModeBadge` has a phone strip variant shown under the top bar |
| Model registry presented the synthetic hold-out accuracy as the headline | Fixed | Model information shows the challenge-set accuracy first and labels the template hold-out as in-distribution |
| YOLO not usable in any mode | Still open | Rows 3.5 and 12.2 (no trained weights are shipped) |
| Officers had no map of their queue | Fixed | `?view=map` on `/officer/complaints` |
| `/api/ai/analyze/` and the photo mode of `/api/ai/verify-resolution/` were not used by any page | Fixed | Model playground "Full pipeline" and "Before / after check" tools |
| Departments had no contact details | Fixed | All seven departments now have fictitious contacts (`InitCivicAICommandTests::test_every_default_department_has_fictitious_contacts`) |
| No README | Fixed | `README.md` and `backend/README.md` |
| Admin demo password shipped in the production bundle | Fixed | Demo accounts exist only in development builds (`pages/public/components/authUtils.js`) |
| "High-priority unresolved" alerts never ran without Celery | Fixed | Built-in scheduler `apps/core/scheduler.py` (`SchedulerTests`) |
| Confirming a duplicate whose original was closed closed the live report | Fixed | Refused with an explanation (`DuplicateRecurrenceTests`) |
| Officers could not override an AI "likely resolved" verdict | Fixed | `OfficerVerificationOverrideTests` |
| Verification text said "no longer detected" while the issue was still the top class | Fixed | `VerificationContractTests::test_issue_that_is_still_the_top_class_counts_as_still_detected` |
| Citizen notifications out of lifecycle order | Fixed | `e2e/test_citizen.py::test_new_complaint_notifications_follow_the_lifecycle_order` (passed in the latest run) |
| `frontend/src/assets` missing | Fixed | `frontend/src/assets/logo-mark.svg` |
| Officer phone cards without severity | Fixed | `OfficerComplaintCard.jsx` shows the severity badge |

## Beyond the requirements

Features built in addition to the specification: the public live AI demo on the landing page, the "similar issue
already reported nearby" check before submitting, the priority simulator and model playground, admin-managed risk
zones for the location-risk factor, a duplicate-review queue page, audit logs, the contact-message inbox, civic points
for citizens, SLA deadlines with automatic alerts, a built-in scheduler for periodic checks, CSV formula-injection
protection in exports, upload hardening (decompression-bomb checks, metadata stripping), rate limits, the installable
PWA, and `manage.py seed_demo`, which builds a 180-day demo history through the real services.
