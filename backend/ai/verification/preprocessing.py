"""Before/after image preparation for resolution verification: common size + geometric alignment.

An officer never re-photographs a site from exactly the same spot, so pixels cannot be compared directly.
The after-photo is first resized to the before-photo's size and then *registered* onto it:

1. **ORB** (Oriented FAST and Rotated BRIEF) finds up to 1500 corner-like keypoints in each photo and
   describes each with a 256-bit binary descriptor. Both photos are contrast-equalised first (CLAHE) so
   a change of daylight does not change the keypoints.
2. **Brute-force matching** with Hamming distance, keeping a match only if it is clearly better than the
   second-best candidate (Lowe's *ratio test*, 0.75).
3. **RANSAC homography**: repeatedly fit a 3x3 perspective transform to 4 random matches and keep the
   transform most matches agree with (*inliers*, reprojection error < 5 px). Matches in the repaired area
   or on moving objects simply become outliers.
4. The after-photo is warped onto the before-photo; a validity mask marks pixels both photos cover.

``scene_consistency`` = inlier ratio x a confidence factor on the absolute inlier count. Two photos of
the same place give many consistent matches; two different places give a handful of random ones. When
alignment is impossible (degenerate transform, too little overlap) the photos are compared unaligned and
``aligned = False`` is reported. Plenty of keypoints *without* consistent matches is evidence of two
different places; only photos too plain for ORB (``enough_features = False``) make the verifier fall back
to a weaker global similarity.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import cv2
import numpy as np

from ai.vision.preprocessing import load_image, resize_for_model, to_gray

#: Longest side used for verification (alignment + metrics).
VERIFY_MAX_SIDE = 512
ORB_FEATURES = 1500
RATIO_TEST = 0.75
RANSAC_REPROJ_PX = 5.0
MIN_GOOD_MATCHES = 10
#: Inliers needed for full confidence in the alignment (fewer inliers scale scene_consistency down).
FULL_CONFIDENCE_INLIERS = 30
#: Below this many keypoints in either photo the scene is too plain to judge geometrically.
MIN_KEYPOINTS = 60


@dataclass
class Alignment:
    """Result of registering the after-photo onto the before-photo."""
    after: np.ndarray            # after-photo warped into the before-photo's frame (BGR uint8)
    valid: np.ndarray            # bool mask: pixels covered by both photos
    aligned: bool                # True when a plausible homography was found
    matches: int                 # good matches after the ratio test
    inliers: int                 # RANSAC inliers
    inlier_ratio: float
    scene_consistency: float     # 0..1 geometric evidence that both photos show the same place
    method: str                  # "orb_ransac_homography" | "unaligned"
    keypoints: int = 0           # min(keypoints in before, keypoints in after)

    @property
    def enough_features(self) -> bool:
        """False when the photos are too plain for ORB - geometry then says nothing about the scene."""
        return self.keypoints >= MIN_KEYPOINTS


def prepare_pair(before, after):
    """Load both images (any supported input) and bring the after-photo to the before-photo's size.

    Returns ``(before_bgr, after_bgr, info)`` where ``info`` holds the original sizes and whether their
    aspect ratios differ by more than 25% (a hint that the photos were taken differently).
    """
    b = load_image(before)
    a = load_image(after)
    info = {
        "before_size": [int(b.shape[1]), int(b.shape[0])],
        "after_size": [int(a.shape[1]), int(a.shape[0])],
    }
    ratio_b, ratio_a = b.shape[1] / b.shape[0], a.shape[1] / a.shape[0]
    info["aspect_mismatch"] = bool(abs(math.log(ratio_b / ratio_a)) > math.log(1.25))
    b_small = resize_for_model(b, VERIFY_MAX_SIDE)
    h, w = b_small.shape[:2]
    a_small = cv2.resize(a, (w, h), interpolation=cv2.INTER_AREA if a.shape[0] > h else cv2.INTER_LINEAR)
    return b_small, a_small, info


def _equalised(gray: np.ndarray) -> np.ndarray:
    return cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)


def _plausible(h: np.ndarray, width: int, height: int) -> bool:
    """Reject degenerate / extreme homographies (mirroring, huge zoom, strong perspective)."""
    if h is None or not np.all(np.isfinite(h)):
        return False
    det = float(np.linalg.det(h[:2, :2]))
    if not 0.4 <= det <= 2.5:
        return False
    return abs(h[2, 0]) * width < 0.6 and abs(h[2, 1]) * height < 0.6


def align_images(before: np.ndarray, after: np.ndarray) -> Alignment:
    """Register ``after`` onto ``before`` (both BGR, same size) with ORB + ratio test + RANSAC."""
    height, width = before.shape[:2]
    full = np.ones((height, width), bool)
    orb = cv2.ORB_create(nfeatures=ORB_FEATURES)
    kp_b, des_b = orb.detectAndCompute(_equalised(to_gray(before)), None)
    kp_a, des_a = orb.detectAndCompute(_equalised(to_gray(after)), None)
    keypoints = min(len(kp_b), len(kp_a))
    unaligned = Alignment(after, full, False, 0, 0, 0.0, 0.0, "unaligned", keypoints)
    if des_b is None or des_a is None or keypoints < MIN_GOOD_MATCHES:
        return unaligned
    pairs = cv2.BFMatcher(cv2.NORM_HAMMING).knnMatch(des_a, des_b, k=2)
    good = [p[0] for p in pairs if len(p) == 2 and p[0].distance < RATIO_TEST * p[1].distance]
    if len(good) < MIN_GOOD_MATCHES:
        unaligned.matches = len(good)
        return unaligned
    src = np.float32([kp_a[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
    dst = np.float32([kp_b[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
    homography, mask = cv2.findHomography(src, dst, cv2.RANSAC, RANSAC_REPROJ_PX)
    inliers = int(mask.sum()) if mask is not None else 0
    ratio = inliers / len(good)
    consistency = ratio * min(1.0, inliers / FULL_CONFIDENCE_INLIERS)
    if not _plausible(homography, width, height) or inliers < 8:
        return Alignment(after, full, False, len(good), inliers, ratio, consistency * 0.5, "unaligned", keypoints)
    warped = cv2.warpPerspective(after, homography, (width, height), flags=cv2.INTER_LINEAR,
                                 borderMode=cv2.BORDER_REPLICATE)
    cover = cv2.warpPerspective(np.full((height, width), 255, np.uint8), homography, (width, height),
                                flags=cv2.INTER_NEAREST, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    valid = cv2.erode(cover, np.ones((5, 5), np.uint8)) > 0     # drop the interpolated border
    if valid.mean() < 0.3:     # the photos barely overlap - comparing them would be meaningless
        return Alignment(after, full, False, len(good), inliers, ratio, consistency * 0.5, "unaligned", keypoints)
    return Alignment(warped, valid, True, len(good), inliers, ratio, consistency, "orb_ransac_homography", keypoints)
