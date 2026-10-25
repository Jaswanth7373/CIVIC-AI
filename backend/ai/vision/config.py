"""Configuration of the CivicAI vision module (classes, label synonyms, prompts, thresholds).

Everything that a viva examiner might ask "where does this number come from?" about lives here, in one
place, with a comment. The values are read by :mod:`ai.vision.model`, :mod:`ai.vision.postprocessing`
and :mod:`ai.vision.inference`.

Three techniques share this configuration:

* **YOLOv8** (production, needs ``ultralytics`` + trained weights) - detector class names are mapped onto
  CivicAI classes through :data:`LABEL_SYNONYMS` (and admin categories' ``vision_labels``).
* **CLIP zero-shot** (production fallback, needs ``sentence-transformers``) - every class is described by
  several natural-language prompts (:data:`CLIP_PROMPTS`); the image embedding is compared with them.
* **Demo OpenCV heuristics** (demo mode / last-resort fallback) - hand-crafted colour / texture / shape
  features; their confidences are deliberately capped (:data:`DEMO_CONFIDENCE_CAP`).
"""
from ai.config import CIVIC_CLASSES

# --------------------------------------------------------------------------------------------------------
# Classes
# --------------------------------------------------------------------------------------------------------
#: The canonical classes the vision module scores. They equal the default CivicCategory slugs.
VISION_CLASSES = list(CIVIC_CLASSES)

#: Catch-all class used when no specific civic defect is recognised.
FALLBACK_CLASS = "other"

#: Detector label -> canonical class. Keys are normalised labels (lower case, spaces/dashes -> "_").
#: Covers our own class names, common public-dataset names (RDD2022 road-damage codes D00/D10/D20/D40,
#: Roboflow pothole sets, TACO litter classes) and common descriptive variants.
LABEL_SYNONYMS = {
    # Pothole
    "pothole": "pothole", "potholes": "pothole", "road_hole": "pothole", "pit": "pothole",
    "crater": "pothole", "d40": "pothole",
    # Garbage
    "garbage": "garbage", "trash": "garbage", "litter": "garbage", "waste": "garbage",
    "waste_pile": "garbage", "garbage_pile": "garbage", "rubbish": "garbage", "dump": "garbage",
    "plastic": "garbage", "plastic_bag": "garbage", "bottle": "garbage", "can": "garbage",
    "carton": "garbage", "cigarette": "garbage",
    # Drainage / waterlogging
    "drainage": "drainage", "waterlogging": "drainage", "water_logging": "drainage", "flood": "drainage",
    "flooded_road": "drainage", "puddle": "drainage", "sewage": "drainage", "clogged_drain": "drainage",
    "drain_overflow": "drainage", "water_pool": "drainage",
    # Streetlight
    "streetlight": "streetlight", "street_light": "streetlight", "street_lamp": "streetlight",
    "streetlamp": "streetlight", "lamp_post": "streetlight", "broken_streetlight": "streetlight",
    "dead_streetlight": "streetlight", "light_pole": "streetlight", "damaged_pole": "streetlight",
    # Water leak
    "water_leak": "water_leak", "leak": "water_leak", "leakage": "water_leak", "water_leakage": "water_leak",
    "pipe_leak": "water_leak", "burst_pipe": "water_leak", "pipe_burst": "water_leak",
    # Open manhole
    "open_manhole": "open_manhole", "manhole": "open_manhole", "uncovered_manhole": "open_manhole",
    "manhole_open": "open_manhole", "missing_manhole_cover": "open_manhole",
    # Road crack
    "road_crack": "road_crack", "crack": "road_crack", "cracks": "road_crack", "d00": "road_crack",
    "d10": "road_crack", "d20": "road_crack", "longitudinal_crack": "road_crack",
    "transverse_crack": "road_crack", "alligator_crack": "road_crack", "crack_network": "road_crack",
    # Fallen tree
    "fallen_tree": "fallen_tree", "tree": "fallen_tree", "fallen_branch": "fallen_tree",
    "uprooted_tree": "fallen_tree", "tree_obstruction": "fallen_tree", "branch": "fallen_tree",
    # Other
    "other": "other", "graffiti": "other", "broken_bench": "other", "vandalism": "other",
    "street_object": "other", "no_defect": "other",
}

