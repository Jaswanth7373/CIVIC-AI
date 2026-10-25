"""Image-comparison metrics for before/after resolution verification (OpenCV + NumPy only).

All functions take aligned images of the same size and an optional boolean ``mask`` of the pixels to use
(the area both photos cover after alignment).

* :func:`ssim` - Structural Similarity (Wang, Bovik, Sheikh & Simoncelli, 2004), implemented directly from
  its formula with Gaussian-weighted local statistics (``cv2.GaussianBlur``, sigma 1.5)::

      SSIM(x, y) = ((2 mu_x mu_y + C1) (2 sigma_xy + C2)) / ((mu_x^2 + mu_y^2 + C1) (sigma_x^2 + sigma_y^2 + C2))
      C1 = (0.01 L)^2, C2 = (0.03 L)^2, L = 255

  It compares local brightness (mu), contrast (sigma) and structure (sigma_xy) and is 1.0 for identical
  images.
* :func:`histogram_similarity` - correlation of 2-D hue/saturation histograms (colour content, robust to
  small shifts).
* :func:`edge_density_change` - relative change in the share of Canny edge pixels (a pothole, crack or
  garbage pile has many edges; a smooth repaired surface few).
* :func:`colour_shift` - mean CIE-Lab colour difference (Delta E 1976) / 100.
* :func:`change_map` - per-pixel change 0..1: the largest of a coarse-scale SSIM dissimilarity, the
  brightness difference and the Lab colour (chroma) difference, after a robust exposure / white-balance
  correction (:func:`normalise_photometry`); :func:`change_ratio` and :func:`region_change` summarise it.
"""
from __future__ import annotations

import cv2
import numpy as np

SSIM_SIGMA = 1.5
_L = 255.0
_C1 = (0.01 * _L) ** 2
_C2 = (0.03 * _L) ** 2
#: A pixel counts as "changed" when its change value exceeds this.
CHANGE_PIXEL_THRESHOLD = 0.35
#: Absolute grey-level difference (after normalisation) that counts as a full change.
FULL_CHANGE_DIFF = 60.0
#: Lab chroma difference that counts as a full colour change.
FULL_CHROMA_DIFF = 40.0
#: Percentile of the change map used as the "level of change" of a region (see region_change).
REGION_PERCENTILE = 90
#: Prior boxes are widened by this fraction of their size on each side (detector boxes are approximate and
#: a repair - e.g. an asphalt patch - usually extends a little beyond the defect).
BOX_MARGIN = 0.10


def _gray(img: np.ndarray) -> np.ndarray:
    gray = img if img.ndim == 2 else cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    return gray.astype(np.float64)


def _select(values: np.ndarray, mask):
    return values if mask is None else values[mask]


def ssim_map(a: np.ndarray, b: np.ndarray, sigma: float = SSIM_SIGMA) -> np.ndarray:
    """Per-pixel SSIM of two images (BGR or grey) using Gaussian-weighted local statistics."""
    x, y = _gray(a), _gray(b)

    def blur(img):
        return cv2.GaussianBlur(img, (0, 0), sigma)

    mu_x, mu_y = blur(x), blur(y)
    var_x = blur(x * x) - mu_x * mu_x
    var_y = blur(y * y) - mu_y * mu_y
    cov = blur(x * y) - mu_x * mu_y
    numerator = (2 * mu_x * mu_y + _C1) * (2 * cov + _C2)
    denominator = (mu_x * mu_x + mu_y * mu_y + _C1) * (var_x + var_y + _C2)
    return numerator / denominator


def ssim(a: np.ndarray, b: np.ndarray, mask=None) -> float:
    """Mean SSIM (1.0 = identical, ~0 = unrelated) over ``mask``."""
    return float(np.mean(_select(ssim_map(a, b), mask)))


def histogram_similarity(a: np.ndarray, b: np.ndarray, mask=None) -> float:
    """Correlation (clipped to 0..1) of normalised 30x32-bin hue/saturation histograms."""
    m = None if mask is None else mask.astype(np.uint8) * 255
    hists = []
    for img in (a, b):
        hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
        hist = cv2.calcHist([hsv], [0, 1], m, [30, 32], [0, 180, 0, 256])
        cv2.normalize(hist, hist, alpha=1.0, norm_type=cv2.NORM_L1)
        hists.append(hist)
    return float(max(0.0, cv2.compareHist(hists[0], hists[1], cv2.HISTCMP_CORREL)))


def edge_density(img: np.ndarray, mask=None) -> float:
    """Share of Canny edge pixels (thresholds 50 / 150 on a lightly blurred grey image)."""
    gray = cv2.GaussianBlur(_gray(img).astype(np.uint8), (5, 5), 0)
    edges = cv2.Canny(gray, 50, 150) > 0
    return float(np.mean(_select(edges, mask)))


def edge_density_change(a: np.ndarray, b: np.ndarray, mask=None) -> float:
    """``|d_a - d_b| / max(d_a, d_b)`` - 0 = same amount of edges, 1 = edges appeared / vanished."""
    da, db = edge_density(a, mask), edge_density(b, mask)
    top = max(da, db)
    return float(abs(da - db) / top) if top > 1e-6 else 0.0


