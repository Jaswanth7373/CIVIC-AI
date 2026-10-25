# CivicAI — Original Project Requirements

This is the requirement specification supplied by the student for the final-year project. Every requirement,
example and quoted string is kept; long bullet lists are condensed into comma-separated prose and the section
numbering follows the original (which ended mid-sentence in section 49, "All analytics must be dynamically
calculate[d]"). It is the source of truth for compliance reviews; `docs/BUILD_SPEC.md` is the engineering contract
derived from it.

**Project name:** CivicAI — *A Multimodal AI-Based Multi-Department Civic Issue Detection, Prioritization and
Resolution Platform*

## 1. Project objective

Build a complete AI-powered civic complaint management platform that allows citizens to report civic problems
using: image, text description, GPS/location. The system should automatically analyze the complaint using AI and:

1. Identify the civic issue.
2. Classify the issue.
3. Estimate severity.
4. Calculate priority.
5. Detect duplicate complaints.
6. Identify the appropriate department.
7. Recommend/assign an officer.
8. Track complaint progress.
9. Monitor resolution.
10. Verify resolution using before/after images.
11. Collect citizen feedback.
12. Perform sentiment analysis.
13. Identify geographical civic hotspots.
14. Provide analytics to administrators.

Complete lifecycle: Citizen Report → Image + Text + GPS → Data Preprocessing → Multimodal AI Analysis → Issue
Classification → Severity Assessment → Priority Calculation → Duplicate Detection → Department Routing → Officer
Assignment → Resolution → Before/After Verification → Citizen Feedback → Sentiment Analysis → Analytics Dashboard.

## 2. Civic issue categories

Initially: 1. Roads / Potholes, 2. Garbage / Waste, 3. Drainage / Waterlogging, 4. Streetlight / Electricity,
5. Water Supply / Water Leakage, 6. Open Manhole, 7. Road Cracks / Road Damage, 8. Fallen Tree / Obstruction,
9. Other. The architecture must allow additional categories to be added later from the admin panel/database
without changing the entire application.

## 3. Technology stack

- Frontend: React.js, Vite, Tailwind CSS, React Router, Axios, Framer Motion, Recharts, Leaflet, React-Leaflet,
  Lucide React.
- Backend: Python, Django, Django REST Framework, JWT authentication, Django CORS Headers, Pillow. Celery + Redis
  only where genuinely useful.
- Database: MySQL, Django ORM, Django migrations.
- AI / ML: Python, PyTorch, YOLO, OpenCV, scikit-learn, Pandas, NumPy, Hugging Face Transformers, Sentence
  Transformers.
- Maps: Leaflet, OpenStreetMap.
- Development: VS Code, Git, GitHub.
- Deployment: frontend Vercel; backend Render/Railway or equivalent; database MySQL-compatible cloud database.

## 4. Important requirement

A REAL, INTEGRATED, RUNNABLE PROJECT. Not: pseudocode, disconnected examples, incomplete code, fake buttons, static
dashboards, hardcoded analytics, HTML-only mockups, sample APIs that don't connect to the frontend, database models
that don't match the APIs, frontend pages that don't connect to the backend, AI features that are only described
but not implemented. Every major feature must actually work, e.g. Submit Complaint → Save to MySQL → Upload image →
Run AI analysis → Calculate severity → Calculate priority → Check duplicates → Route department → Create
notification → Display result.

## 5. User roles — A. Citizen

Register, login, logout, view profile, edit profile, upload profile image, submit complaint, upload image, enter
description, capture GPS location, select location manually, view complaint, view AI analysis, view severity, view
priority, view department, track complaint, view complaint history, receive notifications, submit feedback, rate
resolution, view resolution evidence, reopen complaint where applicable.

Citizen dashboard: total complaints, pending complaints, in-progress complaints, resolved complaints, recent
complaints, complaint timeline, notifications, feedback requests.

## 6. Officer role

Login, view assigned complaints, search complaints, filter complaints, sort by priority, view complaint details,
view citizen description, view complaint image, view GPS location, view map, view AI prediction, view severity,
view priority, accept complaint, update status, add remarks, upload before image, upload after image, request
manual verification, mark complaint resolved. Statuses: Assigned, Accepted, In Progress, Resolved, Rejected,
Reopened.

## 7. Admin role

Login, view all complaints, manage citizens, manage officers, manage departments, manage civic categories, assign
officers, reassign complaints, view AI predictions, view critical complaints, view duplicate complaints, view hotspot
maps, view analytics, view department performance, view officer workload, view citizen feedback, view sentiment
analytics, manage AI configuration, view model information, override AI predictions, generate reports.

## 8. Frontend pages

Public: 1 Landing Page, 2 About, 3 Features, 4 How It Works, 5 Contact, 6 Login, 7 Register.
Citizen: 8 Citizen Dashboard, 9 Submit Complaint, 10 My Complaints, 11 Complaint Details, 12 Complaint Tracking,
13 Profile, 14 Notifications, 15 Feedback.
Officer: 16 Officer Dashboard, 17 Assigned Complaints, 18 Complaint Details, 19 Resolution Update, 20 Resolution
Verification.
Admin: 21 Admin Dashboard, 22 All Complaints, 23 Complaint Management, 24 User Management, 25 Officer Management,
26 Department Management, 27 AI Analytics, 28 Hotspot Map, 29 Feedback Analytics, 30 Reports, 31 System/AI Settings.

## 9. UI/UX

A professional smart-city themed application that looks like a real commercial civic management platform, not a
basic college CRUD project. Use modern cards, tables, charts, maps, filters, search, modals, toast messages, loading
animations, empty states, error states, confirmation dialogs, responsive layouts, professional icons — with Tailwind
CSS, Framer Motion, Lucide icons, Recharts. Support light mode and dark mode. Work on desktop, laptop, tablet,
mobile.

## 10. Landing page

Hero: "CivicAI" / "AI-Powered Civic Issue Management". Subtitle: "Report civic issues using image, text and
location. CivicAI uses artificial intelligence to identify, prioritize and route complaints for efficient
resolution." Buttons: "Report an Issue", "Explore Dashboard". Sections: How CivicAI Works, AI Issue Detection,
Multimodal AI, Smart Prioritization, Duplicate Detection, Automatic Department Routing, Resolution Verification,
Citizen Feedback, Smart City Analytics.

## 11. Complaint submission

Fields: image, description, category, GPS location, address, date/time. Features: drag-and-drop image, image
preview, remove image, GPS detection, manual map selection, address display, form validation. On "Analyze &
Submit": Validate → Upload image → Save complaint → Image AI analysis → Text NLP analysis → Multimodal
classification → Severity → Priority → Duplicate detection → Department routing → Officer recommendation → Database
save → Notification → Display AI result.

## 12. Computer vision

AI-based civic image analysis, YOLO where appropriate. Classes: pothole, garbage, drainage, streetlight, water_leak,
open_manhole, road_crack, fallen_tree, other. Return `{"category": "pothole", "confidence": 0.92,
"detected_objects": [], "bounding_boxes": []}`. Create `backend/ai/vision/` with model.py, inference.py,
preprocessing.py, postprocessing.py, config.py.

## 13. Demo AI mode

The project MUST work even when trained models are unavailable: `MODEL_MODE=demo` (deterministic/sample logic so
the whole workflow can be demonstrated) and `MODEL_MODE=production` (load actual trained models). Never pretend demo
predictions are real trained-model predictions; clearly display "Demo AI Mode" when demo mode is active.

## 14. NLP analysis

Example input "Large pothole near the school entrance causing traffic problems." → Category: Pothole, Severity:
High, Potential Impact: Public Safety, Keywords: pothole, school, traffic. Implement `backend/ai/nlp/`
text_preprocessor.py, classifier.py, embedding.py, sentiment.py, keyword_extractor.py using Sentence Transformers,
Hugging Face Transformers and NLP preprocessing.

## 15. Multimodal AI

Combine IMAGE + TEXT + LOCATION in one pipeline (e.g. image pothole, text "Large pothole near school causing traffic
problems.", location high-traffic area → Category Pothole, Severity High, Priority calculated, Department Roads).
The final category should use available image and text information rather than blindly trusting one modality.

## 16. Severity assessment

Levels Low / Medium / High / Critical. Factors: visual severity, issue type, public safety, location, potential
impact, number of nearby complaints, complaint frequency. Return `{"severity": "High", "score": 84, "reason":
"Large road damage detected near a high-traffic area."}`.

## 17. Priority engine

Dedicated priority engine, 0–100. Factors: severity, public safety impact, location risk, complaint frequency,
duplicate count, issue category. Configurable weights (suggested: Severity 40%, Public Impact 25%, Location Risk
15%, Frequency 10%, Duplicate Count 10%). Create `backend/ai/priority/` priority_engine.py, priority_rules.py,
priority_config.py. Levels: 0–25 Low, 26–50 Medium, 51–75 High, 76–100 Critical. Weights configurable; the
calculation must not be hardcoded inside a Django view.

## 18. Priority explanation

Every priority score includes an explanation, e.g. "Priority Score: 87/100 — Severity: 35/40, Public Impact: 25/25,
Location Risk: 12/15, Frequency: 8/10, Duplicates: 7/10 — High priority because the issue has high severity,
significant public impact and multiple nearby complaints."

## 19. Duplicate complaint detection

Compare text similarity, image similarity and location similarity using Sentence Transformer embeddings, cosine
similarity, perceptual image hashing and GPS distance. Create `backend/ai/duplicate/` text_similarity.py,
image_similarity.py, location_similarity.py, duplicate_engine.py. Example: "Large pothole near school." vs "Big road
pothole outside school." at the same/nearby GPS → Potential Duplicate, Similarity 89%, Original Complaint C001. Do
NOT automatically delete duplicates: link complaints, show similarity, show the original, allow admin/officer
confirmation.

## 20. Department routing

Configurable mapping stored in the database and modifiable by the admin (not only frontend hardcoding). Default:
Pothole → Roads; Road Crack → Roads; Garbage → Waste Management; Drainage → Drainage; Waterlogging → Drainage;
Streetlight → Electrical; Water Leakage → Water Supply; Open Manhole → Roads/Drainage; Fallen Tree → Parks/Public
Works; Other → General Civic Department.

## 21. Officer assignment

Factors: department, officer workload, availability, location, priority. Admin sees the recommended officer and
workload; admin can assign, reassign, override the recommendation.

## 22. Map and GPS

Leaflet + OpenStreetMap: detect current location, select location, display marker, display complaint details,
complaint clustering, filters, hotspot map, category / severity / status filtering.

## 23. Hotspot analysis

Geographical hotspot detection with DBSCAN (or another suitable clustering method) on latitude/longitude. Output:
cluster, complaint count, dominant issue, severity, area. Admin filters: date, category, severity, department.
Display: interactive map, cluster markers, complaint density, statistics.

## 24. Resolution tracking

Lifecycle SUBMITTED → AI ANALYSIS → ASSIGNED → ACCEPTED → IN PROGRESS → RESOLVED → VERIFIED → FEEDBACK. Store every
status change with old_status, new_status, changed_by, timestamp, remarks.

## 25. Before/after resolution verification

Officer uploads before and after images; use OpenCV, image similarity, structural comparison and image embeddings
where appropriate. Output: Likely Resolved / Partially Resolved / Not Resolved / Needs Manual Review, plus a
verification score and explanation (e.g. "Resolution Verification Score: 91/100 — Status: Likely Resolved — Reason:
The after-image shows substantial visual change in the previously detected damaged area."). Call it AI-assisted
verification, not guaranteed verification; allow admin/officer manual override.

## 26. Citizen feedback

After resolution the citizen submits a 1–5 star rating and text feedback (e.g. "Road was repaired properly and
quickly."). Store rating, feedback, citizen, complaint, timestamp.

## 27. Sentiment analysis

Classes Positive / Neutral / Negative (e.g. "The issue was resolved quickly." → Positive). Admin dashboard shows
positive %, neutral %, negative %, average rating, sentiment by department, by category and over time.

## 28. Notification system

In-app notifications. Citizen: complaint submitted, AI analysis completed, department assigned, officer assigned,
status changed, complaint resolved, resolution verified, feedback requested. Officer: new assignment, critical
complaint, reassignment. Admin: critical complaint, high-priority unresolved complaint, hotspot alert. Notification
bell and notification page.

## 29. Admin dashboard

Cards: total complaints, pending, in progress, resolved, critical, average resolution time, average rating.
Charts (Recharts): complaints by category, by department, over time, status distribution, severity distribution,
priority distribution, sentiment distribution, citizen satisfaction, resolution time, hotspots. All values must come
from the database.

## 30. Officer dashboard

Assigned complaints, critical complaints, pending, in progress, resolved, average resolution time. Table: Complaint
ID, Category, Location, Priority, Severity, Status, Date, Action.

## 31. Citizen dashboard

Total complaints, pending, in progress, resolved. Recent complaints: Complaint ID, Category, Priority, Status, Date.
Also notifications, tracking timeline, feedback requests.

## 32. Database

MySQL with Django ORM. Models: User, CitizenProfile, OfficerProfile, Department, CivicCategory, Complaint,
ComplaintImage, Location, AIPrediction, PriorityScore, DuplicateComplaint, ComplaintAssignment, StatusHistory,
ResolutionEvidence, ResolutionVerification, Feedback, Notification, AuditLog.

## 33–40. Model fields

- **Complaint:** id, complaint_number, citizen, category, description, status, severity, severity_score,
  priority_score, priority_level, department, assigned_officer, location, created_at, updated_at, resolved_at.
- **Location:** latitude, longitude, address, city, area, pincode.
- **AIPrediction:** complaint, image_category, image_confidence, text_category, text_confidence, final_category,
  multimodal_confidence, explanation, model_version, created_at.
- **PriorityScore:** complaint, severity_component, impact_component, location_component, frequency_component,
  duplicate_component, final_score, priority_level, explanation.
- **DuplicateComplaint:** complaint, similar_complaint, text_similarity, image_similarity, location_similarity,
  overall_similarity, status (Pending Review / Confirmed Duplicate / Not Duplicate).
- **Resolution:** complaint, before_image, after_image, uploaded_by, remarks, uploaded_at; verification: score,
  status, explanation, verified_by, verified_at.
- **Feedback:** complaint, citizen, rating, text, sentiment, sentiment_score, created_at.
- **Notification:** user, title, message, notification_type, is_read, created_at.

## 41. Database indexing

Indexes for complaint status, category, department, priority, severity, created_at, latitude, longitude; proper
foreign keys and relationships.

## 42. Backend API

- Authentication: POST /api/auth/register/, POST /api/auth/login/, POST /api/auth/refresh/, POST /api/auth/logout/,
  GET /api/auth/profile/.
- Complaints: POST /api/complaints/, GET /api/complaints/, GET /api/complaints/{id}/, PUT /api/complaints/{id}/,
  DELETE /api/complaints/{id}/.
- AI: POST /api/ai/analyze/, /api/ai/classify/, /api/ai/priority/, /api/ai/duplicates/, /api/ai/verify-resolution/.
- Departments: GET, POST /api/departments/, PUT /api/departments/{id}/.
- Officers: GET, POST /api/officers/, PUT /api/officers/{id}/.
- Assignments: POST /api/assignments/, PUT /api/assignments/{id}/.
- Feedback: POST, GET /api/feedback/.
- Analytics: GET /api/analytics/overview/, categories/, departments/, trends/, hotspots/, sentiment/.
- Notifications: GET /api/notifications/, PUT /api/notifications/{id}/read/.

## 43. Authentication and security

JWT, password hashing, role-based permissions, protected routes, CORS, input validation, file validation, image size
restrictions, environment variables. Never store plain-text passwords; never expose secrets. Use .env and
.env.example (SECRET_KEY, DEBUG, DATABASE_NAME, DATABASE_USER, DATABASE_PASSWORD, DATABASE_HOST, DATABASE_PORT,
JWT_SECRET, MODEL_PATH).

## 44. Project structure

Backend: `backend/manage.py`, `config/` (settings, urls, wsgi, asgi), `apps/` (accounts, complaints, departments,
officers, assignments, feedback, notifications, analytics, audit), `ai/` (vision, nlp, priority, duplicate,
geospatial, verification), `scripts/`, `media/`, `static/`, `requirements.txt`, `.env.example`, `README.md`.
Frontend: `frontend/package.json`, `vite.config.js`, `src/` (components, pages/{public,citizen,officer,admin},
services, context, hooks, utils, assets, App.jsx).

## 45. Authentication flow

Register → Login → JWT access token → refresh token → protected routes → role verification → dashboard. After login:
Citizen → Citizen Dashboard, Officer → Officer Dashboard, Admin → Admin Dashboard.

## 46. Role-based routing

`/citizen/*`, `/officer/*`, `/admin/*`; prevent unauthorized users from accessing other dashboards.

## 47. Complaint detail page

Complaint ID, category, description, image, location, map, date, citizen, severity, priority, AI confidence, AI
explanation, department, officer, status, timeline, duplicate information, resolution evidence, verification result,
citizen feedback.

## 48. Complaint timeline

Complaint Submitted → AI Analysis Completed → Priority Assigned → Department Assigned → Officer Assigned → Accepted →
In Progress → Resolved → Verified → Citizen Feedback, with a timestamp for each event.

## 49. Analytics

All analytics must be dynamically calculated (from the database).
