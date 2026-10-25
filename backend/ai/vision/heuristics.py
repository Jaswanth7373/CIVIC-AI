"""Hand-crafted OpenCV features used by the demo vision model (no training, fully deterministic).

Each civic-issue class has one feature function that looks for that issue's typical *visual pattern* and
returns a :class:`FeatureResult` with

* ``score`` (0-1)   - how strongly the pattern is present,
* ``regions``       - pixel boxes of the contours / line networks that produced the score
                      (they become the bounding boxes shown in the UI),
* ``cues``          - the intermediate measurements (useful for the viva and for debugging),
* ``evidence``      - one human sentence describing what was found.

**How cues are combined.** Every measurement is mapped to a 0-1 "truth value" with a linear :func:`ramp`
(e.g. "the rim is brighter than the floor": 0 below a 0.06 brightness difference, 1 above 0.20).
*Essential* cues are multiplied as soft gates, ``t1^w1 * t2^w2 * ...`` (:func:`gates`): if one essential
cue is clearly absent the pattern is rejected, a half-satisfied cue only lowers the score. *Optional* cues
act as bonuses, ``base + (1 - base) * t`` (:func:`bonus`): missing them lowers the score but never vetoes.

The patterns (BUILD_SPEC section 2.1):

=============  =====================================================================================
pothole        dark, irregular, textured blob on grey road with a lighter broken rim
open_manhole   very dark, almost perfectly elliptical hole with a bright metal rim (+ ``HoughCircles``)
road_crack     network of thin, wiggly dark lines (morphological black-hat, then ``HoughLinesP`` segments
               running in many directions)
garbage        many small saturated blobs in many different colour families
fallen_tree    lots of green vegetation low in the frame + an elongated brown trunk lying sideways
streetlight    dark (night) scene + a long vertical pole + no lit lamp near the top of the pole
drainage       large smooth water-coloured (brown / grey-blue / grey) region on the ground
water_leak     a fan of thin bright whitish jets (morphological top-hat) spreading in many directions,
               ideally next to a pipe (long straight parallel edges)
=============  =====================================================================================

All patterns except ``streetlight`` assume a daylight photo: their score is multiplied by a daylight gate
(dark night scenes make sky gradients look like water and building silhouettes like holes).

The functions expect the image resized to 640 px on its longest side (see ``DemoHeuristicModel``), so the
pixel constants below are meaningful.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from functools import cached_property

import cv2
import numpy as np


# ------------------------------------------------------------------------------------------------------
# Small numeric helpers
# ------------------------------------------------------------------------------------------------------
def ramp(x: float, lo: float, hi: float) -> float:
    """Linear 0 -> 1 between ``lo`` and ``hi`` (decreasing when ``lo > hi``), clipped to [0, 1]."""
    if hi == lo:
        return 1.0 if x >= hi else 0.0
    return float(min(1.0, max(0.0, (x - lo) / (hi - lo))))


def gates(*pairs) -> float:
    """Soft AND of essential cues: ``prod(t_i ** w_i)`` over ``(t_i, w_i)`` pairs (w < 1 softens a gate)."""
    out = 1.0
    for value, weight in pairs:
        out *= max(0.0, float(value)) ** weight
    return float(out)


def bonus(value: float, base: float) -> float:
    """Optional cue: ``base`` when absent, 1.0 when fully present."""
    return float(base + (1.0 - base) * max(0.0, min(1.0, value)))


def _kernel(size: int):
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (size, size))


def _union_box(boxes):
    boxes = [b for b in boxes if b is not None]
    if not boxes:
        return None
    arr = np.array(boxes, dtype=np.float64)
    return [float(arr[:, 0].min()), float(arr[:, 1].min()), float(arr[:, 2].max()), float(arr[:, 3].max())]


def _rounded(terms: dict) -> dict:
    return {k: (round(float(v), 3) if isinstance(v, (float, np.floating)) else v) for k, v in terms.items()}


# ------------------------------------------------------------------------------------------------------
# Data structures
# ------------------------------------------------------------------------------------------------------
@dataclass
class Region:
    """A pixel box ``[x1, y1, x2, y2]`` that supports a class, with its own strength (0-1)."""
    box: list
    strength: float
    label: str


@dataclass
class FeatureResult:
    score: float = 0.0
    regions: list = field(default_factory=list)
    cues: dict = field(default_factory=dict)
    evidence: str = ""


class ImageStats:
    """Per-image measurements shared by all feature functions (computed once)."""

    def __init__(self, bgr: np.ndarray):
        self.h, self.w = bgr.shape[:2]
        self.area = float(self.h * self.w)
        self.diag = math.hypot(self.h, self.w)
        self.gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
        self.hue = hsv[..., 0]                                   # OpenCV hue: 0..179 (2 degrees per unit)
        self.sat = hsv[..., 1].astype(np.float32) / 255.0
        self.val = hsv[..., 2].astype(np.float32) / 255.0
        self.brightness = float(self.gray.mean()) / 255.0
        #: 1 for daylight photos, 0 for night scenes (mean brightness 0.25 -> 0.15)
        self.daylight = ramp(self.brightness, 0.15, 0.25)
        g = self.gray.astype(np.float32)
        mean = cv2.blur(g, (7, 7))
        self.local_std = np.sqrt(np.maximum(cv2.blur(g * g, (7, 7)) - mean * mean, 0.0))
        # "Ground" reference: median brightness of the low-saturation (grey) pixels in the lower two thirds
        # of the photo - for street photos that is the road or pavement surface.
        lower = slice(self.h // 3, None)
        grey = self.sat[lower] < 0.25
        if grey.mean() > 0.05:
            self.ground_v = float(np.median(self.val[lower][grey]))
            self.ground_gray = float(np.median(self.gray[lower][grey]))
        else:
            self.ground_v = float(np.median(self.val[lower]))
            self.ground_gray = float(np.median(self.gray[lower]))
        self.ground_v = max(self.ground_v, 0.05)
        self.ground_gray = max(self.ground_gray, 12.0)
        # Typical texture of the ground surface (70th percentile of the local std-dev of grey lower pixels).
        # A low-resolution photo that was upscaled for analysis is smoother overall, so smoothness tests
        # compare against this reference instead of an absolute value.
        ground_std = self.local_std[lower][grey] if grey.mean() > 0.05 else self.local_std[lower]
        self.texture_ref = float(np.percentile(ground_std, 70)) if ground_std.size else 0.0

    @cached_property
    def edges(self) -> np.ndarray:
        """Canny edges with thresholds adapted to the image's median brightness ("auto-Canny")."""
        blurred = cv2.GaussianBlur(self.gray, (5, 5), 0)
        median = float(np.median(blurred))
        lower, upper = max(15.0, 0.66 * median), max(40.0, 1.33 * median)
        return cv2.Canny(blurred, lower, upper)

    @cached_property
    def long_lines(self) -> np.ndarray:
        """Probabilistic Hough segments at least 10% of the image height long: ``(N, 4)`` x1,y1,x2,y2.

        Callers merge collinear pieces (poles) or keep only the long ones (pipes)."""
        lines = cv2.HoughLinesP(self.edges, 1, np.pi / 180, threshold=40,
                                minLineLength=int(0.1 * self.h), maxLineGap=12)
        # OpenCV 5 returns (N, 4); OpenCV 4.x returned (N, 1, 4)
        return np.zeros((0, 4), np.float64) if lines is None else lines.reshape(-1, 4).astype(np.float64)


