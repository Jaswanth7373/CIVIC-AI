/**
 * Pure helpers shared by the officer pages (kept out of the .jsx files so those export components only, as
 * React Fast Refresh requires). Every rule here mirrors the backend so the UI never offers what the API
 * would refuse; the server stays the authority and its error message is shown when it disagrees.
 */
import { STATUS_GROUPS } from '@/utils/constants'
import { formatDate, toDate } from '@/utils/format'

export const OFFICER_BASE_PATH = '/officer/complaints'

/** Maximum length of remarks / explanations accepted by the API (TEXT_MAX in the serializers). */
export const REMARKS_MAX = 2000

/** Statuses of an officer's open work (assigned / accepted / in progress / reopened). */
export const OPEN_WORK_STATUSES = STATUS_GROUPS.open_assigned

/** `/officer/complaints?status=...` style links used by the dashboard tiles. */
export function complaintsLink(params = {}) {
  const search = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return
    search.set(key, Array.isArray(value) ? value.join(',') : String(value))
  })
  const query = search.toString()
  return query ? `${OFFICER_BASE_PATH}?${query}` : OFFICER_BASE_PATH
}

export function complaintPath(id, suffix = '') {
  return `${OFFICER_BASE_PATH}/${id}${suffix ? `/${suffix}` : ''}`
}

/**
 * Can `userId` accept this list row? The list endpoint has no `allowed_actions`, so this mirrors the
 * lifecycle rule (assigned / reopened -> accepted, by the assigned officer only).
 */
export function canAcceptRow(complaint, userId) {
  if (!complaint || userId == null) return false
  const officerId = complaint.assigned_officer?.id
  return ['assigned', 'reopened'].includes(complaint.status) && officerId != null && String(officerId) === String(userId)
}

/** Allowed action keys of a ComplaintDetail as a Set. */
export function allowedSet(complaint) {
  return new Set(Array.isArray(complaint?.allowed_actions) ? complaint.allowed_actions : [])
}

/** The lifecycle actions in the order that decides which one is the primary (next) action. */
const PRIMARY_ORDER = ['accept', 'start_work', 'resolve', 'verify', 'manual_verify']

/** Key of the complaint's primary action - the next step of its lifecycle - or null when there is none. */
export function primaryActionKey(complaint) {
  const allowed = allowedSet(complaint)
  return PRIMARY_ORDER.find((key) => allowed.has(key)) ?? null
}

/** Turn-by-turn navigation links to the complaint location (OpenStreetMap and Google Maps). */
export function directionsLinks(lat, lng) {
  const latitude = Number(lat)
  const longitude = Number(lng)
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
  return {
    osm: `https://www.openstreetmap.org/directions?route=;${latitude},${longitude}`,
    google: `https://www.google.com/maps/dir/?api=1&destination=${latitude},${longitude}`,
  }
}

/** The citizen's original photo (first `original` image, else any image, else the list thumbnail). */
export function citizenPhoto(complaint) {
  const images = Array.isArray(complaint?.images) ? complaint.images : []
  const original = images.find((image) => image?.kind === 'original' && image.url) ?? images.find((image) => image?.url)
  return original?.url ?? complaint?.thumbnail ?? null
}

const timeOf = (value) => toDate(value)?.getTime() ?? 0

/** Evidence rows, newest upload first. */
export function sortEvidence(evidence) {
  return (Array.isArray(evidence) ? evidence : [])
    .filter(Boolean)
    .slice()
    .sort((a, b) => timeOf(b.uploaded_at) - timeOf(a.uploaded_at) || (Number(b.id) || 0) - (Number(a.id) || 0))
}

/** Timestamp of the latest `reopened` timeline event (a new resolution cycle starts there), or 0. */
export function lastReopenedAt(complaint) {
  const events = Array.isArray(complaint?.timeline) ? complaint.timeline : []
  return events.reduce((latest, event) => (event?.event === 'reopened' ? Math.max(latest, timeOf(event.timestamp)) : latest), 0)
}

/** Evidence of the current resolution cycle (uploaded after the last reopen), newest first. */
export function cycleEvidence(complaint) {
  const since = lastReopenedAt(complaint)
  return sortEvidence(complaint?.evidence).filter((item) => timeOf(item.uploaded_at) > since)
}

/** Newest evidence of the current cycle that has an after photo - the one the AI verification judges. */
export function currentAfterEvidence(complaint) {
  return cycleEvidence(complaint).find((item) => item.after_image) ?? null
}

/**
 * Before photo for a comparison, with the same fallbacks as the backend: the evidence's own before photo,
 * else the latest uploaded before photo, else the citizen's original photo.
 * Returns `{url, source: 'evidence' | 'uploaded' | 'citizen'}` or null.
 */
export function beforePhotoFor(complaint, evidence) {
  if (evidence?.before_image) return { url: evidence.before_image, source: 'evidence' }
  const uploaded = sortEvidence(complaint?.evidence).find((item) => item.before_image)
  if (uploaded) return { url: uploaded.before_image, source: 'uploaded' }
  const photo = citizenPhoto(complaint)
  return photo ? { url: photo, source: 'citizen' } : null
}

/** The evidence a verification judged (by `evidence_id`), else the current after evidence. */
export function evidenceForVerification(complaint, verification) {
  const rows = sortEvidence(complaint?.evidence)
  if (verification?.evidence_id != null) {
    const match = rows.find((item) => String(item.id) === String(verification.evidence_id))
    if (match) return match
  }
  return currentAfterEvidence(complaint) ?? rows.find((item) => item.after_image) ?? null
}

