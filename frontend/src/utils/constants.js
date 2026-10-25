/**
 * Domain constants shared by every screen.
 *
 * "Colour = meaning" (BUILD_SPEC 5.2): every status, level, sentiment and event gets ONE tone, icon and
 * chart colour here, so badges, timelines, maps and charts stay consistent. Values mirror the Django model
 * choices (backend/apps/<app>/models.py); labels are sentence case for the UI.
 *
 * `tone` is a Badge tone (neutral | green | yellow | orange | red | blue | violet | teal | magenta | slate).
 * `color` is a hex colour for charts and map markers (Recharts / Leaflet cannot use Tailwind classes).
 */
import {
  Archive,
  Ban,
  BellRing,
  Building2,
  CircleCheck,
  CircleDashed,
  CircleX,
  ClipboardCheck,
  ClipboardList,
  Clock,
  Construction,
  Copy,
  CopyCheck,
  CopyX,
  Flame,
  Frown,
  Gauge,
  Hourglass,
  ImageUp,
  Info,
  Meh,
  MessageSquare,
  MessageSquareText,
  Monitor,
  Moon,
  RefreshCcw,
  RefreshCw,
  RotateCcw,
  ScanEye,
  ScanSearch,
  Send,
  ShieldCheck,
  ShieldX,
  Shuffle,
  Siren,
  SlidersHorizontal,
  Smile,
  Star,
  Sun,
  UserCheck,
  UserSearch,
} from 'lucide-react'
import { LevelHighIcon, LevelLowIcon, LevelMediumIcon } from './levelIcons'

export const APP_NAME = 'CivicAI'
export const APP_TAGLINE = 'AI-Powered Civic Issue Management'
export const DEFAULT_DOCUMENT_TITLE = `${APP_NAME} - ${APP_TAGLINE}`

/** Shown by DemoModeBadge. Describes what the demo engine actually does (BUILD_SPEC 2.1 / 2.2). */
export const DEMO_MODE_DESCRIPTION =
  'Demo AI Mode: the AI engine is using its lightweight demo techniques - OpenCV image heuristics and ' +
  'TF-IDF text models trained on the bundled complaint corpus - instead of trained deep-learning weights. ' +
  'Every result is still computed from the real photo, description and location, and is labelled as demo.'

/* ----------------------------------------------------------------------------------------------------------
 * Roles
 * -------------------------------------------------------------------------------------------------------- */
export const ROLES = Object.freeze({ CITIZEN: 'citizen', OFFICER: 'officer', ADMIN: 'admin' })

export const ROLE_LABELS = Object.freeze({
  citizen: 'Citizen',
  officer: 'Officer',
  admin: 'Administrator',
})

/** Landing page of each role after login. */
export const ROLE_HOME = Object.freeze({
  citizen: '/citizen/dashboard',
  officer: '/officer/dashboard',
  admin: '/admin/dashboard',
})

export const ROLE_OPTIONS = Object.freeze(
  Object.entries(ROLE_LABELS).map(([value, label]) => ({ value, label })),
)

/* ----------------------------------------------------------------------------------------------------------
 * Complaint status (Complaint.Status)
 * -------------------------------------------------------------------------------------------------------- */
