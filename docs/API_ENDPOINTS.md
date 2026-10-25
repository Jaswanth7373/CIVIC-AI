# CivicAI REST API — endpoint reference

Base URL: `http://localhost:8000/api` (production: `https://<backend-host>/api`). Authentication:
`Authorization: Bearer <access token>` from `/api/auth/login/` or `/api/auth/register/`. Every path ends with `/`.
Request / response shapes are specified in `docs/BUILD_SPEC.md` section 4 (CategoryMini, DepartmentMini, UserMini,
OfficerMini, ComplaintList, ComplaintDetail, AIPrediction, PriorityBreakdown, DuplicateLink, Assignment, Evidence,
Verification, Feedback, TimelineEvent, Notification).

This table is the result of the contract audit of the live URLconf (`django.urls.get_resolver()`) against
`docs/BUILD_SPEC.md` section 4.2: every endpoint of the specification exists with the documented methods and
permission levels. It is kept in sync automatically — `apps/core/test_api_contract.py` fails when an endpoint, a
method or a permission level differs from this file (`python manage.py api_endpoints` prints the live inventory).

**Permission levels**

| Level | Meaning |
|---|---|
| P | Public — no account needed (`AllowAny`) |
| A | Any signed-in user (`IsAuthenticated`); results are scoped to what the user may see |
| C | Citizen accounts only |
| C (owner)/AD | The citizen who reported the complaint, or an administrator |
| O | Officer accounts only |
| O (assigned) | Only the officer the complaint is assigned to |
| O (assigned)/AD | The assigned officer, or an administrator |
| O/AD | Officers and administrators |
| AD | Administrators only |

Object-level rules on top of the level: citizens only see their own complaints / feedback / notifications; officers
see complaints assigned to them or to their department; objects outside the caller's scope answer 404.
Errors use `{"detail": str, "errors"?: {field: [msg]}, "code": str}`. List endpoints are paginated
(`?page=&page_size=` → `{"count", "next", "previous", "page", "page_size", "total_pages", "results"}`) unless marked
non-paginated. Ids in filters and URLs are plain ASCII whole numbers and dates are `YYYY-MM-DD` between 2000-01-01
and 2100-12-31; anything else answers 400 (or 404 in a URL). A request body over 20 MB (`MAX_REQUEST_BODY_MB`)
answers 413 with code `payload_too_large` before it is read.

**Photo uploads** (complaint photos, evidence, avatars, every `/api/ai/` endpoint, the public demo): the real content
must be JPEG, PNG or WebP (a renamed file is rejected), at most 8 MB (`MAX_IMAGE_UPLOAD_MB`), 32 to 8000 px per side,
at most 25 Mpx for JPEG and 12 Mpx for PNG / WebP; the pixel count is checked before decoding. Stored copies are
re-encoded: EXIF orientation applied, EXIF / GPS / XMP metadata removed, longest side at most 2560 px, and saved
under a random, unguessable file name.

**Rate limits** (`REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]`, HTTP 429 with `Retry-After` when exceeded):
`auth` 20/min (register, login), `contact` 5/min (contact form), `ai` 60/min (every POST under `/api/ai/` except the
demo), `ai_public` 12/min (public demo), `complaint_burst` 6/min and `complaint_daily` 40/day (new complaints per
citizen, `POST /api/complaints/` only), plus the global `anon` 120/min and `user` 600/min. Client addresses come from
`REMOTE_ADDR` unless `NUM_PROXIES` trusted proxies are configured, so `X-Forwarded-For` cannot reset a limit.

## Health

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | /api/health/ | P | Liveness probe `{"status": "ok", "service", "model_mode", "demo_mode"}` (deployment health check). |

## Authentication

