/**
 * SLAIndicator - is the complaint on time against its service-level deadline (`sla_due_at`)?
 *
 * Props:
 * - dueAt: ISO deadline (`sla_due_at`); without it the indicator says "No deadline set"
 * - status: complaint status (decides between a live countdown and a met / missed verdict)
 * - resolvedAt: ISO `resolved_at` (for the met / missed verdict)
 * - isOverdue: the server's `is_overdue` flag - when given it wins over the local clock, so a phone with a
 *   wrong clock still shows the truth
 * - createdAt: ISO `created_at`; with it "due soon" means less than 25% of the SLA window is left
 * - compact: one short line for tables ("Due in 5 h")
 * - className
 *
 * States (colour + icon + words, never colour alone):
 * - overdue -> red "Overdue by 2 d 4 h", with its own clock icon (the siren belongs to the critical level, so an
 *   overdue critical work order never shows two sirens);
 * - due soon (under 25% of the window or under 6 h left) -> yellow "Due in 3 h";
 * - on track -> neutral "Due in 2 d";
 * - resolved / verified / closed -> green "Resolved within SLA" or orange "Resolved 5 h late";
 * - rejected -> no SLA applies, nothing is rendered.
 * The countdown re-renders once a minute from a shared clock (useNow).
 */
import { CircleCheck, ClockAlert, Hourglass, Timer, TimerOff } from 'lucide-react'
import { cn } from '@/utils/cn'
import { STATUS_GROUPS } from '@/utils/constants'
import { formatDateTime, formatHours, toDate } from '@/utils/format'
import { useNow } from './useNow'

const HOUR_MS = 3_600_000
const DUE_SOON_HOURS = 6

const TONES = {
  overdue: 'bg-signal-50 text-signal-700 ring-signal-200 dark:bg-signal-500/15 dark:text-signal-300 dark:ring-signal-500/30',
  soon: 'bg-marking-50 text-marking-800 ring-marking-200 dark:bg-marking-500/15 dark:text-marking-300 dark:ring-marking-500/30',
  ok: 'bg-surface-2 text-ink-2 ring-line',
  met: 'bg-sign-50 text-sign-700 ring-sign-200 dark:bg-sign-500/15 dark:text-sign-300 dark:ring-sign-500/30',
  late: 'bg-hazard-50 text-hazard-700 ring-hazard-200 dark:bg-hazard-500/15 dark:text-hazard-300 dark:ring-hazard-500/30',
  none: 'bg-surface-2 text-ink-3 ring-line',
}

/** Pure decision used by the component: which SLA state applies and the words to show. */
function describe({ due, status, resolved, isOverdue, created, now }) {
  if (status === 'rejected') return null
  if (!due) return { key: 'none', icon: Hourglass, text: 'No deadline set', short: 'No SLA' }

  const closed = STATUS_GROUPS.resolved.includes(status)
  if (closed) {
    if (!resolved) return { key: 'met', icon: CircleCheck, text: 'Resolved', short: 'Resolved' }
    const lateHours = (resolved.getTime() - due.getTime()) / HOUR_MS
    return lateHours <= 0
      ? { key: 'met', icon: CircleCheck, text: 'Resolved within SLA', short: 'Within SLA' }
      : { key: 'late', icon: TimerOff, text: `Resolved ${formatHours(lateHours)} late`, short: `${formatHours(lateHours)} late` }
  }

  const leftHours = (due.getTime() - now) / HOUR_MS
  const overdue = typeof isOverdue === 'boolean' ? isOverdue : leftHours < 0
  if (overdue) {
    const by = Math.max(0, -leftHours)
    return { key: 'overdue', icon: ClockAlert, text: `Overdue by ${formatHours(by)}`, short: `Overdue ${formatHours(by)}` }
  }
  const windowHours = created ? (due.getTime() - created.getTime()) / HOUR_MS : null
  const soon = leftHours <= DUE_SOON_HOURS || (windowHours > 0 && leftHours / windowHours < 0.25)
  const left = formatHours(Math.max(0, leftHours))
  return { key: soon ? 'soon' : 'ok', icon: soon ? Timer : Hourglass, text: `Due in ${left}`, short: `Due in ${left}` }
}

export function SLAIndicator({ dueAt, status, resolvedAt, isOverdue, createdAt, compact = false, className }) {
  const now = useNow(60_000)
  const due = toDate(dueAt)
  const state = describe({
    due,
    status,
    resolved: toDate(resolvedAt),
    isOverdue,
    created: toDate(createdAt),
    now,
  })
  if (!state) return null
  const Icon = state.icon
  const absolute = due ? `Deadline ${formatDateTime(due)}` : 'No service-level deadline is set for this complaint.'

  if (compact) {
    return (
      <span
        title={absolute}
        className={cn(
          'inline-flex items-center gap-1 whitespace-nowrap text-xs font-semibold tabular',
          state.key === 'overdue' && 'text-signal-600 dark:text-signal-300',
          state.key === 'soon' && 'text-marking-800 dark:text-marking-300',
          state.key === 'late' && 'text-hazard-700 dark:text-hazard-300',
          state.key === 'met' && 'text-sign-700 dark:text-sign-300',
          (state.key === 'ok' || state.key === 'none') && 'text-ink-3',
          className,
        )}
      >
        <Icon aria-hidden className="size-3.5 shrink-0" />
        <span className="sr-only">SLA: </span>
        {state.short}
      </span>
    )
  }

  return (
    <span
      title={absolute}
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-semibold leading-5 ring-1 ring-inset tabular',
        TONES[state.key],
        className,
      )}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span className="sr-only">SLA: </span>
      <span className="truncate">{state.text}</span>
      {due && state.key !== 'met' && state.key !== 'late' ? <span className="sr-only">. {absolute}.</span> : null}
    </span>
  )
}

export default SLAIndicator