export const STATUS_META = Object.freeze({
  submitted: {
    value: 'submitted',
    label: 'Submitted',
    tone: 'slate',
    color: '#64748B',
    icon: Send,
    description: 'Received and waiting for AI analysis.',
  },
  analyzed: {
    value: 'analyzed',
    label: 'AI analyzed',
    tone: 'violet',
    color: '#7C3AED',
    icon: ScanSearch,
    description: 'The AI engine classified the issue and scored its severity and priority.',
  },
  assigned: {
    value: 'assigned',
    label: 'Assigned',
    tone: 'blue',
    color: '#1F5FAD',
    icon: UserCheck,
    description: 'An officer from the responsible department has been assigned.',
  },
  accepted: {
    value: 'accepted',
    label: 'Accepted',
    tone: 'teal',
    color: '#0D9488',
    icon: ClipboardCheck,
    description: 'The officer accepted the complaint and is planning the work.',
  },
  in_progress: {
    value: 'in_progress',
    label: 'In progress',
    tone: 'yellow',
    color: '#F5B700',
    icon: Construction,
    description: 'Work zone: field work on the issue is under way.',
  },
  resolved: {
    value: 'resolved',
    label: 'Resolved',
    tone: 'green',
    color: '#35A17B',
    icon: CircleCheck,
    description: 'The officer marked the issue resolved and uploaded evidence.',
  },
  verified: {
    value: 'verified',
    label: 'Verified',
    tone: 'green',
    variant: 'solid',
    color: '#095A41',
    icon: ShieldCheck,
    description: 'The resolution was verified against the before and after photos.',
  },
  closed: {
    value: 'closed',
    label: 'Closed',
    tone: 'neutral',
    color: '#8C9A96',
    icon: Archive,
    description: 'The complaint is closed after verification and citizen feedback.',
  },
  rejected: {
    value: 'rejected',
    label: 'Rejected',
    tone: 'red',
    color: '#D3341F',
    icon: Ban,
    description: 'The officer could not act on this complaint. The remarks explain why.',
  },
  reopened: {
    value: 'reopened',
    label: 'Reopened',
    tone: 'magenta',
    color: '#C026D3',
    icon: RotateCcw,
    description: 'The citizen reported that the issue is not fixed, so work starts again.',
  },
})

export const STATUS_ORDER = Object.freeze([
  'submitted',
  'analyzed',
  'assigned',
  'accepted',
  'in_progress',
  'resolved',
  'verified',
  'closed',
  'rejected',
  'reopened',
])

export const STATUS_OPTIONS = Object.freeze(
  STATUS_ORDER.map((value) => ({ value, label: STATUS_META[value].label })),
)

/** Status groups, identical to Complaint.PENDING_STATUSES etc. on the backend. */
export const STATUS_GROUPS = Object.freeze({
  pending: ['submitted', 'analyzed', 'assigned', 'reopened'],
  in_progress: ['accepted', 'in_progress'],
  resolved: ['resolved', 'verified', 'closed'],
  open: ['submitted', 'analyzed', 'assigned', 'reopened', 'accepted', 'in_progress'],
  open_assigned: ['assigned', 'accepted', 'in_progress', 'reopened'],
})

/* ----------------------------------------------------------------------------------------------------------
 * Severity / priority levels (Level)
 * -------------------------------------------------------------------------------------------------------- */
export const LEVEL_META = Object.freeze({
  low: {
    value: 'low',
    label: 'Low',
    tone: 'green',
    color: '#35A17B',
    icon: LevelLowIcon,
    min: 0,
    max: 25,
    description: 'Minor issue with little public impact.',
  },
  medium: {
    value: 'medium',
    label: 'Medium',
    tone: 'yellow',
    color: '#F5B700',
    icon: LevelMediumIcon,
    min: 26,
    max: 50,
    description: 'Needs attention within the normal service window.',
  },
  high: {
    value: 'high',
    label: 'High',
    tone: 'orange',
    color: '#E8730C',
    icon: LevelHighIcon,
    min: 51,
    max: 75,
    description: 'Significant impact or risk; schedule work soon.',
  },
  critical: {
    value: 'critical',
    label: 'Critical',
    tone: 'red',
    color: '#D3341F',
    icon: Siren,
    min: 76,
    max: 100,
    description: 'Immediate risk to public safety; act first.',
  },
})

export const LEVEL_ORDER = Object.freeze(['low', 'medium', 'high', 'critical'])

export const LEVEL_OPTIONS = Object.freeze(
  LEVEL_ORDER.map((value) => ({ value, label: LEVEL_META[value].label })),
)

/** Default score thresholds (AIConfiguration): score >= threshold -> level. */
export const DEFAULT_LEVEL_THRESHOLDS = Object.freeze({ medium: 26, high: 51, critical: 76 })

/** Map a 0-100 score to a level key using the (configurable) thresholds. */
export function scoreToLevel(score, thresholds = DEFAULT_LEVEL_THRESHOLDS) {
  const value = Number(score) || 0
  if (value >= thresholds.critical) return 'critical'
  if (value >= thresholds.high) return 'high'
  if (value >= thresholds.medium) return 'medium'
  return 'low'
}

