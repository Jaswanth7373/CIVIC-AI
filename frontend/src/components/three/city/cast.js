/**
 * Casting the illustration: which real category and department each issue site and headquarters shows.
 * Pure JS (shared by CityScene and CityFallback).
 *
 * - Departments come from the categories' `department_detail` (GET /api/categories/), in category order; the
 *   first six get the HQ landmarks. Categories whose department has no landmark are not used on the streets, so
 *   a routing arc always ends at the HQ of the department it names.
 * - Without categories (still loading, offline) the labels use generic wording and the beacons a neutral palette.
 * - Severity colours on the sites are illustrative levels (colour = meaning, no numbers are ever shown).
 */
import { HQ_SLOTS, ISSUE_SITES } from './layout'

export const SIGN_GREEN = '#0B6E4F'
export const RESOLVED_GREEN = '#35A17B'
export const MARKING_YELLOW = '#F5B700'

/** LEVEL_META colours (utils/constants) without importing the icon module into the 3D chunk. */
export const SEVERITY_COLORS = Object.freeze({
  low: '#35A17B',
  medium: '#F5B700',
  high: '#E8730C',
  critical: '#D3341F',
})

const SEVERITY_CYCLE = ['high', 'critical', 'medium', 'high', 'low', 'critical', 'medium', 'high', 'medium', 'low']
const FALLBACK_HQ_COLORS = ['#1F5FAD', '#0B8EA8', '#E8730C', '#2F9E44', '#9C6B30', '#7C3AED']

export const GENERIC_LABELS = Object.freeze({
  detected: 'Issue detected',
  department: 'Department',
  resolved: 'Resolved',
  report: 'New report',
})

function validHex(value, fallback) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim() : fallback
}

/**
 * @param {Array<object>|null|undefined} categories CategoryOut[] from the API (optional)
 * @returns {{ hqs: {slot:number, name:string|null, color:string}[], sites: object[], hasData: boolean }}
 */
export function castCity(categories) {
  const list = Array.isArray(categories) ? categories.filter((c) => c && c.is_active !== false && c.name) : []
  const departments = []
  list.forEach((category) => {
    const dept = category.department_detail
    if (dept && dept.id != null && !departments.some((d) => d.id === dept.id)) departments.push(dept)
  })
  const housed = departments.slice(0, HQ_SLOTS.length)
  const hqs = HQ_SLOTS.map((_, slot) => {
    const dept = housed[slot]
    return {
      slot,
      name: dept?.name ? String(dept.name) : null,
      color: validHex(dept?.color, FALLBACK_HQ_COLORS[slot % FALLBACK_HQ_COLORS.length]),
    }
  })
  const eligible = list.filter((c) => housed.some((d) => d.id === c.department_detail?.id))
  const sites = ISSUE_SITES.map((site, index) => {
    const category = eligible.length ? eligible[index % eligible.length] : null
    const hq = category ? housed.findIndex((d) => d.id === category.department_detail.id) : index % HQ_SLOTS.length
    const severity = SEVERITY_CYCLE[index % SEVERITY_CYCLE.length]
    return {
      ...site,
      index,
      hq,
      severity,
      severityColor: SEVERITY_COLORS[severity],
      label: category ? String(category.name) : GENERIC_LABELS.detected,
      department: hqs[hq].name ?? GENERIC_LABELS.department,
    }
  })
  return { hqs, sites, hasData: eligible.length > 0 }
}
