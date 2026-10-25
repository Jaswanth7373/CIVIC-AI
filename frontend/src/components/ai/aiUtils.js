/**
 * Small pure helpers shared by the AI result components (kept out of the .jsx files so those export
 * components only, as React Fast Refresh requires).
 */

/** Confidence / similarity as a 0..1 ratio, or null when it is not a number (91 is read as 91%). */
export function toRatio(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  return Math.min(1, Math.max(0, number > 1 ? number / 100 : number))
}

/** "water_leak" -> "Water leak", "open-manhole" -> "Open manhole". */
export function humanize(value) {
  const text = String(value ?? '').replace(/[_-]+/g, ' ').trim()
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : ''
}

/** Bar tone for a model confidence: >= 75% green, >= 50% yellow, otherwise orange. */
export function confidenceTone(ratio) {
  if (ratio == null) return 'neutral'
  if (ratio >= 0.75) return 'green'
  if (ratio >= 0.5) return 'yellow'
  return 'orange'
}

/**
 * Resolve a category slug to something displayable: the matching CategoryMini from `categories` (or the
 * prediction's final category) when known, else a humanised name.
 */
export function categoryFromSlug(slug, categories = [], fallback = null) {
  if (!slug) return null
  if (fallback && fallback.slug === slug) return fallback
  const match = (categories ?? []).find((category) => category?.slug === slug)
  return match ?? { slug, name: humanize(slug), icon: slug }
}

/**
 * Image / text agreement of a prediction: 'agree' | 'disagree' | 'single_modality' | 'none'.
 * Uses the fusion engine's own verdict when the payload carries it, otherwise compares the two slugs.
 */
export function modalityAgreement(prediction) {
  const explicit = prediction?.agreement ?? prediction?.fusion?.agreement
  if (['agree', 'disagree', 'single_modality', 'none'].includes(explicit)) return explicit
  const image = prediction?.image_category
  const text = prediction?.text_category
  if (image && text) return image === text ? 'agree' : 'disagree'
  if (image || text) return 'single_modality'
  return 'none'
}

/** The first four numbers of a detection box, or null when it is not a usable box. */
export function boxNumbers(box) {
  if (!Array.isArray(box) || box.length < 4) return null
  const numbers = box.slice(0, 4).map(Number)
  return numbers.every(Number.isFinite) ? numbers : null
}

/**
 * A detection box as `{x, y, w, h}` fractions of the image (0..1, top-left origin), or null when it cannot be
 * placed yet. The engine sends normalised boxes; pixel boxes (any value > 1.5) are converted with the image's
 * natural size once it is known.
 */
export function normaliseBox(box, natural) {
  const numbers = boxNumbers(box)
  if (!numbers) return null
  let [x1, y1, x2, y2] = numbers
  if (Math.max(x1, y1, x2, y2) > 1.5) {
    if (!natural) return null
    x1 /= natural.width
    x2 /= natural.width
    y1 /= natural.height
    y2 /= natural.height
  }
  const left = Math.min(1, Math.max(0, Math.min(x1, x2)))
  const top = Math.min(1, Math.max(0, Math.min(y1, y2)))
  const right = Math.min(1, Math.max(0, Math.max(x1, x2)))
  const bottom = Math.min(1, Math.max(0, Math.max(y1, y2)))
  if (right - left <= 0 || bottom - top <= 0) return null
  return { x: left, y: top, w: right - left, h: bottom - top }
}

/**
 * Detections of an AIPrediction as `[{box, label, confidence, approximate, number}]`: `detected_objects` when
 * the engine sent any, else the bare `bounding_boxes`.
 */
export function detectionsOf(objects, boxes) {
  const list =
    Array.isArray(objects) && objects.length
      ? objects.map((object) => ({
          box: object?.box,
          label: object?.label ?? object?.detector_label ?? '',
          confidence: object?.confidence,
          approximate: Boolean(object?.approximate),
        }))
      : (Array.isArray(boxes) ? boxes : []).map((box) => ({ box, label: '', confidence: null, approximate: false }))
  return list.map((item, index) => ({ ...item, number: index + 1 })).filter((item) => boxNumbers(item.box))
}
