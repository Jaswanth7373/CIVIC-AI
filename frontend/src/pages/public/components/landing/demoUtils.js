/**
 * Helpers for the landing page's live AI demo (POST /api/ai/demo/, public, nothing is stored).
 *
 * - `runHeroDemo()` posts the bundled sample photo + description once per page load and shares the result
 *   (one request even when React StrictMode mounts the hero twice, or the visitor navigates away and back);
 *   `{force: true}` runs a fresh request (the "Try again" button).
 * - `retryAfterSeconds(error)` reads how long a rate-limited (429) visitor has to wait.
 * - `routeFor(categories, category)` resolves the department a category is routed to, from the public
 *   /categories/ list (CategoryOut carries `department_detail` and `effective_sla_hours`).
 */
import { aiService } from '@/services/aiService'

/** The photo and description the hero work order analyses on load (public/samples/pothole.jpg). */
export const HERO_SAMPLE = Object.freeze({
  src: '/samples/pothole.jpg',
  filename: 'pothole.jpg',
  alt: 'Sample report photo: a large pothole on an asphalt road beside a yellow lane marking',
  description: 'Large pothole in the middle of the road near the bus stop. Two-wheelers are swerving to avoid it.',
})

/** Sample photos visitors can send from the "Try your own photo" dialog (public/samples/). */
export const SAMPLE_PHOTOS = Object.freeze([
  { id: 'garbage', label: 'Garbage dump', src: '/samples/garbage.jpg', filename: 'garbage.jpg' },
  { id: 'open-manhole', label: 'Open manhole', src: '/samples/open-manhole.jpg', filename: 'open-manhole.jpg' },
  { id: 'fallen-tree', label: 'Fallen tree', src: '/samples/fallen-tree.jpg', filename: 'fallen-tree.jpg' },
  { id: 'water-leak', label: 'Water leak', src: '/samples/water-leak.jpg', filename: 'water-leak.jpg' },
])

/** Download a bundled sample photo and wrap it in a File, exactly like a photo the visitor picked. */
export async function sampleFile({ src, filename }) {
  const response = await fetch(src)
  if (!response.ok) throw new Error('The sample photo could not be loaded. Reload the page and try again.')
  const blob = await response.blob()
  return new File([blob], filename, { type: blob.type || 'image/jpeg' })
}

let heroResult = null
let heroRequest = null

/** Analyse the hero sample with the real engine; cached for the page load unless `force`. */
export function runHeroDemo({ force = false } = {}) {
  if (heroResult && !force) return Promise.resolve(heroResult)
  if (heroRequest && !force) return heroRequest
  heroRequest = sampleFile(HERO_SAMPLE)
    .then((image) => aiService.demo({ image, description: HERO_SAMPLE.description }))
    .then((result) => {
      heroResult = result
      return result
    })
    .finally(() => {
      heroRequest = null
    })
  return heroRequest
}

/**
 * Seconds until a rate-limited (HTTP 429) request may be repeated: the Retry-After header when the browser
 * may read it, otherwise the number in DRF's message ("Expected available in 37 seconds."). null when the
 * error is not a rate limit.
 */
export function retryAfterSeconds(error) {
  if (error?.response?.status !== 429) return null
  const header = Number(error.response.headers?.['retry-after'])
  if (Number.isFinite(header) && header > 0) return Math.ceil(header)
  const match = /(\d+)\s*second/i.exec(String(error.response.data?.detail ?? ''))
  return match ? Math.max(1, Number(match[1])) : 60
}

/** The CategoryOut for a CategoryMini / id / slug from the public categories list (or null). */
export function findCategory(categories, category) {
  if (!category || !Array.isArray(categories)) return null
  const id = typeof category === 'object' ? category.id : category
  const slug = typeof category === 'object' ? category.slug : category
  return categories.find((item) => item.id === id || (slug && item.slug === slug)) ?? null
}

/** `{department, secondary, slaHours}` for a category, from the routing data in the categories list. */
export function routeFor(categories, category) {
  const match = findCategory(categories, category)
  if (!match) return { department: null, secondary: null, slaHours: null }
  return {
    department: match.department_detail ?? null,
    secondary: match.secondary_department_detail ?? null,
    slaHours: match.effective_sla_hours ?? match.sla_hours ?? null,
  }
}

/** Ratio 0..1 -> "75%" (null-safe, rounds like the engine's own explanations). */
export function percent(value) {
  const number = Number(value)
  if (value === null || value === undefined || !Number.isFinite(number)) return '—'
  return `${Math.round(number * 100)}%`
}
