"""CivicAI AI engine.

A framework-independent Python package (no Django imports) containing every
AI / ML component of the platform:

    ai.vision        - civic issue image analysis (YOLO / CLIP zero-shot / demo OpenCV heuristics)
    ai.nlp           - text preprocessing, classification, embeddings, keywords, sentiment
    ai.multimodal    - image + text + location late fusion
    ai.severity      - severity assessment (Low / Medium / High / Critical)
    ai.priority      - configurable 0-100 priority engine with explanations
    ai.duplicate     - duplicate detection (text embeddings + perceptual hashes + GPS)
    ai.geospatial    - haversine distances, location risk, DBSCAN hotspots
    ai.verification  - before/after resolution verification (OpenCV SSIM & friends)
    ai.pipeline      - orchestrates the analysis for one complaint

The Django layer (apps.complaints.services) gathers data from the database,
passes plain dicts into these modules and persists the results.

Mode is controlled by the MODEL_MODE environment variable ("demo" | "production").
"""

from .config import get_model_mode, is_demo_mode  # noqa: F401

__version__ = "1.0.0"