| Method | Path | Permission | Description |
|---|---|---|---|
| POST | /api/auth/register/ | P | Citizen self-registration `{email, password, confirm_password, first_name, last_name, phone?}` → 201 `{user, access, refresh}`; the role is always citizen. Throttle `auth`. |
| POST | /api/auth/login/ | P | `{email, password}` → `{access, refresh, user}`; 401 for wrong credentials, 403 for a deactivated account. Throttle `auth`. |
| POST | /api/auth/refresh/ | P | `{refresh}` → `{access, refresh}` (refresh tokens rotate; the old one is blacklisted). |
| POST | /api/auth/logout/ | A | `{refresh}` → `{"detail": "Logged out."}` (blacklists the refresh token and the access token the request was made with; the refresh token must belong to the caller). |
| GET | /api/auth/profile/ | A | The signed-in User (citizen / officer profile, stats). |
| PUT | /api/auth/profile/ | A | Update the own profile (JSON or multipart: names, phone, avatar / `remove_avatar`, citizen profile fields). |
| PATCH | /api/auth/profile/ | A | Partial profile update (same fields as PUT). |
| POST | /api/auth/change-password/ | A | `{old_password, new_password, confirm_password?}` (Django password validators) → `{detail, access, refresh}`. Every earlier session of the account ends (tokens carry a password fingerprint and outstanding refresh tokens are blacklisted); the returned pair keeps the current session signed in. |

## Users (administration)

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | /api/users/ | AD | Users with `complaint_count` and `civic_points`; filters `role`, `is_active`, `search`. |
| POST | /api/users/ | AD | Create a user of any role (officers should be created through `/api/officers/`). |
| GET | /api/users/{id}/ | AD | One user. |
| PUT | /api/users/{id}/ | AD | Update `first_name, last_name, phone, is_active, role`. |
| PATCH | /api/users/{id}/ | AD | Partial update (same fields as PUT). |
| DELETE | /api/users/{id}/ | AD | Soft delete (`is_active=false`); an administrator cannot delete their own account. |

## Officers

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | /api/officers/ | O/AD | OfficerOut list with live `active_workload`, `resolved_count`, `avg_resolution_hours`, `avg_rating`; filters `department`, `is_available`, `is_active`, `zone`, `search`; `ordering`. |
| POST | /api/officers/ | AD | Create `User(role=officer)` + OfficerProfile in one transaction. |
| GET | /api/officers/{id}/ | O/AD | One officer (`id` = user id). |
| PUT | /api/officers/{id}/ | AD | Update the officer account and profile (password optional). |
| PATCH | /api/officers/{id}/ | AD | Partial update. |
| DELETE | /api/officers/{id}/ | AD | Deactivate the account (history is kept); reports the open complaints that still need reassignment. |
| GET | /api/officers/{id}/workload/ | O/AD | `{active, capacity, utilization (0..1, clamped), overloaded (active > capacity), critical, by_status, complaints: [ComplaintList]}`; officers can read only their own workload. |

## Departments, categories and routing (non-paginated)

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | /api/departments/ | P | DepartmentOut list with officer / category / complaint counters; `?include_inactive=true` (admins). |
| POST | /api/departments/ | AD | Create a department. |
| GET | /api/departments/{id}/ | P | One department. |
| PUT | /api/departments/{id}/ | AD | Update a department. |
| PATCH | /api/departments/{id}/ | AD | Partial update. |
| DELETE | /api/departments/{id}/ | AD | Deactivate when it still has complaints or officers, otherwise delete. |
| GET | /api/departments/routing/ | A | Routing table `[{category, department, secondary_department}]`. |
| PUT | /api/departments/routing/ | AD | `{mappings: [{category, department, secondary_department}]}` → the updated table. |
| GET | /api/categories/ | P | CategoryOut list (keywords, vision labels, base severity, safety weight, SLA); `?include_inactive=true`. |
| POST | /api/categories/ | AD | Create a category (slug derived from the name when missing); the AI engines use it immediately. |
| GET | /api/categories/{id}/ | P | One category. |
| PUT | /api/categories/{id}/ | AD | Update a category. |
| PATCH | /api/categories/{id}/ | AD | Partial update. |
| DELETE | /api/categories/{id}/ | AD | Deactivate when complaints use it, otherwise delete. |

