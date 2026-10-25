/**
 * Pure helpers shared by the admin insight pages (dashboard, AI analytics, hotspot map, feedback analytics,
 * reports). Kept in a .js module so the component files export components only (React Fast Refresh).
 *
 * Units (backend contract): every analytics `*_rate`, `*_pct`, `sla_compliance` and `percentage` value is a
 * PERCENT 0-100 with one decimal; `utilization` and every AI confidence are FRACTIONS 0-1.
 */
import { LEVEL_META, STATUS_GROUPS, scoreToLevel } from '@/utils/constants'
import { EMPTY_VALUE, formatDateInput, formatNumber } from '@/utils/format'

/* ----------------------------------------------------------------------------------------------------------
 * Number formatting
 * -------------------------------------------------------------------------------------------------------- */

function finite(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

/** A 0-100 percent from the analytics API -> "75%" / "70.8%". */
export function formatPct(value, { digits = 1 } = {}) {
  const number = finite(value)
  return number == null ? EMPTY_VALUE : `${formatNumber(number, { digits })}%`
}

/** A 0-1 fraction (utilisation, AI confidence) -> "73%". */
export function formatShare(value, { digits = 0 } = {}) {
  const number = finite(value)
  return number == null ? EMPTY_VALUE : `${formatNumber(number * 100, { digits })}%`
}

/** Average rating -> "3.9" (one decimal, keeps the trailing zero so a column of ratings lines up). */
export function formatRating(value) {
  const number = finite(value)
  return number == null || number === 0 ? EMPTY_VALUE : number.toFixed(1)
}

/** Processing time in milliseconds -> "98 ms" / "1.4 s". */
export function formatMs(value) {
  const number = finite(value)
  if (number == null) return EMPTY_VALUE
  return number < 1000 ? `${Math.round(number)} ms` : `${formatNumber(number / 1000, { digits: 1 })} s`
}

/** "1 complaint" / "12 complaints" with Indian digit grouping. */
export function countLabel(count, singular, plural = `${singular}s`) {
  const number = finite(count) ?? 0
  return `${formatNumber(number)} ${number === 1 ? singular : plural}`
}

/* ----------------------------------------------------------------------------------------------------------
 * Chart mark colours
 * -------------------------------------------------------------------------------------------------------- */

/**
 * Meaning colours (STATUS_META / LEVEL_META / ...) are tuned for badges. As chart MARKS placed side by side
 * (the lifecycle bar, status-group stacks, trend lines) a few need another step of the SAME ramp, so the hue -
 * and therefore the meaning - never changes:
 * - dark mode: blues / greens / violet / slate that fall under 3:1 on the dark surface (#172022) move up;
 *   resolved and verified are kept apart (normal-vision dE >= 15);
 * - light mode: "reopened" fuchsia-600 sits next to "assigned" blue in the lifecycle bar and is too close
 *   under protanopia (dE 6.4), so marks use fuchsia-500.
 * Checked with the dataviz palette validator against both chart surfaces: every adjacent pair of the
 * lifecycle order passes CVD separation (>= 9.9) and the normal-vision floor (>= 16).
 */
const DARK_MARK_STEPS = {
  '#1f5fad': '#6a9edd', // guide-500 -> guide-300 (assigned / pending)
  '#35a17b': '#6dbf9f', // sign-400 -> sign-300 (resolved / low)
  '#095a41': '#12845f', // sign-700 -> sign-500 (verified)
  '#7c3aed': '#8b5cf6', // violet-600 -> violet-500 (AI analyzed)
  '#64748b': '#8391a7', // slate-500 -> slate-400 (submitted)
}

const LIGHT_MARK_STEPS = {
  '#c026d3': '#d946ef', // fuchsia-600 -> fuchsia-500 (reopened)
}

/** Colour of a chart mark for the current theme mode ('light' | 'dark'). */
export function markColor(hex, mode = 'light') {
  if (typeof hex !== 'string') return hex
  const key = hex.trim().toLowerCase()
  const steps = mode === 'dark' ? DARK_MARK_STEPS : LIGHT_MARK_STEPS
  return steps[key] ?? hex
}

/**
 * A round upper bound for a count axis, so ticks read 0 / 10 / 20 / 30 / 40 instead of 0 / 9 / 18 / 27 / 36
 * (Recharts splits the domain into four intervals). Use as `domain={[0, niceAxisMax]}`.
 */
export function niceAxisMax(max, intervals = 4) {
  const value = Number(max)
  if (!Number.isFinite(value) || value <= 0) return intervals
  const raw = value / intervals
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  // Fractional multipliers only from tens upwards, so small counts keep whole-number ticks.
  const multipliers = magnitude >= 10 ? [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10] : [1, 2, 3, 4, 5, 6, 8, 10]
  const step = Math.max(1, (multipliers.find((multiplier) => multiplier * magnitude >= raw) ?? 10) * magnitude)
  return step * intervals
}

/**
 * Readable model name: registry ids such as "nlp.text_classifier" become "Text classifier (NLP)"; names that
 * are already readable ("CLIP zero-shot classifier") are kept.
 */
export function modelDisplayName(model) {
  const name = String(model?.name || model?.key || '').trim()
  if (!/^[a-z0-9_]+(\.[a-z0-9_]+)+$/.test(name)) return name || 'Model'
  const parts = name.split('.')
  const leaf = parts[parts.length - 1].replace(/_/g, ' ')
  return `${leaf.charAt(0).toUpperCase()}${leaf.slice(1)} (${parts.slice(0, -1).join(' ').toUpperCase()})`
}

/** Model registry status -> label + badge tone (statuses reported by describe_models()). */
export const MODEL_STATUS = Object.freeze({
  active: { label: 'Active', tone: 'green' },
  loaded: { label: 'Loaded', tone: 'green' },
  available: { label: 'Available', tone: 'blue' },
  fallback: { label: 'Fallback in use', tone: 'yellow' },
  weights_missing: { label: 'Weights missing', tone: 'orange' },
  not_installed: { label: 'Not installed', tone: 'neutral' },
  error: { label: 'Error', tone: 'red' },
})

export function modelStatus(status) {
  const text = String(status ?? '').replace(/_/g, ' ')
  return MODEL_STATUS[status] ?? { label: text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Unknown', tone: 'neutral' }
}

/** Category names like "Water Supply / Water Leakage" -> "Water Supply" (narrow screens; full name in tooltips). */
export function shortCategoryName(name) {
  const text = String(name ?? '')
  const [first] = text.split(' / ')
  return first || text
}

/** Colour of a priority histogram bucket ("50-59") = the level of the bucket's midpoint. */
export function bucketLevelColor(bucket) {
  const [low, high] = String(bucket ?? '')
    .split('-')
    .map((part) => Number.parseFloat(part))
  if (!Number.isFinite(low)) return null
  const mid = Number.isFinite(high) ? (low + high) / 2 : low
  return LEVEL_META[scoreToLevel(mid)]?.color ?? null
}

/* ----------------------------------------------------------------------------------------------------------
 * Date range presets (analytics filters are created_at dates, YYYY-MM-DD, inclusive)
 * -------------------------------------------------------------------------------------------------------- */

export const RANGE_PRESETS = Object.freeze([
  { value: '', label: 'All time' },
  { value: '7d', label: 'Last 7 days', days: 7 },
  { value: '30d', label: 'Last 30 days', days: 30 },
  { value: '90d', label: 'Last 90 days', days: 90 },
  { value: '365d', label: 'Last 12 months', days: 365 },
  { value: 'custom', label: 'Custom range' },
])

/**
 * Hotspot map presets: DBSCAN needs a bounded window, so there is no "All time"; the empty value is the
 * server's default window (the last 90 days, `days=90`).
 */
export const HOTSPOT_RANGE_PRESETS = Object.freeze([
  { value: '7d', label: 'Last 7 days', days: 7 },
  { value: '30d', label: 'Last 30 days', days: 30 },
  { value: '', label: 'Last 90 days' },
  { value: '180d', label: 'Last 6 months', days: 180 },
  { value: '365d', label: 'Last 12 months', days: 365 },
  { value: 'custom', label: 'Custom range' },
])

/** `{date_from, date_to}` for a preset: the last N calendar days including today (open-ended). */
export function rangeFromPreset(preset, today = new Date(), presets = RANGE_PRESETS) {
  const option = presets.find((item) => item.value === preset)
  if (!option?.days) return { date_from: '', date_to: '' }
  const from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (option.days - 1))
  return { date_from: formatDateInput(from), date_to: '' }
}

/** Which preset (or 'custom') the current `date_from` / `date_to` correspond to. */
export function detectRange({ date_from: from, date_to: to } = {}, today = new Date(), presets = RANGE_PRESETS) {
  if (!from && !to) return ''
  if (!to) {
    const match = presets.find((item) => item.days && rangeFromPreset(item.value, today, presets).date_from === from)
    if (match) return match.value
  }
  return 'custom'
}

/* ----------------------------------------------------------------------------------------------------------
 * Links into the complaint list (same URL parameters as useComplaintFilters)
 * -------------------------------------------------------------------------------------------------------- */

/** Status lists of the dashboard groups, identical to the backend's PENDING / IN_PROGRESS / RESOLVED / OPEN. */
export const STATUS_GROUP_PARAM = Object.freeze({
  pending: STATUS_GROUPS.pending.join(','),
  in_progress: STATUS_GROUPS.in_progress.join(','),
  resolved: STATUS_GROUPS.resolved.join(','),
  open: STATUS_GROUPS.open.join(','),
})

/**
 * `/admin/complaints?...` filtered like the insight page (`params` = analytics params) plus `extra`
 * (e.g. `{status: 'assigned,accepted'}`), so a number on a dashboard opens exactly the complaints behind it.
 */
export function complaintsHref(params = {}, extra = {}) {
  const search = new URLSearchParams()
  const merged = { ...params, ...extra }
  Object.entries(merged).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return
    const text = Array.isArray(value) ? value.filter(Boolean).join(',') : String(value)
    if (text) search.set(key, text)
  })
  const query = search.toString()
  return query ? `/admin/complaints?${query}` : '/admin/complaints'
}

