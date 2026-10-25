/**
 * Small pure helpers shared by the citizen complaint pages (dashboard, details, tracking, report form).
 * Kept in a .js module so the component files export components only (React Fast Refresh).
 */
import { STATUS_GROUPS } from '@/utils/constants'
import { toDate } from '@/utils/format'

/** Citizen list links for the dashboard tiles: the status groups the dashboard counts by. */
export const STATUS_GROUP_LINKS = Object.freeze({
  all: '/citizen/complaints',
  pending: `/citizen/complaints?status=${STATUS_GROUPS.pending.join(',')}`,
  in_progress: `/citizen/complaints?status=${STATUS_GROUPS.in_progress.join(',')}`,
  resolved: `/citizen/complaints?status=${STATUS_GROUPS.resolved.join(',')}`,
})

export const complaintPath = (id) => `/citizen/complaints/${id}`
export const trackingPath = (id) => `/citizen/complaints/${id}/track`

/** The citizen's original photo of a complaint (ComplaintDetail.images, falling back to the list thumbnail). */
export function primaryPhoto(complaint) {
  const images = Array.isArray(complaint?.images) ? complaint.images.filter(Boolean) : []
  const original = images.find((image) => image.kind === 'original') ?? images[0]
  return original?.url ?? complaint?.thumbnail ?? null
}

/**
 * Who is handling the complaint: `{officer, assignment}` or null.
 * The active assignment carries the richer OfficerMini (designation, zone, employee id); after a resolution
 * or a reopen there may be no active assignment any more, so the assignment of `assigned_officer` (or the
 * newest assignment) is used instead.
 */
export function handlingOfficer(complaint) {
  if (!complaint) return null
  const active = complaint.current_assignment
  if (active?.officer) return { officer: active.officer, assignment: active }
  const assignments = (Array.isArray(complaint.assignments) ? complaint.assignments : [])
    .filter((item) => item?.officer)
    .sort((a, b) => (toDate(b.assigned_at)?.getTime() ?? 0) - (toDate(a.assigned_at)?.getTime() ?? 0))
  if (complaint.assigned_officer) {
    const match = assignments.find((item) => item.officer.id === complaint.assigned_officer.id)
    return { officer: match?.officer ?? complaint.assigned_officer, assignment: match ?? null }
  }
  return assignments[0] ? { officer: assignments[0].officer, assignment: assignments[0] } : null
}

/** Address of a LocationOut as display lines: street address, landmark, "area, city pincode". */
export function addressLines(location) {
  if (!location) return { street: '', landmark: '', locality: '' }
  const street = (location.address ?? '').trim()
  const landmark = (location.landmark ?? '').trim()
  const cityLine = [location.city, location.pincode].filter(Boolean).join(' ')
  const area = (location.area ?? '').trim()
  // The street address often already ends with the area name; do not repeat it.
  const showArea = area && !street.toLowerCase().includes(area.toLowerCase())
  const locality = [showArea ? area : '', cityLine].filter(Boolean).join(', ')
  return { street, landmark, locality }
}

/** Short place label for cards: area, else the street address, else the city. */
export function placeLabel(location) {
  return location?.area || location?.address || location?.city || ''
}

/** Time-of-day greeting for the dashboard heading (shared with the officer dashboard). */
export { greetingFor } from '@/pages/shared/components/greeting'

/** True while the complaint is still being worked on (not resolved, closed or rejected). */
export function isOpenStatus(status) {
  return STATUS_GROUPS.open.includes(status)
}

/** Newest event of a timeline (any order in, newest out) or null. */
export function latestEvent(events) {
  const list = Array.isArray(events) ? events.filter(Boolean) : []
  return list.reduce((latest, event) => {
    if (!latest) return event
    const a = toDate(event.timestamp)?.getTime() ?? 0
    const b = toDate(latest.timestamp)?.getTime() ?? 0
    return a > b || (a === b && Number(event.id) > Number(latest.id)) ? event : latest
  }, null)
}