/* ----------------------------------------------------------------------------------------------------------
 * Feedback sentiment (Feedback.Sentiment) and ratings
 * -------------------------------------------------------------------------------------------------------- */
export const SENTIMENT_META = Object.freeze({
  positive: { value: 'positive', label: 'Positive', tone: 'green', color: '#12845F', icon: Smile },
  neutral: { value: 'neutral', label: 'Neutral', tone: 'neutral', color: '#8C9A96', icon: Meh },
  negative: { value: 'negative', label: 'Negative', tone: 'red', color: '#D3341F', icon: Frown },
})

export const SENTIMENT_OPTIONS = Object.freeze(
  Object.values(SENTIMENT_META).map(({ value, label }) => ({ value, label })),
)

export const RATING_LABELS = Object.freeze({
  1: 'Very poor',
  2: 'Poor',
  3: 'Okay',
  4: 'Good',
  5: 'Excellent',
})

/* ----------------------------------------------------------------------------------------------------------
 * Resolution verification (ResolutionVerification.Status / Method)
 * -------------------------------------------------------------------------------------------------------- */
export const VERIFICATION_META = Object.freeze({
  likely_resolved: {
    value: 'likely_resolved',
    label: 'Likely resolved',
    tone: 'green',
    color: '#35A17B',
    icon: ShieldCheck,
    description: 'The after photo shows strong change where the issue was detected.',
  },
  partially_resolved: {
    value: 'partially_resolved',
    label: 'Partially resolved',
    tone: 'yellow',
    color: '#F5B700',
    icon: CircleDashed,
    description: 'Some change is visible, but part of the issue may remain.',
  },
  not_resolved: {
    value: 'not_resolved',
    label: 'Not resolved',
    tone: 'red',
    color: '#D3341F',
    icon: ShieldX,
    description: 'Little change between the photos, or the issue is still detected.',
  },
  needs_manual_review: {
    value: 'needs_manual_review',
    label: 'Needs manual review',
    tone: 'blue',
    color: '#1F5FAD',
    icon: UserSearch,
    description: 'The photos could not be compared reliably, so a person should check.',
  },
})

export const VERIFICATION_OPTIONS = Object.freeze(
  Object.values(VERIFICATION_META).map(({ value, label }) => ({ value, label })),
)

export const VERIFICATION_METHOD_LABELS = Object.freeze({
  ai_assisted: 'AI-assisted',
  manual: 'Manual',
})

export const VERIFICATION_DISCLAIMER =
  'AI-assisted verification - not a guarantee. An officer or administrator can override the result.'

/* ----------------------------------------------------------------------------------------------------------
 * Duplicate review (DuplicateComplaint.Status)
 * -------------------------------------------------------------------------------------------------------- */
export const DUPLICATE_STATUS_META = Object.freeze({
  pending_review: { value: 'pending_review', label: 'Pending review', tone: 'yellow', icon: Clock },
  confirmed_duplicate: {
    value: 'confirmed_duplicate',
    label: 'Confirmed duplicate',
    tone: 'orange',
    icon: CopyCheck,
  },
  not_duplicate: { value: 'not_duplicate', label: 'Not a duplicate', tone: 'neutral', icon: CopyX },
})

export const DUPLICATE_STATUS_OPTIONS = Object.freeze(
  Object.values(DUPLICATE_STATUS_META).map(({ value, label }) => ({ value, label })),
)

/* ----------------------------------------------------------------------------------------------------------
 * Assignments (ComplaintAssignment.Status / Type)
 * -------------------------------------------------------------------------------------------------------- */
export const ASSIGNMENT_STATUS_META = Object.freeze({
  active: { value: 'active', label: 'Active', tone: 'blue' },
  completed: { value: 'completed', label: 'Completed', tone: 'green' },
  reassigned: { value: 'reassigned', label: 'Reassigned', tone: 'neutral' },
  rejected: { value: 'rejected', label: 'Rejected', tone: 'red' },
  cancelled: { value: 'cancelled', label: 'Cancelled', tone: 'slate' },
})

export const ASSIGNMENT_TYPE_LABELS = Object.freeze({
  auto: 'Automatic (AI recommended)',
  manual: 'Manual',
  reassignment: 'Reassignment',
})

