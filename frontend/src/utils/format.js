/**
 * Display formatting for dates, numbers, durations and distances.
 *
 * The API sends ISO-8601 timestamps with offsets and plain JSON numbers (BUILD_SPEC 0.9). These helpers turn
 * them into short, human readable strings and never throw: missing or invalid values render as an em dash,
 * so a half-filled record cannot break a table. Numbers use the en-IN locale (Indian digit grouping,
 * e.g. 1,20,000), matching the deployment region.
 */
import { format, formatDistanceToNowStrict, isValid, parseISO } from 'date-fns'

export const EMPTY_VALUE = '—'
const LOCALE = 'en-IN'

/** Accepts a Date, an ISO string or epoch milliseconds; returns a valid Date or null. */
export function toDate(value) {
  if (value == null || value === '') return null
  if (value instanceof Date) return isValid(value) ? value : null
  const date = typeof value === 'number' ? new Date(value) : parseISO(String(value))
  return isValid(date) ? date : null
}

/** 17 Oct 2026 */
export function formatDate(value, pattern = 'd MMM yyyy') {
  const date = toDate(value)
  return date ? format(date, pattern) : EMPTY_VALUE
}

/** 17 Oct 2026, 2:30 PM */
export function formatDateTime(value, pattern = 'd MMM yyyy, h:mm a') {
  const date = toDate(value)
  return date ? format(date, pattern) : EMPTY_VALUE
}

/** 2:30 PM */
export function formatTime(value) {
  return formatDateTime(value, 'h:mm a')
}

/** yyyy-MM-dd for <input type="date"> values and the API's date_from / date_to filters ('' when empty). */
export function formatDateInput(value) {
  const date = toDate(value)
  return date ? format(date, 'yyyy-MM-dd') : ''
}

/** Relative time: "just now", "5 minutes ago", "in 3 hours" (future values work too, e.g. SLA due dates). */
export function timeAgo(value, { addSuffix = true } = {}) {
  const date = toDate(value)
  if (!date) return EMPTY_VALUE
  if (Math.abs(Date.now() - date.getTime()) < 45_000) return 'just now'
  return formatDistanceToNowStrict(date, { addSuffix })
}

const numberFormats = new Map()

/** Intl.NumberFormat instances are relatively expensive to build, so they are cached per option set. */
function numberFormat(options) {
  const key = JSON.stringify(options)
  if (!numberFormats.has(key)) numberFormats.set(key, new Intl.NumberFormat(LOCALE, options))
  return numberFormats.get(key)
}

function toNumber(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

/** 12,345 / 1,20,000; `compact` gives 1.2L; `digits` sets the maximum fraction digits. */
export function formatNumber(value, { digits = 0, compact = false } = {}) {
  const number = toNumber(value)
  if (number == null) return EMPTY_VALUE
  return numberFormat({
    maximumFractionDigits: digits,
    notation: compact ? 'compact' : 'standard',
  }).format(number)
}

/** Ratio in 0..1 -> "91%". Use `digits` for "91.4%". */
export function formatPercent(value, { digits = 0 } = {}) {
  const number = toNumber(value)
  if (number == null) return EMPTY_VALUE
  return numberFormat({ style: 'percent', maximumFractionDigits: digits }).format(number)
}

/**
 * Duration given in hours -> compact text: 0.4 -> "24 min", 5.4 -> "5 h", 52 -> "2 d 4 h", 48 -> "2 d".
 * Used for SLA windows and average resolution times. 0 is "0 min" (a real zero, e.g. no time spent yet);
 * a positive duration under a minute still shows as "1 min"; null / undefined / NaN show the empty dash.
 */
export function formatHours(hours) {
  const number = toNumber(hours)
  if (number == null) return EMPTY_VALUE
  if (number === 0) return '0 min'
  const sign = number < 0 ? '-' : ''
  const value = Math.abs(number)
  if (value < 1) return `${sign}${Math.max(1, Math.round(value * 60))} min`
  const total = Math.round(value)
  if (total < 24) return `${sign}${total} h`
  const days = Math.floor(total / 24)
  const rest = total % 24
  return rest ? `${sign}${days} d ${rest} h` : `${sign}${days} d`
}

/** Distance in metres -> "40 m" / "1.2 km" / "15 km". */
export function formatDistance(meters) {
  const number = toNumber(meters)
  if (number == null) return EMPTY_VALUE
  if (Math.abs(number) < 1000) return `${Math.round(number)} m`
  const km = number / 1000
  return `${formatNumber(km, { digits: Math.abs(km) < 10 ? 1 : 0 })} km`
}

/** Bytes -> "820 KB" / "2.4 MB". */
export function formatFileSize(bytes) {
  const number = toNumber(bytes)
  if (number == null) return EMPTY_VALUE
  if (number < 1024) return `${number} B`
  if (number < 1024 * 1024) return `${Math.round(number / 1024)} KB`
  return `${formatNumber(number / (1024 * 1024), { digits: 1 })} MB`
}

/** Score out of a maximum -> "87/100". */
export function formatScore(value, max = 100) {
  const number = toNumber(value)
  return number == null ? EMPTY_VALUE : `${Math.round(number)}/${max}`
}

/** "Ravi Kumar" -> "RK", "ravi@civicai.local" -> "R". */
export function getInitials(name) {
  const words = String(name ?? '')
    .replace(/@.*/, '')
    .split(/[\s._-]+/)
    .filter(Boolean)
  if (!words.length) return ''
  const first = words[0].charAt(0)
  const last = words.length > 1 ? words[words.length - 1].charAt(0) : ''
  return (first + last).toUpperCase()
}

/** Shorten long text on a word boundary: "Large pothole near the…" */
export function truncate(text, length = 120) {
  const value = String(text ?? '')
  if (value.length <= length) return value
  const cut = value.slice(0, length)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > length * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}