/** Verifications, newest first. */
export function sortVerifications(verifications) {
  return (Array.isArray(verifications) ? verifications : [])
    .filter(Boolean)
    .slice()
    .sort((a, b) => timeOf(b.verified_at) - timeOf(a.verified_at) || (Number(b.id) || 0) - (Number(a.id) || 0))
}

/** The newest timeline event of a kind (e.g. the rejection with its reason). */
export function latestEvent(complaint, eventKey) {
  const events = Array.isArray(complaint?.timeline) ? complaint.timeline : []
  return events.filter((event) => event?.event === eventKey).sort((a, b) => timeOf(b.timestamp) - timeOf(a.timestamp))[0] ?? null
}

/** "15 Oct" for dates in the current year, "15 Oct 2025" otherwise (dense tables). */
export function shortDate(value) {
  const date = toDate(value)
  if (!date) return formatDate(value)
  return formatDate(date, date.getFullYear() === new Date().getFullYear() ? 'd MMM' : 'd MMM yyyy')
}

/** True when `userId` is the complaint's assigned officer. */
export function isAssignedTo(complaint, userId) {
  const officerId = complaint?.assigned_officer?.id
  return officerId != null && userId != null && String(officerId) === String(userId)
}

/**
 * What the officer should do next with this complaint: `{key, text}`. The key picks the icon; the text is
 * the plain-language instruction shown next to the action buttons.
 */
export function nextStep(complaint, userId) {
  const allowed = allowedSet(complaint)
  const status = complaint?.status
  if (status === 'closed') return { key: 'done', text: 'Closed after citizen feedback. No further action is needed.' }
  if (status === 'rejected') return { key: 'stopped', text: 'Rejected. The citizen was told the reason; no further action is needed.' }
  if (!isAssignedTo(complaint, userId)) {
    const officer = complaint?.assigned_officer?.full_name
    return {
      key: 'watch',
      text: officer
        ? `Assigned to ${officer}. As an officer of the department you can follow it and add remarks.`
        : 'Not assigned to an officer yet. As an officer of the department you can follow it and add remarks.',
    }
  }
  if (allowed.has('accept')) {
    return {
      key: 'accept',
      text:
        status === 'reopened'
          ? 'The citizen reopened this complaint. Accept it to restart the work, or reject it with a reason.'
          : 'Accept the work order to confirm you will handle it, or reject it with a reason.',
    }
  }
  if (allowed.has('start_work')) {
    return { key: 'start', text: 'Start work when the crew reaches the site. You can also upload evidence and resolve directly.' }
  }
  if (allowed.has('resolve')) {
    return {
      key: 'resolve',
      text: 'When the work is done, upload an after photo and mark the complaint as resolved. The AI then checks it.',
    }
  }
  if (status === 'resolved') {
    if (complaint.needs_manual_review) {
      return {
        key: 'review',
        text: 'The verification needs a person: compare the photos and verify manually, or upload a clearer after photo.',
      }
    }
    if (allowed.has('verify')) return { key: 'verify', text: 'Run the AI verification on the after photo, or verify the work manually.' }
    return { key: 'evidence', text: 'Upload an after photo so the AI can verify the work, or verify it manually.' }
  }
  if (status === 'verified') return { key: 'done', text: 'Verified. The citizen has been asked to rate the resolution.' }
  return { key: 'wait', text: 'The AI routing is still running. The complaint appears in your queue once it is assigned.' }
}

/** A finite coordinate from the API, else null (null, undefined and '' mean "unknown", never 0). */
function coordinateOf(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

/**
 * Where a complaint is, for the officer list and its cards: `{primary, secondary, full, gps}` or null.
 * - A named place: the area (else the city, else the street address), then the landmark.
 * - A complaint reported with only its GPS pin (no address could be looked up): the latitude, then the
 *   longitude ("17.4368° N", "78.4476° E"; 4 decimals, about 11 m), so the crew can still find the place.
 * `full` is the longest description, for a tooltip.
 */
export function locationSummary(location) {
  if (!location) return null
  const named = location.area || location.city || location.address
  if (named) {
    return {
      primary: named,
      secondary: location.landmark || '',
      full: [location.address, location.landmark].filter(Boolean).join(', ') || named,
      gps: false,
    }
  }
  const lat = coordinateOf(location.latitude)
  const lng = coordinateOf(location.longitude)
  if (lat === null || lng === null) return null
  return {
    primary: `${Math.abs(lat).toFixed(4)}° ${lat < 0 ? 'S' : 'N'}`,
    secondary: `${Math.abs(lng).toFixed(4)}° ${lng < 0 ? 'W' : 'E'}`,
    full: [`GPS ${lat.toFixed(6)}, ${lng.toFixed(6)}`, location.landmark].filter(Boolean).join(', '),
    gps: true,
  }
}

/** "Ameerpet Main Road, near Ameerpet Metro Station" style one-line place for headers and cards. */
export function placeLine(location) {
  if (!location) return ''
  const parts = [location.address, location.area, location.city].filter(Boolean)
  const unique = parts.filter((part, index) => !parts.slice(0, index).some((earlier) => earlier.includes(part)))
  return unique.join(', ')
}