## Complaints

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | /api/complaints/ | A | ComplaintList scoped by role (citizen: own; officer: assigned, `?scope=department`; admin: all); filters `status, category, severity, priority_level, department, assigned_officer, citizen, date_from, date_to, is_overdue, has_duplicates, needs_review, unassigned, search, ordering` (`unassigned=true`: open complaints no officer is assigned to; `false`: every other complaint). |
| POST | /api/complaints/ | C | Multipart submission (`description`, `image?`, `latitude`, `longitude`, address fields, `category` hint, `title`, `incident_at`) → 201 ComplaintDetail + `analysis {steps, summary}`; runs the whole AI pipeline (classification, severity, priority, duplicates, routing, auto-assignment, notifications). Throttles `complaint_burst`, `complaint_daily`. |
| GET | /api/complaints/map/ | A | Non-paginated map pins (newest 3000), same scope and filters as the list. |
| GET | /api/complaints/{id}/ | A | ComplaintDetail (object-scoped; citizens see public timeline events only; `allowed_actions` drives the UI). |
| PUT | /api/complaints/{id}/ | C (owner)/AD | Edit text / location fields while the complaint is editable; a changed description is re-analysed. |
| PATCH | /api/complaints/{id}/ | C (owner)/AD | Partial edit (same rules as PUT). |
| DELETE | /api/complaints/{id}/ | C (owner)/AD | Delete while editable → 204 (duplicate counts and priorities of linked complaints are refreshed). |
| GET | /api/complaints/{id}/timeline/ | A | `[TimelineEvent]` in chronological order. |
| GET | /api/complaints/{id}/duplicates/ | A | `[DuplicateLink]` in both directions. |
| POST | /api/complaints/{id}/accept/ | O (assigned) | `{remarks?}` → ComplaintDetail (status accepted). |
| POST | /api/complaints/{id}/reject/ | O (assigned)/AD | `{remarks}` (required) → ComplaintDetail. |
| POST | /api/complaints/{id}/start/ | O (assigned) | `{remarks?}` → ComplaintDetail (status in progress). |
| POST | /api/complaints/{id}/update-status/ | O (assigned)/AD | `{status, remarks}`, validated against the lifecycle state machine. |
| POST | /api/complaints/{id}/resolve/ | O (assigned)/AD | Multipart `{remarks, after_image?}`; AI-assisted verification runs automatically when an after photo exists. |
| POST | /api/complaints/{id}/evidence/ | O (assigned)/AD | Multipart `{before_image?, after_image?, remarks?}` (at least one photo) → 201 Evidence. |
| POST | /api/complaints/{id}/verify/ | O (assigned)/AD | Run AI-assisted before/after verification on the latest evidence → Verification. |
| POST | /api/complaints/{id}/manual-verification/ | O (assigned)/AD | `{status, score?, explanation}` → Verification (human decision overrides the AI). |
| POST | /api/complaints/{id}/request-manual-verification/ | O (assigned) | `{remarks?}` → ComplaintDetail (flags the resolution for administrator review). |
| POST | /api/complaints/{id}/reopen/ | C (owner)/AD | `{reason}`; citizens can reopen within `REOPEN_WINDOW_DAYS` of the resolution. |
| POST | /api/complaints/{id}/remarks/ | O/AD | `{remarks, is_public?}` → 201 TimelineEvent (internal note when `is_public=false`). |
| POST | /api/complaints/{id}/override-ai/ | AD | `{category?, severity?, priority_score?, reason}` → ComplaintDetail (audited correction of the AI). |
| POST | /api/complaints/{id}/reanalyze/ | AD | Re-run the AI pipeline → ComplaintDetail + `analysis`. |
| POST | /api/complaints/{id}/close/ | AD | `{remarks?}` → ComplaintDetail (status closed). |

## Duplicate review

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | /api/duplicates/ | O/AD | Duplicate pairs in the caller's scope; filters `status`, `complaint`; ordered by similarity. |
| PATCH | /api/duplicates/{id}/ | O/AD | `{status: confirmed_duplicate \| not_duplicate, notes?}` → the reviewed pair. |