#: Words that may appear in an upload filename and hint at a class (demo technique only, always disclosed).
#: Multi-word keywords are matched against joined neighbouring filename tokens (``open_manhole``).
FILENAME_HINT_KEYWORDS = {
    "pothole": ["pothole", "potholes", "gaddha", "khadda", "crater"],
    "garbage": ["garbage", "trash", "litter", "waste", "rubbish", "kachra", "chetta", "dump"],
    "drainage": ["drainage", "drain", "waterlogging", "waterlogged", "flood", "flooded", "sewage", "nala"],
    "streetlight": ["streetlight", "street_light", "streetlamp", "street_lamp", "lamp", "lamppost"],
    "water_leak": ["water_leak", "leak", "leakage", "pipeline", "burst_pipe", "pipe_burst"],
    "open_manhole": ["open_manhole", "manhole"],
    "road_crack": ["road_crack", "crack", "cracks", "cracked"],
    "fallen_tree": ["fallen_tree", "tree", "uprooted", "chettu", "branch"],
}

# --------------------------------------------------------------------------------------------------------
# Image quality (shared with ai.verification)
# --------------------------------------------------------------------------------------------------------
#: Images are analysed at most this large (longest side, pixels). Keeps inference fast and makes
#: pixel-based thresholds comparable between a 640 px and a 4000 px upload.
ANALYSIS_MAX_SIDE = 640
#: Smallest accepted image side in pixels (anything smaller cannot show a civic issue).
MIN_IMAGE_SIDE = 16
#: Sharpness = variance of the Laplacian over the most detailed BLUR_TOP_FRACTION of BLUR_TILE x BLUR_TILE
#: tiles (see preprocessing.blur_score). Below BLUR_THRESHOLD a photo counts as blurry. Calibrated on the
#: sample set: sharp photos score >= 24 (10th percentile 87); a Gaussian blur of sigma 1.5 px drops them to
#: a median of 11 (max 33); sigma 2.5 px to <= 10.
BLUR_TILE = 32
BLUR_TOP_FRACTION = 0.25
BLUR_THRESHOLD = 20.0
#: Mean luminance (0-1) below which a photo counts as dark.
DARK_THRESHOLD = 0.25

# --------------------------------------------------------------------------------------------------------
# Demo heuristic model
# --------------------------------------------------------------------------------------------------------
DEMO_MODEL_VERSION = "demo-opencv-heuristic-1.0"
#: Demo confidences are never higher than this - hand-crafted features are not a trained model.
DEMO_CONFIDENCE_CAP = 0.75
#: ...except when a class keyword in the filename agrees; the explanation then says a hint was used.
DEMO_HINT_CONFIDENCE_CAP = 0.90
#: Weight of the filename hint when it is blended with the heuristic probabilities.
FILENAME_HINT_WEIGHT = 0.5
#: Softmax temperature applied to the heuristic feature scores (smaller = more peaked). With 0.2 a score
#: lead of 0.2 multiplies the odds by e (2.7), so confidences stay graded instead of all-or-nothing.
DEMO_SOFTMAX_TEMPERATURE = 0.2
#: Constant score of the "other" class: it wins whenever no defect feature is convincingly stronger.
DEMO_OTHER_BASE_SCORE = 0.30

# --------------------------------------------------------------------------------------------------------
# YOLO (production technique 1)
# --------------------------------------------------------------------------------------------------------
YOLO_CONFIDENCE = 0.25      # minimum detection confidence (ultralytics default)
YOLO_IOU = 0.45             # NMS IoU threshold
YOLO_IMGSZ = 640            # network input size (letterboxed square)
YOLO_MAX_DETECTIONS = 50
#: When the detector finds nothing (or only weak boxes) the unexplained probability mass is split:
#: this share goes to "other", the rest is spread uniformly over every class.
NO_DETECTION_OTHER_SHARE = 0.5

