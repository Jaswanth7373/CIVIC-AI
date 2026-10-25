/**
 * AI configuration form schema: every editable AIConfiguration field with its label, unit, range and help,
 * plus the cross-field rules the API enforces (apps/core/serializers.AIConfigurationSerializer), checked
 * in the browser first so mistakes show up while typing.
 *
 * Ranges mirror AI_CONFIG_LIMITS on the server. Units: priority weights are points of the 0-100 score (they
 * must add up to 100), fusion / duplicate weights and confidences are fractions 0-1, distances metres.
 */

/** The five priority factors; `short` labels the factor's segment of the weights bar when space is tight. */
export const WEIGHT_FIELDS = Object.freeze([
  { key: 'weight_severity', label: 'Severity', short: 'Severity', hint: 'How bad the issue looks (photo, text, category).' },
  { key: 'weight_public_impact', label: 'Public impact', short: 'Impact', hint: 'Danger to people, traffic, health, services.' },
  { key: 'weight_location_risk', label: 'Location risk', short: 'Location', hint: 'Schools, hospitals, junctions and busy roads nearby.' },
  { key: 'weight_frequency', label: 'Frequency', short: 'Frequency', hint: 'Other complaints of the same kind nearby.' },
  { key: 'weight_duplicates', label: 'Duplicates', short: 'Duplicates', hint: 'How many citizens reported the same issue.' },
])

export const THRESHOLD_FIELDS = Object.freeze([
  { key: 'threshold_medium', label: 'Medium from', min: 1, max: 100, step: 1, unit: 'points' },
  { key: 'threshold_high', label: 'High from', min: 1, max: 100, step: 1, unit: 'points' },
  { key: 'threshold_critical', label: 'Critical from', min: 1, max: 100, step: 1, unit: 'points' },
])

/** Number sections below the priority weights. `kind: 'boolean'` fields render as switches. */
export const CONFIG_SECTIONS = Object.freeze([
  {
    id: 'fusion',
    title: 'Multimodal fusion',
    description: 'How the photo and the description are combined into one category decision.',
    fields: [
      { key: 'image_modality_weight', label: 'Photo weight', min: 0, max: 1, step: 0.05, decimals: 2, hint: 'Base weight of the image model (reduced for blurry or dark photos).' },
      { key: 'text_modality_weight', label: 'Description weight', min: 0, max: 1, step: 0.05, decimals: 2, hint: 'Base weight of the text classifier.' },
      { key: 'min_category_confidence', label: 'Minimum confidence', min: 0, max: 1, step: 0.05, decimals: 2, hint: 'Below this fused confidence a complaint is flagged for manual review.' },
    ],
  },
  {
    id: 'duplicates',
    title: 'Duplicate detection',
    description: 'When two reports count as the same issue.',
    fields: [
      { key: 'duplicate_threshold', label: 'Match threshold', min: 0.1, max: 1, step: 0.01, decimals: 2, hint: 'Overall similarity from which a pair is flagged.' },
      { key: 'duplicate_radius_m', label: 'Search radius', min: 10, max: 5000, step: 10, unit: 'm', hint: 'Only reports this close are compared.' },
      { key: 'duplicate_window_days', label: 'Time window', min: 1, max: 365, step: 1, unit: 'days', hint: 'Only reports this recent are compared.' },
      { key: 'duplicate_text_weight', label: 'Description similarity weight', min: 0, max: 1, step: 0.05, decimals: 2 },
      { key: 'duplicate_image_weight', label: 'Photo similarity weight', min: 0, max: 1, step: 0.05, decimals: 2 },
      { key: 'duplicate_location_weight', label: 'Location similarity weight', min: 0, max: 1, step: 0.05, decimals: 2 },
    ],
  },
  {
    id: 'hotspots',
    title: 'Hotspots (DBSCAN)',
    description: 'How dense a cluster of complaints must be to count as a hotspot.',
    fields: [
      { key: 'hotspot_eps_m', label: 'Neighbourhood radius (eps)', min: 50, max: 5000, step: 10, unit: 'm', hint: 'Complaints closer than this are neighbours.' },
      { key: 'hotspot_min_samples', label: 'Minimum complaints', min: 2, max: 100, step: 1, unit: 'complaints', hint: 'Neighbours needed to start a cluster.' },
      { key: 'hotspot_alert_threshold', label: 'Alert from', min: 2, max: 1000, step: 1, unit: 'complaints', hint: 'Cluster size that raises a hotspot alert.' },
    ],
  },
  {
    id: 'verification',
    title: 'Resolution verification',
    description: 'Before / after photo scores that decide the verification status.',
    fields: [
      { key: 'verification_resolved_threshold', label: 'Likely resolved from', min: 1, max: 100, step: 1, unit: 'points' },
      { key: 'verification_partial_threshold', label: 'Partially resolved from', min: 1, max: 100, step: 1, unit: 'points', hint: 'Must be lower than the resolved threshold.' },
    ],
  },
  {
    id: 'automation',
    title: 'Automation and alerts',
    description: 'What the platform does without waiting for a person.',
    fields: [
      { key: 'auto_assign_officer', label: 'Assign officers automatically', kind: 'boolean', hint: 'New complaints go to the top recommended officer.' },
      { key: 'auto_verify_resolution', label: 'Verify resolutions automatically', kind: 'boolean', hint: 'A "likely resolved" AI result marks the complaint verified.' },
      { key: 'nearby_radius_m', label: 'Nearby radius', min: 50, max: 10000, step: 50, unit: 'm', hint: 'Radius for the nearby-complaint frequency factor.' },
      { key: 'frequency_window_days', label: 'Frequency window', min: 1, max: 365, step: 1, unit: 'days' },
      { key: 'sla_alert_hours', label: 'High-priority alert after', min: 1, max: 720, step: 1, unit: 'hours', hint: 'Admins are alerted when a high or critical complaint stays open this long.' },
    ],
  },
])