def _contour_mask(shape, contour) -> np.ndarray:
    mask = np.zeros(shape, np.uint8)
    cv2.drawContours(mask, [contour], -1, 1, thickness=-1)
    return mask


def _ellipse_iou(contour, mask) -> tuple[float, float, tuple]:
    """Fit an ellipse to a contour; return (IoU between ellipse and blob, minor/major axis ratio, ellipse)."""
    ellipse = cv2.fitEllipse(contour)
    (cx, cy), (ax1, ax2), angle = ellipse
    if min(ax1, ax2) <= 1:
        return 0.0, 0.0, ellipse
    emask = np.zeros_like(mask)
    cv2.ellipse(emask, ((cx, cy), (ax1, ax2), angle), 1, thickness=-1)
    inter = float(np.logical_and(mask, emask).sum())
    union = float(np.logical_or(mask, emask).sum())
    return (inter / union if union else 0.0), min(ax1, ax2) / max(ax1, ax2), ellipse


def _ring(mask: np.ndarray, width: int) -> np.ndarray:
    return cv2.dilate(mask, _kernel(2 * width + 1)) - mask


# ======================================================================================================
# Feature functions
# ======================================================================================================
def pothole_feature(st: ImageStats) -> FeatureResult:
    """Dark, irregular, textured blob on grey textured road with a lighter broken rim.

    1. Candidate pixels are clearly darker than the road (``V < 0.62 x ground``) and not colourful
       (``S < 0.35``); morphological closing + opening merge the hole and drop thin cracks / specks.
    2. For every blob covering 0.6-40% of the image the essential cues are: rim contrast (the ring around
       the blob is brighter than its floor), moderate darkness (not as black as an open manhole), solidity
       (area / convex-hull area - a hole, not a frame of bars), not elongated (axis ratio of the fitted
       ellipse - wet streaks and shadows are long), grey surroundings and *textured* surroundings
       (asphalt grain, not smooth paint or pavement slabs).
    3. Bonuses: gravel texture inside, size, and *irregularity* (a pothole outline deviates from its fitted
       ellipse, an open manhole matches it almost perfectly).
    """
    dark = ((st.val < 0.62 * st.ground_v) & (st.sat < 0.35)).astype(np.uint8)
    dark = cv2.morphologyEx(dark, cv2.MORPH_CLOSE, _kernel(7))
    dark = cv2.morphologyEx(dark, cv2.MORPH_OPEN, _kernel(5))
    contours, _ = cv2.findContours(dark, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    regions, best = [], None
    for c in contours:
        area_ratio = cv2.contourArea(c) / st.area
        if area_ratio < 0.006 or area_ratio > 0.40 or len(c) < 5:
            continue
        mask = _contour_mask(dark.shape, c)
        ring = _ring(mask, max(5, int(0.12 * math.sqrt(area_ratio * st.area))))
        ring_sel = ring == 1
        if int(ring_sel.sum()) < 20:
            continue
        inner_med = float(np.median(st.val[mask == 1]))
        ring_med = float(np.median(st.val[ring_sel]))
        iou, axis_ratio, _ = _ellipse_iou(c, mask)
        hull_area = cv2.contourArea(cv2.convexHull(c))
        solidity = cv2.contourArea(c) / hull_area if hull_area > 0 else 0.0
        terms = {
            "rim_contrast": ramp(ring_med - inner_med, 0.06, 0.20),
            "moderately_dark": ramp(inner_med / st.ground_v, 0.18, 0.32),
            "solid": ramp(solidity, 0.65, 0.85),
            "not_elongated": ramp(axis_ratio, 0.18, 0.35),
            "grey_ground": ramp(float((st.sat[ring_sel] < 0.3).mean()), 0.5, 0.85),
            "textured_ground": ramp(float(np.median(st.local_std[ring_sel])), 5.0, 8.0),
            "gravel_texture": ramp(float(np.median(st.local_std[mask == 1])), 3.0, 8.0),
            "size": ramp(area_ratio, 0.006, 0.025),
            "irregular": ramp(iou, 0.965, 0.90),
        }
        score = gates((terms["rim_contrast"], 1), (terms["moderately_dark"], 1), (terms["solid"], 0.5),
                      (terms["not_elongated"], 0.5), (terms["grey_ground"], 0.5), (terms["textured_ground"], 0.5))
        score *= bonus(terms["gravel_texture"], 0.6) * bonus(terms["size"], 0.6) * bonus(terms["irregular"], 0.6)
        score *= st.daylight
        x, y, w, h = cv2.boundingRect(c)
        regions.append(Region([x, y, x + w, y + h], score, "pothole"))
        if best is None or score > best[0]:
            best = (score, area_ratio, terms)
    if best is None:
        return FeatureResult(evidence="no dark road blob found")
    score, area_ratio, terms = best
    return FeatureResult(
        score=score, regions=regions, cues=_rounded({"area_ratio": area_ratio, **terms}),
        evidence=f"a dark irregular hole covering {area_ratio:.0%} of the photo with a lighter broken rim "
                 f"on grey road texture",
    )


def open_manhole_feature(st: ImageStats) -> FeatureResult:
    """Very dark, smooth elliptical hole with a bright metallic rim.

    Candidates are near-black blobs (``V < 0.55 x ground``). Essential cues: *ellipticity* (IoU of the blob
    with its fitted ellipse - a cast-iron frame is a perfect circle seen in perspective), a very dark
    interior, a brighter ring around it and a roundish shape. ``cv2.HoughCircles`` (circle voting along
    gradient directions) adds support when the hole is seen almost from above.
    """
    thr = min(0.25, 0.55 * st.ground_v)
    dark = (st.val < thr).astype(np.uint8)
    dark = cv2.morphologyEx(dark, cv2.MORPH_CLOSE, _kernel(9))
    dark = cv2.morphologyEx(dark, cv2.MORPH_OPEN, _kernel(5))
    contours, _ = cv2.findContours(dark, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    circles = cv2.HoughCircles(cv2.GaussianBlur(st.gray, (9, 9), 2), cv2.HOUGH_GRADIENT, dp=1.5,
                               minDist=40, param1=100, param2=35, minRadius=int(0.03 * min(st.h, st.w)),
                               maxRadius=int(0.25 * min(st.h, st.w)))
    circles = [] if circles is None else circles.reshape(-1, 3)
    regions, best = [], None
    for c in contours:
        area_ratio = cv2.contourArea(c) / st.area
        if area_ratio < 0.003 or area_ratio > 0.20 or len(c) < 5:
            continue
        mask = _contour_mask(dark.shape, c)
        iou, axis_ratio, ellipse = _ellipse_iou(c, mask)
        (cx, cy), (ax1, ax2), _ = ellipse
        rim = _ring(mask, max(4, int(0.18 * min(ax1, ax2) / 2)))
        rim_vals = st.val[rim == 1]
        if rim_vals.size < 20:
            continue
        inner_med = float(np.median(st.val[mask == 1]))
        hough = any(math.hypot(x - cx, y - cy) < 0.35 * max(ax1, ax2) and 0.5 * min(ax1, ax2) / 2 < r
                    < 1.3 * max(ax1, ax2) / 2 for x, y, r in circles)
        terms = {
            # a Hough circle over the dark blob also proves roundness when a slid cover hides part of it
            "elliptical": max(ramp(iou, 0.86, 0.95), 0.75 if hough else 0.0),
            "very_dark": ramp(inner_med / st.ground_v, 0.38, 0.18),
            "bright_rim": ramp(float(np.median(rim_vals)) / st.ground_v, 0.9, 1.2),
            "round": ramp(axis_ratio, 0.4, 0.6),
            "size": ramp(area_ratio, 0.003, 0.012),
            "hough_circle": 1.0 if hough else 0.0,
        }
        score = gates((terms["elliptical"], 1), (terms["very_dark"], 1), (terms["bright_rim"], 0.5),
                      (terms["round"], 0.5))
        score *= bonus(terms["size"], 0.6) * bonus(terms["hough_circle"], 0.85) * st.daylight
        x, y, w, h = cv2.boundingRect(c)
        pad = int(0.12 * max(w, h))   # include the metal rim in the box
        regions.append(Region([x - pad, y - pad, x + w + pad, y + h + pad], score, "open_manhole"))
        if best is None or score > best[0]:
            best = (score, area_ratio, iou, hough, terms)
    if best is None:
        return FeatureResult(evidence="no very dark round opening found")
    score, area_ratio, iou, hough, terms = best
    return FeatureResult(
        score=score, regions=regions, cues=_rounded({"area_ratio": area_ratio, "ellipse_iou": iou, **terms}),
        evidence=f"a very dark, smooth elliptical opening ({area_ratio:.0%} of the photo, {iou:.0%} match with "
                 f"a fitted ellipse) framed by a brighter rim" + (", confirmed by a Hough circle" if hough else ""),
    )


def _is_wiggly(ys: np.ndarray, xs: np.ndarray) -> bool:
    """PCA straightness test: a crack bends, a kerb shadow or pipe edge is a straight line.

    The spread of the pixels across the main axis (``sqrt`` of the smaller covariance eigenvalue) is
    compared with the spread along it; for a straight line the ratio is close to 0.
    """
    if xs.size < 3:
        return False
    cov = np.cov(np.stack([xs.astype(np.float64), ys.astype(np.float64)]))
    small, large = np.linalg.eigvalsh(cov)
    return math.sqrt(max(small, 0.0)) >= max(1.5, 0.05 * math.sqrt(max(large, 1e-9)))


def road_crack_feature(st: ImageStats) -> FeatureResult:
    """Network of thin, wiggly dark lines on grey road.

    * Morphological **black-hat** (``closing(gray) - gray`` with an 11 px ellipse) keeps only dark
      structures thinner than the kernel - cracks - and ignores large dark areas such as potholes.
    * Each candidate pixel must be grey itself (not a brown branch), darker than the road, and lie on
      normally lit road (its closed background is near the road brightness - this excludes gravel inside
      potholes and shadows).
    * Connected components must be long and thin (``bbox_diagonal^2 / area`` large) and *wiggly*
      (:func:`_is_wiggly`) - straight kerb shadows and pipe edges are rejected.
    * ``HoughLinesP`` turns the kept pixels into segments: total length, number of segments and the
      *orientation entropy* (cracks branch in many directions).
    """
    closed = cv2.morphologyEx(st.gray, cv2.MORPH_CLOSE, _kernel(11))
    blackhat = cv2.subtract(closed, st.gray)
    cand = ((blackhat > 22) & (st.gray < 0.85 * st.ground_gray) & (closed > 0.8 * st.ground_gray)
            & (st.sat < 0.25)).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(cand, connectivity=8)
    keep = np.zeros(n, bool)
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        if area >= 20 and max(w, h) >= 15 and (w * w + h * h) / area >= 6.0:
            ys, xs = np.nonzero(labels[y:y + h, x:x + w] == i)
            keep[i] = _is_wiggly(ys, xs)
    crack = keep[labels].astype(np.uint8)
    coverage = float(crack.mean())
    lines = cv2.HoughLinesP(crack * 255, 1, np.pi / 180, threshold=15, minLineLength=12, maxLineGap=4)
    segs = np.zeros((0, 4)) if lines is None else lines.reshape(-1, 4).astype(np.float64)
    if len(segs) == 0:
        return FeatureResult(cues={"coverage": round(coverage, 4)}, evidence="no thin dark line network found")
    lengths = np.hypot(segs[:, 2] - segs[:, 0], segs[:, 3] - segs[:, 1])
    angles = np.degrees(np.arctan2(segs[:, 3] - segs[:, 1], segs[:, 2] - segs[:, 0])) % 180.0
    hist, _ = np.histogram(angles, bins=8, range=(0, 180), weights=lengths)
    p = hist / hist.sum()
    entropy = float(-(p[p > 0] * np.log(p[p > 0])).sum() / math.log(8))
    total_len = float(lengths.sum()) / st.diag
    terms = {
        "length": ramp(total_len, 0.3, 1.4),
        "directions": ramp(entropy, 0.45, 0.8),
        "segments": ramp(len(segs), 4, 16),
        "thin": ramp(coverage, 0.08, 0.04),
    }
    score = gates((terms["length"], 1), (terms["directions"], 0.5))
    score *= bonus(terms["segments"], 0.6) * bonus(terms["thin"], 0.5) * st.daylight
    regions = []
    big = [i for i in range(1, n) if keep[i] and stats[i][4] >= 40]
    if big:
        boxes = [[stats[i][0], stats[i][1], stats[i][0] + stats[i][2], stats[i][1] + stats[i][3]] for i in big]
        regions.append(Region(_union_box(boxes), score, "road_crack"))
    return FeatureResult(
        score=score, regions=regions,
        cues=_rounded({"segments_found": int(len(segs)), "total_length_diag": total_len, "orientation_entropy": entropy,
                       "coverage": coverage, **terms}),
        evidence=f"a network of {len(segs)} thin dark line segments running in many directions "
                 f"(total length {total_len:.1f}x the image diagonal)",
    )


def garbage_feature(st: ImageStats) -> FeatureResult:
    """Many small, saturated objects of many different colours (a litter pile).

    Saturated pixels are split into 12 hue bins (30 degrees each) and connected components are counted
    *per bin*, so touching items of different colours still count separately. Colour diversity is the
    *effective number of colour families* - ``exp(entropy)`` of the blob counts over six 60-degree families
    centred on red, yellow, green, cyan, blue and magenta: litter of many colours gives 4-6, a tree canopy
    (natural variation of greens) or yellow lit windows give 1-2. The pile box is the largest cluster after
    dilating the blobs.
    """
    colourful = (st.sat > 0.38) & (st.val > 0.22)
    hue_bin = (st.hue // 15).astype(np.int32)
    blob_mask = np.zeros(st.gray.shape, np.uint8)
    counts = np.zeros(12)
    for b in range(12):
        m = (colourful & (hue_bin == b)).astype(np.uint8)
        if int(m.sum()) < 30:
            continue
        m = cv2.morphologyEx(m, cv2.MORPH_OPEN, _kernel(3))
        n, labels, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
        ok = [i for i in range(1, n) if 30 <= stats[i][4] <= 0.03 * st.area]
        counts[b] = len(ok)
        if ok:
            blob_mask[np.isin(labels, ok)] = 1
    n_blobs = int(counts.sum())
    if n_blobs < 3:
        return FeatureResult(cues={"blobs": n_blobs}, evidence="few colourful objects")
    # 30-degree bin b covers hue [30b, 30b+30) degrees; family = which of red/yellow/green/cyan/blue/magenta
    families = np.zeros(6)
    for b in range(12):
        families[((30 * b + 15 + 30) % 360) // 60] += counts[b]
    p = families[families > 0] / n_blobs
    effective_hues = float(math.exp(-(p * np.log(p)).sum()))
    sat_frac = float(colourful.mean())
    terms = {
        "many_objects": ramp(n_blobs, 8, 25),
        "many_colours": ramp(effective_hues, 2.2, 3.8),
        "colour_present": ramp(sat_frac, 0.005, 0.03),
    }
    score = gates((terms["many_objects"], 1), (terms["many_colours"], 1), (terms["colour_present"], 0.5))
    score *= st.daylight
    pile = cv2.dilate(blob_mask, _kernel(31))
    n, labels, stats, _ = cv2.connectedComponentsWithStats(pile, connectivity=8)
    regions = []
    if n > 1:
        per_cluster = np.bincount(labels[blob_mask == 1], minlength=n)[1:]
        i = 1 + int(np.argmax(per_cluster))
        x, y, w, h = stats[i][:4]
        regions.append(Region([x + 12, y + 12, x + w - 12, y + h - 12], score, "garbage"))
    return FeatureResult(
        score=score, regions=regions,
        cues=_rounded({"blobs": n_blobs, "effective_hues": effective_hues, "saturated_fraction": sat_frac, **terms}),
        evidence=f"{n_blobs} small colourful objects in about {effective_hues:.0f} different colours "
                 "clustered together",
    )


def fallen_tree_feature(st: ImageStats) -> FeatureResult:
    """Green vegetation low in the frame (a canopy lying on the road) + an elongated brown trunk.

    * Green mask: hue 30-90 (OpenCV units = 60-180 degrees), saturated, not black. Standing trees are
      mostly in the upper part of a street photo, a fallen one covers the road, so only the lower two
      thirds count.
    * Canopy = largest green area after closing; leaves make it highly textured (local std-dev).
    * Trunk = brown component whose minimum-area rectangle is long, thin and closer to horizontal than
      vertical (a standing trunk is vertical). It is a bonus because the canopy may hide it.
    """
    green = (st.hue >= 30) & (st.hue <= 90) & (st.sat > 0.3) & (st.val > 0.12)
    green_low = float(green[st.h // 3:].mean())
    if green_low < 0.005:
        return FeatureResult(cues={"green_lower": round(green_low, 4)}, evidence="no vegetation on the ground")
    canopy = cv2.morphologyEx(green.astype(np.uint8), cv2.MORPH_CLOSE, _kernel(15))
    n, labels, stats, _ = cv2.connectedComponentsWithStats(canopy, connectivity=8)
    i = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA])) if n > 1 else 0
    canopy_ratio = float(stats[i][4]) / st.area if i else 0.0
    canopy_box = [float(stats[i][0]), float(stats[i][1]), float(stats[i][0] + stats[i][2]),
                  float(stats[i][1] + stats[i][3])] if i else None
    leafy = float(np.median(st.local_std[labels == i])) if i else 0.0
    brown = ((st.hue >= 4) & (st.hue <= 25) & (st.sat > 0.3) & (st.sat < 0.9) & (st.val > 0.12)
             & (st.val < 0.65)).astype(np.uint8)
    brown = cv2.morphologyEx(brown, cv2.MORPH_OPEN, _kernel(3))
    trunk_t, trunk_box = 0.0, None
    contours, _ = cv2.findContours(brown, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for c in contours:
        if cv2.contourArea(c) < 0.002 * st.area:
            continue
        (_, _), (rw, rh), angle = cv2.minAreaRect(c)
        long_side, short_side = max(rw, rh), max(1.0, min(rw, rh))
        long_angle = angle if rw >= rh else angle + 90.0
        tilt = abs(((long_angle + 90.0) % 180.0) - 90.0)          # 0 = horizontal, 90 = vertical
        t = ramp(long_side / short_side, 2.5, 6.0) * ramp(long_side / st.w, 0.15, 0.4) * ramp(tilt, 60, 40)
        if t > trunk_t:
            x, y, w, h = cv2.boundingRect(c)
            trunk_t, trunk_box = t, [x, y, x + w, y + h]
    terms = {
        "green_on_ground": ramp(green_low, 0.01, 0.06),
        "canopy": ramp(canopy_ratio, 0.008, 0.04),
        "leafy_texture": ramp(leafy, 6.0, 14.0),
        "trunk": trunk_t,
    }
    score = gates((terms["green_on_ground"], 1), (terms["canopy"], 0.5))
    score *= bonus(terms["leafy_texture"], 0.6) * bonus(trunk_t, 0.6) * st.daylight
    # a weakly trunk-like brown shape still belongs in the box when it touches the canopy
    trunk_joins = (trunk_box is not None and canopy_box is not None
                   and trunk_box[0] <= canopy_box[2] + 40 and canopy_box[0] <= trunk_box[2] + 40
                   and trunk_box[1] <= canopy_box[3] + 40 and canopy_box[1] <= trunk_box[3] + 40)
    box = _union_box([canopy_box, trunk_box if trunk_t > 0.3 or (trunk_t > 0.05 and trunk_joins) else None])
    return FeatureResult(
        score=score, regions=[Region(box, score, "fallen_tree")] if box else [],
        cues=_rounded({"green_lower": green_low, "canopy_ratio": canopy_ratio, "leaf_texture": leafy, **terms}),
        evidence=f"green foliage covering {green_low:.0%} of the lower image" +
                 (" next to an elongated brown trunk lying across the road" if trunk_t > 0.3 else ""),
    )


def _vertical_structures(st: ImageStats):
    """Merge near-vertical Hough segments that lie on the same x into vertical structures.

    Returns ``[(x_mid, top, bottom)]``: a pole edge is often broken into pieces where the background
    behind it changes (sky, building, road), so collinear pieces with gaps up to 40 px are joined.
    """
    pieces = []
    for x1, y1, x2, y2 in st.long_lines:
        angle = abs(math.degrees(math.atan2(y2 - y1, x2 - x1)))
        if abs(angle - 90.0) <= 8.0:
            pieces.append(((x1 + x2) / 2.0, min(y1, y2), max(y1, y2)))
    pieces.sort()
    groups: list[list] = []
    for x, top, bottom in pieces:
        for g in groups:
            if abs(g[0] - x) <= 6 and top <= g[2] + 40 and bottom >= g[1] - 40:
                g[0], g[1], g[2] = (g[0] + x) / 2.0, min(g[1], top), max(g[2], bottom)
                break
        else:
            groups.append([x, top, bottom])
    return [tuple(g) for g in groups]


def streetlight_feature(st: ImageStats) -> FeatureResult:
    """Night scene + a tall vertical pole + no lit lamp at the top of the pole (a dead streetlight).

    * darkness: mean brightness below ~0.22 counts as a night scene;
    * pole: merged near-vertical ``HoughLinesP`` structures (:func:`_vertical_structures`); a pole shows
      both of its edges as a *pair* of parallel verticals 5-30 px apart and stands on the road (reaches
      the lower 30% of the frame), unlike a building corner that ends at the skyline;
    * lamp state: the largest bright blob near the top of the pole - a working lamp is a big glowing
      blob, lit windows and stars are tiny. A lit lamp strongly reduces the score.
    """
    dark_t = ramp(st.brightness, 0.40, 0.22)
    if dark_t == 0.0:
        return FeatureResult(cues={"brightness": round(st.brightness, 3)}, evidence="the scene is not dark")
    structures = _vertical_structures(st)
    best, best_t = None, -1.0
    for i, (x, top, bottom) in enumerate(structures):
        length = bottom - top
        paired = any(5 <= abs(x - x2) <= 30 and min(bottom, b2) - max(top, t2) > 0.4 * length
                     for j, (x2, t2, b2) in enumerate(structures) if j != i)
        grounded = bottom >= 0.7 * st.h
        t = ramp(length / st.h, 0.25, 0.5) * (1.0 if paired else 0.75) * (1.0 if grounded else 0.7)
        if t > best_t:
            best, best_t = (x, top, bottom, length, paired), t
    if best is None:
        return FeatureResult(cues={"brightness": round(st.brightness, 3)},
                             evidence="a dark scene without a visible lamp pole")
    x_mid, top, bottom, length, paired = best
    pole_t = best_t
    wx1, wx2 = int(max(0, x_mid - 0.2 * st.w)), int(min(st.w, x_mid + 0.2 * st.w))
    # lamps hang at (or above) the top of the detected pole edge - the thin arm itself is rarely detected
    wy1, wy2 = int(max(0, top - 0.25 * st.h)), int(min(st.h, top + 0.12 * st.h))
    window = st.val[wy1:wy2, wx1:wx2]
    bright_thr = max(0.55, 2.5 * float(np.median(st.val)))
    lamp_frac = 0.0
    if window.size:
        n, _, stats, _ = cv2.connectedComponentsWithStats((window > bright_thr).astype(np.uint8), connectivity=8)
        if n > 1:
            lamp_frac = float(stats[1:, cv2.CC_STAT_AREA].max()) / window.size
    lamp_on_t = ramp(lamp_frac, 0.006, 0.025)
    score = gates((dark_t, 1), (pole_t, 1)) * (1.0 - 0.8 * lamp_on_t)
    box = [x_mid - 0.12 * st.w, top - 0.2 * st.h, x_mid + 0.12 * st.w, bottom]   # the lamp sits above the edge top
    state = "a lit lamp" if lamp_on_t > 0.5 else "no lit lamp"
    return FeatureResult(
        score=score, regions=[Region(box, score, "streetlight")],
        cues=_rounded({"brightness": st.brightness, "pole_length": length / st.h, "pole_pair": paired,
                       "lamp_glow_fraction": lamp_frac, "dark": dark_t, "pole": pole_t, "lamp_on": lamp_on_t}),
        evidence=f"a dark night scene (brightness {st.brightness:.0%}) with a tall lamp pole and {state} at its top",
    )


def drainage_feature(st: ImageStats) -> FeatureResult:
    """A large, smooth, water-coloured region on the ground (waterlogging / overflowing drain).

    Water is smooth - its local std-dev is below half of the road texture of the same photo (and never
    above 5.5 grey levels) - and muddy brown, grey-blue or dull grey. The largest such region in the lower
    part of the photo is measured. Essential: size, smoothness, compactness (a pool, not a thin stream) and
    position on the ground; ripples / glints (small bright details inside) are a bonus.
    """
    h_, s_, v_ = st.hue, st.sat, st.val
    brownish = (h_ >= 5) & (h_ <= 30) & (s_ >= 0.2) & (s_ <= 0.8) & (v_ >= 0.2) & (v_ <= 0.8)
    bluish = (h_ >= 85) & (h_ <= 130) & (s_ >= 0.06) & (s_ <= 0.6) & (v_ >= 0.2) & (v_ <= 0.8)
    greyish = (s_ < 0.12) & (v_ >= 0.18) & (v_ <= 0.5)
    smooth_limit = float(np.clip(0.5 * st.texture_ref, 2.0, 5.5))
    smooth = st.local_std < smooth_limit
    water = ((brownish | bluish | greyish) & smooth).astype(np.uint8)
    water = cv2.morphologyEx(water, cv2.MORPH_CLOSE, _kernel(9))
    water = cv2.morphologyEx(water, cv2.MORPH_OPEN, _kernel(7))
    n, labels, stats, centroids = cv2.connectedComponentsWithStats(water, connectivity=8)
    best = None
    for i in range(1, n):
        area_ratio = stats[i][4] / st.area
        if area_ratio < 0.02 or centroids[i][1] < 0.35 * st.h:
            continue
        if best is None or area_ratio > best[1]:
            best = (i, area_ratio)
    if best is None:
        return FeatureResult(evidence="no large smooth water surface")
    i, area_ratio = best
    comp = labels == i
    contours, _ = cv2.findContours(comp.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    (_, _), (rw, rh), _ = cv2.minAreaRect(max(contours, key=cv2.contourArea))
    aspect = max(rw, rh) / max(1.0, min(rw, rh))
    v_in = st.val[comp]
    terms = {
        "large": ramp(area_ratio, 0.05, 0.18),
        "smooth": ramp(float((st.local_std[comp] < smooth_limit).mean()), 0.5, 0.8),
        "pool_shaped": ramp(aspect, 6.0, 3.5),
        "on_ground": ramp(centroids[i][1] / st.h, 0.35, 0.5),
        "ripples": ramp(float((v_in > np.median(v_in) + 0.08).mean()), 0.003, 0.02),
    }
    score = gates((terms["large"], 1), (terms["smooth"], 0.5), (terms["pool_shaped"], 0.5), (terms["on_ground"], 0.5))
    score *= bonus(terms["ripples"], 0.85) * st.daylight
    x, y, w, h = stats[i][:4]
    return FeatureResult(
        score=score, regions=[Region([x, y, x + w, y + h], score, "drainage")],
        cues=_rounded({"area_ratio": area_ratio, "aspect": aspect, "smooth_limit": smooth_limit, **terms}),
        evidence=f"a large smooth water surface covering {area_ratio:.0%} of the photo on the road",
    )


def _touches(seg_points: np.ndarray, box, margin: float) -> bool:
    """Does the bounding box of ``seg_points`` (widened by ``margin``) overlap ``box``?"""
    x1, y1 = seg_points.min(axis=0) - margin
    x2, y2 = seg_points.max(axis=0) + margin
    return bool(x1 <= box[2] and box[0] <= x2 and y1 <= box[3] and box[1] <= y2)


def _pipe_near(st: ImageStats, box) -> tuple[float, float | None]:
    """Evidence (0-1) that a pipe runs next to ``box`` and its diameter in px (``None`` if unknown).

    A pipe is a long straight structure: two long parallel edges 22-80 px apart (its two sides) give full
    evidence; a single long straight edge (the other side may blend into the background) gives half.
    Either must lie within 60 px of the spray ("the water comes out of this pipe").
    """
    segs = st.long_lines
    if len(segs) == 0:
        return 0.0, None
    lengths = np.hypot(segs[:, 2] - segs[:, 0], segs[:, 3] - segs[:, 1])
    segs = segs[lengths >= 0.2 * st.w]          # couplings split a pipe's edges into pieces
    near = [s for s in segs if _touches(s.reshape(2, 2), box, 60)]
    if not near:
        return 0.0, None
    angles = [math.degrees(math.atan2(s[3] - s[1], s[2] - s[0])) % 180.0 for s in near]
    for a in range(len(near)):
        for b in range(a + 1, len(near)):
            diff = abs(angles[a] - angles[b])
            if min(diff, 180.0 - diff) > 4.0:
                continue
            x1, y1, x2, y2 = near[a]
            mx, my = (near[b][0] + near[b][2]) / 2, (near[b][1] + near[b][3]) / 2
            dist = abs((y2 - y1) * mx - (x2 - x1) * my + x2 * y1 - y2 * x1) / max(1e-6, math.hypot(x2 - x1, y2 - y1))
            if 22 <= dist <= 80:
                return 1.0, float(dist)
    return 0.5, None


def water_leak_feature(st: ImageStats) -> FeatureResult:
    """Dense spray of thin bright whitish jets, ideally coming from a pipe.

    * spray: morphological **top-hat** (``gray - opening(gray)``, 7 px) keeps bright structures thinner
      than the kernel (wider bright things such as lane markings or wall strips between windows are
      removed by the opening). They must be whitish / bluish (bright, low saturation) and *elongated*
      - jets are lines; compact bright bits (paper, specks) are ignored, and so are very long lines
      (a pipe's specular highlight, a painted line).
    * fan shape: jets radiate from the burst point, so their principal directions (PCA of each jet's
      pixels) are spread over many angles - parallel slivers of sky between buildings are not.
    * Jets within ~40 px of each other are grouped (dilation); every group is scored on jet amount,
      density and fan shape, and the most spray-like group is the spray. A pipe next to it
      (:func:`_pipe_near`) is a bonus.
    """
    tophat = cv2.morphologyEx(st.gray, cv2.MORPH_TOPHAT, _kernel(7))
    bright = ((tophat > 15) & (st.sat < 0.35) & (st.val > 0.55)).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(bright, connectivity=8)
    is_jet = np.zeros(n, bool)
    direction = np.zeros(n)
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        longest = max(w, h)
        if area < 6 or longest < 8 or longest > 0.3 * st.w or (w * w + h * h) / area < 6.0:
            continue
        ys, xs = np.nonzero(labels[y:y + h, x:x + w] == i)
        _, vecs = np.linalg.eigh(np.cov(np.stack([xs.astype(np.float64), ys.astype(np.float64)])))
        direction[i] = math.degrees(math.atan2(vecs[1, 1], vecs[0, 1])) % 180.0
        is_jet[i] = True
    jets = is_jet[labels].astype(np.uint8)
    cluster = cv2.dilate(jets, _kernel(41))     # jets of one fan start within ~40 px of the burst point
    n_c, cl_labels, cl_stats, _ = cv2.connectedComponentsWithStats(cluster, connectivity=8)
    per_cluster = np.bincount(cl_labels[jets == 1], minlength=n_c)
    best = None
    for c in range(1, n_c):   # every jet cluster is a candidate spray; keep the most spray-like one
        count = int(per_cluster[c])
        if count < 40:
            continue
        density = count / float(cl_stats[c][4])
        members = [i for i in np.unique(labels[(cl_labels == c) & (jets == 1)]) if i > 0]
        hist, _ = np.histogram(direction[members], bins=8, range=(0, 180),
                               weights=stats[members, cv2.CC_STAT_AREA])
        p = hist[hist > 0] / hist.sum()
        entropy = float(-(p * np.log(p)).sum() / math.log(8))
        spray_t = ramp(count, 100, 500) * ramp(density, 0.02, 0.07)
        fan_t = ramp(entropy, 0.35, 0.65)
        candidate = gates((spray_t, 1), (fan_t, 1))
        if best is None or candidate > best[0]:
            box = [float(cl_stats[c][0]), float(cl_stats[c][1]), float(cl_stats[c][0] + cl_stats[c][2]),
                   float(cl_stats[c][1] + cl_stats[c][3])]
            best = (candidate, count, len(members), density, entropy, spray_t, fan_t, box)
    if best is None:
        return FeatureResult(evidence="no water spray found")
    candidate, count, n_jets, density, entropy, spray_t, fan_t, spray_box = best
    pipe_t, pipe_gap = _pipe_near(st, spray_box)
    score = candidate * bonus(pipe_t, 0.45) * st.daylight
    return FeatureResult(
        score=score, regions=[Region(spray_box, score, "water_leak")],
        cues=_rounded({"jet_pixels": count, "jets": n_jets, "spray_density": density, "direction_entropy": entropy,
                       "pipe_diameter_px": pipe_gap, "spray": spray_t, "fan_shape": fan_t, "pipe": pipe_t}),
        evidence=f"a spray of {n_jets} thin bright water jets fanning out in many directions"
                 + (" next to a pipe" if pipe_t > 0 else ""),
    )


#: Class slug -> feature function (``other`` has no feature: it is the constant baseline).
FEATURES = {
    "pothole": pothole_feature,
    "garbage": garbage_feature,
    "drainage": drainage_feature,
    "streetlight": streetlight_feature,
    "water_leak": water_leak_feature,
    "open_manhole": open_manhole_feature,
    "road_crack": road_crack_feature,
    "fallen_tree": fallen_tree_feature,
}


def extract_features(bgr: np.ndarray) -> dict[str, FeatureResult]:
    """Run every feature function on a BGR image (already resized to 640 px on the longest side)."""
    stats = ImageStats(bgr)
    return {slug: fn(stats) for slug, fn in FEATURES.items()}
