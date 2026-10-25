/**
 * Data helpers for the chart wrappers (pure functions).
 *
 * The analytics API returns rows such as `{status, label, count}`, `{level, label, count}`,
 * `{sentiment, label, count, percentage}`, `{category: CategoryMini, total, ...}` or
 * `{department: DepartmentMini, ...}`. These helpers let a wrapper render such rows without per-page glue:
 * - `datumLabel` finds the human label (label > name > nested category / department / officer name > ...);
 * - `meaningColor` finds the colour that CARRIES MEANING for a row: an explicit hex `color`, the status /
 *   level / sentiment / verification colour from utils/constants, or the row's category / department colour.
 *   Rows without such a colour fall back to the validated palette.
 * - `normalizeSeries` + `foldSeries` turn series definitions into `{key, label, color}` and fold anything past
 *   the eighth series into one grey "All others" series (never a generated ninth hue).
 */
import { LEVEL_META, SENTIMENT_META, STATUS_META, VERIFICATION_META } from '@/utils/constants'
import { formatNumber } from '@/utils/format'
import { OTHER_SERIES_COLOR, isHexColor, paletteColor } from './palette'

export const FOLDED_KEY = '__folded'
const LABEL_CANDIDATES = ['label', 'name', 'bucket', 'date', 'title']
const VALUE_CANDIDATES = ['count', 'value', 'total']
const ENTITY_KEYS = ['category', 'department', 'officer']

/** Finite number or null. */
export function toFinite(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

/** First numeric value key of `data` (count > value > total > any numeric field). */
export function inferValueKey(data) {
  const sample = Array.isArray(data) ? data.find(Boolean) : null
  if (!sample) return 'count'
  const preferred = VALUE_CANDIDATES.find((key) => toFinite(sample[key]) != null)
  if (preferred) return preferred
  return Object.keys(sample).find((key) => !key.startsWith('__') && toFinite(sample[key]) != null) ?? 'count'
}

/**
 * Human label of a row: the explicit `labelKey` when given; otherwise the sentence-case label from
 * utils/constants for status / level / sentiment / verification rows (so charts read "In progress" exactly
 * like the badges do), then `label` / `name` / `bucket` / `date`, then a nested category / department /
 * officer name.
 */
export function datumLabel(datum, labelKey) {
  if (datum == null) return ''
  if (typeof datum !== 'object') return String(datum)
  const direct = labelKey ? datum[labelKey] : undefined
  if (direct != null && typeof direct !== 'object') return String(direct)
  if (direct && typeof direct === 'object') return String(direct.name ?? direct.full_name ?? direct.label ?? '')
  const meta = STATUS_META[datum.status] ?? VERIFICATION_META[datum.status] ?? LEVEL_META[datum.level] ?? SENTIMENT_META[datum.sentiment]
  if (meta?.label) return meta.label
  for (const key of LABEL_CANDIDATES) {
    if (datum[key] != null && typeof datum[key] !== 'object') return String(datum[key])
  }
  for (const key of ENTITY_KEYS) {
    const entity = datum[key]
    if (entity && typeof entity === 'object') return String(entity.name ?? entity.full_name ?? '')
  }
  return ''
}

/**
 * The colour that carries meaning for a row, or null (see module docs for the order). With
 * `{entities: false}` the colour of a nested category / department / officer is left out (see entityColor).
 */
export function meaningColor(datum, { entities = true } = {}) {
  if (!datum || typeof datum !== 'object') return null
  if (isHexColor(datum.color)) return datum.color
  const meta = STATUS_META[datum.status] ?? VERIFICATION_META[datum.status] ?? LEVEL_META[datum.level] ?? SENTIMENT_META[datum.sentiment]
  if (meta?.color) return meta.color
  return entities ? entityColor(datum) : null
}

/** The stored colour of a row's nested category / department / officer (an identity, not a meaning), or null. */
export function entityColor(datum) {
  if (!datum || typeof datum !== 'object') return null
  for (const key of ENTITY_KEYS) {
    if (isHexColor(datum[key]?.color)) return datum[key].color
  }
  return null
}

/**
 * Series definitions -> `[{key, label, color}]`. Strings are keys. A series without a valid colour takes the
 * palette slot of its position, so the colour follows the series' place in the definition (stable across
 * filters as long as the page passes the same list), never its rank in the data.
 */
export function normalizeSeries(series, mode = 'light') {
  return (Array.isArray(series) ? series : [])
    .filter(Boolean)
    .map((item, index) => {
      const entry = typeof item === 'string' ? { key: item } : item
      return {
        key: entry.key ?? entry.dataKey,
        label: entry.label ?? entry.name ?? String(entry.key ?? entry.dataKey ?? ''),
        color: isHexColor(entry.color) ? entry.color : paletteColor(index, mode),
      }
    })
    .filter((entry) => entry.key != null)
}

/** Sum of a key over rows. */
export function totalOf(rows, key) {
  return (rows ?? []).reduce((sum, row) => sum + (toFinite(row?.[key]) ?? 0), 0)
}

/**
 * Keep at most `maxSeries` series: the largest `maxSeries - 1` by total stay (in their original order) and
 * the rest are summed into one grey "All others" series. Returns `{rows, series}`.
 */
export function foldSeries(rows, series, { maxSeries = 8, mode = 'light', otherLabel = 'All others' } = {}) {
  if (!Array.isArray(series) || series.length <= maxSeries) return { rows, series }
  const ranked = [...series].sort((a, b) => totalOf(rows, b.key) - totalOf(rows, a.key))
  const keep = new Set(ranked.slice(0, Math.max(1, maxSeries - 1)).map((entry) => entry.key))
  const folded = series.filter((entry) => !keep.has(entry.key))
  const nextRows = (rows ?? []).map((row) => ({
    ...row,
    [FOLDED_KEY]: folded.reduce((sum, entry) => sum + (toFinite(row?.[entry.key]) ?? 0), 0),
  }))
  return {
    rows: nextRows,
    series: [
      ...series.filter((entry) => keep.has(entry.key)),
      { key: FOLDED_KEY, label: `${otherLabel} (${folded.length})`, color: OTHER_SERIES_COLOR[mode] ?? OTHER_SERIES_COLOR.light },
    ],
  }
}

/** Axis tick: clean integers, compact from 1,000 up (Indian grouping: 1K, 1.2L). */
export function axisNumber(value) {
  const number = toFinite(value)
  if (number == null) return ''
  return formatNumber(number, { compact: Math.abs(number) >= 1000, digits: Math.abs(number) < 10 && !Number.isInteger(number) ? 1 : 0 })
}

/** Rough rendered width of a label at `fontSize` (Public Sans averages ~0.56em per character). */
export function estimateTextWidth(text, fontSize = 12) {
  return Math.ceil(String(text ?? '').length * fontSize * 0.56)
}

/** "Roads / Potholes and drainage" -> "Roads / Potholes and…" for axis ticks (full text stays in tooltips). */
export function shortenLabel(text, max = 22) {
  const value = String(text ?? '')
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value
}

/** True when any series has a finite, non-zero value in any row. */
export function hasValues(rows, keys) {
  return (rows ?? []).some((row) => keys.some((key) => (toFinite(row?.[key]) ?? 0) !== 0))
}

/**
 * Series for `trends.category_series` / `trends.categories`: one series per category, keyed by its slug and
 * drawn in its own colour (the colour follows the category everywhere in the app).
 */
export function seriesFromCategories(categories) {
  return (Array.isArray(categories) ? categories : [])
    .filter((category) => category?.slug)
    .map((category) => ({ key: category.slug, label: category.name ?? category.slug, color: category.color }))
}