export const NUMBER_FIELDS = Object.freeze([
  ...WEIGHT_FIELDS.map((field) => ({ ...field, min: 0, max: 100, step: 0.5 })),
  ...THRESHOLD_FIELDS,
  ...CONFIG_SECTIONS.flatMap((section) => section.fields.filter((field) => field.kind !== 'boolean')),
])

export const BOOLEAN_FIELDS = Object.freeze(CONFIG_SECTIONS.flatMap((section) => section.fields.filter((field) => field.kind === 'boolean')))

export const EDITABLE_KEYS = Object.freeze([...NUMBER_FIELDS.map((field) => field.key), ...BOOLEAN_FIELDS.map((field) => field.key)])

/** Form state (numbers as strings so a half-typed value is allowed) from the API config. */
export function toFormValues(config) {
  const values = {}
  NUMBER_FIELDS.forEach((field) => {
    values[field.key] = config?.[field.key] == null ? '' : String(config[field.key])
  })
  BOOLEAN_FIELDS.forEach((field) => {
    values[field.key] = Boolean(config?.[field.key])
  })
  return values
}

/** API payload from the form state (numbers parsed). */
export function toPayload(values) {
  const payload = {}
  NUMBER_FIELDS.forEach((field) => {
    payload[field.key] = Number(values[field.key])
  })
  BOOLEAN_FIELDS.forEach((field) => {
    payload[field.key] = Boolean(values[field.key])
  })
  return payload
}

export function weightTotal(values) {
  return WEIGHT_FIELDS.reduce((sum, field) => sum + (Number(values[field.key]) || 0), 0)
}

/** Field messages for the current values (empty object = valid). */
export function validateConfig(values) {
  const errors = {}
  NUMBER_FIELDS.forEach((field) => {
    const raw = values[field.key]
    const number = Number(raw)
    if (raw === '' || !Number.isFinite(number)) errors[field.key] = 'Enter a number.'
    else if (number < field.min || number > field.max) errors[field.key] = `Use a value from ${field.min} to ${field.max}.`
    else if (field.step === 1 && !Number.isInteger(number)) errors[field.key] = 'Use a whole number.'
  })
  const total = weightTotal(values)
  if (Math.abs(total - 100) > 0.01) errors.weights = `The five weights must add up to 100; they add up to ${Math.round(total * 100) / 100} now.`

  const medium = Number(values.threshold_medium)
  const high = Number(values.threshold_high)
  const critical = Number(values.threshold_critical)
  if (!errors.threshold_medium && !errors.threshold_high && !errors.threshold_critical && !(medium < high && high < critical && critical <= 100)) {
    errors.thresholds = 'Thresholds must rise: medium < high < critical (at most 100).'
  }
  if (Number(values.image_modality_weight) + Number(values.text_modality_weight) <= 0) {
    errors.image_modality_weight = 'The photo and description weights cannot both be 0.'
  }
  if (Number(values.duplicate_text_weight) + Number(values.duplicate_image_weight) + Number(values.duplicate_location_weight) <= 0) {
    errors.duplicate_text_weight = 'At least one similarity weight must be above 0.'
  }
  if (!errors.verification_partial_threshold && Number(values.verification_partial_threshold) >= Number(values.verification_resolved_threshold)) {
    errors.verification_partial_threshold = 'Must be lower than the resolved threshold.'
  }
  return errors
}

/** Keys whose value differs from the saved configuration. */
export function changedKeys(values, saved) {
  return EDITABLE_KEYS.filter((key) => {
    const field = NUMBER_FIELDS.find((item) => item.key === key)
    if (field) return Number(values[key]) !== Number(saved?.[key])
    return Boolean(values[key]) !== Boolean(saved?.[key])
  })
}
