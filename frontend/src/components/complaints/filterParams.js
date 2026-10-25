/**
 * Complaint list filters <-> URL search params (pure functions; used by useComplaintFilters and
 * ComplaintFilters).
 *
 * Why the URL: filters in `?status=assigned,reopened&category=pothole&page=2` survive a reload, can be
 * bookmarked or shared, and the browser back button restores the previous list. The parameter names are
 * exactly the GET /api/complaints/ filters (BUILD_SPEC 4.2), so the parsed object can be sent to the API
 * as it is: `status` is a list (sent as a comma list by services/api.js), boolean flags are "true" or "".
 * Values equal to a default are left out of the URL, so links stay short.
 */
import { formatDateInput, toDate } from '@/utils/format'

export const FILTER_KEYS = Object.freeze([
  'search',
  'status',
  'category',
  'severity',
  'priority_level',
  'department',
  'assigned_officer',
  'citizen',
  'date_from',
  'date_to',
  'ordering',
  'is_overdue',
  'has_duplicates',
  'needs_review',
  'unassigned',
])

export const FLAG_KEYS = Object.freeze(['is_overdue', 'has_duplicates', 'needs_review', 'unassigned'])

/** Filters that hold a user id (`?assigned_officer=12`, `?citizen=40`); anything but digits is dropped. */
export const ID_KEYS = Object.freeze(['assigned_officer', 'citizen'])

export const EMPTY_FILTERS = Object.freeze({
  search: '',
  status: Object.freeze([]),
  category: '',
  severity: '',
  priority_level: '',
  department: '',
  assigned_officer: '',
  citizen: '',
  date_from: '',
  date_to: '',
  ordering: '',
  is_overdue: '',
  has_duplicates: '',
  needs_review: '',
  unassigned: '',
})

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function cleanDate(value) {
  const text = String(value ?? '').trim()
  return DATE_PATTERN.test(text) && toDate(text) ? text : ''
}

function cleanList(value) {
  const items = Array.isArray(value) ? value : String(value ?? '').split(',')
  return [...new Set(items.map((item) => String(item).trim()).filter(Boolean))]
}

/** Normalise any partial filter object into the full EMPTY_FILTERS shape (strings, a status list, flags). */
export function normalizeFilters(filters = {}, defaults = {}) {
  const merged = { ...EMPTY_FILTERS, ...defaults, ...filters }
  const result = {}
  FILTER_KEYS.forEach((key) => {
    const value = merged[key]
    if (key === 'status') result.status = cleanList(value)
    else if (key === 'date_from' || key === 'date_to') result[key] = cleanDate(value)
    else if (FLAG_KEYS.includes(key)) result[key] = value === true || value === 'true' ? 'true' : ''
    else if (ID_KEYS.includes(key)) result[key] = /^\d+$/.test(String(value ?? '').trim()) ? String(value).trim() : ''
    else result[key] = value == null ? '' : String(value).trim()
  })
  return result
}

/** Read the filters from URLSearchParams; missing keys take their default. */
export function parseFilters(searchParams, defaults = {}) {
  const fromUrl = {}
  FILTER_KEYS.forEach((key) => {
    if (searchParams.has(key)) fromUrl[key] = searchParams.get(key)
  })
  return normalizeFilters(fromUrl, defaults)
}

function sameValue(a, b) {
  return Array.isArray(a) || Array.isArray(b) ? cleanList(a).join(',') === cleanList(b).join(',') : String(a ?? '') === String(b ?? '')
}

/**
 * Write `filters` into a copy of `current` params: unrelated params (e.g. `tab`) are kept, the page is reset
 * (new filters -> first page), empty values and values equal to their default are removed.
 */
export function filtersToSearchParams(filters, current, defaults = {}) {
  const next = new URLSearchParams(current)
  const normalized = normalizeFilters(filters, {})
  const defaultValues = normalizeFilters({}, defaults)
  FILTER_KEYS.forEach((key) => next.delete(key))
  next.delete('page')
  FILTER_KEYS.forEach((key) => {
    const value = normalized[key]
    const empty = Array.isArray(value) ? value.length === 0 : value === ''
    if (sameValue(value, defaultValues[key])) return
    if (empty) {
      // An explicitly cleared value that HAS a default must be written, or the default would come back.
      if (!sameValue(defaultValues[key], EMPTY_FILTERS[key])) next.set(key, '')
      return
    }
    next.set(key, Array.isArray(value) ? value.join(',') : value)
  })
  return next
}

/** How many filters differ from their defaults (search and sort order excluded). */
export function countActiveFilters(filters, defaults = {}) {
  const normalized = normalizeFilters(filters, {})
  const defaultValues = normalizeFilters({}, defaults)
  const dateActive = normalized.date_from || normalized.date_to ? 1 : 0
  return (
    FILTER_KEYS.filter(
      (key) => !['search', 'ordering', 'date_from', 'date_to'].includes(key) && !sameValue(normalized[key], defaultValues[key]),
    ).length + dateActive
  )
}

/** API query params for complaintService.list / map (empty values are dropped by services/api.js). */
export function toApiParams(filters) {
  const normalized = normalizeFilters(filters, {})
  const params = {}
  FILTER_KEYS.forEach((key) => {
    const value = normalized[key]
    if (Array.isArray(value) ? value.length : value !== '') params[key] = value
  })
  return params
}

/* ---- Date range presets --------------------------------------------------------------------------- */
export const DATE_PRESETS = Object.freeze([
  { value: '', label: 'Any time' },
  { value: 'today', label: 'Today', days: 1 },
  { value: '7d', label: 'Last 7 days', days: 7 },
  { value: '30d', label: 'Last 30 days', days: 30 },
  { value: '90d', label: 'Last 90 days', days: 90 },
  { value: 'custom', label: 'Custom range' },
])

/** `{date_from, date_to}` for a preset: the last N calendar days including today, open-ended. */
export function presetRange(preset, today = new Date()) {
  const option = DATE_PRESETS.find((item) => item.value === preset)
  if (!option?.days) return { date_from: '', date_to: '' }
  const from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (option.days - 1))
  return { date_from: formatDateInput(from), date_to: '' }
}

/** Which preset (or "custom") a date range corresponds to. */
export function detectPreset({ date_from: from, date_to: to } = {}, today = new Date()) {
  if (!from && !to) return ''
  if (!to) {
    const match = DATE_PRESETS.find((item) => item.days && presetRange(item.value, today).date_from === from)
    if (match) return match.value
  }
  return 'custom'
}
