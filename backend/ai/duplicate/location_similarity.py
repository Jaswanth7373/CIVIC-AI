"""Location similarity for duplicate detection (BUILD_SPEC section 2.6).

Technique - a truncated Gaussian distance kernel (the same kernel family used in kernel density
estimation). With ``sigma = radius / 2`` and cut-off ``c = 1.5 x radius``::

    g(d)  = exp(-d^2 / (2 sigma^2))
    s(d)  = (g(d) - g(c)) / (1 - g(c))   for d < c,   0 beyond c

so the similarity is exactly 1.0 at 0 m, decays smoothly (no step at the radius - GPS fixes are
noisy, a report 310 m away is not fundamentally different from one 290 m away), is about 0.13
at the duplicate radius and reaches exactly 0 at 1.5 x radius without a jump. For the default
300 m radius: 42 m -> 0.96, 100 m -> 0.80, 150 m -> 0.60, 300 m -> 0.13, >= 450 m -> 0.
"""
import math

SIGMA_FRACTION = 0.5  # sigma = radius / 2
CUTOFF_FACTOR = 1.5  # similarity is 0 beyond 1.5 x radius


def location_similarity(distance_m, radius_m):
    """Smooth decay from 1.0 at 0 m to 0.0 at 1.5 x ``radius_m`` (None distance -> 0.0).

    Raises ValueError for a non-positive radius.
    """
    radius = float(radius_m)
    if not math.isfinite(radius) or radius <= 0:
        raise ValueError("radius_m must be a positive number of metres")
    if distance_m is None:
        return 0.0
    distance = max(0.0, float(distance_m))
    cutoff = CUTOFF_FACTOR * radius
    if distance >= cutoff:
        return 0.0
    sigma = SIGMA_FRACTION * radius
    g_cut = math.exp(-0.5 * (cutoff / sigma) ** 2)
    g = math.exp(-0.5 * (distance / sigma) ** 2)
    return round((g - g_cut) / (1.0 - g_cut), 4)