def mean_abs_diff(a: np.ndarray, b: np.ndarray, mask=None) -> float:
    """Mean absolute grey-level difference, 0..1."""
    return float(np.mean(_select(np.abs(_gray(a) - _gray(b)), mask)) / _L)


def colour_shift(a: np.ndarray, b: np.ndarray, mask=None) -> float:
    """Mean CIE-Lab colour distance (Delta E 1976) / 100, clipped to 0..1."""
    lab_a = cv2.cvtColor(a, cv2.COLOR_BGR2LAB).astype(np.float64)
    lab_b = cv2.cvtColor(b, cv2.COLOR_BGR2LAB).astype(np.float64)
    # OpenCV 8-bit Lab stores L in 0..255 (x 255/100); rescale it so all channels are in Lab units
    lab_a[..., 0] *= 100.0 / 255.0
    lab_b[..., 0] *= 100.0 / 255.0
    delta = np.sqrt(((lab_a - lab_b) ** 2).sum(axis=2))
    return float(min(1.0, np.mean(_select(delta, mask)) / 100.0))


def _robust_linear(source: np.ndarray, target: np.ndarray, keep: np.ndarray) -> tuple[float, float]:
    """``target ~ gain * source + offset`` from medians and inter-quartile ranges of the kept pixels.

    Matching the spreads (IQR ratio) instead of an ordinary least-squares regression avoids *regression
    dilution*: with two noisy photos of a plain surface, regressing one on the other drives the slope
    towards 0, whereas the IQR ratio stays near the true contrast change.
    """
    q_s = np.percentile(source[keep], [25, 50, 75])
    q_t = np.percentile(target[keep], [25, 50, 75])
    gain = (q_t[2] - q_t[0]) / max(q_s[2] - q_s[0], 1.0)
    gain = float(np.clip(gain, 0.67, 1.5))           # exposure / daylight rarely changes contrast more
    return gain, float(q_t[1] - gain * q_s[1])


