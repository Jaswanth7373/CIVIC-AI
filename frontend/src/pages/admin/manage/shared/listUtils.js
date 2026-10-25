/**
 * Small pure helpers shared by the admin management screens (kept out of the .jsx files so those export
 * components only, as React Fast Refresh requires).
 */

/** Rows of a list endpoint: a plain array (non-paginated endpoints) or the `results` of a page envelope. */
export function toList(data) {
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.results)) return data.results
  return []
}

/** Query params without empty values (`''`, `null`, `undefined`, empty arrays). */
export function compactParams(params) {
  return Object.fromEntries(
    Object.entries(params ?? {}).filter(([, value]) =>
      Array.isArray(value) ? value.length > 0 : value !== '' && value !== null && value !== undefined,
    ),
  )
}

/** Copy of `params` without the given keys. */
export function omitKeys(params, keys) {
  const drop = new Set(keys)
  return Object.fromEntries(Object.entries(params ?? {}).filter(([key]) => !drop.has(key)))
}

/** Display name of an officer row from GET /officers/ (`user.full_name`) or an OfficerMini (`full_name`). */
export function officerName(officer) {
  return officer?.user?.full_name || officer?.full_name || officer?.user?.email || officer?.email || 'Officer'
}

/**
 * Officers grouped by department for `<optgroup>` selects:
 * `[{label: 'Roads Department', officers: [{id, name, hint}]}]`, departments alphabetically, officers by name.
 * Unavailable or deactivated officers stay selectable (history filters need them) and say so in the hint.
 */
export function groupOfficers(officers) {
  const groups = new Map()
  ;(Array.isArray(officers) ? officers : []).forEach((officer) => {
    const department = officer?.department?.name ?? 'No department'
    if (!groups.has(department)) groups.set(department, [])
    const notes = []
    if (officer?.user && officer.user.is_active === false) notes.push('deactivated')
    else if (officer?.is_available === false) notes.push('unavailable')
    groups.get(department).push({
      id: officer.id,
      name: officerName(officer),
      hint: notes.length ? ` (${notes.join(', ')})` : '',
    })
  })
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, items]) => ({ label, officers: items.sort((a, b) => a.name.localeCompare(b.name)) }))
}

/** A percent value from the analytics API (already 0-100, one decimal) -> "75.0%". */
export function formatPercentValue(value, digits = 1) {
  const number = Number(value)
  if (value === null || value === undefined || value === '' || !Number.isFinite(number)) return '—'
  return `${number.toFixed(digits)}%`
}

/** Read `item.path.to.value` safely. */
export function readPath(item, path) {
  return String(path)
    .split('.')
    .reduce((value, key) => (value == null ? value : value[key]), item)
}

/**
 * Field errors of a list payload (`errors.mappings.3.department`) grouped by row index:
 * `{3: {department: 'message'}}`. Used by the routing matrix to show messages on the right row.
 */
export function rowErrors(fieldErrors, listKey) {
  const result = {}
  Object.entries(fieldErrors ?? {}).forEach(([path, message]) => {
    const match = new RegExp(`^${listKey}\\.(\\d+)\\.([a-z_]+)$`).exec(path)
    if (!match) return
    const index = Number(match[1])
    result[index] = { ...(result[index] ?? {}), [match[2]]: message }
  })
  return result
}