/** Query string for another insight page that shares the same filter parameters. */
export function withFilters(path, params = {}, extra = {}) {
  const search = new URLSearchParams()
  Object.entries({ ...params, ...extra }).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return
    const text = Array.isArray(value) ? value.filter(Boolean).join(',') : String(value)
    if (text) search.set(key, text)
  })
  const query = search.toString()
  return query ? `${path}?${query}` : path
}

/* ----------------------------------------------------------------------------------------------------------
 * Client-side sorting for analytics tables (the analytics endpoints return complete, small lists)
 * -------------------------------------------------------------------------------------------------------- */

/**
 * Sort `rows` by a DataTable sort string ("-utilization" = descending). `accessors` maps a sort key to a
 * function returning the comparable value; missing values (null / undefined / '') always sort last.
 */
export function sortRows(rows, sort, accessors = {}) {
  const list = Array.isArray(rows) ? [...rows] : []
  if (!sort) return list
  const descending = sort.startsWith('-')
  const key = descending ? sort.slice(1) : sort
  const read = accessors[key] ?? ((row) => row?.[key])
  const empty = (value) => value === null || value === undefined || value === ''
  return list.sort((a, b) => {
    const left = read(a)
    const right = read(b)
    if (empty(left) && empty(right)) return 0
    if (empty(left)) return 1
    if (empty(right)) return -1
    const order =
      typeof left === 'string' || typeof right === 'string'
        ? String(left).localeCompare(String(right), undefined, { sensitivity: 'base' })
        : Number(left) - Number(right)
    return descending ? -order : order
  })
}