## AI engine

| Method | Path | Permission | Description |
|---|---|---|---|
| POST | /api/ai/analyze/ | A | Full analysis preview (vision, text, fusion, location risk, severity, priority, duplicates, department, recommended officer, steps); nothing is stored. Throttle `ai`. |
| POST | /api/ai/classify/ | A | `{image?, description?}` → `{vision, text, fusion, category, is_demo, mode}`. Throttle `ai`. |
| POST | /api/ai/priority/ | O/AD | `{complaint_id}` → recalculated PriorityBreakdown; or what-if inputs (+ optional `weights`) → engine output. Throttle `ai`. |
| POST | /api/ai/duplicates/ | A | `{complaint_id}` → re-run detection, `[DuplicateLink]`; or multipart `{description, latitude, longitude, image?}` → similar complaints nearby. Throttle `ai`. |
| POST | /api/ai/verify-resolution/ | O/AD | Multipart `{before_image, after_image, category?}` → verification engine output (nothing stored); or `{complaint_id}` → stored Verification. Throttle `ai`. |
| POST | /api/ai/sentiment/ | AD | `{text, rating?}` → sentiment engine output (model playground). Throttle `ai`. |
| GET | /api/ai/model-info/ | A | `get_model_info()` with the live AI configuration (models, component parameters, registry, mode, disclaimer) + `{config}`. |
| POST | /api/ai/demo/ | P | Public landing-page demo: multipart `{image?, description?}` (at least one; description ≤ 1000 characters) → `{vision, text, fusion, category, severity_hint {level, score, reason}, is_demo, mode, disclaimer, processing_time_ms}`; no database writes, credentials ignored. Throttle `ai_public`. |
| GET | /api/ai/config/ | O/AD | AIConfiguration (priority weights, thresholds, fusion, duplicate, hotspot, verification and automation settings) + `updated_by`, `updated_at`. |
| PUT | /api/ai/config/ | AD | Validated update (weights sum to 100, thresholds ordered), audit-logged; `?recalculate=true` recalculates the priority of open complaints. |
| PATCH | /api/ai/config/ | AD | Partial update (same validation as PUT). |

## System and reference data

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | /api/system/config/ | P | Public app configuration: model mode / demo badge, map defaults, upload limits, reopen window, statuses, levels. |
| GET | /api/risk-zones/ | O/AD | Non-paginated risk zones (schools, hospitals, markets, junctions ...) used by the location-risk engine. |
| POST | /api/risk-zones/ | AD | Create a risk zone. |
| GET | /api/risk-zones/{id}/ | O/AD | One risk zone. |
| PUT | /api/risk-zones/{id}/ | AD | Update a risk zone. |
| PATCH | /api/risk-zones/{id}/ | AD | Partial update. |
| DELETE | /api/risk-zones/{id}/ | AD | Delete a risk zone. |
| POST | /api/contact/ | P | Contact form `{name, email, subject, message}` → 201. Throttle `contact`. |
| GET | /api/contact/ | AD | Contact messages; filter `is_resolved`, `search`. |
| GET | /api/contact/{id}/ | AD | One contact message. |
| PATCH | /api/contact/{id}/ | AD | `{is_resolved}`. |
| GET | /api/geo/reverse/ | P | `?lat=&lng=` → `{address, area, city, pincode, display_name, source}` (Nominatim proxy, 24 h cache, graceful fallback). |
| GET | /api/geo/search/ | P | `?q=` → `[{display_name, latitude, longitude, address, area, city, pincode}]`. |
| GET | /api/audit-logs/ | AD | Audit trail; filters `action`, `entity_type`, `actor`, `date_from`, `date_to`, `search`. |
| GET | /api/audit-logs/{id}/ | AD | One audit entry. |

