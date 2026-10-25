"""Generate deterministic synthetic civic-issue photos for CivicAI demos, evaluation and tests.

Usage (from ``backend/``)::

    venv/Scripts/python.exe scripts/generate_sample_images.py            # 10 images per class
    venv/Scripts/python.exe scripts/generate_sample_images.py --count 8

Output (``backend/sample_data/images/``)::

    <slug>/<slug>_<nn>.jpg              "before" photo of the issue (640x480 JPEG)
    after/<slug>_<nn>_after.jpg         the SAME scene after repair (defect patched / cleared)
    unchanged/<slug>_<nn>_unchanged.jpg the same scene re-shot WITHOUT repair (negative verification case)
    manifest.json                       every file, its label and the ground-truth defect box

How the "photos" are made (procedural rendering, no external assets):

* **Textures** - asphalt and concrete are layered noise: fine Gaussian noise (grain), up-sampled low
  frequency noise (mottling) and sparse bright/dark specks (aggregate stones). Walls, sky and water are
  smooth gradients plus low-frequency noise.
* **Defects** are drawn with OpenCV primitives on top of the texture: irregular polygons from a random
  Fourier series (potholes, puddles), random-walk polylines (cracks, branches), shaded cylinders
  (pipes, trunks), hundreds of small ellipses (leaves, litter) and alpha-blended spray / glow.
* **Same scene, three states** - every random choice of a scene is drawn once from a seeded generator
  (``numpy.random.default_rng([BASE_SEED, class, index, ...])``); the "after" and "unchanged" renders reuse
  those parameters, so only the defect (repaired or not) differs.
* **Camera and light** - each state gets its own small camera jitter (rotation, zoom, shift) and lighting
  change (exposure, white balance, light gradient, vignetting) plus fresh sensor noise and JPEG compression,
  exactly what happens when an officer re-photographs a site. The images are therefore never
  pixel-identical, which is what makes the resolution-verification task realistic.

Everything is deterministic: running the script twice produces byte-identical files.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import cv2  # noqa: E402
import numpy as np  # noqa: E402

from ai.config import CIVIC_CLASSES  # noqa: E402

OUT_DIR = BACKEND_DIR / "sample_data" / "images"
WIDTH, HEIGHT = 640, 480
MARGIN = 32                      # extra canvas border so camera jitter never shows an empty edge
CW, CH = WIDTH + 2 * MARGIN, HEIGHT + 2 * MARGIN
BASE_SEED = 20261017
DEFAULT_COUNT = 10
JPEG_QUALITY = 88
STATES = ("before", "after", "unchanged")


# ======================================================================================================
# Random helpers
# ======================================================================================================
def scene_rng(slug: str, index: int, stream: int = 0) -> np.random.Generator:
    """Independent, reproducible random stream for (class, image index, purpose)."""
    return np.random.default_rng([BASE_SEED, CIVIC_CLASSES.index(slug), index, stream])


def _u(rng, lo, hi):
    return float(rng.uniform(lo, hi))


def _i(rng, lo, hi):
    """Random int in [lo, hi] (inclusive)."""
    return int(rng.integers(lo, hi + 1))


# ======================================================================================================
# Texture helpers (float32 BGR images in 0..255)
# ======================================================================================================
def _norm_noise(rng, h, w, blur):
    n = rng.standard_normal((h, w)).astype(np.float32)
    if blur > 0:
        n = cv2.GaussianBlur(n, (0, 0), blur)
    return n / (n.std() + 1e-6)


def _lowfreq(rng, h, w, cells=(6, 8)):
    small = rng.standard_normal(cells).astype(np.float32)
    big = cv2.resize(small, (w, h), interpolation=cv2.INTER_CUBIC)
    return big / (big.std() + 1e-6)


def _stack(gray, tint):
    return np.dstack([gray + tint[0], gray + tint[1], gray + tint[2]]).astype(np.float32)


def asphalt(rng, h, w, base, tint=(0.0, 0.0, 0.0), grain=11.0, mottle=7.0, specks=1.0):
    """Asphalt: grey base + grain + mottling + aggregate specks (bright and dark stones)."""
    g = base + _norm_noise(rng, h, w, 0.8) * grain + _lowfreq(rng, h, w, (7, 9)) * mottle
    speck = np.zeros((h, w), np.float32)
    speck[rng.random((h, w)) < 0.004 * specks] = 38.0
    speck[rng.random((h, w)) < 0.006 * specks] = -30.0
    g += cv2.GaussianBlur(speck, (0, 0), 0.7)
    img = _stack(g, tint)
    img += rng.standard_normal((h, w, 3)).astype(np.float32) * 1.5   # slight per-channel colour variation
    return img


def concrete(rng, h, w, base, tint=(-4.0, 0.0, 4.0)):
    """Concrete / pavement: lighter, finer and smoother than asphalt."""
    g = base + _norm_noise(rng, h, w, 1.2) * 6.0 + _lowfreq(rng, h, w, (5, 7)) * 6.0
    return _stack(g, tint)


def plaster(rng, h, w, base, tint):
    """Painted plaster wall: smooth with large blotches."""
    g = base + _norm_noise(rng, h, w, 1.5) * 3.5 + _lowfreq(rng, h, w, (4, 6)) * 7.0
    return _stack(g, tint)


def vertical_gradient(h, w, top, bottom):
    t = np.linspace(0.0, 1.0, h, dtype=np.float32)[:, None, None]
    top = np.array(top, np.float32)[None, None, :]
    bottom = np.array(bottom, np.float32)[None, None, :]
    return np.repeat(top * (1 - t) + bottom * t, w, axis=1)


def blend(img, mask, colour, alpha=1.0):
    """img <- img*(1-a*m) + colour*a*m ; colour can be a BGR triple or an image."""
    m = (mask * alpha)[..., None] if mask.ndim == 2 else mask * alpha
    col = np.array(colour, np.float32)[None, None, :] if not isinstance(colour, np.ndarray) or colour.ndim == 1 \
        else colour
    img *= (1.0 - m)
    img += col * m
    return img


def poly_mask(h, w, pts, soft=0.0):
    mask = np.zeros((h, w), np.float32)
    cv2.fillPoly(mask, [np.round(pts).astype(np.int32)], 1.0, lineType=cv2.LINE_AA)
    return cv2.GaussianBlur(mask, (0, 0), soft) if soft > 0 else mask


def blend_poly(img, pts, colour, alpha=1.0, soft=0.7):
    """Alpha-blend a small filled polygon, working only inside its bounding box (much faster than a
    full-frame mask when hundreds of small objects are drawn)."""
    pts = np.asarray(pts, np.float64)
    pad = int(3 * soft) + 2
    h, w = img.shape[:2]
    x1, y1 = np.floor(pts.min(axis=0)).astype(int) - pad
    x2, y2 = np.ceil(pts.max(axis=0)).astype(int) + pad
    x1, y1, x2, y2 = max(x1, 0), max(y1, 0), min(x2, w), min(y2, h)
    if x2 <= x1 or y2 <= y1:
        return np.zeros((0, 0), np.float32), (0, 0)
    local = poly_mask(y2 - y1, x2 - x1, pts - np.array([x1, y1]), soft)
    roi = img[y1:y2, x1:x2]
    col = colour[y1:y2, x1:x2] if isinstance(colour, np.ndarray) and colour.ndim == 3 else colour
    blend(roi, local, col, alpha)
    return local, (x1, y1)


def blob_polygon(rng, cx, cy, rx, ry, angle_deg=0.0, roughness=0.18, n=80, jitter=0.03):
    """Irregular closed outline: an ellipse whose radius is modulated by a random Fourier series."""
    t = np.linspace(0, 2 * np.pi, n, endpoint=False)
    r = np.ones(n)
    for k in range(2, 8):
        r += rng.normal(0, roughness / k) * np.cos(k * t + rng.uniform(0, 2 * np.pi))
    r += rng.normal(0, jitter, n)
    r = np.clip(r, 0.6, 1.45)
    x, y = rx * r * np.cos(t), ry * r * np.sin(t)
    a = math.radians(angle_deg)
    xr, yr = x * math.cos(a) - y * math.sin(a), x * math.sin(a) + y * math.cos(a)
    return np.stack([xr + cx, yr + cy], axis=1)


def random_walk(rng, x, y, angle, steps, step_len=7.0, wiggle=0.22):
    pts = [(x, y)]
    for _ in range(steps):
        angle += rng.normal(0, wiggle)
        x += step_len * math.cos(angle)
        y += step_len * math.sin(angle)
        pts.append((x, y))
    return np.array(pts), angle


def bbox_of(points_list, pad=0.0):
    pts = np.concatenate([np.asarray(p, np.float64).reshape(-1, 2) for p in points_list], axis=0)
    x1, y1 = pts.min(axis=0) - pad
    x2, y2 = pts.max(axis=0) + pad
    return [float(x1), float(y1), float(x2), float(y2)]


def lane_marking(img, rng, y, colour, dashed=True, thickness=10, angle=0.0):
    """Painted (slightly worn) lane line across the road."""
    h, w = img.shape[:2]
    mask = np.zeros((h, w), np.float32)
    x = -20.0
    slope = math.tan(math.radians(angle))
    while x < w + 20:
        length = 90.0 if dashed else w + 60.0
        p1 = (int(x), int(y + slope * x))
        p2 = (int(x + length), int(y + slope * (x + length)))
        cv2.line(mask, p1, p2, 1.0, thickness)
        x += length + (60.0 if dashed else 0.0)
    wear = np.clip(0.75 + 0.35 * _norm_noise(rng, h, w, 2.0), 0.3, 1.0)
    blend(img, cv2.GaussianBlur(mask, (0, 0), 0.8) * wear, colour, 0.85)


def sidewalk_band(img, rng, height):
    """Concrete footpath + kerb along the top of a road photo."""
    h, w = img.shape[:2]
    walk = concrete(rng, height, w, _u(rng, 150, 180))
    img[:height] = walk
    kerb = np.zeros((h, w), np.float32)
    cv2.rectangle(kerb, (0, height - 4), (w, height + 9), 1.0, -1)
    blend(img, kerb, (175, 178, 180), 0.9)
    shadow = np.zeros((h, w), np.float32)
    cv2.rectangle(shadow, (0, height + 9), (w, height + 16), 1.0, -1)
    blend(img, cv2.GaussianBlur(shadow, (0, 0), 2.0), (40, 40, 40), 0.35)


def buildings_band(img, rng, horizon, night=False):
    """Row of simple buildings with windows above ``horizon`` (sky must already be drawn)."""
    h, w = img.shape[:2]
    x = -_u(rng, 0, 40)
    lit = []
    while x < w:
        bw = _u(rng, 70, 150)
        bh = _u(rng, 0.25, 0.75) * horizon
        x1, x2 = int(x), int(x + bw)
        y1 = int(horizon - bh)
        if night:
            colour = (_u(rng, 18, 28), _u(rng, 16, 24), _u(rng, 14, 22))
        else:
            v = _u(rng, 140, 205)
            colour = (v + _u(rng, -15, 10), v + _u(rng, -10, 8), v + _u(rng, -5, 15))
        cv2.rectangle(img, (x1, y1), (x2, int(horizon)), colour, -1)
        for wy in range(y1 + 10, int(horizon) - 14, 20):
            for wx in range(x1 + 8, x2 - 10, 18):
                if night:
                    if rng.random() < 0.25:
                        warm = (_u(rng, 60, 110), _u(rng, 160, 205), _u(rng, 215, 250))
                        cv2.rectangle(img, (wx, wy), (wx + 6, wy + 8), warm, -1)
                        lit.append((wx + 3, wy + 4))
                    else:
                        cv2.rectangle(img, (wx, wy), (wx + 6, wy + 8), (12, 12, 14), -1)
                else:
                    shade = _u(rng, 70, 110)
                    cv2.rectangle(img, (wx, wy), (wx + 7, wy + 9), (shade + 20, shade + 8, shade), -1)
        x += bw + _u(rng, 0, 12)
    return lit


# ======================================================================================================
# Scene sampling + drawing, one pair of functions per class.
#   sample_<slug>(rng) -> params         (all random decisions; shared by before / after / unchanged)
#   draw_<slug>(p, state) -> (canvas, defect_box_in_canvas_px)
# ======================================================================================================
def _road_base(p, rng):
    img = asphalt(rng, CH, CW, p["base"], p["tint"])
    if p.get("sidewalk"):
        sidewalk_band(img, rng, p["sidewalk"])
    if p.get("lane"):
        lane_marking(img, rng, p["lane_y"], p["lane_colour"], dashed=p["lane_dashed"], angle=p["lane_angle"])
    return img


def _road_params(rng, base_range=(85, 125), sidewalk_p=0.4, lane_p=0.5):
    tint = rng.choice([[3.0, 0.0, -2.0], [-3.0, 0.0, 3.0], [0.0, 0.0, 0.0]])
    return {
        "base": _u(rng, *base_range),
        "tint": tuple(float(t) for t in tint),
        "sidewalk": _i(rng, 70, 120) if rng.random() < sidewalk_p else 0,
        "lane": bool(rng.random() < lane_p),
        "lane_y": _u(rng, 0.25, 0.9) * CH,
        "lane_colour": (230, 232, 235) if rng.random() < 0.6 else (40, 190, 230),
        "lane_dashed": bool(rng.random() < 0.7),
        "lane_angle": _u(rng, -8, 8),
    }


# ---------------------------------------------------------------------------------------------- pothole
def sample_pothole(rng):
    p = _road_params(rng)
    rx = _u(rng, 60, 135)
    p.update(seed=_i(rng, 0, 10**9), cx=_u(rng, 0.32, 0.68) * CW, cy=_u(rng, 0.5, 0.74) * CH, rx=rx,
             ry=rx * _u(rng, 0.45, 0.8), angle=_u(rng, -25, 25), depth=_u(rng, 0.42, 0.58),
             rim=_u(rng, 22, 42), puddle=bool(rng.random() < 0.2), cracks=bool(rng.random() < 0.25),
             patch_rect=bool(rng.random() < 0.6), patch_tone=_u(rng, 0.82, 0.95))
    if p["lane"]:  # keep the lane line away from the hole
        p["lane_y"] = p["cy"] - p["ry"] - _u(rng, 50, 90)
    return p


def draw_pothole(p, state):
    rng_bg, rng_d = np.random.default_rng(p["seed"]), np.random.default_rng(p["seed"] + 1)
    img = _road_base(p, rng_bg)
    outline = blob_polygon(rng_d, p["cx"], p["cy"], p["rx"], p["ry"], p["angle"], roughness=0.22, jitter=0.04)
    box = bbox_of([outline], pad=4)
    if state == "after":
        rng_f = np.random.default_rng(p["seed"] + 2)
        if p["patch_rect"]:
            x1, y1, x2, y2 = bbox_of([outline], pad=_u(rng_f, 8, 20))
            cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
            rect = cv2.boxPoints(((cx, cy), (x2 - x1, y2 - y1), _u(rng_f, -6, 6)))
            patch_pts = rect
        else:
            patch_pts = blob_polygon(rng_f, p["cx"], p["cy"], p["rx"] * 1.15, p["ry"] * 1.15, p["angle"],
                                     roughness=0.1, jitter=0.01)
        fresh = asphalt(rng_f, CH, CW, p["base"] * p["patch_tone"], p["tint"], grain=8.0, mottle=3.0, specks=0.5)
        blend(img, poly_mask(CH, CW, patch_pts, soft=1.2), fresh)
        return img, None

    inside = poly_mask(CH, CW, outline, soft=1.0)
    hard = (inside > 0.5).astype(np.uint8)
    gravel = asphalt(rng_d, CH, CW, p["base"] * p["depth"], (2.0, 1.0, 0.0), grain=15.0, mottle=6.0, specks=3.0)
    # depth shading: the wall on the far side is in shadow, the floor is a little lighter in the centre
    dist = cv2.distanceTransform(hard, cv2.DIST_L2, 5)
    depth = np.clip(dist / (dist.max() + 1e-6), 0, 1)
    gravel *= (0.72 + 0.28 * depth)[..., None]
    blend(img, inside, gravel)
    # rim: broken, lighter asphalt edge (exposed aggregate)
    k = max(3, int(p["rx"] * 0.09))
    ring = cv2.dilate(hard, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * k + 1, 2 * k + 1))) - hard
    ring = cv2.GaussianBlur(ring.astype(np.float32), (0, 0), 1.5)
    rim_noise = np.clip(0.6 + 0.4 * _norm_noise(rng_d, CH, CW, 1.0), 0.2, 1.4)
    img += (ring * rim_noise * p["rim"])[..., None]
    # chunks of broken asphalt around the edge
    for _ in range(_i(rng_d, 3, 7)):
        a = _u(rng_d, 0, 2 * np.pi)
        cx = p["cx"] + math.cos(a) * p["rx"] * _u(rng_d, 1.0, 1.25)
        cy = p["cy"] + math.sin(a) * p["ry"] * _u(rng_d, 1.0, 1.25)
        chunk = blob_polygon(rng_d, cx, cy, _u(rng_d, 4, 10), _u(rng_d, 3, 7), _u(rng_d, 0, 180), 0.3)
        tone = p["base"] * _u(rng_d, 0.6, 1.25)
        blend_poly(img, chunk, (tone, tone, tone), 0.9, soft=0.6)
    if p["puddle"]:
        pud = blob_polygon(rng_d, p["cx"], p["cy"] + p["ry"] * 0.15, p["rx"] * 0.45, p["ry"] * 0.35, p["angle"], 0.15)
        pm = poly_mask(CH, CW, pud, 1.5)
        blend(img, pm, (p["base"] * 0.42 + 8, p["base"] * 0.4 + 4, p["base"] * 0.38), 0.85)
        hl = blob_polygon(rng_d, p["cx"] - p["rx"] * 0.1, p["cy"], p["rx"] * 0.12, p["ry"] * 0.06, 0, 0.1)
        blend(img, poly_mask(CH, CW, hl, 2.0) * pm, (170, 170, 165), 0.5)
    if p["cracks"]:
        mask = np.zeros((CH, CW), np.float32)
        for _ in range(_i(rng_d, 2, 3)):
            a = _u(rng_d, 0, 2 * np.pi)
            sx, sy = p["cx"] + math.cos(a) * p["rx"], p["cy"] + math.sin(a) * p["ry"]
            pts, _ = random_walk(rng_d, sx, sy, a, _i(rng_d, 6, 12), 7.0, 0.3)
            cv2.polylines(mask, [pts.astype(np.int32)], False, 1.0, 2, cv2.LINE_AA)
        img *= (1 - 0.55 * cv2.GaussianBlur(mask, (0, 0), 0.6))[..., None]
    return img, box


# ---------------------------------------------------------------------------------------------- garbage
_LITTER_COLOURS = [
    (40, 40, 200), (200, 80, 30), (40, 200, 230), (60, 170, 60), (170, 60, 190), (30, 120, 240),
    (235, 235, 235), (210, 220, 225), (35, 35, 38), (60, 95, 140), (200, 170, 40), (120, 60, 200),
    (90, 200, 160), (20, 70, 160),
]
#: Saturated spray-paint colours for graffiti (BGR).
_PAINT_COLOURS = [(40, 40, 210), (210, 90, 30), (30, 200, 240), (50, 180, 60), (180, 50, 200), (20, 120, 245),
                  (200, 170, 30), (130, 40, 190)]


def sample_garbage(rng):
    concrete_ground = bool(rng.random() < 0.55)
    p = {
        "seed": _i(rng, 0, 10**9), "concrete": concrete_ground,
        "base": _u(rng, 150, 180) if concrete_ground else _u(rng, 85, 120),
        "wall": _i(rng, 110, 170) if rng.random() < 0.4 else 0,
        "cx": _u(rng, 0.35, 0.65) * CW, "cy": _u(rng, 0.55, 0.72) * CH,
        "sx": _u(rng, 55, 110), "sy": _u(rng, 30, 60), "items": _i(rng, 30, 60), "scatter": _i(rng, 5, 12),
        "leftover": _i(rng, 0, 1),
    }
    return p


def _litter_item(img, rng, x, y, scale=1.0):
    kind = rng.choice(["bag", "bag", "bottle", "wrapper", "paper", "carton", "can"])
    colour = np.array(_LITTER_COLOURS[_i(rng, 0, len(_LITTER_COLOURS) - 1)], np.float32)
    if kind == "carton":
        colour = np.array((_u(rng, 50, 80), _u(rng, 100, 130), _u(rng, 150, 185)), np.float32)
    if kind == "paper":
        v = _u(rng, 215, 245)
        colour = np.array((v - 5, v, v), np.float32)
    colour = colour * _u(rng, 0.8, 1.1)
    size = _u(rng, 10, 26) * scale
    if kind == "bag":
        pts = blob_polygon(rng, x, y, size * _u(rng, 0.9, 1.5), size * _u(rng, 0.6, 1.0), _u(rng, 0, 180), 0.35)
    elif kind in ("bottle", "can"):
        length = size * (2.2 if kind == "bottle" else 1.3)
        pts = cv2.boxPoints(((x, y), (length, size * 0.55), _u(rng, 0, 180)))
    else:
        pts = cv2.boxPoints(((x, y), (size * _u(rng, 0.8, 1.6), size * _u(rng, 0.6, 1.2)), _u(rng, 0, 180)))
    blend_poly(img, pts, colour)
    # simple shading: a lighter highlight towards the light (upper-left)
    highlight = np.asarray(pts) * 0.6 + np.array([x, y]) * 0.4 - np.array([size * 0.15, size * 0.15])
    blend_poly(img, highlight, np.minimum(colour * 1.35 + 25, 255), 0.45, soft=1.5)
    return pts


def draw_garbage(p, state):
    rng_bg, rng_d = np.random.default_rng(p["seed"]), np.random.default_rng(p["seed"] + 1)
    if p["concrete"]:
        img = concrete(rng_bg, CH, CW, p["base"])
    else:
        img = asphalt(rng_bg, CH, CW, p["base"])
    if p["wall"]:
        img[: p["wall"]] = plaster(rng_bg, p["wall"], CW, _u(rng_bg, 175, 210), (-10, -2, 8))
        kerb = np.zeros((CH, CW), np.float32)
        cv2.rectangle(kerb, (0, p["wall"]), (CW, p["wall"] + 10), 1.0, -1)
        blend(img, kerb, (120, 122, 125), 0.8)
    if state == "after":
        rng_f = np.random.default_rng(p["seed"] + 2)
        stain = blob_polygon(rng_f, p["cx"], p["cy"], p["sx"] * 1.2, p["sy"] * 1.1, 0, 0.2)
        img *= (1 - 0.07 * poly_mask(CH, CW, stain, 8.0))[..., None]
        for _ in range(p["leftover"]):
            x = p["cx"] + _u(rng_f, -1.5, 1.5) * p["sx"]
            y = p["cy"] + _u(rng_f, -1, 1) * p["sy"]
            _litter_item(img, rng_f, x, y, 0.5)
        return img, None
    shadow = blob_polygon(rng_d, p["cx"], p["cy"] + p["sy"] * 0.3, p["sx"] * 1.5, p["sy"] * 1.3, 0, 0.15)
    img *= (1 - 0.28 * poly_mask(CH, CW, shadow, 10.0))[..., None]
    outlines = []
    for _ in range(p["items"]):
        x = p["cx"] + rng_d.normal(0, p["sx"] * 0.55)
        y = p["cy"] + rng_d.normal(0, p["sy"] * 0.55)
        outlines.append(_litter_item(img, rng_d, x, y))
    box = bbox_of(outlines, pad=2)
    for _ in range(p["scatter"]):
        x = p["cx"] + rng_d.normal(0, p["sx"] * 1.6)
        y = p["cy"] + rng_d.normal(0, p["sy"] * 1.6)
        _litter_item(img, rng_d, x, y, 0.6)
    return img, box


# ---------------------------------------------------------------------------------------------- drainage
def sample_drainage(rng):
    p = _road_params(rng, sidewalk_p=0.0, lane_p=0.3)
    top = rng.choice(["sidewalk", "buildings", "none"], p=[0.45, 0.3, 0.25])
    rx = _u(rng, 170, 290)
    water = rng.choice(["muddy", "grey_blue", "dark"], p=[0.45, 0.35, 0.2])
    colours = {"muddy": (_u(rng, 55, 75), _u(rng, 90, 108), _u(rng, 115, 138)),
               "grey_blue": (_u(rng, 120, 140), _u(rng, 105, 120), _u(rng, 85, 100)),
               "dark": (_u(rng, 70, 85), _u(rng, 72, 84), _u(rng, 66, 78))}
    p.update(seed=_i(rng, 0, 10**9), top=str(top), top_h=_i(rng, 90, 150), cx=_u(rng, 0.4, 0.6) * CW,
             cy=_u(rng, 0.6, 0.72) * CH, rx=rx, ry=rx * _u(rng, 0.35, 0.55), water=tuple(colours[str(water)]),
             reflect=_u(rng, 20, 45), ripples=_i(rng, 2, 6), debris=_i(rng, 0, 5), grate=bool(rng.random() < 0.3))
    p["lane_y"] = p["cy"] + _u(rng, -0.2, 0.2) * p["ry"]
    return p


def draw_drainage(p, state):
    rng_bg, rng_d = np.random.default_rng(p["seed"]), np.random.default_rng(p["seed"] + 1)
    img = _road_base(p, rng_bg)
    if p["top"] == "sidewalk":
        sidewalk_band(img, rng_bg, p["top_h"])
    elif p["top"] == "buildings":
        img[: p["top_h"]] = vertical_gradient(p["top_h"], CW, (235, 205, 170), (225, 220, 210))
        buildings_band(img, rng_bg, p["top_h"])
    outline = blob_polygon(rng_d, p["cx"], p["cy"], p["rx"], p["ry"], _u(rng_d, -8, 8), roughness=0.14)
    pool = poly_mask(CH, CW, outline, soft=2.0)
    hard = (pool > 0.5).astype(np.uint8)
    box = bbox_of([outline], pad=4)
    if state == "after":
        rng_f = np.random.default_rng(p["seed"] + 2)
        damp = cv2.GaussianBlur(pool, (0, 0), 12.0)
        img *= (1 - 0.08 * damp)[..., None]
        silt = np.clip(_lowfreq(rng_f, CH, CW, (10, 12)), 0, None) * damp
        img += (silt * 6.0)[..., None] * np.array([0.6, 1.0, 1.4], np.float32)
        return img, None
    # wet, darker margin around the water
    k = 15
    margin = cv2.dilate(hard, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * k + 1, 2 * k + 1))) - hard
    img *= (1 - 0.25 * cv2.GaussianBlur(margin.astype(np.float32), (0, 0), 5.0))[..., None]
    # water body: base colour + sky reflection that is lighter on the far (upper) side + very smooth noise
    ys = np.arange(CH, dtype=np.float32)[:, None]
    y_top, y_bot = box[1], box[3]
    rel = np.clip((ys - y_top) / max(1.0, y_bot - y_top), 0, 1)
    water = np.empty((CH, CW, 3), np.float32)
    water[:] = np.array(p["water"], np.float32)
    water += (p["reflect"] * (1 - rel))[..., None]
    water += (_lowfreq(rng_d, CH, CW, (5, 7)) * 4.0)[..., None]
    # reflections of poles / trees: soft vertical darker stripes
    for _ in range(_i(rng_d, 0, 2)):
        x = _u(rng_d, box[0], box[2])
        stripe = np.zeros((CH, CW), np.float32)
        cv2.rectangle(stripe, (int(x), int(y_top)), (int(x + _u(rng_d, 6, 14)), int(y_bot)), 1.0, -1)
        water *= (1 - 0.25 * cv2.GaussianBlur(stripe, (0, 0), 4.0))[..., None]
    blend(img, pool, water)
    # ripples from rain drops: thin concentric lighter ellipses
    ripple = np.zeros((CH, CW), np.float32)
    for _ in range(p["ripples"]):
        a = _u(rng_d, 0, 2 * np.pi)
        rr = _u(rng_d, 0.0, 0.6)
        cx, cy = p["cx"] + math.cos(a) * p["rx"] * rr, p["cy"] + math.sin(a) * p["ry"] * rr
        for j in range(_i(rng_d, 2, 4)):
            rad = 8 + j * _u(rng_d, 7, 12)
            cv2.ellipse(ripple, (int(cx), int(cy)), (int(rad), int(rad * 0.4)), 0, 0, 360, 1.0, 1, cv2.LINE_AA)
    img += (cv2.GaussianBlur(ripple, (0, 0), 0.7) * pool * 30.0)[..., None]
    # specular glints
    for _ in range(_i(rng_d, 2, 5)):
        gx, gy = _u(rng_d, box[0], box[2]), _u(rng_d, y_top, y_top + (y_bot - y_top) * 0.5)
        g = blob_polygon(rng_d, gx, gy, _u(rng_d, 10, 30), _u(rng_d, 2, 5), 0, 0.2)
        blend(img, poly_mask(CH, CW, g, 2.5) * pool, (225, 225, 220), 0.45)
    for _ in range(p["debris"]):
        _litter_item(img, rng_d, _u(rng_d, box[0] + 30, box[2] - 30), _u(rng_d, y_top + 20, y_bot - 20), 0.45)
    if p["grate"]:
        gx, gy = int(_u(rng_d, box[0] + 40, box[2] - 80)), int(_u(rng_d, y_top + 10, y_bot - 40))
        grate = np.zeros((CH, CW), np.float32)
        for j in range(6):
            cv2.line(grate, (gx + j * 8, gy), (gx + j * 8, gy + 26), 1.0, 3)
        blend(img, grate * pool, (25, 28, 30), 0.6)
    return img, box


# ---------------------------------------------------------------------------------------------- streetlight
def sample_streetlight(rng):
    horizon = _u(rng, 0.55, 0.68) * CH
    return {
        "seed": _i(rng, 0, 10**9), "horizon": horizon,
        "sky_top": (_u(rng, 35, 55), _u(rng, 18, 28), _u(rng, 8, 16)),
        "sky_bottom": (_u(rng, 70, 95), _u(rng, 58, 72), _u(rng, 48, 66)),
        "stars": bool(rng.random() < 0.4), "moon": bool(rng.random() < 0.25), "buildings": bool(rng.random() < 0.7),
        "ground": _u(rng, 28, 42), "distant_lights": _i(rng, 0, 2),
        "px": _u(rng, 0.3, 0.7) * CW, "pole_bottom": _u(rng, 0.86, 0.95) * CH, "pole_top": _u(rng, 0.1, 0.2) * CH,
        "pole_w": _i(rng, 9, 15), "arm": _u(rng, 55, 90) * (1 if rng.random() < 0.5 else -1),
        "glow": _u(rng, 90, 160),
    }


def draw_streetlight(p, state):
    rng_bg = np.random.default_rng(p["seed"])
    hz = int(p["horizon"])
    img = vertical_gradient(CH, CW, p["sky_top"], p["sky_bottom"])
    if p["stars"]:
        for _ in range(_i(rng_bg, 20, 50)):
            x, y = _i(rng_bg, 0, CW - 1), _i(rng_bg, 0, int(hz * 0.6))
            v = _u(rng_bg, 120, 200)
            cv2.circle(img, (x, y), 1, (v, v, v), -1)
    if p["moon"]:
        mx, my = int(_u(rng_bg, 0.1, 0.9) * CW), int(_u(rng_bg, 0.08, 0.25) * CH)
        glow = np.zeros((CH, CW), np.float32)
        cv2.circle(glow, (mx, my), 26, 1.0, -1)
        img += (cv2.GaussianBlur(glow, (0, 0), 12) * 35)[..., None]
        cv2.circle(img, (mx, my), _i(rng_bg, 10, 15), (200, 215, 225), -1, cv2.LINE_AA)
    img[hz:] = asphalt(rng_bg, CH - hz, CW, p["ground"], (2, 0, -1), grain=5.0, mottle=3.0, specks=0.5)
    if p["buildings"]:
        buildings_band(img, rng_bg, hz, night=True)
    lane_marking(img, rng_bg, hz + (CH - hz) * 0.55, (70, 75, 80), dashed=True, thickness=6)
    for _ in range(p["distant_lights"]):  # far-away working lamps: small poles with a glow
        dx, dy = int(_u(rng_bg, 0.05, 0.95) * CW), int(hz - _u(rng_bg, 50, 90))
        cv2.line(img, (dx, dy), (dx, hz + 10), (40, 40, 44), 3)
        glow = np.zeros((CH, CW), np.float32)
        cv2.circle(glow, (dx, dy), 6, 1.0, -1)
        img += (cv2.GaussianBlur(glow, (0, 0), 8) * 160)[..., None] * np.array([0.6, 0.85, 1.0], np.float32)
        cv2.circle(img, (dx, dy), 4, (190, 230, 250), -1)
    # the pole, lit a little on one side by ambient city light
    x, top, bottom, w = int(p["px"]), int(p["pole_top"]), int(p["pole_bottom"]), p["pole_w"]
    cv2.rectangle(img, (x - w // 2, top), (x + w // 2, bottom), (62, 62, 66), -1)
    cv2.rectangle(img, (x - w // 2, top), (x - w // 2 + 2, bottom), (95, 95, 100), -1)
    cv2.rectangle(img, (x - w, bottom - 30), (x + w, bottom), (55, 55, 60), -1)
    arm_end = (int(x + p["arm"]), top + 6)
    cv2.line(img, (x, top + 4), arm_end, (62, 62, 66), 5, cv2.LINE_AA)
    lamp_center = (arm_end[0], arm_end[1] + 8)
    box = bbox_of([[(x - w, top), (x + w, bottom)], [(lamp_center[0] - 20, lamp_center[1] - 10),
                                                       (lamp_center[0] + 20, lamp_center[1] + 12)]], pad=4)
    if state == "after":  # repaired: the lamp is lit, with a glow halo and a pool of light on the road
        halo = np.zeros((CH, CW), np.float32)
        cv2.circle(halo, lamp_center, 12, 1.0, -1)
        halo = cv2.GaussianBlur(halo, (0, 0), p["glow"] * 0.35)
        halo /= halo.max() + 1e-6
        img += (halo * 150)[..., None] * np.array([0.65, 0.88, 1.0], np.float32)
        cone = np.zeros((CH, CW), np.float32)
        cv2.ellipse(cone, (lamp_center[0], int(p["pole_bottom"]) - 10), (int(p["glow"] * 1.2), int(p["glow"] * 0.35)),
                    0, 0, 360, 1.0, -1)
        img += (cv2.GaussianBlur(cone, (0, 0), 25) * 55)[..., None] * np.array([0.7, 0.9, 1.0], np.float32)
        cv2.ellipse(img, lamp_center, (20, 9), 0, 0, 360, (200, 240, 255), -1, cv2.LINE_AA)
        return img, None
    cv2.ellipse(img, lamp_center, (20, 9), 0, 0, 360, (38, 38, 44), -1, cv2.LINE_AA)
    cv2.ellipse(img, lamp_center, (20, 9), 0, 180, 360, (75, 75, 82), 2, cv2.LINE_AA)
    return img, box


# ---------------------------------------------------------------------------------------------- water_leak
def sample_water_leak(rng):
    concrete_ground = bool(rng.random() < 0.6)
    wall = _i(rng, 110, 190) if rng.random() < 0.5 else 0
    colours = [(150, 150, 146), (165, 115, 60), (48, 48, 50), (60, 85, 125)]
    return {
        "seed": _i(rng, 0, 10**9), "concrete": concrete_ground,
        "base": _u(rng, 150, 180) if concrete_ground else _u(rng, 85, 120), "wall": wall,
        "pipe_y": (wall + _u(rng, 10, 40)) if wall else _u(rng, 0.25, 0.45) * CH,
        "pipe_angle": _u(rng, -10, 10), "pipe_d": _u(rng, 26, 46),
        "pipe_colour": colours[_i(rng, 0, len(colours) - 1)],
        "burst": _u(rng, 0.3, 0.7) * CW, "jets": _i(rng, 30, 60), "stream_w": _u(rng, 50, 90),
    }


def _draw_pipe(img, x0, y0, x1, y1, d, colour):
    yy, xx = np.mgrid[0:CH, 0:CW].astype(np.float32)
    length = math.hypot(x1 - x0, y1 - y0)
    ux, uy = (x1 - x0) / length, (y1 - y0) / length
    along = (xx - x0) * ux + (yy - y0) * uy
    across = -(xx - x0) * uy + (yy - y0) * ux
    t = across / (d / 2.0)
    inside = np.clip((1.0 - np.abs(t)) * d / 3.0, 0, 1) * ((along >= 0) & (along <= length))
    profile = np.clip(0.42 + 0.58 * (1 - ((t + 0.3) / 1.3) ** 2), 0.3, 1.0)
    shaded = np.array(colour, np.float32)[None, None, :] * profile[..., None]
    shaded += (55 * np.exp(-((t + 0.5) / 0.09) ** 2))[..., None]
    blend(img, inside.astype(np.float32), shaded)
    return ux, uy


def draw_water_leak(p, state):
    rng_bg, rng_d = np.random.default_rng(p["seed"]), np.random.default_rng(p["seed"] + 1)
    img = concrete(rng_bg, CH, CW, p["base"]) if p["concrete"] else asphalt(rng_bg, CH, CW, p["base"])
    if p["wall"]:
        img[: p["wall"]] = plaster(rng_bg, p["wall"], CW, _u(rng_bg, 170, 205), (-12, -3, 6))
    slope = math.tan(math.radians(p["pipe_angle"]))
    y0, y1 = p["pipe_y"] - slope * CW / 2, p["pipe_y"] + slope * CW / 2
    ux, uy = _draw_pipe(img, -10, y0, CW + 10, y1, p["pipe_d"], p["pipe_colour"])
    for cx in np.arange(_u(rng_bg, 60, 160), CW, _u(rng_bg, 170, 250)):  # couplings
        cy = y0 + (cx + 10) * (y1 - y0) / (CW + 20)
        band = cv2.boxPoints(((cx, cy), (12, p["pipe_d"] + 6), p["pipe_angle"]))
        blend_poly(img, band, np.array(p["pipe_colour"], np.float32) * 0.8, 0.9, soft=0.8)
    bx = p["burst"]
    by = y0 + (bx + 10) * (y1 - y0) / (CW + 20)
    top_y = by - p["pipe_d"] * 0.45
    if state == "after":  # repaired: a clamp on the pipe, ground only slightly damp
        rng_f = np.random.default_rng(p["seed"] + 2)
        clamp = cv2.boxPoints(((bx, by), (26, p["pipe_d"] + 10), p["pipe_angle"]))
        blend_poly(img, clamp, (175, 178, 180), 0.95, soft=0.8)
        damp = np.zeros((CH, CW), np.float32)
        cv2.ellipse(damp, (int(bx), int(by + p["pipe_d"])), (int(_u(rng_f, 40, 70)), 20), 0, 0, 360, 1.0, -1)
        img *= (1 - 0.06 * cv2.GaussianBlur(damp, (0, 0), 10))[..., None]
        return img, None
    # water stream running down from the burst point across the pavement (wet = darker + slight blue)
    pts, _ = random_walk(rng_d, bx, by + p["pipe_d"] * 0.5, math.pi / 2 + _u(rng_d, -0.3, 0.3),
                         _i(rng_d, 40, 60), 9.0, 0.08)
    stream = np.zeros((CH, CW), np.float32)
    for j in range(len(pts) - 1):
        width = int(p["stream_w"] * (0.5 + 0.9 * j / len(pts)))
        cv2.line(stream, tuple(pts[j].astype(int)), tuple(pts[j + 1].astype(int)), 1.0, width, cv2.LINE_AA)
    stream = cv2.GaussianBlur(stream, (0, 0), 4.0)
    wet = img * 0.62 + np.array([10.0, 4.0, 0.0], np.float32)
    blend(img, stream, wet)
    glint = np.zeros((CH, CW), np.float32)
    for _ in range(_i(rng_d, 6, 14)):
        j = _i(rng_d, 0, len(pts) - 2)
        gx, gy = pts[j] + rng_d.normal(0, 12, 2)
        cv2.line(glint, (int(gx), int(gy)), (int(gx + _u(rng_d, -6, 6)), int(gy + _u(rng_d, 8, 20))), 1.0, 2)
    blend(img, cv2.GaussianBlur(glint, (0, 0), 1.0) * stream, (215, 210, 200), 0.5)
    # the spray: a fan of thin bluish-white jets + droplets + mist above the burst point
    spray = np.zeros((CH, CW), np.float32)
    jet_pts = [(bx, top_y)]
    for _ in range(p["jets"]):
        a = math.radians(_u(rng_d, -165, -15))
        length = _u(rng_d, 40, 170)
        ex, ey = bx + math.cos(a) * length, top_y + math.sin(a) * length
        mx, my = bx + math.cos(a) * length * 0.5, top_y + math.sin(a) * length * 0.5 - _u(rng_d, 0, 15)
        curve = np.array([(bx, top_y), (mx, my), (ex, ey + length * 0.15)], np.int32)
        cv2.polylines(spray, [curve], False, _u(rng_d, 0.7, 1.0), _i(rng_d, 1, 3), cv2.LINE_AA)
        jet_pts.append((ex, ey))
    for _ in range(_i(rng_d, 40, 110)):
        a = math.radians(_u(rng_d, -170, -10))
        r = _u(rng_d, 10, 180)
        cv2.circle(spray, (int(bx + math.cos(a) * r), int(top_y + math.sin(a) * r)), _i(rng_d, 1, 2),
                   _u(rng_d, 0.6, 1.0), -1)
    mist = np.zeros((CH, CW), np.float32)
    cv2.ellipse(mist, (int(bx), int(top_y - 40)), (70, 45), 0, 0, 360, 1.0, -1)
    spray = np.clip(cv2.GaussianBlur(spray, (0, 0), 0.7) + cv2.GaussianBlur(mist, (0, 0), 18) * 0.35, 0, 1)
    blend(img, spray, (248, 238, 222), 0.92)
    box = bbox_of([jet_pts], pad=6)   # annotate the leak itself (burst point + spray), not the run-off
    return img, box


# ---------------------------------------------------------------------------------------------- open_manhole
def sample_open_manhole(rng):
    p = _road_params(rng)
    r = _u(rng, 45, 85)
    p.update(seed=_i(rng, 0, 10**9), cx=_u(rng, 0.32, 0.68) * CW, cy=_u(rng, 0.5, 0.72) * CH, r=r,
             squash=_u(rng, 0.62, 0.95), tilt=_u(rng, -10, 10), collar=bool(rng.random() < 0.6),
             rim_w=_i(rng, 5, 10), rungs=bool(rng.random() < 0.4), cover_aside=bool(rng.random() < 0.5),
             cover_dx=_u(rng, 1.3, 1.9) * (1 if rng.random() < 0.5 else -1))
    if p["lane"]:
        p["lane_y"] = p["cy"] - r - _u(rng, 50, 90)
    return p


def _manhole_cover(img, rng, cx, cy, rx, ry, tilt):
    mask = np.zeros((CH, CW), np.float32)
    cv2.ellipse(mask, (int(cx), int(cy)), (int(rx), int(ry)), tilt, 0, 360, 1.0, -1, cv2.LINE_AA)
    tex = asphalt(rng, CH, CW, _u(rng, 85, 105), (-2, 0, 4), grain=6.0, mottle=4.0, specks=0.3)
    pattern = np.zeros((CH, CW), np.float32)
    for k in range(-12, 13):
        off = k * 9
        cv2.line(pattern, (int(cx + off - 80), int(cy - 80)), (int(cx + off + 80), int(cy + 80)), 1.0, 2)
        cv2.line(pattern, (int(cx + off + 80), int(cy - 80)), (int(cx + off - 80), int(cy + 80)), 1.0, 2)
    tex += (pattern * 22.0)[..., None]
    blend(img, cv2.GaussianBlur(mask, (0, 0), 0.8), tex)


def draw_open_manhole(p, state):
    rng_bg, rng_d = np.random.default_rng(p["seed"]), np.random.default_rng(p["seed"] + 1)
    img = _road_base(p, rng_bg)
    cx, cy, rx, ry, tilt = p["cx"], p["cy"], p["r"], p["r"] * p["squash"], p["tilt"]
    centre = (int(cx), int(cy))
    if p["collar"]:
        collar = np.zeros((CH, CW), np.float32)
        cv2.ellipse(collar, centre, (int(rx + 16), int(ry + 16 * p["squash"])), tilt, 0, 360, 1.0, -1, cv2.LINE_AA)
        conc = concrete(rng_bg, CH, CW, p["base"] + 35)
        blend(img, cv2.GaussianBlur(collar, (0, 0), 1.0), conc)
    rim = np.zeros((CH, CW), np.float32)
    cv2.ellipse(rim, centre, (int(rx), int(ry)), tilt, 0, 360, 1.0, -1, cv2.LINE_AA)
    steel = np.empty((CH, CW, 3), np.float32)
    steel[:] = (_u(rng_d, 120, 145), _u(rng_d, 120, 145), _u(rng_d, 118, 140))
    yy = np.arange(CH, dtype=np.float32)[:, None, None]
    steel += np.clip((cy - yy) / ry, -1, 1) * 30.0   # lit from above: upper arc brighter
    blend(img, cv2.GaussianBlur(rim, (0, 0), 0.8), steel)
    inner = (int(rx - p["rim_w"]), int(ry - p["rim_w"] * p["squash"]))
    box = [cx - rx - 3, cy - ry - 3, cx + rx + 3, cy + ry + 3]
    if state == "after":  # repaired: the cover sits in the frame
        _manhole_cover(img, np.random.default_rng(p["seed"] + 2), cx, cy, inner[0], inner[1], tilt)
        return img, None
    hole = np.zeros((CH, CW), np.float32)
    cv2.ellipse(hole, centre, inner, tilt, 0, 360, 1.0, -1, cv2.LINE_AA)
    dark = np.empty((CH, CW, 3), np.float32)
    dark[:] = (_u(rng_d, 8, 16), _u(rng_d, 8, 16), _u(rng_d, 9, 18))
    far_wall = np.clip((cy - yy[..., 0]) / inner[1], 0, 1) ** 2   # the far inner wall catches some light
    dark += (far_wall * _u(rng_d, 25, 45))[..., None]
    if p["rungs"]:
        rungs = np.zeros((CH, CW), np.float32)
        for j in range(3):
            y = int(cy - inner[1] * 0.55 + j * inner[1] * 0.28)
            cv2.line(rungs, (int(cx - inner[0] * 0.25), y), (int(cx + inner[0] * 0.25), y), 1.0, 2)
        dark += (rungs * 28.0)[..., None]
    blend(img, cv2.GaussianBlur(hole, (0, 0), 0.8), dark)
    if p["cover_aside"]:
        _manhole_cover(img, rng_d, cx + p["cover_dx"] * rx, cy + rx * 0.2, inner[0], inner[1], tilt + 15)
    return img, box


# ---------------------------------------------------------------------------------------------- road_crack
def sample_road_crack(rng):
    p = _road_params(rng, base_range=(105, 140), sidewalk_p=0.5, lane_p=0.4)
    top = (p["sidewalk"] + 60) if p["sidewalk"] else 90
    p.update(seed=_i(rng, 0, 10**9), mains=_i(rng, 2, 4), alligator=bool(rng.random() < 0.3),
             darkness=_u(rng, 0.25, 0.45), ncx=_u(rng, 0.3, 0.7) * CW, ncy=_u(rng, max(top, 0.42 * CH), 0.7 * CH),
             patch_angle=_u(rng, -5, 5))
    return p


def draw_road_crack(p, state):
    rng_bg, rng_d = np.random.default_rng(p["seed"]), np.random.default_rng(p["seed"] + 1)
    img = _road_base(p, rng_bg)
    mask = np.zeros((CH, CW), np.float32)
    all_pts = []
    # a crack network grows from a weak spot: main cracks start near a common centre and branch out
    for _ in range(p["mains"]):
        x, y = p["ncx"] + rng_d.normal(0, 45), p["ncy"] + rng_d.normal(0, 30)
        pts, angle = random_walk(rng_d, x, y, _u(rng_d, 0, 2 * np.pi), _i(rng_d, 16, 34), 7.0, 0.25)
        cv2.polylines(mask, [pts.astype(np.int32)], False, 1.0, _i(rng_d, 2, 4), cv2.LINE_AA)
        all_pts.append(pts)
        for _ in range(_i(rng_d, 2, 5)):   # branches
            j = _i(rng_d, 0, len(pts) - 1)
            bx, by = pts[j]
            bpts, _ = random_walk(rng_d, bx, by, angle + _u(rng_d, 0.5, 1.2) * rng_d.choice([-1, 1]),
                                  _i(rng_d, 6, 18), 6.0, 0.3)
            cv2.polylines(mask, [bpts.astype(np.int32)], False, 1.0, _i(rng_d, 1, 2), cv2.LINE_AA)
            all_pts.append(bpts)
    if p["alligator"]:   # interconnected "crocodile skin" cells around the centre
        seeds = np.stack([rng_d.normal(p["ncx"], 55, 16), rng_d.normal(p["ncy"], 35, 16)], axis=1)
        for i, s in enumerate(seeds):
            d = np.linalg.norm(seeds - s, axis=1)
            for j in np.argsort(d)[1:3]:
                seg = np.linspace(s, seeds[j], 6) + rng_d.normal(0, 2.5, (6, 2))
                cv2.polylines(mask, [seg.astype(np.int32)], False, 1.0, 1, cv2.LINE_AA)
                all_pts.append(seg)
    box = bbox_of(all_pts, pad=4)
    box = [max(0.0, box[0]), max(0.0, box[1]), min(CW - 1.0, box[2]), min(CH - 1.0, box[3])]
    if state == "after":  # the cracked area is cut out and patched with fresh, darker, smoother asphalt
        rng_f = np.random.default_rng(p["seed"] + 2)
        fresh = asphalt(rng_f, CH, CW, p["base"] * 0.8, p["tint"], grain=8.0, mottle=3.0, specks=0.5)
        x1, y1, x2, y2 = box
        patch = cv2.boxPoints((((x1 + x2) / 2, (y1 + y2) / 2), (x2 - x1 + 40, y2 - y1 + 40), p["patch_angle"]))
        blend(img, poly_mask(CH, CW, patch, 1.5), fresh)
        if p["lane"]:
            lane_marking(img, rng_f, p["lane_y"], p["lane_colour"], dashed=p["lane_dashed"], angle=p["lane_angle"])
        return img, None
    mask = cv2.GaussianBlur(mask, (0, 0), 0.6)
    img *= (1 - (1 - p["darkness"]) * mask)[..., None]
    return img, box


# ---------------------------------------------------------------------------------------------- fallen_tree
def sample_fallen_tree(rng):
    horizon = _u(rng, 0.33, 0.48) * CH
    xa = _u(rng, -0.05, 0.25) * CW
    xb = _u(rng, 0.6, 0.92) * CW
    ya = _u(rng, 0.6, 0.85) * CH
    angle = _u(rng, -22, 22)
    yb = float(np.clip(ya + math.tan(math.radians(angle)) * (xb - xa), horizon + 60, CH - 40))
    flip = bool(rng.random() < 0.5)
    if flip:
        xa, xb = CW - xa, CW - xb
    return {
        "seed": _i(rng, 0, 10**9), "horizon": horizon, "xa": xa, "ya": ya, "xb": xb, "yb": yb,
        "thick": _u(rng, 22, 44), "canopy_r": _u(rng, 95, 175), "leaves": _i(rng, 350, 700),
        "roots": bool(rng.random() < 0.4), "buildings": bool(rng.random() < 0.6), "road": _u(rng, 85, 120),
        "bark": (_u(rng, 35, 55), _u(rng, 60, 80), _u(rng, 85, 110)),
    }


def _leaf_colour(rng):
    hsv = np.uint8([[[_i(rng, 36, 75), _i(rng, 115, 215), _i(rng, 60, 185)]]])
    return tuple(float(c) for c in cv2.cvtColor(hsv, cv2.COLOR_HSV2BGR)[0, 0])


def draw_fallen_tree(p, state):
    rng_bg, rng_d = np.random.default_rng(p["seed"]), np.random.default_rng(p["seed"] + 1)
    hz = int(p["horizon"])
    img = asphalt(rng_bg, CH, CW, p["road"])
    img[:hz] = vertical_gradient(hz, CW, (235, 200, 160), (230, 225, 215))
    if p["buildings"]:
        buildings_band(img, rng_bg, hz)
    else:
        wall = np.zeros((CH, CW), np.float32)
        cv2.rectangle(wall, (0, int(hz - 60)), (CW, hz), 1.0, -1)
        blend(img, wall, (165, 180, 195), 1.0)
    kerb = np.zeros((CH, CW), np.float32)
    cv2.rectangle(kerb, (0, hz), (CW, hz + 12), 1.0, -1)
    blend(img, kerb, (170, 172, 175), 0.9)
    if state == "after":  # cleared road: only a few leaves and some sawdust remain
        rng_f = np.random.default_rng(p["seed"] + 2)
        for _ in range(_i(rng_f, 5, 14)):
            x, y = _u(rng_f, 0.05, 0.95) * CW, _u(rng_f, hz + 30, CH - 10)
            cv2.ellipse(img, (int(x), int(y)), (_i(rng_f, 3, 6), _i(rng_f, 2, 3)), _u(rng_f, 0, 180), 0, 360,
                        _leaf_colour(rng_f), -1, cv2.LINE_AA)
        dust = np.zeros((CH, CW), np.float32)
        cv2.ellipse(dust, (int((p["xa"] + p["xb"]) / 2), int((p["ya"] + p["yb"]) / 2)), (60, 14), 0, 0, 360, 1.0, -1)
        blend(img, cv2.GaussianBlur(dust, (0, 0), 6) * 0.5, (120, 160, 190), 0.35)
        return img, None
    xa, ya, xb, yb, th = p["xa"], p["ya"], p["xb"], p["yb"], p["thick"]
    # trunk as a shaded, tapering cylinder with bark streaks along its length
    trunk = np.zeros((CH, CW), np.float32)
    n_seg = 24
    for j in range(n_seg):
        t0, t1 = j / n_seg, (j + 1) / n_seg
        width = int(th * (1.0 - 0.45 * t0))
        p0 = (int(xa + (xb - xa) * t0), int(ya + (yb - ya) * t0))
        p1 = (int(xa + (xb - xa) * t1), int(ya + (yb - ya) * t1))
        cv2.line(trunk, p0, p1, 1.0, width, cv2.LINE_AA)
    bark = np.empty((CH, CW, 3), np.float32)
    bark[:] = np.array(p["bark"], np.float32)
    bark *= (0.8 + 0.25 * _norm_noise(rng_d, CH, CW, 1.2))[..., None]
    shadow = np.zeros((CH, CW), np.float32)
    cv2.line(shadow, (int(xa), int(ya + th * 0.6)), (int(xb), int(yb + th * 0.4)), 1.0, int(th * 0.8))
    img *= (1 - 0.35 * cv2.GaussianBlur(shadow, (0, 0), 6))[..., None]
    blend(img, cv2.GaussianBlur(trunk, (0, 0), 0.8), bark)
    if p["roots"]:
        roots = blob_polygon(rng_d, xa, ya, th * 1.3, th * 1.6, 0, 0.4)
        blend(img, poly_mask(CH, CW, roots, 1.0), (35, 50, 70), 1.0)
    # branches into the canopy
    for _ in range(_i(rng_d, 4, 8)):
        t = _u(rng_d, 0.55, 0.95)
        sx, sy = xa + (xb - xa) * t, ya + (yb - ya) * t
        a = math.atan2(yb - ya, xb - xa) + _u(rng_d, -1.1, 1.1)
        bpts, _ = random_walk(rng_d, sx, sy, a, _i(rng_d, 6, 14), 9.0, 0.2)
        cv2.polylines(img, [bpts.astype(np.int32)], False, tuple(c * 0.9 for c in p["bark"]), _i(rng_d, 3, 6),
                      cv2.LINE_AA)
    # canopy: hundreds of small leaves, denser and darker in the middle
    ccx, ccy, cr = xb + (xb - xa) * 0.08, yb - p["canopy_r"] * 0.15, p["canopy_r"]
    leaf_pts = []
    for _ in range(p["leaves"]):
        rr = abs(rng_d.normal(0, 0.5))
        a = _u(rng_d, 0, 2 * np.pi)
        lx, ly = ccx + math.cos(a) * cr * rr, ccy + math.sin(a) * cr * rr * 0.75
        leaf_pts.append((lx, ly))
        cv2.ellipse(img, (int(lx), int(ly)), (_i(rng_d, 4, 10), _i(rng_d, 3, 6)), _u(rng_d, 0, 180), 0, 360,
                    _leaf_colour(rng_d), -1, cv2.LINE_AA)
    for _ in range(_i(rng_d, 20, 50)):   # leaves and twigs scattered on the road
        x, y = _u(rng_d, 0.0, 1.0) * CW, _u(rng_d, hz + 20, CH)
        cv2.ellipse(img, (int(x), int(y)), (_i(rng_d, 3, 6), _i(rng_d, 2, 3)), _u(rng_d, 0, 180), 0, 360,
                    _leaf_colour(rng_d), -1, cv2.LINE_AA)
    box = bbox_of([[(xa, ya - th / 2), (xb, yb + th / 2)], leaf_pts], pad=6)
    return img, box


# ---------------------------------------------------------------------------------------------- other
def sample_other(rng):
    """A non-defect civic issue on a footpath: a broken bench or graffiti on a wall (alternating)."""
    p = {
        "seed": _i(rng, 0, 10**9), "wall_h": _u(rng, 0.42, 0.62) * CH, "walk": _u(rng, 150, 180),
        "wall": _u(rng, 170, 210), "wall_tint": [(-12, -2, 8), (0, 0, 0), (-22, 0, 6), (10, 2, -6)][_i(rng, 0, 3)],
        "cx": _u(rng, 0.35, 0.65) * CW, "slat_len": _u(rng, 180, 270), "wood": [
            (40, 75, 125), (85, 110, 60), (95, 95, 98), (35, 60, 95)][_i(rng, 0, 3)],
        "strokes": _i(rng, 2, 5), "palette": rng.permutation(len(_PAINT_COLOURS))[:3].tolist(),
    }
    p["variant"] = "bench" if p["seed"] % 2 == 0 else "graffiti"
    return p


def _draw_bench(img, p, rng, broken):
    cx, base_y, length = p["cx"], p["wall_h"] + 0.22 * CH, p["slat_len"]
    x1, x2 = int(cx - length / 2), int(cx + length / 2)
    pieces = []
    for leg_x in (x1 + 18, x2 - 18):
        cv2.rectangle(img, (leg_x - 4, int(base_y - 70)), (leg_x + 4, int(base_y + 55)), (45, 45, 48), -1)
    for j in range(4):   # backrest (2 slats) + seat (2 slats)
        y = int(base_y - 66 + j * 22) if j < 2 else int(base_y + (j - 2) * 18)
        colour = np.array(p["wood"], np.float32) * _u(rng, 0.9, 1.1)
        if broken and j == 1:
            continue   # missing backrest slat
        if broken and j == 2:   # seat slat snapped in the middle, one half hanging down
            mid = (x1 + x2) // 2
            cv2.rectangle(img, (x1, y), (mid - 4, y + 14), colour.tolist(), -1)
            hang = cv2.boxPoints(((mid + length / 4, y + 22), (length / 2 - 8, 14), 18))
            cv2.fillPoly(img, [hang.astype(np.int32)], colour.tolist(), cv2.LINE_AA)
            pieces.append(hang)
            continue
        cv2.rectangle(img, (x1, y), (x2, y + 14), colour.tolist(), -1)
        cv2.line(img, (x1, y + 3), (x2, y + 3), (colour * 1.2).tolist(), 1)
    pieces.append(np.array([(x1, base_y - 72), (x2, base_y + 56)], np.float64))
    return bbox_of(pieces, pad=6)


def _draw_graffiti(img, p, rng):
    pts_all = []
    mask_layers = []
    for s in range(p["strokes"]):
        colour = np.array(_PAINT_COLOURS[p["palette"][s % len(p["palette"])]], np.float32)
        x, y = _u(rng, 0.15, 0.7) * CW, _u(rng, 0.12, 0.85) * p["wall_h"]
        pts, _ = random_walk(rng, x, y, _u(rng, -0.6, 0.6), _i(rng, 20, 45), 8.0, 0.45)
        pts[:, 1] = np.clip(pts[:, 1], 10, p["wall_h"] - 15)
        stroke = np.zeros((CH, CW), np.float32)
        cv2.polylines(stroke, [pts.astype(np.int32)], False, 1.0, _i(rng, 8, 16), cv2.LINE_AA)
        for _ in range(_i(rng, 1, 3)):   # paint drips
            j = _i(rng, 0, len(pts) - 1)
            dx, dy = pts[j]
            cv2.line(stroke, (int(dx), int(dy)), (int(dx), int(min(dy + _u(rng, 15, 40), p["wall_h"] - 4))), 1.0, 2)
        mask_layers.append((cv2.GaussianBlur(stroke, (0, 0), 1.3), colour))
        pts_all.append(pts)
    for mask, colour in mask_layers:
        blend(img, mask, colour, 0.9)
    return bbox_of(pts_all, pad=12)


def draw_other(p, state):
    rng_bg, rng_d = np.random.default_rng(p["seed"]), np.random.default_rng(p["seed"] + 1)
    wall_h = int(p["wall_h"])
    img = concrete(rng_bg, CH, CW, p["walk"])
    img[:wall_h] = plaster(rng_bg, wall_h, CW, p["wall"], p["wall_tint"])
    skirting = np.zeros((CH, CW), np.float32)
    cv2.rectangle(skirting, (0, wall_h - 8), (CW, wall_h + 4), 1.0, -1)
    blend(img, skirting, (120, 124, 128), 0.85)
    if p["variant"] == "bench":
        box = _draw_bench(img, p, rng_d, broken=state != "after")
    else:
        if state == "after":   # graffiti painted over: a slightly different, fresh wall tone
            rng_f = np.random.default_rng(p["seed"] + 2)
            fresh = plaster(rng_f, CH, CW, p["wall"] + 6, p["wall_tint"])
            region = np.zeros((CH, CW), np.float32)
            region[: wall_h - 8] = 1.0
            blend(img, cv2.GaussianBlur(region, (0, 0), 1.0), fresh)
            box = None
        else:
            box = _draw_graffiti(img, p, rng_d)
    return img, (None if state == "after" else box)


SAMPLERS = {slug: globals()[f"sample_{slug}"] for slug in CIVIC_CLASSES}
DRAWERS = {slug: globals()[f"draw_{slug}"] for slug in CIVIC_CLASSES}


# ======================================================================================================
# Camera + lighting
# ======================================================================================================
def sample_camera(rng, jitter=False):
    if jitter:
        return {"rot": _u(rng, -1.6, 1.6), "scale": _u(rng, -0.025, 0.025), "dx": _u(rng, -10, 10),
                "dy": _u(rng, -8, 8)}
    return {"rot": _u(rng, -3.0, 3.0), "scale": _u(rng, 1.02, 1.06), "dx": _u(rng, -8, 8), "dy": _u(rng, -6, 6)}


def sample_light(rng, jitter=False):
    if jitter:
        return {"gain": _u(rng, -0.07, 0.07), "wb": rng.uniform(-0.03, 0.03, 3), "grad": _u(rng, -0.04, 0.04),
                "angle": _u(rng, -0.6, 0.6), "noise": _u(rng, 1.2, 2.8), "blur": 0.0}
    return {"gain": _u(rng, 0.9, 1.1), "wb": rng.uniform(0.97, 1.03, 3), "grad": _u(rng, 0.0, 0.08),
            "angle": _u(rng, 0, 2 * np.pi), "vignette": _u(rng, 0.0, 0.12), "noise": _u(rng, 1.2, 2.8),
            "blur": 0.6 if rng.random() < 0.2 else 0.0}


def camera_matrix(cam):
    """Affine canvas -> output transform: rotate/zoom about the canvas centre, shift, crop the margin."""
    m = cv2.getRotationMatrix2D((CW / 2.0, CH / 2.0), cam["rot"], cam["scale"])
    m[0, 2] += cam["dx"] - MARGIN
    m[1, 2] += cam["dy"] - MARGIN
    return m


def apply_camera(canvas, cam):
    return cv2.warpAffine(canvas, camera_matrix(cam), (WIDTH, HEIGHT), flags=cv2.INTER_LINEAR,
                          borderMode=cv2.BORDER_REFLECT)


def apply_light(img, light, rng):
    h, w = img.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    along = (xx - w / 2) * math.cos(light["angle"]) + (yy - h / 2) * math.sin(light["angle"])
    ramp = along / (0.5 * math.hypot(w, h))      # -1..1 across the frame in the light direction
    field = light["gain"] * (1.0 + light["grad"] * ramp)
    radius = np.hypot((xx - w / 2) / (w / 2), (yy - h / 2) / (h / 2)) / math.sqrt(2)
    field *= 1.0 - light["vignette"] * radius ** 2
    out = img * field[..., None] * np.asarray(light["wb"], np.float32)[None, None, :]
    out += rng.standard_normal(out.shape).astype(np.float32) * light["noise"]
    if light["blur"] > 0:
        out = cv2.GaussianBlur(out, (0, 0), light["blur"])
    return np.clip(out, 0, 255).astype(np.uint8)


def transform_box(box, cam):
    """Map a canvas-space box through the camera and clip it to the output frame (pixels)."""
    if box is None:
        return None
    x1, y1, x2, y2 = box
    corners = np.array([[x1, y1, 1], [x2, y1, 1], [x2, y2, 1], [x1, y2, 1]], np.float64)
    mapped = corners @ camera_matrix(cam).T
    bx1, by1 = mapped.min(axis=0)
    bx2, by2 = mapped.max(axis=0)
    bx1, bx2 = float(np.clip(bx1, 0, WIDTH - 1)), float(np.clip(bx2, 0, WIDTH - 1))
    by1, by2 = float(np.clip(by1, 0, HEIGHT - 1)), float(np.clip(by2, 0, HEIGHT - 1))
    if bx2 - bx1 < 2 or by2 - by1 < 2:
        return None
    return [bx1, by1, bx2, by2]


# ======================================================================================================
# Public helpers (also used by the unit tests)
# ======================================================================================================
def _state_camera_and_light(slug, index, state):
    base_cam = sample_camera(scene_rng(slug, index, 1))
    base_light = sample_light(scene_rng(slug, index, 2))
    if state == "before":
        return base_cam, base_light
    stream = 10 if state == "after" else 20
    jc = sample_camera(scene_rng(slug, index, stream), jitter=True)
    jl = sample_light(scene_rng(slug, index, stream + 1), jitter=True)
    cam = {"rot": base_cam["rot"] + jc["rot"], "scale": base_cam["scale"] + jc["scale"],
           "dx": base_cam["dx"] + jc["dx"], "dy": base_cam["dy"] + jc["dy"]}
    light = dict(base_light)
    light.update(gain=base_light["gain"] + jl["gain"], wb=np.asarray(base_light["wb"]) + jl["wb"],
                 grad=base_light["grad"] + jl["grad"], angle=base_light["angle"] + jl["angle"], noise=jl["noise"])
    return cam, light


def render_sample(slug: str, index: int, state: str = "before"):
    """Render one sample deterministically.

    Returns ``(bgr_uint8_image, box)`` where ``box`` is the defect's ground-truth box in output pixels
    ``[x1, y1, x2, y2]`` (``None`` for the repaired "after" state).
    """
    if slug not in SAMPLERS:
        raise ValueError(f"Unknown class {slug!r}")
    if state not in STATES:
        raise ValueError(f"Unknown state {state!r}; expected one of {STATES}")
    params = SAMPLERS[slug](scene_rng(slug, index, 0))
    canvas, box = DRAWERS[slug](params, state)
    cam, light = _state_camera_and_light(slug, index, state)
    noise_rng = scene_rng(slug, index, {"before": 3, "after": 13, "unchanged": 23}[state])
    image = apply_light(apply_camera(np.clip(canvas, 0, 255).astype(np.float32), cam), light, noise_rng)
    return image, transform_box(box, cam)


def encode_jpeg(image, quality=JPEG_QUALITY) -> bytes:
    ok, buf = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, int(quality)])
    if not ok:
        raise RuntimeError("JPEG encoding failed")
    return buf.tobytes()


def _normalise_box(box):
    if box is None:
        return None
    x1, y1, x2, y2 = box
    return [round(x1 / WIDTH, 4), round(y1 / HEIGHT, 4), round(x2 / WIDTH, 4), round(y2 / HEIGHT, 4)]


def generate(out_dir: Path = OUT_DIR, count: int = DEFAULT_COUNT, quality: int = JPEG_QUALITY) -> dict:
    """Render every class x index x state, write the JPEGs and ``manifest.json``; returns the manifest."""
    out_dir.mkdir(parents=True, exist_ok=True)
    folders = list(CIVIC_CLASSES) + ["after", "unchanged"]
    for folder in folders:   # remove stale images from earlier runs so the folders match the manifest
        (out_dir / folder).mkdir(parents=True, exist_ok=True)
        for old in (out_dir / folder).glob("*.jpg"):
            old.unlink()
    entries = []
    for slug in CIVIC_CLASSES:
        for index in range(1, count + 1):
            name = f"{slug}_{index:02d}"
            files = {"before": f"{slug}/{name}.jpg", "after": f"after/{name}_after.jpg",
                     "unchanged": f"unchanged/{name}_unchanged.jpg"}
            boxes = {}
            for state in STATES:
                image, box = render_sample(slug, index, state)
                (out_dir / files[state]).write_bytes(encode_jpeg(image, quality))
                boxes[state] = _normalise_box(box)
            entries.append({
                "id": name, "label": slug, "index": index, "file": files["before"], "after": files["after"],
                "unchanged": files["unchanged"], "box": boxes["before"], "unchanged_box": boxes["unchanged"],
            })
        print(f"  {slug:<13} {count} scenes x 3 states")
    manifest = {
        "generator": "scripts/generate_sample_images.py",
        "description": "Deterministic synthetic civic-issue photos (procedural textures). 'file' is the issue "
                       "photo, 'after' the same scene repaired, 'unchanged' the same scene re-shot without "
                       "repair. Boxes are normalised [x1, y1, x2, y2] ground-truth defect regions.",
        "seed": BASE_SEED, "width": WIDTH, "height": HEIGHT, "jpeg_quality": quality,
        "classes": list(CIVIC_CLASSES), "count_per_class": count, "images": entries,
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8", newline="\n")
    return manifest


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--count", type=int, default=DEFAULT_COUNT, help="scenes per class (default 10, min 6)")
    parser.add_argument("--out", type=Path, default=OUT_DIR, help="output folder (default sample_data/images)")
    parser.add_argument("--quality", type=int, default=JPEG_QUALITY, help="JPEG quality (default 88)")
    args = parser.parse_args(argv)
    if args.count < 6:
        parser.error("--count must be at least 6 (the evaluation needs several images per class)")
    print(f"Generating {args.count} scenes per class into {args.out} ...")
    manifest = generate(args.out, args.count, args.quality)
    total = len(manifest["images"]) * len(STATES)
    size_mb = sum(f.stat().st_size for f in args.out.rglob("*.jpg")) / 1e6
    print(f"Done: {total} images ({size_mb:.1f} MB) + manifest.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
