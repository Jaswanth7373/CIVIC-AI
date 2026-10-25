/**
 * Report-an-issue form model (pure functions, no React): the four wizard steps, the empty form, per-step
 * validation that mirrors the API's rules (POST /api/complaints/), the mapping from API field errors back to
 * the step that owns the field, and the multipart body.
 *
 * API rules mirrored here (apps/complaints/serializers.ComplaintCreateSerializer): description 10-2000
 * characters (required), title <= 160, latitude / longitude required, address <= 255, landmark <= 150,
 * area <= 120, city <= 100, pincode <= 10, incident_at not in the future, category = id or slug of an active
 * category (optional, the citizen's hint), image optional (validated again on the server).
 */
import { format, isValid, parse } from 'date-fns'

export const DESCRIPTION_MIN = 10
export const DESCRIPTION_MAX = 2000
export const TITLE_MAX = 160
/** The live AI suggestion starts once there is a photo and/or this many characters of description. */
export const SUGGEST_MIN_CHARS = 15

export const ADDRESS_FIELDS = Object.freeze([
  { key: 'address', label: 'Street address', maxLength: 255, autoComplete: 'street-address' },
  { key: 'landmark', label: 'Nearby landmark', maxLength: 150, autoComplete: 'off' },
  { key: 'area', label: 'Area / locality', maxLength: 120, autoComplete: 'address-level3' },
  { key: 'city', label: 'City', maxLength: 100, autoComplete: 'address-level2' },
  { key: 'pincode', label: 'PIN code', maxLength: 10, autoComplete: 'postal-code' },
])

export const REPORT_STEPS = Object.freeze([
  {
    key: 'photo',
    label: 'Photo',
    title: 'Add a photo of the problem',
    description: 'A clear photo lets the AI identify the issue and helps the officer find it on site.',
  },
  {
    key: 'details',
    label: 'Details',
    title: 'Describe what is wrong',
    description: 'A few sentences are enough. Say what you see and why it is a problem.',
  },
  {
    key: 'location',
    label: 'Location',
    title: 'Mark where it is',
    description: 'Drop the pin on the exact spot. The address is filled in from the map.',
  },
  {
    key: 'review',
    label: 'Review',
    title: 'Check and submit',
    description: 'Make sure everything is right. The AI analyses the report as soon as you submit.',
  },
])

export const STEP_INDEX = Object.freeze({ photo: 0, details: 1, location: 2, review: 3 })

/** Which wizard step owns each API field, so server errors send the citizen to the right place. */
const FIELD_STEP = {
  image: STEP_INDEX.photo,
  description: STEP_INDEX.details,
  title: STEP_INDEX.details,
  category: STEP_INDEX.details,
  incident_at: STEP_INDEX.details,
  latitude: STEP_INDEX.location,
  longitude: STEP_INDEX.location,
  address: STEP_INDEX.location,
  landmark: STEP_INDEX.location,
  area: STEP_INDEX.location,
  city: STEP_INDEX.location,
  pincode: STEP_INDEX.location,
}

const INPUT_PATTERN = "yyyy-MM-dd'T'HH:mm"

/** `<input type="datetime-local">` value for a Date (local time, minute precision). */
export function toLocalInputValue(date = new Date()) {
  return format(date, INPUT_PATTERN)
}

/** Parse a datetime-local value (local time) into a Date, or null. */
export function parseLocalInputValue(value) {
  if (!value) return null
  const date = parse(value, INPUT_PATTERN, new Date())
  return isValid(date) ? date : null
}

export function emptyAddress() {
  return { address: '', landmark: '', area: '', city: '', pincode: '' }
}

export function initialReport(now = new Date()) {
  return {
    image: null,
    description: '',
    title: '',
    category: '',
    incidentAt: toLocalInputValue(now),
    position: null,
    address: emptyAddress(),
  }
}