def normalise_photometry(after: np.ndarray, before: np.ndarray, mask=None) -> np.ndarray:
    """Map the after-photo into the before-photo's colour / brightness scale (returns float64 BGR).

    A different time of day, exposure or white balance must not count as physical change. Each colour
    channel gets its own linear model ``after_c = gain_c * before_c + offset_c`` (exposure + a von-Kries
    style white-balance correction), estimated robustly (:func:`_robust_linear`):

    1. start with a pure offset (median difference) and keep the 50% of pixels that agree best;
    2. fit gains + offsets on those pixels, then refit on the 60% that agree best with that fit.

    Pixels of the repaired area (which really changed) disagree with the lighting model and are thereby
    excluded from its estimate, even when the repair covers a large part of the photo.
    """
    a = cv2.GaussianBlur(after.astype(np.float64), (0, 0), 2.0)
    b = cv2.GaussianBlur(before.astype(np.float64), (0, 0), 2.0)
    a_vals, b_vals = _select(a, mask).reshape(-1, 3), _select(b, mask).reshape(-1, 3)
    step = max(1, len(a_vals) // 20000)            # a regular subsample is plenty for six parameters
    a_vals, b_vals = a_vals[::step], b_vals[::step]
    residual = np.abs(a_vals - b_vals - np.median(a_vals - b_vals, axis=0)).sum(axis=1)
    keep = residual <= np.percentile(residual, 50)
    params = [(1.0, 0.0)] * 3
    for share in (60, None):
        params = [_robust_linear(b_vals[:, c], a_vals[:, c], keep) for c in range(3)]
        if share is None:
            break
        predicted = np.stack([g * b_vals[:, c] + o for c, (g, o) in enumerate(params)], axis=1)
        residual = np.abs(a_vals - predicted).sum(axis=1)
        keep = residual <= np.percentile(residual, share)
    corrected = after.astype(np.float64).copy()
    for c, (gain, offset) in enumerate(params):
        corrected[..., c] = (corrected[..., c] - offset) / gain
    return np.clip(corrected, 0, 255)


def change_map(before: np.ndarray, after: np.ndarray, mask=None) -> np.ndarray:
    """Per-pixel change in 0..1: the largest of a structural, a brightness and a colour difference.

    The after-photo is first corrected for exposure and white balance (:func:`normalise_photometry`).

    * structural - ``(1 - SSIM) / 0.8`` on photos blurred with sigma 2.5 (and a sigma-2 SSIM window):
      at this coarse scale sensor noise, JPEG artefacts and sub-pixel misalignment of fine asphalt grain
      disappear, while a hole that became flat or a pile that vanished remains;
    * brightness - ``|gray_after - gray_before| / 60``;
    * colour     - CIE-Lab chroma difference ``sqrt(da^2 + db^2) / 40`` (removed graffiti or litter may
      have the same brightness as the wall or pavement but a very different colour).
    """
    corrected = np.rint(normalise_photometry(after, before, mask)).astype(np.uint8)
    b = cv2.GaussianBlur(_gray(before), (0, 0), 2.5)
    a = cv2.GaussianBlur(_gray(corrected), (0, 0), 2.5)
    structural = np.clip((1.0 - ssim_map(b, a, sigma=2.0)) / 0.8, 0.0, 1.0)
    intensity = np.clip(np.abs(a - b) / FULL_CHANGE_DIFF, 0.0, 1.0)
    lab_b = cv2.GaussianBlur(cv2.cvtColor(before, cv2.COLOR_BGR2LAB).astype(np.float64), (0, 0), 2.5)
    lab_a = cv2.GaussianBlur(cv2.cvtColor(corrected, cv2.COLOR_BGR2LAB).astype(np.float64), (0, 0), 2.5)
    chroma = np.sqrt(((lab_a[..., 1:] - lab_b[..., 1:]) ** 2).sum(axis=2))
    colour = np.clip(chroma / FULL_CHROMA_DIFF, 0.0, 1.0)
    change = cv2.GaussianBlur(np.maximum(np.maximum(structural, intensity), colour), (0, 0), 2.0)
    if mask is not None:
        change = np.where(mask, change, 0.0)
    return change


def change_ratio(change: np.ndarray, mask=None, threshold: float = CHANGE_PIXEL_THRESHOLD) -> float:
    """Share of (valid) pixels whose change exceeds ``threshold``."""
    return float(np.mean(_select(change > threshold, mask)))


def _boxes_mask(boxes, shape) -> np.ndarray:
    h, w = shape[:2]
    mask = np.zeros((h, w), bool)
    for box in boxes:
        x1, y1, x2, y2 = (float(v) for v in box[:4])
        c1, c2 = int(np.clip(np.floor(x1 * w), 0, w)), int(np.clip(np.ceil(x2 * w), 0, w))
        r1, r2 = int(np.clip(np.floor(y1 * h), 0, h)), int(np.clip(np.ceil(y2 * h), 0, h))
        mask[r1:r2, c1:c2] = True
    return mask


def most_changed_box(change: np.ndarray, mask=None):
    """Normalised box around the most changed area: the change map is smoothed at a coarse scale, the
    peak is located and the connected area above half of the peak value around it is boxed."""
    h, w = change.shape[:2]
    smooth = cv2.GaussianBlur(change, (0, 0), 0.04 * max(h, w))
    if mask is not None:
        smooth = np.where(mask, smooth, 0.0)
    peak = float(smooth.max())
    if peak <= 1e-6:
        return None
    region = (smooth >= 0.5 * peak).astype(np.uint8)
    _, labels = cv2.connectedComponents(region)
    py, px = np.unravel_index(int(np.argmax(smooth)), smooth.shape)
    ys, xs = np.nonzero(labels == labels[py, px])
    return [float(xs.min() / w), float(ys.min() / h), float((xs.max() + 1) / w), float((ys.max() + 1) / h)]


def region_change(change: np.ndarray, boxes=None, mask=None):
    """How much the defect region changed compared with the rest of the scene (0..1).

    ``boxes`` are normalised ``[x1, y1, x2, y2]`` boxes of the originally detected issue; without boxes the
    most-changed area is used (:func:`most_changed_box`). The level of change inside is the 90th percentile
    of the change map (a defect rarely fills its whole box - an irregular puddle covers ~60% of it, a lamp
    only the top of a tall pole box). It is taken *relative to the typical change elsewhere* (median of the
    change outside the region): ``(inside - outside) / (1 - outside)``.
    Re-photographing an unchanged scene changes every pixel a little (light, noise, alignment) - only
    change that stands out in the defect area counts.

    Returns ``(value, box, source)`` with ``source`` = ``"prior_boxes"`` or ``"most_changed_region"``.
    """
    valid = np.ones(change.shape[:2], bool) if mask is None else mask
    boxes = [b for b in (boxes or []) if b is not None and len(b) >= 4 and b[2] > b[0] and b[3] > b[1]]
    source = "prior_boxes"
    if not boxes:
        box = most_changed_box(change, valid)
        if box is None:
            return 0.0, None, "most_changed_region"
        boxes, source = [box], "most_changed_region"
    if source == "prior_boxes":
        boxes = [[b[0] - BOX_MARGIN * (b[2] - b[0]), b[1] - BOX_MARGIN * (b[3] - b[1]),
                  b[2] + BOX_MARGIN * (b[2] - b[0]), b[3] + BOX_MARGIN * (b[3] - b[1])] for b in boxes]
    region = _boxes_mask(boxes, change.shape) & valid
    outside = ~_boxes_mask(boxes, change.shape) & valid
    if not region.any():
        return 0.0, boxes[0], source
    inside_level = float(np.percentile(change[region], REGION_PERCENTILE))
    background = float(np.median(change[outside])) if outside.sum() > 100 else 0.0
    value = (inside_level - background) / max(1e-6, 1.0 - background)
    union = [max(0.0, min(b[0] for b in boxes)), max(0.0, min(b[1] for b in boxes)),
             min(1.0, max(b[2] for b in boxes)), min(1.0, max(b[3] for b in boxes))]
    return float(np.clip(value, 0.0, 1.0)), [round(v, 4) for v in union], source
