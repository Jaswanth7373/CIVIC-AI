# CivicAI — Build Specification (binding contract for every contributor)

CivicAI: *A Multimodal AI-Based Multi-Department Civic Issue Detection, Prioritization and Resolution Platform.*
Citizens report civic issues (photo + description + GPS). The AI engine classifies, scores severity and priority,
detects duplicates, routes to a department, recommends/assigns an officer; officers resolve with before/after
evidence that is AI-verified; citizens give feedback that is sentiment-analysed; admins get live analytics and
DBSCAN hotspot maps.

**Everything must really work end-to-end** — no fake buttons, no hardcoded analytics, no static dashboards, no
mock APIs. Every number on every page comes from the database through the REST API.

Repository root: `C:\Users\jaswa\Downloads\civic project` (Windows 11; Git Bash and PowerShell available).

```
backend/          Django 5.2 + DRF project (Python 3.13, venv at backend/venv, --system-site-packages)
  config/         settings.py, urls.py, celery.py, wsgi.py, asgi.py          (DONE - do not restructure)
  apps/<app>/     core accounts departments officers complaints assignments feedback notifications analytics audit
  ai/             framework-independent AI engine (NO Django imports anywhere inside ai/)
  scripts/        training / data generation / evaluation scripts
  sample_data/    generated demo images (committed)
  ml_models/      model weights / caches (git-ignored)
  media/          uploads (git-ignored)
frontend/         React 19 + Vite 7 + Tailwind 4 web app (installable PWA)
docs/             this spec + architecture docs
```

Run Python with `backend/venv/Scripts/python.exe` (cwd `backend/`). Dev DB = SQLite (`backend/.env` has
`DB_ENGINE=sqlite`); production DB = MySQL 8. Installed: Django 5.2.18, djangorestframework 3.18, simplejwt 5.5,
django-filter 26, django-cors-headers 4.9, numpy 2.4, pandas 3.0, scipy 1.17, scikit-learn 1.8,
**opencv-python-headless 5.0** (cv2 API as in 4.x for everything we need — verify by running code),
ImageHash 4.3, Pillow 12, reportlab 5.0, celery 5.6, redis 8, torch 2.14, transformers 5.17,
sentence-transformers 6.1. **Not installed:** ultralytics (YOLO) — code must import it lazily and degrade
gracefully. Frontend: react 19.3, react-router-dom 7.18, axios 1.20, framer-motion 12.43, recharts 3.10,
leaflet 1.9.4, react-leaflet 5.0, leaflet.markercluster 1.5.3, lucide-react 1.59 (legacy icon aliases such as
`AlertTriangle`, `CheckCircle2`, `Loader2` exist; brand icons such as `Github` do NOT), clsx, tailwind-merge 3,
date-fns 4, tailwindcss 4.3 (`@tailwindcss/vite`).

---------------------------------------------------------------------------------------------------------------

## 0. Ground rules (all contributors)

1. **Stay inside the files you own** (ownership table in §6). If you need something in a file you don't own,
   code against the contract here and mention the need in your final report. Never rewrite another owner's file.
2. **Stubs are contracts.** Files that currently `raise NotImplementedError` define exact names, signatures and
   return shapes. Implement them *in place* keeping signatures. Adding optional kwargs is fine; removing or
   renaming is not.
3. **Models are final** (`apps/*/models.py`, written already, migrations exist). Do not edit models. If a model
   change is unavoidable, stop and report it instead.
4. **Cross-app imports inside functions** (lazy) in service modules, to avoid circular imports, e.g.
   `def f(): from apps.notifications.services import notify`.
5. **MySQL compatibility**: do NOT use DB date-truncation/extract functions (`TruncDate`, `TruncMonth`,
   `ExtractHour`, `__date` lookups on aggregated querysets...) for analytics — MySQL time-zone tables are often
   missing and return NULL. Fetch timestamps and bucket in Python/pandas (convert to `settings.TIME_ZONE`).
   Do not use JSONField `__contains` lookups, `distinct(*fields)` or Postgres-only features. Plain filters,
   `annotate(Count/Avg/Sum)`, `values().annotate()` are fine.
6. **Security**: every endpoint has explicit permission classes (`apps.core.permissions`). Object-level checks
   for citizens (own data only) and officers (assigned/department only). Validate uploads with
   `apps.core.validators.validate_image_upload`. Never log or return secrets. Passwords are only set via
   `set_password` / `create_user`.
7. **Errors**: raise DRF exceptions / `apps.core.exceptions.ServiceError` / `TransitionNotAllowed`; the global
   handler produces `{"detail": str, "errors"?: {field: [msg]}, "code": str}`.
8. **Media URLs** in API responses are absolute (`request.build_absolute_uri(file.url)`); pass `request` in
   serializer context. Use `apps.core.utils.absolute_media_url(request, field)`.
9. **Timestamps** are ISO-8601 strings with offset (DRF default). Numbers are JSON numbers
   (`COERCE_DECIMAL_TO_STRING=False`).
10. **Routers**: use `rest_framework.routers.SimpleRouter(trailing_slash=True)` or explicit `path()`s. Never
    `DefaultRouter`. All URLs end with `/`.
11. **Honest AI**: demo-mode results always carry `is_demo: true`, `mode: "demo"`, a demo `model_version` and an
    explanation that says it is a demo technique. Production fallbacks report `fallback_reason`.
12. **Tests**: `cd backend && venv/Scripts/python.exe manage.py test` must pass. AI unit tests live in
    `backend/ai/tests/test_*.py`, use `unittest`, and must not import Django. App tests live in
    `apps/<app>/tests.py` (or `tests/` package) using `django.test.TestCase` / `rest_framework.test.APITestCase`.
13. **Quality bar**: production-grade, readable code with docstrings; no TODO placeholders; no dead code; logging
    via `logging.getLogger("ai.<module>")` / `logging.getLogger("apps.<app>")`.

---------------------------------------------------------------------------------------------------------------

## 1. Data model summary (source of truth = `backend/apps/*/models.py`)

| Model | App | Key fields |
|---|---|---|
| User | accounts | email (login), first_name, last_name, role (`citizen`/`officer`/`admin`), phone, avatar, is_active; props `full_name`, `is_citizen`, `is_officer`, `is_admin_role` |
| CitizenProfile | accounts | user (PK), address, area, city, pincode, date_of_birth, gender, preferred_language, email_notifications, civic_points (auto-created for citizens by signal) |
| OfficerProfile | officers | user (PK → officer id == user id), department, employee_id, designation, zone, base_latitude/longitude, max_active_complaints, is_available, skills, joined_on; prop `active_workload` |
| Department | departments | name, code, description, email, phone, head_name, icon, color, sla_hours, is_active |
| CivicCategory | departments | name, slug, description, icon, color, **department** (routing), secondary_department, keywords[], vision_labels[], base_severity (0-100), public_safety_weight (0-1), sla_hours, is_active, sort_order; `effective_sla_hours`, `to_engine_dict()` |
| Location | complaints | latitude, longitude (Decimal 9,6), address, landmark, area, city, pincode |
| Complaint | complaints | complaint_number (`CIV-YYYY-000123`, auto), citizen, title, description, reported_category, category, status, severity, severity_score, priority_score, priority_level, department, assigned_officer, location (1:1), incident_at, duplicate_of, duplicate_count, reopen_count, is_ai_overridden, needs_manual_review, sla_due_at, created_at, updated_at, accepted_at, resolved_at, verified_at, closed_at; status groups `PENDING_STATUSES`, `IN_PROGRESS_STATUSES`, `RESOLVED_STATUSES`, `OPEN_STATUSES`, `OPEN_ASSIGNED_STATUSES`; props `latest_prediction`, `latest_priority`, `latest_verification`, `primary_image`, `is_open`, `is_overdue`; `compute_sla_due()` |
| ComplaintImage | complaints | complaint, image, kind, phash, dhash, width, height, file_size |
| AIPrediction | complaints | image_category/confidence, text_category/confidence, final_category (FK) + final_category_slug, multimodal_confidence, severity, severity_score, severity_reason, severity_factors, detected_objects, bounding_boxes, keywords, impacts, probabilities, modality_weights, location_risk, explanation, needs_review, model_mode, is_demo, model_version, processing_time_ms, raw_output |
| PriorityScore | complaints | severity/impact/location/frequency/duplicate _component, final_score, priority_level, weights, factors, explanation, trigger, is_override, created_by |
| DuplicateComplaint | complaints | complaint (newer), similar_complaint (original), text/image/location/overall_similarity, distance_m, category_match, status (`pending_review`/`confirmed_duplicate`/`not_duplicate`), explanation, reviewed_by/at, review_notes |
| StatusHistory | complaints | complaint, **event** (see `StatusHistory.Event`), old_status, new_status, changed_by (null = system/AI), remarks, metadata, is_public, timestamp |
| ResolutionEvidence | complaints | complaint, before_image, after_image, uploaded_by, remarks, uploaded_at |
| ResolutionVerification | complaints | complaint, evidence, score, status (`likely_resolved`/`partially_resolved`/`not_resolved`/`needs_manual_review`), explanation, metrics, method (`ai_assisted`/`manual`), is_manual_override, manual_review_requested, verified_by, verified_at, model_version, is_demo |
| ComplaintAssignment | assignments | complaint, officer, department, assigned_by (null=auto), assignment_type (`auto`/`manual`/`reassignment`), status (`active`/`completed`/`reassigned`/`rejected`/`cancelled`), is_active, recommendation_score, recommendation_reasons, notes, assigned_at, accepted_at, completed_at |
| Feedback | feedback | complaint, citizen, rating 1-5, text, sentiment (`positive`/`neutral`/`negative`), sentiment_score (-1..1), sentiment_confidence, sentiment_model, is_demo |
| Notification | notifications | user, title, message, notification_type (see `Notification.Type`), level (`info`/`success`/`warning`/`critical`), complaint, link, is_read, read_at |
| AuditLog | audit | actor, action (see `AuditLog.Action`), entity_type, entity_id, description, changes, ip_address, user_agent |
| HotspotAlert | analytics | cluster_key, latitude, longitude, radius_m, complaint_count, dominant_category, severity, area_name, complaint_ids, is_acknowledged |
| AIConfiguration | core | singleton (`AIConfiguration.load()`), priority weights, thresholds, fusion, duplicate, hotspot, verification, automation settings; `to_engine_config()` |
| RiskZone | core | name, zone_type, latitude, longitude, radius_m, risk_level 1-5, is_active; `to_engine_dict()` |
| ContactMessage | core | name, email, subject, message, is_resolved |