/** True once the citizen entered anything worth warning about when they try to leave. */
export function hasUserInput(form) {
  return Boolean(
    form.image ||
      form.description.trim() ||
      form.title.trim() ||
      form.category ||
      form.position ||
      Object.values(form.address).some((value) => String(value).trim()),
  )
}

/** Field errors of one step (`{field: message}`); an empty object means the step is complete. */
export function validateStep(stepIndex, form, now = new Date()) {
  const errors = {}
  if (stepIndex === STEP_INDEX.details) {
    const description = form.description.trim()
    if (!description) errors.description = 'Describe the problem in a few words.'
    else if (description.length < DESCRIPTION_MIN) {
      errors.description = `Add a little more detail: at least ${DESCRIPTION_MIN} characters (${description.length} so far).`
    } else if (description.length > DESCRIPTION_MAX) {
      errors.description = `Keep the description under ${DESCRIPTION_MAX} characters.`
    }
    if (form.title.trim().length > TITLE_MAX) errors.title = `Keep the title under ${TITLE_MAX} characters.`
    const incident = parseLocalInputValue(form.incidentAt)
    if (!incident) errors.incident_at = 'Enter the date and time you noticed the problem.'
    else if (incident.getTime() > now.getTime() + 60_000) errors.incident_at = 'The time cannot be in the future.'
  }
  if (stepIndex === STEP_INDEX.location) {
    if (!form.position) errors.latitude = 'Place the pin on the map, search for a place or use your location.'
    ADDRESS_FIELDS.forEach((field) => {
      if (String(form.address[field.key] ?? '').trim().length > field.maxLength) {
        errors[field.key] = `Keep this under ${field.maxLength} characters.`
      }
    })
  }
  return errors
}

/** Errors of every step up to (excluding) `stepIndex`, plus the first step that has one (or -1). */
export function validateUntil(stepIndex, form, now = new Date()) {
  for (let index = 0; index < stepIndex; index += 1) {
    const errors = validateStep(index, form, now)
    if (Object.keys(errors).length) return { step: index, errors }
  }
  return { step: -1, errors: {} }
}

/** Lowest step index that owns one of the given field errors (unknown fields -> the review step). */
export function stepForErrors(fieldErrors) {
  const steps = Object.keys(fieldErrors ?? {}).map((field) => FIELD_STEP[field] ?? STEP_INDEX.review)
  return steps.length ? Math.min(...steps) : STEP_INDEX.review
}

/** Multipart body for POST /api/complaints/ (empty optional fields are left out). */
export function buildComplaintFormData(form) {
  const data = new FormData()
  data.append('description', form.description.trim())
  if (form.image) data.append('image', form.image, form.image.name || 'photo.jpg')
  if (form.position) {
    data.append('latitude', String(form.position.lat))
    data.append('longitude', String(form.position.lng))
  }
  ADDRESS_FIELDS.forEach(({ key }) => {
    const value = String(form.address[key] ?? '').trim()
    if (value) data.append(key, value)
  })
  if (form.category) data.append('category', form.category)
  if (form.title.trim()) data.append('title', form.title.trim())
  const incident = parseLocalInputValue(form.incidentAt)
  if (incident) data.append('incident_at', incident.toISOString())
  return data
}

/** Stable identity of a File for dependency keys (name, size, last modified). */
export function fileKey(file) {
  return file ? `${file.name}:${file.size}:${file.lastModified}` : ''
}

/** `accept` attribute for the photo input, from the server's allowed extensions (/system/config/). */
export function acceptFromExtensions(extensions) {
  const types = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    heic: 'image/heic',
    heif: 'image/heif',
  }
  const list = (Array.isArray(extensions) ? extensions : [])
    .map((extension) => types[String(extension).toLowerCase().replace(/^\./, '')])
    .filter(Boolean)
  return list.length ? [...new Set(list)].join(',') : 'image/jpeg,image/png,image/webp'
}