# --------------------------------------------------------------------------------------------------------
# CLIP zero-shot (production technique 2)
# --------------------------------------------------------------------------------------------------------
#: CLIP multiplies cosine similarities by a learned temperature of ~100 before the softmax.
CLIP_LOGIT_SCALE = 100.0
#: Square input side used when letterboxing for CLIP (its preprocessing centre-crops non-square images,
#: which could cut the defect off; letterboxing keeps the whole photo visible).
CLIP_INPUT_SIDE = 224

#: Several prompts per class ("prompt ensembling", Radford et al. 2021): the class text embedding is the
#: normalised mean of its prompt embeddings, which is more robust than any single wording.
CLIP_PROMPTS = {
    "pothole": [
        "a photo of a pothole on a road",
        "a photo of a deep hole in the asphalt road surface",
        "a close-up photo of a damaged road with a pothole",
        "a street with a large broken pothole full of gravel",
    ],
    "garbage": [
        "a photo of a pile of garbage on the street",
        "a photo of trash and plastic waste dumped on the roadside",
        "a photo of an overflowing garbage heap",
        "litter and rubbish scattered on a footpath",
    ],
    "drainage": [
        "a photo of a waterlogged road after rain",
        "a photo of a flooded street with muddy water",
        "a photo of an overflowing drain with dirty water on the road",
        "a large puddle of stagnant water covering the road",
    ],
    "streetlight": [
        "a photo of a broken streetlight at night",
        "a photo of a dark street with a street lamp that is not working",
        "a photo of a damaged street light pole",
        "a street light pole with its lamp switched off in the dark",
    ],
    "water_leak": [
        "a photo of a leaking water pipe",
        "a photo of water spraying from a burst pipeline",
        "a photo of a water leak flooding the pavement from a pipe",
        "clean water gushing out of a broken pipe on the street",
    ],
    "open_manhole": [
        "a photo of an open manhole on the road",
        "a photo of an uncovered manhole hole in the street",
        "a photo of a missing manhole cover",
        "a dark round open sewer hole in the road",
    ],
    "road_crack": [
        "a photo of cracks in the asphalt road",
        "a photo of a cracked road surface",
        "a photo of a road with long thin cracks",
        "alligator cracking on a damaged road",
    ],
    "fallen_tree": [
        "a photo of a fallen tree blocking the road",
        "a photo of an uprooted tree lying across the street",
        "a photo of broken tree branches on the road",
        "a big tree that fell down onto a street",
    ],
    "other": [
        "a photo of a city street",
        "a photo of a broken bench in a public place",
        "a photo of graffiti on a wall",
        "a photo of a public place in a city",
    ],
}
#: Prompt templates used for admin-defined categories (filled with the category name / vision labels).
CLIP_CUSTOM_PROMPT_TEMPLATES = [
    "a photo of {}",
    "a photo of {} in a city street",
    "a civic complaint photo showing {}",
]

# --------------------------------------------------------------------------------------------------------
# Post-processing
# --------------------------------------------------------------------------------------------------------
#: IoU above which two boxes of the same class are merged by non-maximum suppression.
NMS_IOU_THRESHOLD = 0.45
#: Max objects reported per image.
MAX_REPORTED_OBJECTS = 6
#: Classes other than the top-1 also get their boxes reported when their probability reaches this value.
SECONDARY_OBJECT_MIN_PROB = 0.25
#: Visual-severity mix (sums to 1): defect area, defect darkness/contrast, number of detections.
SEVERITY_WEIGHTS = {"area": 0.45, "contrast": 0.35, "count": 0.20}
#: Defect area ratio (box area / image area) at which the area term saturates.
SEVERITY_FULL_AREA_RATIO = 0.30
#: Visual severity reported when no defect region was found at all.
SEVERITY_NO_DETECTION = 0.10

# --------------------------------------------------------------------------------------------------------
# Lazy loading
# --------------------------------------------------------------------------------------------------------
#: A production model that failed to load is not retried for this many seconds (avoids paying a slow
#: failing download / import on every request).
LOAD_RETRY_SECONDS = 600
