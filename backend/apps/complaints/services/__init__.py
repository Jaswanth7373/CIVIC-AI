"""Complaint business logic (service layer). Views stay thin and call these functions.

Modules:
    submission    submit_complaint() - create + run the full AI pipeline
    pipeline      process_new_complaint(), analyze_preview(), reanalyze_complaint()
    context       build data the AI engine needs (categories, risk zones, config, nearby complaints)
    priority      recalculate_priority()
    duplicates    detect_duplicates(), review_duplicate()
    status        lifecycle transitions + timeline events + allowed actions
    verification  evidence upload, AI-assisted verification, manual override
    routing       route_department()
    overrides     override_ai()
    sla           SLA breach detection used by tasks.check_sla_breaches and ``manage.py check_sla``
    notify        safe wrappers implementing the notification matrix (never raise)
    helpers       JSON safety for AI outputs, step timing, savepoint-isolated side effects, mini representations

Cross-app collaborators (accounts, departments, assignments, notifications, feedback, analytics, audit) and the
AI engine functions are imported lazily inside functions, so these modules never create import cycles between
Django apps; only leaf infrastructure (apps.core exceptions/permissions/utils/validators, ai.config) is imported
at module level.
"""