/* ----------------------------------------------------------------------------------------------------------
 * Timeline events (StatusHistory.Event) - every event key has a label and an icon
 * -------------------------------------------------------------------------------------------------------- */
export const EVENT_META = Object.freeze({
  submitted: { label: 'Complaint submitted', icon: Send, tone: 'slate' },
  ai_analyzed: { label: 'AI analysis completed', icon: ScanSearch, tone: 'violet' },
  priority_assigned: { label: 'Priority assigned', icon: Gauge, tone: 'orange' },
  department_assigned: { label: 'Department assigned', icon: Building2, tone: 'blue' },
  officer_assigned: { label: 'Officer assigned', icon: UserCheck, tone: 'blue' },
  reassigned: { label: 'Officer reassigned', icon: Shuffle, tone: 'blue' },
  status_changed: { label: 'Status changed', icon: RefreshCw, tone: 'neutral' },
  accepted: { label: 'Accepted', icon: ClipboardCheck, tone: 'teal' },
  in_progress: { label: 'Work in progress', icon: Construction, tone: 'yellow' },
  evidence_uploaded: { label: 'Resolution evidence uploaded', icon: ImageUp, tone: 'teal' },
  resolved: { label: 'Resolved', icon: CircleCheck, tone: 'green' },
  verification_run: { label: 'AI verification completed', icon: ScanEye, tone: 'violet' },
  manual_review_requested: { label: 'Manual verification requested', icon: UserSearch, tone: 'orange' },
  verified: { label: 'Resolution verified', icon: ShieldCheck, tone: 'green' },
  feedback: { label: 'Citizen feedback', icon: MessageSquareText, tone: 'teal' },
  closed: { label: 'Closed', icon: Archive, tone: 'neutral' },
  rejected: { label: 'Rejected', icon: Ban, tone: 'red' },
  reopened: { label: 'Reopened', icon: RotateCcw, tone: 'magenta' },
  duplicate_flagged: { label: 'Potential duplicate detected', icon: Copy, tone: 'orange' },
  duplicate_confirmed: { label: 'Duplicate confirmed', icon: CopyCheck, tone: 'orange' },
  ai_overridden: { label: 'AI prediction overridden', icon: SlidersHorizontal, tone: 'violet' },
  priority_updated: { label: 'Priority recalculated', icon: RefreshCcw, tone: 'orange' },
  remark: { label: 'Remark added', icon: MessageSquare, tone: 'neutral' },
})

/**
 * Canonical lifecycle stops shown by the timeline / stepper. `key` is the StatusHistory event that marks the
 * stop as reached, so stops not yet in the complaint's timeline render as muted "upcoming" stops.
 */
export const LIFECYCLE_STEPS = Object.freeze([
  { key: 'submitted', label: 'Submitted', description: 'Complaint received', icon: Send },
  { key: 'ai_analyzed', label: 'AI analyzed', description: 'Category and severity detected', icon: ScanSearch },
  { key: 'priority_assigned', label: 'Priority assigned', description: 'Priority score calculated', icon: Gauge },
  {
    key: 'department_assigned',
    label: 'Department assigned',
    description: 'Routed to the responsible department',
    icon: Building2,
  },
  { key: 'officer_assigned', label: 'Officer assigned', description: 'Field officer assigned', icon: UserCheck },
  { key: 'accepted', label: 'Accepted', description: 'Officer accepted the work', icon: ClipboardCheck },
  { key: 'in_progress', label: 'In progress', description: 'Work under way', icon: Construction },
  { key: 'resolved', label: 'Resolved', description: 'Officer uploaded resolution evidence', icon: CircleCheck },
  { key: 'verified', label: 'Verified', description: 'Before and after photos verified', icon: ShieldCheck },
  { key: 'feedback', label: 'Feedback', description: 'Citizen rated the resolution', icon: Star },
])

/* ----------------------------------------------------------------------------------------------------------
 * Notifications (Notification.Type / Level)
 * -------------------------------------------------------------------------------------------------------- */
