/**
 * Copy and worked examples of the landing page sections.
 *
 * LIFECYCLE_STOPS is the complaint lifecycle from the project requirements (section 1), one stop per real
 * step of the platform, in order.
 *
 * The worked examples are not statistics: they are fixed inputs run through the real CivicAI engines once
 * (demo mode) so a visitor can see what each engine produces. They are labelled as examples on the page.
 * - PRIORITY_EXAMPLE: ai.priority.PriorityEngine with severity 87.5, public impact 1.0, location risk 0.8,
 *   4 same-category complaints nearby and 3 linked duplicates -> 87/100 Critical (the spec's example).
 * - DUPLICATE_EXAMPLE: ai.duplicate.find_duplicates on the two reports below, 40 m apart, photos
 *   public/samples/pothole.jpg and public/samples/pothole-reshot.jpg (the same scene photographed again).
 * - FEEDBACK_EXAMPLES: ai.nlp.sentiment.analyze_sentiment on the two feedback texts with their ratings.
 */
export const LIFECYCLE_STOPS = Object.freeze([
  { title: 'Citizen report', detail: 'Someone spots a problem and reports it from a phone or a browser.' },
  { title: 'Image + text + GPS', detail: 'A photo, a short description and the map location travel together.' },
  { title: 'Preprocessing', detail: 'Photos are straightened and checked for blur; text is cleaned and normalised.' },
  { title: 'Multimodal AI', detail: 'A vision model reads the photo while a language model reads the description.' },
  { title: 'Classification', detail: 'Late fusion of both models decides the civic category and its confidence.' },
  { title: 'Severity', detail: 'Visible damage, safety risk and likely impact give a severity from 0 to 100.' },
  { title: 'Priority', detail: 'Five weighted factors give a priority from 0 to 100, with the reason in plain words.' },
  { title: 'Duplicate detection', detail: 'Similar reports nearby are linked instead of piling up.' },
  { title: 'Department routing', detail: 'The category decides which department receives the work.' },
  { title: 'Officer assignment', detail: 'The best-placed field officer is recommended and assigned.' },
  { title: 'Resolution', detail: 'The officer accepts the job, works on it and uploads an after photo.' },
  { title: 'Before/after verification', detail: 'AI compares the before and after photos of the same spot.' },
  { title: 'Citizen feedback', detail: 'The citizen rates the fix and can reopen it if it did not hold.' },
  { title: 'Sentiment analysis', detail: 'Feedback text is scored positive, neutral or negative.' },
  { title: 'Analytics', detail: 'Live dashboards and hotspot maps show where the city needs attention.' },
])

/** Priority engine output for the worked example (component points out of their weights). */
export const PRIORITY_EXAMPLE = Object.freeze({
  title: 'Open manhole outside a school gate',
  finalScore: 87,
  level: 'critical',
  explanation: 'Critical priority because the issue has critical severity, significant public impact and a high-risk location.',
  components: Object.freeze([
    { key: 'severity', label: 'Severity', score: 35, max: 40, input: 'Severity score 87.5 of 100' },
    { key: 'public_impact', label: 'Public impact', score: 25, max: 25, input: 'Safety risk near a school' },
    { key: 'location_risk', label: 'Location risk', score: 12, max: 15, input: 'High-risk location (0.8)' },
    { key: 'frequency', label: 'Frequency', score: 8, max: 10, input: '4 similar complaints nearby' },
    { key: 'duplicates', label: 'Duplicates', score: 7, max: 10, input: '3 linked duplicate reports' },
  ]),
})

/** Duplicate engine output for the worked example. */
export const DUPLICATE_EXAMPLE = Object.freeze({
  original: {
    text: 'Large pothole near school.',
    photo: '/samples/pothole.jpg',
    label: 'Earlier report',
  },
  incoming: {
    text: 'Big road pothole outside school.',
    photo: '/samples/pothole-reshot.jpg',
    label: 'New report',
  },
  distanceM: 40,
  signals: Object.freeze([
    { key: 'text', label: 'Description similarity', value: 0.8575, weight: 0.4 },
    { key: 'image', label: 'Photo similarity', value: 0.5548, weight: 0.3 },
    { key: 'location', label: 'Location similarity', value: 0.9646, weight: 0.3 },
  ]),
  overall: 0.7988,
  threshold: 0.72,
  radiusM: 300,
  explanation: 'Text 86% similar, images 55% similar, 40 m apart, same category',
})

/** Sentiment engine output for the worked examples (demo lexicon model). */
export const FEEDBACK_EXAMPLES = Object.freeze([
  {
    id: 'positive',
    rating: 5,
    text: 'The pothole was fixed within two days. Resolved quickly, thank you!',
    sentiment: 'positive',
    score: 0.8614,
    phrases: ['resolved quickly', 'thank you', 'fixed'],
  },
  {
    id: 'negative',
    rating: 2,
    text: 'Still not fixed. The patch broke again after one rain, waste of time.',
    sentiment: 'negative',
    score: -0.8165,
    phrases: ['still not fixed', 'waste of time', 'broke again'],
  },
])
