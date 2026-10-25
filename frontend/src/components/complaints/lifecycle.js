/**
 * Complaint lifecycle logic shared by ComplaintTimeline and LifecycleStepper (pure functions, no React).
 *
 * The backend records every step as a StatusHistory event (`submitted`, `ai_analyzed`, `priority_assigned`,
 * `department_assigned`, `officer_assigned`, `accepted`, `in_progress`, `resolved`, `verified`, `feedback`...).
 * The UI shows the canonical LIFECYCLE_STEPS (utils/constants) that have NOT been reached yet as muted
 * "upcoming" stops, so a citizen always sees what happens next. Deciding "reached" needs three rules:
 *
 * 1. An event in the timeline marks its step as reached.
 * 2. The current status implies every step up to it (citizens only receive public events, so an internal
 *    step may be missing from their timeline even though it happened): `assigned` implies the officer step,
 *    `in_progress` implies acceptance, and so on.
 * 3. A reopened complaint starts a new work cycle: work-phase events (accepted ... feedback) recorded BEFORE
 *    the latest `reopened` event belong to the previous cycle and no longer count; the routing steps
 *    (submitted ... officer_assigned) stay reached.
 * `closed` and `rejected` are terminal: nothing is upcoming any more.
 */
import { LIFECYCLE_STEPS, STATUS_META } from '@/utils/constants'
import { toDate } from '@/utils/format'

/** The furthest lifecycle step that each status implies has happened. */
const STATUS_IMPLIES = {
  submitted: 'submitted',
  analyzed: 'ai_analyzed',
  assigned: 'officer_assigned',
  reopened: 'officer_assigned',
  accepted: 'accepted',
  in_progress: 'in_progress',
  resolved: 'resolved',
  verified: 'verified',
}

const WORK_PHASE = new Set(['accepted', 'in_progress', 'resolved', 'verified', 'feedback'])
export const TERMINAL_STATUSES = Object.freeze(['closed', 'rejected'])

const STEP_INDEX = new Map(LIFECYCLE_STEPS.map((step, index) => [step.key, index]))

/** Events in chronological order (oldest first); ties keep the API order, then sort by id. */
export function sortEvents(events) {
  const list = Array.isArray(events) ? events.filter(Boolean) : []
  return list
    .map((event, index) => ({ event, index, time: toDate(event.timestamp)?.getTime() ?? 0 }))
    .sort((a, b) => a.time - b.time || (Number(a.event.id) || 0) - (Number(b.event.id) || 0) || a.index - b.index)
    .map((item) => item.event)
}

/**
 * Where a complaint stands in its lifecycle.
 * @param {Array<{event: string, timestamp: string}>} events TimelineEvent list (any order)
 * @param {string} [status] current complaint status
 * @returns {{events: object[], reached: Set<string>, furthestIndex: number, upcoming: object[],
 *            nextStep: object|null, terminal: boolean}}
 */
export function lifecycleProgress(events, status) {
  const sorted = sortEvents(events)
  let lastReopen = -1
  sorted.forEach((item, index) => {
    if (item.event === 'reopened') lastReopen = index
  })

  const reached = new Set()
  sorted.forEach((item, index) => {
    if (WORK_PHASE.has(item.event) && index < lastReopen) return
    reached.add(item.event)
  })

  let furthestIndex = -1
  reached.forEach((key) => {
    if (STEP_INDEX.has(key)) furthestIndex = Math.max(furthestIndex, STEP_INDEX.get(key))
  })
  const implied = STATUS_IMPLIES[status]
  if (implied) furthestIndex = Math.max(furthestIndex, STEP_INDEX.get(implied))

  const terminal = TERMINAL_STATUSES.includes(status)
  const upcoming = terminal ? [] : LIFECYCLE_STEPS.slice(furthestIndex + 1)
  return { events: sorted, reached, furthestIndex, upcoming, nextStep: upcoming[0] ?? null, terminal }
}

/** The eight status stages shown by the horizontal LifecycleStepper. */
export const STEPPER_STAGES = Object.freeze(
  ['submitted', 'analyzed', 'assigned', 'accepted', 'in_progress', 'resolved', 'verified', 'closed'].map((key) => ({
    key,
    label: STATUS_META[key].label,
    icon: STATUS_META[key].icon,
  })),
)

const STAGE_INDEX = new Map(STEPPER_STAGES.map((stage, index) => [stage.key, index]))

/**
 * Stepper position for a status.
 * - a normal status -> its own stage;
 * - `reopened` -> back at "Assigned" (the officer has to accept the work again), flagged "reopened";
 * - `rejected` -> the stage the complaint was in when it was rejected (the `old_status` of the rejection
 *   event, when the timeline is available), flagged "rejected".
 * @returns {{currentIndex: number, flag: 'rejected'|'reopened'|null}}
 */
export function stepperPosition(status, events) {
  if (STAGE_INDEX.has(status)) return { currentIndex: STAGE_INDEX.get(status), flag: null }
  if (status === 'reopened') return { currentIndex: STAGE_INDEX.get('assigned'), flag: 'reopened' }
  if (status === 'rejected') {
    const rejection = sortEvents(events)
      .reverse()
      .find((item) => item.event === 'rejected' || item.new_status === 'rejected')
    const before = rejection?.old_status
    return { currentIndex: STAGE_INDEX.has(before) ? STAGE_INDEX.get(before) : STAGE_INDEX.get('assigned'), flag: 'rejected' }
  }
  return { currentIndex: 0, flag: null }
}