**Complaint lifecycle**
`submitted → analyzed → assigned → accepted → in_progress → resolved → verified → closed`, plus `rejected` and
`reopened`. Groups: pending = submitted/analyzed/assigned/reopened; in-progress = accepted/in_progress;
resolved = resolved/verified/closed.

**Default reference data** (created by `python manage.py init_civicai`, see §6 owner B1):

| slug | Category name | icon | color | Department (code) | secondary | base_severity | safety | sla h |
|---|---|---|---|---|---|---|---|---|
| pothole | Roads / Potholes | construction | #D9480F | Roads Department (ROADS) | – | 60 | 0.75 | – |
| garbage | Garbage / Waste | trash-2 | #9C6B30 | Waste Management (WASTE) | – | 40 | 0.45 | – |
| drainage | Drainage / Waterlogging | waves | #0B8EA8 | Drainage Department (DRAIN) | – | 55 | 0.60 | – |
| streetlight | Streetlight / Electricity | lightbulb | #E0A800 | Electrical Department (ELEC) | – | 45 | 0.60 | – |
| water_leak | Water Supply / Water Leakage | droplets | #3B5BDB | Water Supply (WATER) | – | 50 | 0.40 | – |
| open_manhole | Open Manhole | circle-dot | #C92A2A | Roads Department (ROADS) | DRAIN | 85 | 0.95 | 12 |
| road_crack | Road Cracks / Road Damage | activity | #9C36B5 | Roads Department (ROADS) | – | 40 | 0.50 | – |
| fallen_tree | Fallen Tree / Obstruction | tree-deciduous | #2F9E44 | Parks & Public Works (PARKS) | – | 65 | 0.80 | 24 |
| other | Other | circle-help | #6B7C85 | General Civic Department (GEN) | – | 30 | 0.30 | – |