/** Tone for a "higher is better" percent (resolution rate, SLA compliance, satisfaction). */
export function percentTone(value) {
  const number = finite(value)
  if (number == null) return 'neutral'
  if (number >= 85) return 'green'
  if (number >= 70) return 'yellow'
  if (number >= 50) return 'orange'
  return 'red'
}

/* ----------------------------------------------------------------------------------------------------------
 * Invalid filters (an outdated or edited link)
 * -------------------------------------------------------------------------------------------------------- */

export const FILTER_PARAM_KEYS = Object.freeze([
  'date_from',
  'date_to',
  'department',
  'category',
  'severity',
  'status',
  'non_field_errors',
])

/**
 * The first error that is a 400 validation error about the page's filters (e.g. `department=999` from an old
 * link: "Unknown department '999'"), or null. Pages show ONE message with "Clear filters" for it instead of
 * the same failure in every widget.
 */
export function filterValidationError(errors, keys = FILTER_PARAM_KEYS) {
  for (const error of errors ?? []) {
    if (error?.response?.status !== 400) continue
    const fields = Object.keys(error.response.data?.errors ?? {})
    if (fields.some((field) => keys.includes(field))) return error
  }
  return null
}

/* ----------------------------------------------------------------------------------------------------------
 * Misc
 * -------------------------------------------------------------------------------------------------------- */

/** Category / department option lists for filter selects. */
export function departmentOptions(departments) {
  return (Array.isArray(departments) ? departments : []).map((department) => ({
    value: String(department.id),
    label: department.name,
  }))
}

export function categoryOptions(categories) {
  return (Array.isArray(categories) ? categories : []).map((category) => ({
    value: String(category.slug ?? category.id),
    label: category.name,
  }))
}

/** A category filter value may be an id (links from other pages) or a slug; selects use the slug. */
export function categorySelectValue(value, categories) {
  const text = String(value ?? '')
  if (!text || !/^\d+$/.test(text)) return text
  const match = (categories ?? []).find((category) => String(category.id) === text)
  return match ? String(match.slug) : text
}