## Assignments

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | /api/assignments/ | O/AD | Assignments (admin: all, officer: own); filters `complaint`, `officer`, `is_active`. |
| POST | /api/assignments/ | AD | `{complaint, officer, notes?}` → 201 Assignment (a reassignment when one is active). |
| GET | /api/assignments/recommend/ | AD | `?complaint=<id>&limit=5` → ranked officers `{officer, score, workload, capacity, utilization, overloaded, distance_km, is_available, same_department, reasons, recommended}`. |
| GET | /api/assignments/{id}/ | O/AD | One assignment (officers: their own). |
| PUT | /api/assignments/{id}/ | AD | `{officer, notes?}` → reassigns the active assignment → new Assignment. |
| PATCH | /api/assignments/{id}/ | AD | Same as PUT. |

## Feedback

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | /api/feedback/ | A | Feedback (citizen: own, officer: their complaints, admin: all); filters `sentiment, rating, department, category, complaint, date_from, date_to`. |
| POST | /api/feedback/ | C | `{complaint, rating, text?}` → 201 Feedback + `suggest_reopen`; sentiment is analysed and the complaint is closed. |
| GET | /api/feedback/pending/ | C | Feedback requests `[{complaint: ComplaintMini, resolved_at}]`. |

## Notifications

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | /api/notifications/ | A | The caller's notifications; `?is_read=true\|false`. |
| GET | /api/notifications/unread-count/ | A | `{count}`. |
| POST | /api/notifications/read-all/ | A | Mark all as read → `{updated: n}`. |
| DELETE | /api/notifications/{id}/ | A | Delete one of the caller's notifications. |
| PUT | /api/notifications/{id}/read/ | A | Mark one as read → Notification. |
| POST | /api/notifications/{id}/read/ | A | Same as PUT. |

## Analytics (`/api/analytics/`)

Filters where sensible: `date_from`, `date_to`, `department`, `category`, `severity`, `status`. Time buckets are
computed in Python in `settings.TIME_ZONE` (no database date functions).

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | /api/analytics/dashboard/ | A | Role-aware dashboard: citizen (totals, recent and active complaint, feedback requests, notifications, civic points), officer (totals, workload, priority queue, recent activity), admin (= overview). |
| GET | /api/analytics/overview/ | AD | KPIs, status / severity / priority distributions, priority histogram, resolution-time buckets, recent critical complaints, hotspot count. |
| GET | /api/analytics/categories/ | AD | Per-category totals, open / resolved / critical, average priority and severity, resolution time and rate. |
| GET | /api/analytics/departments/ | AD | Per-department performance incl. SLA compliance, average rating, officer count and active workload. |
| GET | /api/analytics/trends/ | AD | `?period=day\|week\|month&days=90` → submitted / resolved / critical series, resolution-time trend, category series. |
| GET | /api/analytics/hotspots/ | O/AD | DBSCAN hotspot clusters + map points + recent alerts (`eps_m`, `min_samples`, `days`); officers see their department's complaints. |
| GET | /api/analytics/sentiment/ | AD | Feedback sentiment distribution, ratings, by department / category, over time, recent feedback and `top_keywords` (sentiment-lexicon opinion phrases merged with extracted keywords). |
| GET | /api/analytics/officers/ | AD | Per-officer workload (`active, capacity, utilization, overloaded`) and track record (resolved, resolution time, rating, critical). |
| GET | /api/analytics/ai/ | AD | AI performance: confidences, modality agreement, overrides, confusion pairs, duplicate precision, verification outcomes, processing time, model info. |
| GET | /api/analytics/public/ | P | Public aggregate statistics for the landing page (no personal data). |
| GET | /api/analytics/reports/ | AD | `?report=summary\|complaints\|departments\|officers\|feedback&format=json\|csv\|pdf` → JSON preview or file download (audit-logged). |
| POST | /api/analytics/run-checks/ | AD | Run the SLA breach check and the hotspot scan now → `{sla_alerts, hotspot_alerts}`. |
| GET | /api/analytics/alerts/ | AD | Hotspot alerts (`?is_acknowledged=`). |
| GET | /api/analytics/alerts/{id}/ | AD | One hotspot alert. |
| PATCH | /api/analytics/alerts/{id}/ | AD | `{is_acknowledged}`. |
