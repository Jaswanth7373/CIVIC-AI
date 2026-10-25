/**
 * One reading of an officer's workload for every admin screen that shows it (officer list, workload drawer,
 * reassignment candidates, the AI analytics officer table), on the same scale as the officer's own dashboard
 * (pages/officer/components/WorkloadMeter):
 * - below 80 % of capacity: room for new work (green);
 * - from 80 %: "Near capacity" (yellow, the product's warning colour);
 * - more open complaints than capacity: "Over capacity" (red; the API's `overloaded` flag).
 * Utilisation is a 0-1 fraction (clamped by the API, which also sends `overloaded` = active > capacity).
 */

/** Utilisation from which an officer counts as near capacity (WorkloadMeter uses the same threshold). */
export const NEAR_CAPACITY = 0.8

export const WORKLOAD_LEVELS = Object.freeze({
  ok: Object.freeze({ key: 'ok', label: 'Has capacity', tone: 'green' }),
  near: Object.freeze({ key: 'near', label: 'Near capacity', tone: 'yellow' }),
  over: Object.freeze({ key: 'over', label: 'Over capacity', tone: 'red' }),
})

function finiteNumber(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

/**
 * `{active, capacity, ratio, level}` for one officer. `ratio` is the 0-1 fill of a workload bar; `level` is one of
 * WORKLOAD_LEVELS. The API's `utilization` and `overloaded` win over the local maths (active / capacity), which is
 * the fallback for lists that carry only the counts (GET /officers/).
 */
export function readWorkload({ active, capacity, utilization, overloaded } = {}) {
  const open = Math.max(0, finiteNumber(active) ?? 0)
  const max = Math.max(0, finiteNumber(capacity) ?? 0)
  const derived = max > 0 ? open / max : open > 0 ? 1 : 0
  const ratio = Math.min(1, Math.max(0, finiteNumber(utilization) ?? derived))
  const over = typeof overloaded === 'boolean' ? overloaded : max > 0 && open > max
  const level = over ? WORKLOAD_LEVELS.over : ratio >= NEAR_CAPACITY ? WORKLOAD_LEVELS.near : WORKLOAD_LEVELS.ok
  return { active: open, capacity: max, ratio, level }
}