Departments: ROADS "Roads Department" (icon traffic-cone, #D9480F, SLA 72h), WASTE "Waste Management" (recycle,
#9C6B30, 48h), DRAIN "Drainage Department" (waves, #0B8EA8, 48h), ELEC "Electrical Department" (zap, #E0A800,
48h), WATER "Water Supply" (droplets, #3B5BDB, 24h), PARKS "Parks & Public Works" (trees, #2F9E44, 48h),
GEN "General Civic Department" (landmark, #6B7C85, 96h).
Category keywords include English + common Indian-English/Hinglish/Telugu words (e.g. pothole: pothole, pit,
crater, gaddha, khadda, broken road; garbage: garbage, trash, waste, dump, kachra, chetta; drainage: drain,
sewage, waterlogging, flooded, nala, overflow; streetlight: streetlight, light not working, dark, pole, bulb,
current, bijli, electric wire; water_leak: leak, pipeline, burst, water wastage, paani, tap; open_manhole: manhole,
open drain cover, uncovered; road_crack: crack, damaged road, uneven, broken asphalt; fallen_tree: tree, branch,
fallen, uprooted, chettu, obstruction, blocked road).
Vision labels per category = its slug plus synonyms (e.g. pothole: ["pothole", "road_hole"], garbage:
["garbage", "trash", "litter", "waste_pile"], ...).

---------------------------------------------------------------------------------------------------------------

## 2. AI engine (`backend/ai/`) — interfaces and behaviour

Shared: `ai/config.py` (`get_model_mode()`, `is_demo_mode()`, `MODEL_PATH`, `YOLO_WEIGHTS`,
`TEXT_EMBEDDING_MODEL`, `SENTIMENT_MODEL`, `CLIP_MODEL`, `HF_CACHE_DIR`, `DEVICE`, `CIVIC_CLASSES`,
`CLASS_LABELS`, `score_to_level(score, thresholds)`, `DEMO_DISCLAIMER`), `ai/common/registry.py`
(`get_or_load(key, loader)`, `set_status(...)`, `get_statuses()`, `reset_registry()`), `ai/exceptions.py`.
Every module reads the mode at call time (`get_model_mode()`), caches heavy models with `get_or_load`, and reports
its status with `set_status`. Image inputs everywhere accept: `str`/`Path` path, `bytes`, `PIL.Image`, or BGR
`numpy.ndarray` (write one shared loader in `ai/vision/preprocessing.py`: `load_image(image) -> np.ndarray BGR`,
honouring EXIF orientation; other modules import it).

### 2.1 Vision — `ai/vision/` (owner A1)
Files: `config.py`, `preprocessing.py`, `model.py`, `inference.py`, `postprocessing.py`, `__init__.py`
(+ `dataset.yaml` for YOLO training).
- `analyze_image(image, *, filename_hint=None, categories=None) -> dict` — shape in the stub
  (`category, confidence, probabilities, detected_objects[{label, confidence, box, area_ratio}],
  bounding_boxes[[x1,y1,x2,y2] normalised 0-1], visual_severity 0-1, quality{width,height,blur_score,brightness,
  is_blurry,is_dark}, model_version, mode, is_demo, fallback_reason, explanation, processing_time_ms`).
  Probabilities cover all `CIVIC_CLASSES` (+ any admin category whose `vision_labels` match a detector label).
- `describe_models() -> list[dict]` — `{name, task, framework, version, status, is_demo, detail}`.
- **Production**: (1) YOLO via `ultralytics` if importable AND `YOLO_WEIGHTS` exists → detections mapped to
  classes; (2) else CLIP zero-shot classification with `sentence_transformers.SentenceTransformer(CLIP_MODEL)`
  (image + text prompts per class, e.g. "a photo of a pothole on a road"; admin categories add prompts from
  their name/description) with an approximate region box from OpenCV saliency/contours, labelled approximate;
  (3) else demo technique with `fallback_reason`.
- **Demo** (deterministic, OpenCV only): colour/texture/shape features — HSV green ratio (vegetation →
  fallen_tree), dark elliptical blobs on grey textured ground (pothole), circular dark contour with rim
  (open_manhole, `HoughCircles`), thin dark line networks (`Canny` + `HoughLinesP`, road_crack), many small
  saturated multi-colour contours (garbage), dark scene with bright point/pole (streetlight), large
  reflective/bluish-brown water region (drainage), bluish/wet streak + pipe-like structure (water_leak). Softmax
  over feature scores; confidence capped at 0.75. If the filename contains a class keyword (e.g.
  `pothole_03.jpg`) the hint may raise confidence up to 0.90 and the explanation MUST say a filename hint was
  used. Bounding boxes come from the actual contour(s) that drove the decision. `visual_severity` from box area
  ratio, darkness/contrast of the defect region and number of detections. `model_version`
  `"demo-opencv-heuristic-1.0"`.
- Also: `scripts/generate_sample_images.py` (owner A1) creates deterministic synthetic demo photos into
  `backend/sample_data/images/<slug>/<slug>_<n>.jpg` (≥6 per class, 640×480, realistic-ish procedural textures)
  plus repaired "after" images `backend/sample_data/images/after/<slug>_<n>_after.jpg` (same scene, defect
  repaired) and "unchanged" after images for negative tests. Demo heuristics must classify the generated
  images correctly at ≥80% top-1 (write `scripts/evaluate_vision.py` that prints a confusion matrix).
  `scripts/train_yolo.py` + `ai/vision/dataset.yaml` document & run real YOLOv8 training (ultralytics) on a
  YOLO-format dataset (e.g. Roboflow pothole / TACO garbage), exporting to `ml_models/yolo/civicai_yolov8.pt`.

### 2.2 NLP — `ai/nlp/` (owner A2)
Files: `text_preprocessor.py`, `classifier.py`, `embedding.py`, `sentiment.py`, `keyword_extractor.py`,
`impact.py`, `__init__.py`, `data/complaint_corpus.csv`, `data/feedback_corpus.csv`.
- `analyze_text(text, *, categories=None) -> dict` (shape in stub): category/confidence/probabilities,
  keywords, impacts[{type,label,score,evidence}] (types: public_safety, traffic, health, environment, property,
  service_disruption, accessibility), primary_impact, safety_score, urgency_score, severity_hint
  (low/medium/high/critical), severity_hint_score, location_mentions, clean_text, language, model_version, mode,
  is_demo, explanation, processing_time_ms. Example: "Large pothole near the school entrance causing traffic
  problems." → pothole, high, Public Safety, keywords pothole/school/traffic.
- `text_preprocessor`: unicode normalisation, lowercasing, URL/emoji/punctuation cleanup, tokenisation, stopwords
  (own list), light lemmatisation, **synonym normalisation incl. Hinglish/Telugu romanised words** (gaddha →
  pothole, kachra/chetta → garbage, nala → drain, bijli/current → electricity, paani/neeru → water, chettu → tree),
  `preprocess(text) -> {"clean", "tokens", "normalized", "language"}`.
- `classifier`: demo = TF-IDF (word 1-2 grams + char 3-5 grams) + LogisticRegression trained on
  `data/complaint_corpus.csv` (generate ≥60 varied labelled rows per class with templates — Indian English,
  Hinglish, typos, severity cues; commit the CSV), cached to `MODEL_PATH/nlp/text_clf_demo.joblib`, retrained
  automatically if missing/stale; production = Sentence-Transformer embeddings (`TEXT_EMBEDDING_MODEL`) +
  LogisticRegression head trained on the same corpus (cached). Both blend in **keyword scores from DB category
  keywords** (`categories` arg) so admin-added categories work without retraining.
- `embedding.get_text_embedder()` — `.encode(list) -> np.ndarray (L2 normalised)`, `.similarity(a,b) -> 0..1`,
  `.name`, `.is_demo`. Demo: TF-IDF (word+char) fitted on corpus with synonym normalisation (so "Large pothole
  near school" vs "Big road pothole outside school" ≳ 0.6). Production: all-MiniLM-L6-v2.
- `sentiment.analyze_sentiment(text, rating=None)` (shape in stub). Demo: lexicon with negation, intensifiers,
  civic phrases ("resolved quickly" +, "still not fixed" −, "no action" −, "waste of time" −). Production:
  `cardiffnlp/twitter-roberta-base-sentiment-latest` via transformers pipeline. Empty text → rating-only.
  "The issue was resolved quickly." → positive.
- `keyword_extractor.extract_keywords(text, top_k=6)`: demo TF-IDF/RAKE-style + domain dictionary boost;
  production KeyBERT-style ranking with the sentence embedder (implement manually, no keybert package).
- `describe_models()`; `scripts/train_text_classifier.py` trains + prints accuracy / macro-F1 / confusion matrix on
  a stratified hold-out split (useful for the project report).

### 2.3 Multimodal fusion — `ai/multimodal/fusion.py` (owner A3)
`fuse_predictions(image_result, text_result, *, reported_category, location_prior, categories, config)` →
stub shape. Confidence-weighted late fusion over the union of classes: modality weight × modality confidence
(image weight reduced for blurry/dark images and in demo mode when image confidence is low), citizen's reported
category as a weak prior (≈0.10–0.15), nearby-complaint category distribution as a weak location prior (≈0.05–0.10).
Never blindly trusts one modality. `agreement`: agree / disagree / single_modality / none. `needs_review` when
modalities disagree with both confident (>0.6), when fused top-2 margin < 0.1, or fused confidence <
`min_confidence`. Explanation e.g. "Image model detected pothole (88%) and the text classifier agreed (91%);
fused confidence 93%."

### 2.4 Severity — `ai/severity/severity_engine.py` (+ `severity_config.py`) (owner A3)
`assess_severity(...)` → `{"severity", "score" 0-100, "reason", "factors"{key:{value,weight,contribution,label}}}`.
Factors: visual severity, issue type (category base_severity), public safety (category safety weight + text
safety_score), location risk, potential impact (text impacts), nearby complaints count, complaint frequency.
Configurable factor weights (sum 1). Level via `score_to_level(score, thresholds)`. Reason is a specific
human sentence built from the top factors ("Large road damage detected near a high-traffic area.").

### 2.5 Priority — `ai/priority/` (owner A3)
Files: `priority_engine.py`, `priority_rules.py`, `priority_config.py`.
`PriorityEngine(config).calculate(inputs)` (stub shape). Default weights severity 40, public_impact 25,
location_risk 15, frequency 10, duplicates 10 (configurable, normalised to 100). Component = weight × factor (0-1);
factors: severity = severity_score/100; public impact = max/blend of text safety/impacts and category safety
weight; location risk = location_risk.score; frequency = saturating `1 - exp(-k·nearby_same_category)`;
duplicates = saturating on duplicate_count. Reopened complaints get a small bump (documented). Levels
0–25 low, 26–50 medium, 51–75 high, 76–100 critical (from config thresholds). Explanation exactly in the
style: "High priority because the issue has high severity, significant public impact and multiple nearby
complaints." Components keyed `severity, public_impact, location_risk, frequency, duplicates`, each
`{"score", "max", "raw", "label"}` with labels "Severity", "Public Impact", "Location Risk", "Frequency",
"Duplicates".

### 2.6 Duplicate detection — `ai/duplicate/` (owner A3)
Files: `text_similarity.py` (`text_similarity(a,b)`, `batch_text_similarity(query, texts)` using
`ai.nlp.embedding.get_text_embedder()`), `image_similarity.py` (`compute_hashes(image)` with imagehash
phash/dhash/ahash hex; `hash_similarity(h1,h2)`; `image_similarity(a,b)` = hashes + colour-histogram correlation
in demo, + CLIP embedding cosine in production), `location_similarity.py` (`location_similarity(distance_m,
radius_m)` smooth decay, 1.0 at 0 m, ~0 beyond radius), `duplicate_engine.py` (`find_duplicates` stub shape).
Overall = weighted text/image/location (weights renormalised when an image is missing), category-mismatch
penalty (×0.85) unless text similarity > 0.8; `is_duplicate = overall >= threshold and distance <= radius`.
Example: "Large pothole near school." vs "Big road pothole outside school." at ~40 m → ≈0.85–0.9.

### 2.7 Geospatial — `ai/geospatial/` (owner A3)
`distance.haversine_m` (done), `location_risk.assess_location_risk(...)` (stub shape: risk zones within
radius scaled by risk_level and proximity; high-traffic words in address/text — main road, highway, junction,
signal, flyover, bus stop, metro, market, school, hospital; complaint density), `hotspots.detect_hotspots(points,
*, eps_m, min_samples)` (stub shape; scikit-learn DBSCAN with `metric="haversine"` on radians, eps = eps_m /
6371000; per-cluster centroid, count, radius (max distance to centroid), dominant category, breakdown, avg/max
severity, severity_level, avg priority, open count, area_name (most common area), bounds, density per km²).

### 2.8 Verification — `ai/verification/` (owner A1)
Files: `preprocessing.py` (resize/align — ORB features + RANSAC homography to align after onto before when
possible), `metrics.py` (SSIM implemented with OpenCV Gaussian filtering, histogram correlation, edge-density
change, colour statistics, region change inside the originally detected boxes), `verifier.py`
(`verify_resolution` stub shape, `describe_models`). Demo uses OpenCV metrics + re-running the demo vision
analysis on the after image (is the issue still detected?). Production adds CLIP embedding similarity of scene
(same place?) and issue re-detection with the production vision model. Status rules: scene mismatch or poor
quality → needs_manual_review; strong change in the defect region + issue no longer detected →
likely_resolved (score ≥ resolved_threshold); some change → partially_resolved; little change / issue still
detected → not_resolved. Always include the disclaimer ("AI-assisted verification — not a guarantee...").
Example: "Resolution Verification Score: 91/100 · Likely Resolved · The after-image shows substantial visual
change in the previously detected damaged area."

### 2.9 Pipeline + model info (owner A3)
`ai/pipeline.run_analysis(...)` (stub shape): steps `preprocess` ("Data preprocessing"), `image_analysis`
("Image AI analysis"; status "skipped" when no image), `text_analysis` ("Text NLP analysis"),
`multimodal_fusion` ("Multimodal classification"), `location_risk` ("Location risk assessment"), `severity`
("Severity assessment"); each `{key, label, status: done|skipped|failed, duration_ms, detail}`. Image failures
must not crash the pipeline (step failed, continue with text). `nearby_count` = all nearby, `frequency_count` =
nearby with the same fused category. `ai/model_info.get_model_info()` aggregates `describe_models()` from vision,
nlp, verification + registry statuses + static component descriptions (priority engine weights, duplicate
engine, DBSCAN hotspots, fusion).

---------------------------------------------------------------------------------------------------------------

## 3. Django service layer (stubs exist; exact contracts in their docstrings)

`apps/complaints/services/` (owner B3): `submission.submit_complaint`, `pipeline.process_new_complaint /
analyze_preview / reanalyze_complaint`, `context.engine_config / engine_categories / engine_risk_zones /
nearby_complaints`, `priority.recalculate_priority`, `duplicates.detect_duplicates / review_duplicate`,
`status.add_event / can_change_status / change_status / get_allowed_actions / accept_complaint / start_work /
reject_complaint / resolve_complaint / reopen_complaint / close_complaint / add_remark`,
`verification.upload_evidence / run_ai_verification / manual_verification / request_manual_review`,
`routing.route_department`, `overrides.override_ai`.
`apps/assignments/services.py` (B4): `recommend_officers`, `assign_officer`, `auto_assign`,
`complete_active_assignment`, `officer_workload`.
`apps/notifications/services.py` (B4): `complaint_link`, `notify`, `notify_many`, `notify_admins`,
`notify_department_officers`.
`apps/feedback/services.py` (B4): `submit_feedback`, `pending_feedback_for`.
`apps/analytics/services.py` (B5): `check_hotspot_alert(complaint)` (+ whatever analytics helpers B5 needs).
`apps/audit/services.log_action(actor, action, *, entity, description, changes, request)` (DONE).

### 3.1 Submission flow (`submit_complaint`) — the core integration
validate → upload image (ComplaintImage + hashes/size) → save Location + Complaint (status `submitted`, event
`submitted`) → `ai.pipeline.run_analysis` (preprocess, image, text, fusion, location risk, severity) → save
AIPrediction, set category/severity/title (auto title like "Pothole near Banjara Hills Road No. 12" when blank),
status `analyzed`, event `ai_analyzed` → priority (initial PriorityScore, event `priority_assigned`) →
duplicate detection (DuplicateComplaint rows, event `duplicate_flagged`; if any: priority recalculated with
trigger `duplicate_update` and originals' counts/priority updated) → department routing (event
`department_assigned`) → SLA due date → officer recommendation + auto-assignment when
`AIConfiguration.auto_assign_officer` (B4 `auto_assign`; status `assigned`, event `officer_assigned`) →
database save (atomic) → notifications → hotspot check (`apps.analytics.services.check_hotspot_alert`, never
fails the request) → civic points +10 → audit log. Returns `(complaint, analysis)`:
`analysis = {"steps": [ {key,label,status,duration_ms,detail} ... in execution order: validate, upload, save,
preprocess, image_analysis, text_analysis, multimodal_fusion, severity, priority, duplicate_detection,
department_routing, officer_assignment, database_save, notification ], "summary": {"category": CategoryMini|null,
"confidence", "severity", "severity_score", "priority_score", "priority_level", "department": DepartmentMini|null,
"officer": UserMini|null, "duplicates_found": int, "is_demo": bool, "mode", "explanation", "needs_review"}}`.
If the AI step throws: complaint stays `submitted`, `needs_manual_review=True`, admins notified, steps report
`failed`, HTTP still 201.

### 3.2 Transition rules (`status.py`)
Admins may perform any transition. System (actor None) performs automatic ones. Others:

| from → to | allowed for |
|---|---|
| submitted → analyzed | system |
| analyzed / reopened / assigned → assigned | system, admin (assignment) |
| assigned → accepted | assigned officer |
| reopened → accepted / in_progress | assigned officer |
| assigned / accepted → rejected | assigned officer (remarks required) |
| accepted → in_progress | assigned officer |
| in_progress / accepted → resolved | assigned officer (remarks required) |
| resolved → verified | system (AI likely_resolved + auto verify), assigned officer / admin via manual verification |
| resolved → in_progress | system (AI not_resolved after manual confirmation), admin |
| resolved / verified / closed → reopened | citizen owner within `REOPEN_WINDOW_DAYS` of resolved_at (reason required) |
| verified / resolved → closed | system on citizen feedback, admin |

Status timestamps: accepted_at, resolved_at, verified_at, closed_at. Reopen: reopen_count += 1, resolved_at /
verified_at / closed_at cleared, priority recalculated (`trigger="reopened"`), officer + admins notified.
`get_allowed_actions(complaint, user)` returns keys from: `edit`, `delete`, `accept`, `reject`, `start_work`,
`upload_evidence`, `resolve`, `verify`, `manual_verify`, `request_manual_review`, `reopen`, `feedback`,
`assign`, `reassign`, `override_ai`, `reanalyze`, `review_duplicates`, `add_remark`, `close`.
(citizen: edit/delete only while submitted/analyzed/assigned and not yet accepted; feedback when
resolved/verified and no feedback since the last reopen; reopen per table.)

### 3.3 Notifications matrix
Citizen: complaint_submitted, ai_analysis_completed, department_assigned, officer_assigned, status_changed,
complaint_resolved, resolution_verified, feedback_requested, duplicate_detected.
Officer: new_assignment, critical_complaint (assigned complaint is critical), reassignment, complaint_reopened.
Admin: critical_complaint (every new critical), high_priority_unresolved (SLA task), hotspot_alert,
manual_review_requested, feedback_received (negative feedback).
Links: citizen `/citizen/complaints/<id>`, officer `/officer/complaints/<id>`, admin `/admin/complaints/<id>`.

### 3.4 Officer recommendation (B4)
Candidates: active officers of `complaint.department` (fallback: secondary department, then GEN, then any).
Score 0-1 = 0.40·(1 − workload/capacity) + 0.25·proximity (exp(−d/5 km), 0.5 if unknown) + 0.15·availability +
0.20·track record (resolution rate / avg rating, neutral 0.5 when no history); for critical priority the track
record weight increases to 0.30 (capacity weight 0.30). Officers at/over capacity are ranked last. Reasons are
human readable strings.

### 3.5 Feedback (B4)
Eligible: citizen owns complaint, status resolved/verified, no feedback since last reopen. Sentiment via
`ai.nlp.sentiment.analyze_sentiment(text, rating)`. Then status → closed (event `feedback`, then `closed`),
officer notified, admins notified for negative sentiment or rating ≤ 2, civic points +5. Response includes
`suggest_reopen: true` when rating ≤ 2 and the reopen window is open.

### 3.6 Celery tasks
`apps/complaints/tasks.py` (B3): `check_sla_breaches()` — open high/critical complaints past `sla_due_at` or
older than `sla_alert_hours`, notify admins + assigned officer at most once per complaint per 24 h; also
`reanalyze_complaint_task(id)`. Management command `check_sla`.
`apps/analytics/tasks.py` (B5): `scan_hotspots()` — runs DBSCAN over the last 30 days and raises HotspotAlerts.
Tasks are `@shared_task` functions that also work when called directly (eager mode).

---------------------------------------------------------------------------------------------------------------

## 4. REST API contract

Base URL `http://localhost:8000/api`. Auth header `Authorization: Bearer <access>`. Pagination (list endpoints
unless stated "non-paginated"): `?page=&page_size=` → `{"count","next","previous","page","page_size",
"total_pages","results"}`.

### 4.1 Shared JSON shapes
```jsonc
// CategoryMini
{"id": 1, "name": "Roads / Potholes", "slug": "pothole", "icon": "construction", "color": "#D9480F"}
// DepartmentMini
{"id": 1, "name": "Roads Department", "code": "ROADS", "icon": "traffic-cone", "color": "#D9480F"}
// UserMini
{"id": 5, "full_name": "Ravi Kumar", "email": "ravi@civicai.local", "role": "officer", "avatar": "http://…/media/avatars/a.png" /* or null */, "phone": "9876543210"}
// OfficerMini = UserMini + {"employee_id": "RD-1001", "designation": "Field Officer", "zone": "Ward 7", "department": DepartmentMini|null, "is_available": true}
// LocationOut
{"latitude": 17.41, "longitude": 78.44, "address": "Road No. 12, Banjara Hills", "landmark": "", "area": "Banjara Hills", "city": "Hyderabad", "pincode": "500034"}
// ComplaintMini
{"id": 12, "complaint_number": "CIV-2026-000012", "title": "…", "description": "…", "status": "assigned", "status_display": "Assigned", "category": CategoryMini|null, "thumbnail": "http://…"|null, "created_at": "…", "location": LocationOut, "priority_score": 64, "priority_level": "high", "severity": "high"}
```

**ComplaintList** (list endpoints):
```jsonc
{"id", "complaint_number", "title", "description", "category": CategoryMini|null, "status", "status_display",
 "severity", "severity_score", "priority_score", "priority_level", "department": DepartmentMini|null,
 "assigned_officer": UserMini|null, "citizen": UserMini, "location": LocationOut, "thumbnail": url|null,
 "duplicate_count", "has_pending_duplicates": bool, "is_overdue": bool, "sla_due_at", "ai_is_demo": bool,
 "ai_confidence": 0.91|null, "needs_manual_review": bool, "created_at", "updated_at", "resolved_at"}
```
**ComplaintDetail** = ComplaintList +
```jsonc
{"incident_at", "reported_category": CategoryMini|null,
 "images": [{"id", "url", "kind", "width", "height", "phash", "uploaded_at"}],
 "ai_prediction": AIPrediction|null, "priority": PriorityBreakdown|null,
 "duplicates": [DuplicateLink], "duplicate_of": ComplaintMini|null,
 "current_assignment": Assignment|null, "assignments": [Assignment],
 "evidence": [Evidence], "latest_verification": Verification|null, "verifications": [Verification],
 "feedback": [Feedback], "timeline": [TimelineEvent], "allowed_actions": ["accept", …],
 "is_ai_overridden", "reopen_count", "accepted_at", "verified_at", "closed_at", "can_reopen_until": iso|null}
```
**AIPrediction**: `{"id", "image_category", "image_confidence", "text_category", "text_confidence",
"final_category": CategoryMini|null, "final_category_slug", "multimodal_confidence", "severity", "severity_score",
"severity_reason", "severity_factors", "detected_objects", "bounding_boxes", "keywords", "impacts",
"probabilities": {"image": {}, "text": {}, "fused": {}}, "modality_weights", "location_risk", "explanation",
"needs_review", "model_mode", "is_demo", "model_version", "processing_time_ms", "created_at"}`

**PriorityBreakdown**: `{"final_score": 87, "priority_level": "critical", "components": [{"key": "severity",
"label": "Severity", "score": 35.0, "max": 40.0, "raw": 0.875}, {"key": "public_impact", …}, {"key":
"location_risk", …}, {"key": "frequency", …}, {"key": "duplicates", …}], "severity_component",
"impact_component", "location_component", "frequency_component", "duplicate_component", "weights", "factors",
"explanation", "trigger", "is_override", "created_at"}`

**DuplicateLink** (relative to the complaint being viewed): `{"id", "direction": "original"|"duplicate",
"other": ComplaintMini, "text_similarity", "image_similarity"|null, "location_similarity", "overall_similarity",
"distance_m", "category_match", "status", "status_display", "explanation", "reviewed_by": UserMini|null,
"reviewed_at", "created_at"}` — `direction: "original"` means *other* is the earlier original of this complaint.

**Assignment**: `{"id", "complaint": id, "officer": OfficerMini, "department": DepartmentMini|null, "assigned_by":
UserMini|null, "assignment_type", "assignment_type_display", "status", "status_display", "is_active",
"recommendation_score", "recommendation_reasons", "notes", "assigned_at", "accepted_at", "completed_at"}`

**Evidence**: `{"id", "before_image": url|null, "after_image": url|null, "uploaded_by": UserMini|null, "remarks",
"uploaded_at"}`

**Verification**: `{"id", "evidence_id", "score", "status", "status_display", "explanation", "metrics", "method",
"method_display", "is_manual_override", "manual_review_requested", "verified_by": UserMini|null, "verified_at",
"model_version", "is_demo"}`

**Feedback**: `{"id", "complaint": id, "complaint_number", "complaint_title", "citizen": UserMini, "rating",
"text", "sentiment", "sentiment_display", "sentiment_score", "sentiment_confidence", "sentiment_model", "is_demo",
"department": DepartmentMini|null, "category": CategoryMini|null, "created_at"}`

**TimelineEvent**: `{"id", "event", "event_display", "old_status", "new_status", "changed_by": UserMini|null,
"actor_label": "CivicAI Engine"|"Ravi Kumar (Officer)", "remarks", "metadata", "is_public", "timestamp"}`
(citizens only see `is_public` events).

**Notification**: `{"id", "title", "message", "notification_type", "type_display", "level", "complaint": id|null,
"complaint_number": str|null, "link", "is_read", "read_at", "created_at"}`

### 4.2 Endpoints
Permissions: P = public (AllowAny), A = any authenticated, C = citizen, O = officer, AD = admin.

**Auth** (`apps/accounts/urls_auth.py`, B1)
| Method | Path | Perm | Request → Response |
|---|---|---|---|
| POST | /auth/register/ | P (throttle auth) | `{email, password, confirm_password, first_name, last_name, phone?}` → 201 `{user: User, access, refresh}` (role always citizen) |
| POST | /auth/login/ | P (throttle auth) | `{email, password}` → `{access, refresh, user: User}`; 401 `{"detail": "Invalid email or password."}`; inactive → 403 |
| POST | /auth/refresh/ | P | `{refresh}` → `{access, refresh}` (rotation + blacklist) |
| POST | /auth/logout/ | A | `{refresh}` → 200 `{"detail": "Logged out."}` (blacklists token) |
| GET | /auth/profile/ | A | → User |
| PATCH/PUT | /auth/profile/ | A | multipart or JSON `{first_name, last_name, phone, avatar (file), remove_avatar?, citizen_profile: {address, area, city, pincode, date_of_birth, gender, preferred_language, email_notifications}}` (multipart may send citizen fields flat: `address`, `city`, …) → User |
| POST | /auth/change-password/ | A | `{old_password, new_password}` → 200 |

**User** shape: `{"id", "email", "first_name", "last_name", "full_name", "role", "phone", "avatar", "is_active",
"date_joined", "last_login", "citizen_profile": {...}|null, "officer_profile": OfficerProfileOut|null,
"stats": {"complaints": n, "civic_points": n}}`

**Users (admin)** `/users/` (B1): GET (filters `role`, `is_active`, `search`; paginated; each row adds
`complaint_count`, `civic_points`), POST (create user of any role; officers should use /officers/), GET/PATCH
`/users/{id}/` (`first_name, last_name, phone, is_active, role`), DELETE (soft: `is_active=false`; cannot delete
self).

**Officers** `/officers/` (B1): GET (A for officers/admins; filters `department`, `is_available`, `search`;
paginated), POST (AD; `{email, password, first_name, last_name, phone, department, employee_id, designation,
zone, base_latitude, base_longitude, max_active_complaints, is_available, skills, joined_on}` creates User
role=officer + profile), GET/PUT/PATCH `/officers/{id}/` (id = user id; password optional on update), DELETE
(deactivate), GET `/officers/{id}/workload/` → `{"active", "capacity", "utilization", "critical", "by_status",
"complaints": [ComplaintList]}`.
OfficerOut: `{"id", "user": {"id","email","first_name","last_name","full_name","phone","avatar","is_active",
"last_login"}, "department": DepartmentMini|null, "department_id", "employee_id", "designation", "zone",
"base_latitude", "base_longitude", "max_active_complaints", "is_available", "skills", "joined_on",
"active_workload", "resolved_count", "avg_resolution_hours", "avg_rating", "created_at"}`

**Departments / Categories / Routing** (B1) — **non-paginated** lists
- `/departments/` GET (P) `?include_inactive=true` (admin) → `[DepartmentOut]` with `{"id","name","code",
  "description","email","phone","head_name","icon","color","sla_hours","is_active","officer_count",
  "category_count","open_complaints","total_complaints","created_at","updated_at"}`; POST/PUT/PATCH (AD);
  DELETE (AD; deactivates when it has complaints/officers, else deletes).
- `/departments/routing/` GET (A) → `[{"category": CategoryMini, "department": DepartmentMini|null,
  "secondary_department": DepartmentMini|null}]`; PUT (AD) `{"mappings": [{"category": id, "department": id|null,
  "secondary_department": id|null}]}` → same list.
- `/categories/` GET (P) `?include_inactive=true` → `[CategoryOut]`: `{"id","name","slug","description","icon",
  "color","department": id|null, "department_detail": DepartmentMini|null, "secondary_department": id|null,
  "secondary_department_detail", "keywords", "vision_labels", "base_severity", "public_safety_weight",
  "sla_hours", "effective_sla_hours", "is_active", "sort_order", "complaint_count", "created_at"}`;
  POST/PUT/PATCH (AD; slug auto from name if missing); DELETE (AD; deactivates when used).

**Complaints** (B2 views; logic in B3 services)
| Method | Path | Perm | Notes |
|---|---|---|---|
| GET | /complaints/ | A | scope: citizen → own; officer → assigned to me (default) or `?scope=department`; admin → all. Filters: `status` (comma list), `category` (id or slug), `severity`, `priority_level`, `department`, `assigned_officer`, `citizen`, `date_from`, `date_to` (YYYY-MM-DD), `is_overdue`, `has_duplicates`, `needs_review`, `search` (number/title/description/address/area), `ordering` (`created_at`, `-created_at`, `priority_score`, `-priority_score`, `severity_score`, `-severity_score`, `updated_at`, `-updated_at`; default `-created_at`). Paginated ComplaintList |
| POST | /complaints/ | C | multipart: `description` (10–2000 chars, required), `image` (optional file), `latitude`, `longitude` (required), `address`, `landmark`, `area`, `city`, `pincode`, `category` (optional id or slug = citizen hint), `title`, `incident_at` (not in future). → 201 ComplaintDetail + `"analysis": {steps, summary}` |
| GET | /complaints/{id}/ | A (object-scoped) | ComplaintDetail |
| PUT/PATCH | /complaints/{id}/ | C owner (while editable) / AD | citizen: `description, title, address, landmark, area, city, pincode, incident_at` (description change → reanalysis); admin: same |
| DELETE | /complaints/{id}/ | C owner (while editable) / AD | 204 |
| GET | /complaints/map/ | A (scoped like list, same filters) | non-paginated (max 3000): `[{"id","complaint_number","title","latitude","longitude","category": CategoryMini|null,"severity","priority_level","priority_score","status","status_display","created_at","thumbnail","area"}]` |
| GET | /complaints/{id}/timeline/ | A | `[TimelineEvent]` |
| GET | /complaints/{id}/duplicates/ | A | `[DuplicateLink]` |
| POST | /complaints/{id}/accept/ | O | `{remarks?}` → ComplaintDetail |
| POST | /complaints/{id}/reject/ | O/AD | `{remarks}` → ComplaintDetail |
| POST | /complaints/{id}/start/ | O | `{remarks?}` → ComplaintDetail |
| POST | /complaints/{id}/update-status/ | O/AD | `{status, remarks}` → ComplaintDetail |
| POST | /complaints/{id}/resolve/ | O/AD | multipart `{remarks, after_image?}` → ComplaintDetail (AI verification runs automatically when an after image exists) |
| POST | /complaints/{id}/evidence/ | O/AD | multipart `{before_image?, after_image?, remarks?}` (≥1 image) → 201 Evidence |
| POST | /complaints/{id}/verify/ | O/AD | runs AI verification → Verification |
| POST | /complaints/{id}/manual-verification/ | O/AD | `{status, score?, explanation}` → Verification |
| POST | /complaints/{id}/request-manual-verification/ | O | `{remarks?}` → ComplaintDetail |
| POST | /complaints/{id}/reopen/ | C owner / AD | `{reason}` → ComplaintDetail |
| POST | /complaints/{id}/remarks/ | O/AD | `{remarks}` → TimelineEvent |
| POST | /complaints/{id}/override-ai/ | AD | `{category?, severity?, priority_score?, reason}` → ComplaintDetail |
| POST | /complaints/{id}/reanalyze/ | AD | → ComplaintDetail + `analysis` |
| POST | /complaints/{id}/close/ | AD | `{remarks?}` → ComplaintDetail |

**Duplicates** (B2): GET `/duplicates/` (O/AD; officer sees pairs involving their assigned/department complaints;
filters `status`, `complaint`; paginated) → `[{"id","complaint": ComplaintMini,"similar_complaint": ComplaintMini,
"text_similarity","image_similarity","location_similarity","overall_similarity","distance_m","category_match",
"status","status_display","explanation","reviewed_by","reviewed_at","created_at"}]`; PATCH `/duplicates/{id}/`
`{status: "confirmed_duplicate"|"not_duplicate", notes?}` → same shape.

**AI** (B2 `apps/complaints/ai_views.py`; throttle scope `ai`)
| Method | Path | Perm | Notes |
|---|---|---|---|
| POST | /ai/analyze/ | A | multipart `{image?, description, latitude?, longitude?, address?, category?}` → `{"vision","text","fusion","location_risk","severity","priority" (engine output),"duplicates": [{"complaint": ComplaintMini, …scores}],"department": DepartmentMini|null,"recommended_officer": OfficerMini|null,"category": CategoryMini|null,"is_demo","mode","steps"}` — no DB writes |
| POST | /ai/classify/ | A | multipart `{image?, description?}` (≥1) → `{"vision","text","fusion","category": CategoryMini|null,"is_demo","mode"}` |
| POST | /ai/priority/ | O/AD | `{complaint_id}` → recalculates & returns PriorityBreakdown; or simulation `{severity_score, public_impact, location_risk, nearby_count, frequency_count, duplicate_count, category?}` → engine output (+ optional `weights` override for what-if) |
| POST | /ai/duplicates/ | A | `{complaint_id}` → re-run, `[DuplicateLink]`; or multipart `{description, latitude, longitude, image?}` → `[{"complaint": ComplaintMini, scores…}]` (used by the submit form "similar issues nearby" check) |
| POST | /ai/verify-resolution/ | O/AD | multipart `{before_image, after_image, category?}` → engine output (no DB); or `{complaint_id}` → Verification (persisted) |
| POST | /ai/sentiment/ | AD | `{text, rating?}` → sentiment output (model playground) |
| GET | /ai/model-info/ | A | `get_model_info()` + `{"config": AIConfig}` |

**System / core** (B1)
- GET `/system/config/` (P) → `{"app_name": "CivicAI", "version", "model_mode", "is_demo", "demo_badge",
  "map": {"center": [lat, lng], "zoom": 12, "city"}, "upload": {"max_image_mb", "allowed_extensions"},
  "reopen_window_days", "statuses": [{"value","label"}], "levels": [{"value","label"}]}`
- GET/PUT/PATCH `/ai/config/` (GET O/AD, write AD) → AIConfiguration fields (all model fields +
  `updated_by`: UserMini|null, `updated_at`); validation: weights sum 100, thresholds ordered; config change is
  audit-logged; optional `?recalculate=true` on PUT recalculates priority of open complaints.
- `/risk-zones/` CRUD (read O/AD, write AD; non-paginated).
- POST `/contact/` (P, throttle `contact`) `{name, email, subject, message}` → 201; GET (AD, paginated);
  PATCH `/contact/{id}/` `{is_resolved}` (AD).
- GET `/geo/reverse/?lat=&lng=` (P) → `{"address","area","city","pincode","display_name","source":
  "nominatim"|"fallback"}` (Nominatim proxy with proper User-Agent, 24 h cache, 5 s timeout, graceful fallback);
  GET `/geo/search/?q=` (P) → `[{"display_name","latitude","longitude","address","area","city","pincode"}]`.
- GET `/audit-logs/` (AD; filters `action`, `entity_type`, `actor`, `date_from`, `date_to`, `search`; paginated)
  → `[{"id","actor": UserMini|null,"action","action_display","entity_type","entity_id","description","changes",
  "ip_address","created_at"}]` (audit app urls, B1).

**Assignments** (B4)
- GET `/assignments/` (AD all; O own; filters `complaint`, `officer`, `is_active`) paginated `[Assignment]`.
- POST `/assignments/` (AD) `{complaint, officer, notes?}` → 201 Assignment (reassignment if one is active).
- PUT/PATCH `/assignments/{id}/` (AD) `{officer, notes?}` → reassign → new Assignment.
- GET `/assignments/recommend/?complaint=<id>&limit=5` (AD) → `[{"officer": OfficerMini, "score", "workload",
  "capacity", "utilization", "distance_km", "is_available", "same_department", "reasons": [], "recommended": bool}]`.

**Feedback** (B4)
- POST `/feedback/` (C) `{complaint, rating, text?}` → 201 Feedback + `{"suggest_reopen": bool}`.
- GET `/feedback/` (A; citizen own, officer their complaints, admin all; filters `sentiment`, `rating`,
  `department`, `category`, `complaint`, `date_from`, `date_to`) paginated `[Feedback]`.
- GET `/feedback/pending/` (C) → `[{"complaint": ComplaintMini, "resolved_at"}]` (feedback requests).

**Notifications** (B4): GET `/notifications/` (A; `?is_read=true|false`, paginated), GET
`/notifications/unread-count/` → `{"count"}`, PUT or POST `/notifications/{id}/read/` → Notification, POST
`/notifications/read-all/` → `{"updated": n}`, DELETE `/notifications/{id}/`.

**Analytics** (B5; mounted at `/api/analytics/`; filters where sensible: `date_from`, `date_to`, `department`,
`category`, `severity`, `status`)
- GET `dashboard/` (A, role-aware):
  citizen → `{"role":"citizen","totals":{"total","pending","in_progress","resolved","rejected"},
  "recent_complaints":[ComplaintList ×5],"active_complaint": {"complaint": ComplaintList, "timeline":
  [TimelineEvent]}|null,"feedback_requests":[{"complaint": ComplaintMini,"resolved_at"}],
  "notifications":[Notification ×5],"civic_points"}`;
  officer → `{"role":"officer","totals":{"assigned","critical","pending","in_progress","resolved","overdue"},
  "avg_resolution_hours","workload":{"active","capacity","utilization"},"queue":[ComplaintList ×10 by priority],
  "recent_activity":[TimelineEvent + {"complaint_number"} ×10],"department": DepartmentMini|null}`;
  admin → same as `overview/`.
- GET `overview/` (AD): `{"totals":{"total","pending","in_progress","resolved","critical","rejected","reopened",
  "overdue","duplicates_pending","needs_review"},"avg_resolution_hours","avg_rating","satisfaction_rate",
  "status_distribution":[{"status","label","count"}],"severity_distribution":[{"level","label","count"}],
  "priority_distribution":[{"level","label","count"}],"priority_histogram":[{"bucket":"0-9","count"}…10],
  "resolution_time_distribution":[{"bucket":"< 24 h","count"},{"bucket":"1–3 days"},{"bucket":"3–7 days"},
  {"bucket":"> 7 days"}],"recent_critical":[ComplaintList ×5],"hotspot_count","generated_at"}`
- GET `categories/` (AD): `[{"category": CategoryMini,"total","open","resolved","critical","avg_priority",
  "avg_severity_score","avg_resolution_hours","resolution_rate"}]`
- GET `departments/` (AD): `[{"department": DepartmentMini,"total","pending","in_progress","resolved","critical",
  "overdue","avg_resolution_hours","resolution_rate","sla_compliance","avg_rating","officer_count",
  "active_workload"}]`
- GET `trends/?period=day|week|month&days=90` (AD): `{"period","series":[{"date":"2026-10-01","label":"Oct 1",
  "submitted","resolved","critical"}],"resolution_time_trend":[{"date","label","avg_hours"}],
  "category_series":[{"date","label","<slug>": n…}],"categories":[CategoryMini]}` (bucketed in Python)
- GET `hotspots/` (O/AD; filters + `eps_m`, `min_samples`, `days` default 90) → detect_hotspots output with
  clusters enriched (`dominant_category` → CategoryMini) + `"points":[{"id","complaint_number","latitude",
  "longitude","category": CategoryMini|null,"severity","status","cluster"}]` + `"alerts":[HotspotAlert ×10]`
- GET `sentiment/` (AD): `{"distribution":[{"sentiment","label","count","percentage"}],"positive_pct",
  "neutral_pct","negative_pct","average_rating","total_feedback","satisfaction_rate","rating_distribution":
  [{"rating","count"}],"by_department":[{"department": DepartmentMini,"positive","neutral","negative","total",
  "avg_rating"}],"by_category":[{"category": CategoryMini,…}],"over_time":[{"date","label","positive","neutral",
  "negative","avg_rating"}],"recent":[Feedback ×10],"top_keywords":{"positive":[…],"negative":[…]}}`
- GET `officers/` (AD): `[{"officer": OfficerMini,"department": DepartmentMini|null,"active","capacity",
  "utilization","is_available","resolved_total","resolved_30d","avg_resolution_hours","avg_rating",
  "critical_active"}]`
- GET `ai/` (AD): `{"mode","is_demo","total_predictions","avg_confidence","avg_image_confidence",
  "avg_text_confidence","modality_agreement_rate","needs_review_count","override_count","override_rate",
  "ai_category_match_rate","confidence_histogram":[{"bucket","count"}],"predictions_by_category":[{"category":
  CategoryMini,"count","avg_confidence"}],"confusion":[{"ai","final","count"}],"duplicates":{"detected",
  "pending","confirmed","rejected","precision"},"verification":{"total","by_status":[{"status","label","count"}],
  "avg_score","manual_overrides"},"avg_processing_ms","severity_distribution":[…],"model_info": get_model_info()}`
- GET `public/` (P): `{"total_complaints","resolved_complaints","resolution_rate","avg_resolution_hours",
  "departments","categories","active_officers","citizens","recent_resolved":[{"complaint_number","title",
  "category": CategoryMini|null,"area","resolved_at"}]}` (no personal data)
- GET `reports/?report=summary|complaints|departments|officers|feedback&format=json|csv|pdf&…filters` (AD) →
  JSON preview `{"report","title","generated_at","filters","columns":[…],"rows":[…],"summary":{…}}` or a file
  download (CSV via `csv` module; PDF via reportlab with title, filters, summary table and data table).
  Export is audit-logged.
- POST `run-checks/` (AD) → runs SLA check + hotspot scan now → `{"sla_alerts": n, "hotspot_alerts": n}`.
- GET `alerts/` (AD) → `[HotspotAlert]`; PATCH `alerts/{id}/` `{is_acknowledged}`.

---------------------------------------------------------------------------------------------------------------

## 5. Frontend contract (`frontend/`)

### 5.1 Stack & conventions
React 19 + Vite 7, JavaScript (JSX, no TypeScript), Tailwind CSS v4 (CSS-first; tokens in `src/index.css`,
already written — extend, don't rewrite the palette), react-router-dom v7 (`createBrowserRouter` +
`RouterProvider`, lazy routes), axios, framer-motion, recharts 3, leaflet + react-leaflet 5 +
leaflet.markercluster (imperative layer via `useMap`), lucide-react, clsx + tailwind-merge (`cn()`), date-fns.
Import alias `@/` → `src/`. `VITE_API_URL` (default `http://localhost:8000/api`).
**Tailwind v4 notes**: use `bg-black/50` (no `bg-opacity-*`), `shadow-xs`/`shadow-sm` names, `outline-hidden`
instead of `outline-none` for removing outlines, `rounded-sm/md/lg/xl/2xl` map to our radius scale (6/8/10/14/18 px),
`dark:` variant is class based (`.dark` on `<html>`). Prefer semantic utilities: `bg-bg`, `bg-surface`,
`bg-surface-2`, `bg-sunken`, `border-line`, `border-line-strong`, `text-ink`, `text-ink-2`, `text-ink-3`,
`bg-primary`, `hover:bg-primary-hover`, `bg-primary-soft`, `text-primary-ink`, `bg-sidebar`, `bg-sidebar-2`,
`bg-overlay`; palette scales `sign-*` (green), `marking-*` (yellow), `asphalt-*`, `signal-*` (red),
`hazard-*` (orange), `guide-*` (blue); utilities `lane-line`, `lane-line-x`, `sign-panel`, `tabular`,
`scrollbar-thin`; fonts `font-display` (Overpass) and `font-sans` (Public Sans).

### 5.2 Design direction — "civic signage" (follow it; it is the product's identity)
- **Subject**: municipal infrastructure. Visual vernacular = road signage & work orders. Highway-sign green
  primary, road-marking yellow as the wayfinding accent, asphalt/concrete neutrals. Overpass (derived from
  highway-sign lettering) for headings and large numbers; Public Sans (civic UI typeface) for UI text.
- **One signature motif**: the dashed yellow *lane line* — used for the complaint timeline connector, the active
  sidebar item marker, and the landing page's lifecycle "road". The `sign-panel` treatment is used for the logo
  and the landing hero headline only.
- **Colour = meaning**: status / severity / priority / sentiment colours come from `utils/constants.js`; no
  decorative gradients, no gradient text, no glow blobs.
- **Hierarchy over uniform cards**: panels are `bg-surface border border-line rounded-xl` without shadow; only
  floating layers (menus, modals, toasts, map popups) use `shadow-[var(--shadow-overlay)]`. Vary layout density:
  dashboards dense (14px base), marketing pages generous (16–18px).
- **Avoid these generic tells**: ALL-CAPS tracked eyebrow labels above headings; one highlighted word in a
  headline; `→` appended to button text; middle-dot meta strings; monospace for small data labels (use `tabular`
  numerals instead); identical card grids with the same shadow; scattered fade-up-on-scroll for every section.
- **Motion**: purposeful only — modal/drawer/menu transitions, toast in/out, and two orchestrated moments: the
  landing hero "photo → AI work order" sequence and the submission "AI analysis" sequence driven by the real
  `analysis.steps` from the API. Respect `prefers-reduced-motion` (`useReducedMotion`).
- **Copy**: sentence case, plain verbs, specific CTAs ("Report an issue", "Accept complaint", "Upload after
  photo"); toasts reuse the action verb ("Complaint accepted"). Errors say what happened and how to fix it.
  Empty states invite the next action. Spec-given strings are used verbatim (hero "CivicAI" / "AI-Powered Civic
  Issue Management" + subtitle, buttons "Report an Issue" / "Explore Dashboard", submit button
  "Analyze & Submit", "Demo AI Mode").
- **Quality floor**: responsive 360px → 1920px (no horizontal page scroll; tables scroll inside their container
  or collapse to cards on mobile), visible keyboard focus (yellow outline), WCAG AA contrast in both themes,
  labelled form controls, `aria-*` on icon buttons, dialogs trap focus and close on Esc.
- **Mobile app feel**: citizens on phones get a bottom tab bar (Home, Complaints, **Report** (raised yellow
  button), Alerts, Profile); the image input offers camera capture (`capture="environment"`); GPS button is
  thumb-reachable; the app is an installable PWA (manifest + service worker caching the app shell, never API
  responses).

### 5.3 Structure & ownership
```
frontend/
  index.html, vite.config.js (done), package.json (done), eslint.config.js, .env.example, vercel.json
  public/  favicon.svg, manifest.webmanifest, sw.js, icons/icon-192.png, icons/icon-512.png, robots.txt
  src/
    main.jsx, App.jsx (router), index.css (tokens done)
    services/   api.js + one module per resource                     (F1)
    context/    AuthContext, ThemeContext, ToastContext, NotificationContext, ConfigContext   (F1)
    hooks/      useAuth, useTheme, useToast, useNotifications, useConfig, useApi, useDebounce,
                useGeolocation, useMediaQuery, useConfirm, useDocumentTitle                 (F1)
    utils/      cn.js, constants.js, format.js, icons.js, errors.js, storage.js              (F1)
    components/ui/          design-system primitives                                         (F1)
    components/layout/      PublicLayout, DashboardLayout, Sidebar, Topbar, MobileTabBar, …  (F1)
    components/complaints/  domain components                                                (F2)
    components/maps/        Leaflet components                                               (F2)
    components/charts/      Recharts wrappers                                                (F2)
    components/ai/          AI result components                                             (F2)
    pages/public|citizen|officer|admin|shared/                                               (P1–P5)
```

### 5.4 Services (F1) — function names (all return `response.data`)
`api.js`: axios instance, `setTokens/getAccessToken/getRefreshToken/clearTokens` (localStorage keys
`civicai.access`, `civicai.refresh`), request interceptor adds Bearer, response interceptor refreshes once on 401
(queueing concurrent requests) then logs out + redirects to `/login?next=…`; `buildFormData(obj)` helper.
- `authService`: register, login, refresh, logout, getProfile, updateProfile(dataOrFormData), changePassword
- `complaintService`: list(params), get(id), create(formData), update(id, data), remove(id), map(params),
  timeline(id), duplicates(id), accept(id, data), reject(id, data), start(id, data), updateStatus(id, data),
  resolve(id, formData), uploadEvidence(id, formData), verify(id), manualVerification(id, data),
  requestManualVerification(id, data), reopen(id, data), addRemark(id, data), overrideAI(id, data),
  reanalyze(id), close(id, data)
- `duplicateService`: list(params), review(id, data)
- `aiService`: analyze(formData), classify(formData), priority(data), duplicates(dataOrFormData),
  verifyResolution(dataOrFormData), sentiment(data), modelInfo(), getConfig(), updateConfig(data, {recalculate})
- `departmentService`: list(params), get(id), create, update, remove, routing(), updateRouting(mappings);
  `categoryService`: list(params), create, update, remove
- `officerService`: list(params), get(id), create, update, remove, workload(id)
- `userService`: list(params), get(id), create, update, remove
- `assignmentService`: list(params), assign(data), reassign(id, data), recommend(complaintId, limit)
- `feedbackService`: submit(data), list(params), pending()
- `notificationService`: list(params), unreadCount(), markRead(id), markAllRead(), remove(id)
- `analyticsService`: dashboard(), overview(params), categories(params), departments(params), trends(params),
  hotspots(params), sentiment(params), officers(params), ai(params), publicStats(), report(params) (JSON),
  downloadReport(params) (blob → triggers file download), runChecks(), alerts(), acknowledgeAlert(id)
- `systemService`: config(), riskZones(), createRiskZone, updateRiskZone, deleteRiskZone, contact(data),
  contactMessages(params), updateContactMessage(id, data), reverseGeocode(lat, lng), searchPlaces(q),
  auditLogs(params)

### 5.5 Routes (F1 writes `App.jsx` with every route; page agents fill the page files)
Public (PublicLayout): `/` Landing, `/about`, `/features`, `/how-it-works`, `/contact`, `/login`, `/register`.
Citizen (`ProtectedRoute roles=['citizen']`, DashboardLayout): `/citizen` → redirect `/citizen/dashboard`,
`/citizen/dashboard`, `/citizen/report` (Submit Complaint), `/citizen/complaints`, `/citizen/complaints/:id`,
`/citizen/complaints/:id/track`, `/citizen/profile`, `/citizen/notifications`, `/citizen/feedback`.
Officer (`roles=['officer']`): `/officer/dashboard`, `/officer/complaints`, `/officer/complaints/:id`,
`/officer/complaints/:id/resolve` (Resolution Update), `/officer/complaints/:id/verify` (Resolution
Verification), `/officer/profile`, `/officer/notifications`.
Admin (`roles=['admin']`): `/admin/dashboard`, `/admin/complaints` (All Complaints), `/admin/complaints/:id`
(Complaint Management), `/admin/duplicates`, `/admin/users` (User Management), `/admin/officers` (Officer
Management), `/admin/departments` (Department + category + routing management), `/admin/ai-analytics`,
`/admin/hotspots` (Hotspot Map), `/admin/feedback` (Feedback Analytics), `/admin/reports`, `/admin/settings`
(System/AI settings, model info, risk zones), `/admin/audit-logs`, `/admin/profile`, `/admin/notifications`.
Other: `/unauthorized`, `*` NotFound. After login: citizen → `/citizen/dashboard`, officer →
`/officer/dashboard`, admin → `/admin/dashboard` (or `?next=`). Logged-in users visiting /login are redirected.

Page file paths (default export = page component):
`pages/public/{LandingPage,AboutPage,FeaturesPage,HowItWorksPage,ContactPage,LoginPage,RegisterPage,
NotFoundPage,UnauthorizedPage}.jsx`, `pages/citizen/{CitizenDashboard,SubmitComplaint,MyComplaints,
ComplaintDetails,ComplaintTracking,FeedbackPage}.jsx`, `pages/officer/{OfficerDashboard,AssignedComplaints,
OfficerComplaintDetails,ResolutionUpdate,ResolutionVerification}.jsx`, `pages/admin/{AdminDashboard,
AllComplaints,ComplaintManagement,DuplicateReview,UserManagement,OfficerManagement,DepartmentManagement,
AIAnalytics,HotspotMap,FeedbackAnalytics,Reports,SystemSettings,AuditLogs}.jsx`,
`pages/shared/{ProfilePage,NotificationsPage}.jsx` (used under every role prefix).

### 5.6 UI primitives (F1, `components/ui/`, each a named export + `index.js` barrel)
Button (`variant`: primary|secondary|outline|ghost|danger|warning|link; `size`: sm|md|lg|icon; `loading`,
`leftIcon`, `rightIcon` (lucide component), `to` (renders router Link), `fullWidth`), IconButton (`label`
required → aria-label), Card / CardHeader (`title`, `description`, `actions`, `icon`) / CardBody / CardFooter,
Badge (`tone`: neutral|green|yellow|orange|red|blue|violet|teal|magenta|slate; `dot`; `size`; `icon`), Input,
Textarea (with `maxLength` counter), Select (native, styled), Checkbox, Switch, RadioGroup, FormField (`label`,
`hint`, `error`, `required`, `htmlFor`), SearchInput (debounced `onSearch`, clear button), Modal (`open`,
`onClose`, `title`, `description`, `size`: sm|md|lg|xl, `footer`; portal, focus trap, Esc, framer-motion),
ConfirmDialog + `useConfirm()` (promise API: `const ok = await confirm({title, message, confirmLabel, tone})`),
Drawer (`side`: left|right|bottom), DropdownMenu (`trigger`, `items: [{label, icon, onClick, to, danger,
divider}]`), Tabs (`tabs: [{id, label, icon, count}]`, `value`, `onChange`; underline style with yellow
active marker), DataTable (`columns: [{key, header, render(row), sortable, align, className, hideOnMobile}]`,
`data`, `loading`, `rowKey`, `onRowClick`, `sort`, `onSortChange`, `empty`, `mobileCard(row)` render fallback
for small screens), Pagination (`page`, `totalPages`, `count`, `pageSize`, `onPageChange`), Spinner, Skeleton,
PageLoader, EmptyState (`icon`, `title`, `description`, `action`), ErrorState (`title`, `message`, `onRetry`),
StatCard (`label`, `value`, `icon`, `tone`, `hint`, `to`, `loading`; Overpass tabular value), Avatar (`src`,
`name`, `size`), Tooltip, FileDropzone (`value: File|null`, `onChange`, `previewUrl`, `accept`, `maxSizeMB`,
`capture`, `label`, `hint`, `error`; drag & drop, preview, remove, camera capture), StarRating (`value`,
`onChange`, `readOnly`, `size`), ProgressBar (`value`, `max`, `tone`), ScoreRing (`value`, `max`, `size`,
`tone`, `label`), KeyValueList (`items: [{label, value}]`), PageHeader (`title`, `description`, `actions`,
`breadcrumbs: [{label, to}]`, `back`), Logo (`size`, `variant`: full|mark; sign-panel styled), ThemeToggle,
DemoModeBadge (reads ConfigContext; renders only in demo mode; tooltip explains Demo AI Mode).
Toasts via `useToast()`: `toast.success(title, description?)`, `toast.error`, `toast.info`, `toast.warning`.

### 5.7 Domain components (F2)
`components/complaints/`: StatusBadge, SeverityBadge, PriorityBadge, CategoryBadge, PriorityMeter (0–100
segmented gauge with Low/Medium/High/Critical zones), PriorityBreakdown (5 component bars "35/40" + explanation),
ComplaintTimeline (vertical lane-line timeline of TimelineEvents with icons, actor, timestamp, remarks; `compact`
mode; shows the canonical lifecycle steps not yet reached as muted "upcoming" stops), LifecycleStepper
(horizontal compact progress), ComplaintCard (mobile/list card), ComplaintTable (configurable columns: number,
category, location, priority, severity, status, date, action), ComplaintFilters (search + status / category /
severity / priority / department / date range; responsive drawer on mobile; syncs to URL search params),
DuplicatePanel (DuplicateLink list with similarity bars, original link, confirm / not-duplicate actions via
callbacks + permission flag), EvidencePanel (before/after with BeforeAfterSlider), BeforeAfterSlider,
VerificationResult (ScoreRing, status, explanation, metrics, "AI-assisted verification" disclaimer, override
slot), FeedbackCard, FeedbackForm (stars + textarea + submit), SLAIndicator, AnalysisProgress (animates
`analysis.steps` sequentially with durations, then reveals the summary).
`components/ai/`: AIAnalysisPanel (final category with confidence, image vs text vs fused confidences,
agreement, keywords, impacts, severity factors, explanation, model version, DemoModeBadge, needs-review flag),
ImageWithBoxes (image with normalised bounding boxes + labels overlay), ConfidenceBar, ModelInfoCard.
`components/maps/`: BaseMap (OSM tiles, attribution, theme aware), LocationPicker (`value: {lat, lng}`,
`onChange({lat, lng})`, click to place, draggable marker, "Use my location" button with useGeolocation, place
search via systemService.searchPlaces, reverse geocode callback `onAddress(addressObj)`), ComplaintMap
(`points`, `cluster` (leaflet.markercluster), `onSelect`, category-coloured SVG pin divIcons, popup with
number/title/status/link), HotspotLayer (`clusters` → circles sized by radius, coloured by severity, popup with
stats), MiniMap (`lat`, `lng`, non-interactive), MapLegend.
`components/charts/`: ChartCard (`title`, `description`, `actions`, `loading`, `empty`, `children`, `height`),
`useChartTheme()` (axis/grid/tooltip colours from CSS vars, reacts to theme), and wrappers BarChartCard,
HorizontalBarChart, AreaTrendChart, LineTrendChart, DonutChart (with centre total + legend), StackedBarChart,
RatingBars — all accept `data` + key props, render accessible legends, tooltips styled with tokens.
Load the `dataviz` skill before building charts.

---------------------------------------------------------------------------------------------------------------

## 6. Ownership (phase 2)

| ID | Owner of | Notes |
|---|---|---|
| A1 | `ai/vision/**`, `ai/verification/**`, `scripts/generate_sample_images.py`, `scripts/evaluate_vision.py`, `scripts/train_yolo.py`, `sample_data/**`, `ai/tests/test_vision.py`, `ai/tests/test_verification.py` | provides `ai.vision.preprocessing.load_image` used by others |
| A2 | `ai/nlp/**`, `scripts/train_text_classifier.py`, `ai/tests/test_nlp.py` | |
| A3 | `ai/multimodal/**`, `ai/severity/**`, `ai/priority/**`, `ai/duplicate/**`, `ai/geospatial/**`, `ai/pipeline.py`, `ai/model_info.py`, `ai/tests/test_{fusion,severity,priority,duplicate,geospatial,pipeline}.py` | |
| B1 | `apps/accounts/**` (not models/signals/apps), `apps/officers/**` (not models), `apps/departments/**` (not models) incl. `defaults.py` + `management/commands/init_civicai.py`, `apps/core/**` (not models/permissions/pagination/exceptions/validators/utils), `apps/audit/{serializers,views,urls,filters,tests}.py` | auth, users, officers, departments, categories, routing, system config, AI config, risk zones, contact, geo, audit logs |
| B2 | `apps/complaints/{serializers,views,ai_views,filters,permissions,urls,tests}.py` (or `tests/`) | complaints REST API + `/api/ai/*` + `/api/duplicates/` |
| B3 | `apps/complaints/services/**`, `apps/complaints/tasks.py`, `apps/complaints/management/**`, `apps/complaints/tests_services.py` | |
| B4 | `apps/assignments/**`, `apps/notifications/**`, `apps/feedback/**` (not models) | |
| B5 | `apps/analytics/**` (not models) | analytics, reports, hotspots API, alerts, Celery hotspot task |
| F1 | frontend config files, `public/**`, `src/main.jsx`, `src/App.jsx`, `src/index.css` (extend only), `src/services/**`, `src/context/**`, `src/hooks/**`, `src/utils/**`, `src/components/ui/**`, `src/components/layout/**`, placeholder page files | |
| F2 | `src/components/{complaints,maps,charts,ai}/**` | starts after F1 |