export const NOTIFICATION_META = Object.freeze({
  complaint_submitted: { label: 'Complaint submitted', icon: Send, tone: 'slate' },
  ai_analysis_completed: { label: 'AI analysis completed', icon: ScanSearch, tone: 'violet' },
  department_assigned: { label: 'Department assigned', icon: Building2, tone: 'blue' },
  officer_assigned: { label: 'Officer assigned', icon: UserCheck, tone: 'blue' },
  status_changed: { label: 'Status changed', icon: RefreshCw, tone: 'neutral' },
  complaint_resolved: { label: 'Complaint resolved', icon: CircleCheck, tone: 'green' },
  resolution_verified: { label: 'Resolution verified', icon: ShieldCheck, tone: 'green' },
  feedback_requested: { label: 'Feedback requested', icon: Star, tone: 'yellow' },
  duplicate_detected: { label: 'Possible duplicate detected', icon: Copy, tone: 'orange' },
  new_assignment: { label: 'New assignment', icon: ClipboardList, tone: 'blue' },
  critical_complaint: { label: 'Critical complaint', icon: Siren, tone: 'red' },
  reassignment: { label: 'Reassignment', icon: Shuffle, tone: 'blue' },
  complaint_reopened: { label: 'Complaint reopened', icon: RotateCcw, tone: 'magenta' },
  high_priority_unresolved: { label: 'High-priority complaint unresolved', icon: Hourglass, tone: 'red' },
  hotspot_alert: { label: 'Hotspot alert', icon: Flame, tone: 'orange' },
  manual_review_requested: { label: 'Manual verification requested', icon: UserSearch, tone: 'orange' },
  feedback_received: { label: 'Feedback received', icon: MessageSquareText, tone: 'teal' },
  system: { label: 'System', icon: Info, tone: 'neutral' },
})

export const NOTIFICATION_LEVEL_META = Object.freeze({
  info: { value: 'info', label: 'Info', tone: 'blue', icon: Info },
  success: { value: 'success', label: 'Success', tone: 'green', icon: CircleCheck },
  warning: { value: 'warning', label: 'Warning', tone: 'yellow', icon: BellRing },
  critical: { value: 'critical', label: 'Critical', tone: 'red', icon: Siren },
})

/* ----------------------------------------------------------------------------------------------------------
 * Complaint actions (keys returned in ComplaintDetail.allowed_actions) - specific, verb-first copy
 * -------------------------------------------------------------------------------------------------------- */
export const ACTION_LABELS = Object.freeze({
  edit: 'Edit complaint',
  delete: 'Delete complaint',
  accept: 'Accept complaint',
  reject: 'Reject complaint',
  start_work: 'Start work',
  upload_evidence: 'Upload evidence',
  resolve: 'Mark as resolved',
  verify: 'Run AI verification',
  manual_verify: 'Verify manually',
  request_manual_review: 'Request manual review',
  reopen: 'Reopen complaint',
  feedback: 'Give feedback',
  assign: 'Assign officer',
  reassign: 'Reassign officer',
  override_ai: 'Override AI result',
  reanalyze: 'Re-run AI analysis',
  review_duplicates: 'Review duplicates',
  add_remark: 'Add remark',
  close: 'Close complaint',
})

/* ----------------------------------------------------------------------------------------------------------
 * Lists, filters and reports
 * -------------------------------------------------------------------------------------------------------- */
export const DEFAULT_PAGE_SIZE = 20
export const PAGE_SIZE_OPTIONS = Object.freeze([10, 20, 50, 100])

/** `ordering` values accepted by GET /complaints/. */
export const COMPLAINT_ORDERING_OPTIONS = Object.freeze([
  { value: '-created_at', label: 'Newest first' },
  { value: 'created_at', label: 'Oldest first' },
  { value: '-priority_score', label: 'Highest priority' },
  { value: 'priority_score', label: 'Lowest priority' },
  { value: '-severity_score', label: 'Most severe' },
  { value: 'severity_score', label: 'Least severe' },
  { value: '-updated_at', label: 'Recently updated' },
])

export const REPORT_TYPES = Object.freeze([
  { value: 'summary', label: 'Summary', description: 'Headline numbers, status and priority breakdown.' },
  { value: 'complaints', label: 'Complaints', description: 'Every complaint matching the filters.' },
  { value: 'departments', label: 'Departments', description: 'Workload, resolution rate and SLA compliance.' },
  { value: 'officers', label: 'Officers', description: 'Active load, resolutions and ratings per officer.' },
  { value: 'feedback', label: 'Feedback', description: 'Citizen ratings and analysed sentiment.' },
])

export const REPORT_FORMATS = Object.freeze([
  { value: 'csv', label: 'CSV spreadsheet', extension: 'csv' },
  { value: 'pdf', label: 'PDF document', extension: 'pdf' },
])

/** AuditLog.Action choices. */
export const AUDIT_ACTION_LABELS = Object.freeze({
  create: 'Create',
  update: 'Update',
  delete: 'Delete',
  register: 'Register',
  login: 'Login',
  logout: 'Logout',
  password_change: 'Password change',
  status_change: 'Status change',
  assign: 'Assign',
  reassign: 'Reassign',
  ai_override: 'AI override',
  verify: 'Verification',
  duplicate_review: 'Duplicate review',
  config_change: 'Configuration change',
  export: 'Report export',
  other: 'Other',
})

export const AUDIT_ACTION_OPTIONS = Object.freeze(
  Object.entries(AUDIT_ACTION_LABELS).map(([value, label]) => ({ value, label })),
)

/** RiskZone.ZoneType choices. */
export const RISK_ZONE_TYPES = Object.freeze([
  { value: 'school', label: 'School / College' },
  { value: 'hospital', label: 'Hospital' },
  { value: 'market', label: 'Market / Commercial' },
  { value: 'highway', label: 'Highway / Arterial road' },
  { value: 'junction', label: 'Traffic junction' },
  { value: 'transit', label: 'Bus / Metro / Railway station' },
  { value: 'residential', label: 'Dense residential' },
  { value: 'industrial', label: 'Industrial' },
  { value: 'other', label: 'Other' },
])

/** CitizenProfile.Gender choices. */
export const GENDER_OPTIONS = Object.freeze([
  { value: 'male', label: 'Male' },
  { value: 'female', label: 'Female' },
  { value: 'other', label: 'Other' },
  { value: 'undisclosed', label: 'Prefer not to say' },
])

export const THEME_OPTIONS = Object.freeze([
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
])

/* ----------------------------------------------------------------------------------------------------------
 * System configuration defaults (used until GET /system/config/ answers, or when the API is offline)
 * -------------------------------------------------------------------------------------------------------- */
export const DEFAULT_SYSTEM_CONFIG = Object.freeze({
  app_name: APP_NAME,
  version: '',
  model_mode: null,
  is_demo: null,
  demo_badge: 'Demo AI Mode',
  map: { center: [17.385, 78.4867], zoom: 12, city: 'Hyderabad' },
  upload: { max_image_mb: 8, allowed_extensions: ['jpg', 'jpeg', 'png', 'webp'] },
  reopen_window_days: 14,
  statuses: STATUS_OPTIONS,
  levels: LEVEL_OPTIONS,
})

/* ----------------------------------------------------------------------------------------------------------
 * Safe lookups (unknown values from the API never crash a badge)
 * -------------------------------------------------------------------------------------------------------- */
const humanizeKey = (value) => {
  const text = String(value ?? '').replace(/_/g, ' ').trim()
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Unknown'
}

export function getStatusMeta(status) {
  return (
    STATUS_META[status] ?? {
      value: status,
      label: humanizeKey(status),
      tone: 'neutral',
      color: '#8C9A96',
      icon: Info,
      description: '',
    }
  )
}

export function getLevelMeta(level) {
  return LEVEL_META[level] ?? null
}

export function getSentimentMeta(sentiment) {
  return SENTIMENT_META[sentiment] ?? null
}

export function getVerificationMeta(status) {
  return (
    VERIFICATION_META[status] ?? {
      value: status,
      label: humanizeKey(status),
      tone: 'neutral',
      color: '#8C9A96',
      icon: CircleX,
      description: '',
    }
  )
}

export function getEventMeta(event) {
  return EVENT_META[event] ?? { label: humanizeKey(event), icon: Info, tone: 'neutral' }
}

export function getNotificationMeta(type) {
  return NOTIFICATION_META[type] ?? NOTIFICATION_META.system
}
