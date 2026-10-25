/**
 * CriticalCallout - the critical-priority complaints in the officer's queue, shown above everything else.
 *
 * Props:
 * - complaints: ComplaintList rows with `priority_level === 'critical'` (from the dashboard queue)
 * - total: the officer's open critical count (dashboard totals) - can exceed the rows when the queue is cut
 * - currentUserId, onAccept(row), acceptingId: accept straight from the callout
 * - className
 *
 * Signal red is used here because it means "critical" everywhere in CivicAI; the octagon plate repeats the
 * meaning through shape, and every row says its status and SLA state in words. When the callout first appears
 * the stop sign sends out two soft warning rings (once; none with reduced motion) - the words carry the
 * message, the rings only draw the eye to it.
 */
import { motion } from 'framer-motion'
import { ChevronRight, ClipboardCheck, MapPin, Siren } from 'lucide-react'
import { Link } from 'react-router-dom'
import { SLAIndicator } from '@/components/complaints/SLAIndicator'
import { usePrefersReducedMotion } from '@/components/motion/hooks'
import { EASE } from '@/components/motion/tokens'
import { StatusBadge } from '@/components/complaints/StatusBadge'
import { Button } from '@/components/ui/Button'
import { cn } from '@/utils/cn'
import { formatNumber } from '@/utils/format'
import { canAcceptRow, complaintPath, complaintsLink, OPEN_WORK_STATUSES } from './officerUtils'

export function CriticalCallout({ complaints = [], total, currentUserId, onAccept, acceptingId = null, className }) {
  const reduced = usePrefersReducedMotion()
  const rows = Array.isArray(complaints) ? complaints : []
  if (!rows.length) return null
  const count = Math.max(Number(total) || 0, rows.length)

  return (
    <section
      aria-labelledby="critical-callout-title"
      className={cn(
        'rounded-xl border border-signal-200 bg-signal-50 p-4 sm:p-5 dark:border-signal-500/30 dark:bg-signal-500/10',
        className,
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span aria-hidden className="relative grid size-10 shrink-0 place-items-center">
            {reduced ? null : (
              <motion.span
                className="pointer-events-none absolute -inset-0.5 rounded-[12px] border-2 border-signal-400"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: [0, 0.7, 0], scale: [0.9, 1.2, 1.7] }}
                transition={{ duration: 1.2, ease: EASE.standard, delay: 0.5, repeat: 1, repeatDelay: 0.2 }}
              />
            )}
            <svg viewBox="0 0 32 32" className="absolute inset-0 size-full">
              <path d="M9.8 1h12.4L31 9.8v12.4L22.2 31H9.8L1 22.2V9.8Z" className="fill-signal-600" />
              <path
                d="M10.9 3.75h10.2l7.15 7.15v10.2l-7.15 7.15H10.9l-7.15-7.15V10.9Z"
                className="fill-none stroke-white/85"
                strokeWidth="1.4"
              />
            </svg>
            <Siren className="relative size-4 text-white" strokeWidth={2.4} />
          </span>
          <div className="min-w-0">
            <h2 id="critical-callout-title" className="font-display text-lg font-bold leading-snug text-ink">
              {count === 1
                ? '1 critical complaint needs attention first'
                : `${formatNumber(count)} critical complaints need attention first`}
            </h2>
            <p className="mt-0.5 text-sm text-ink-2">
              The AI scored these highest in your queue: risks to public safety that should be made safe before other work.
            </p>
          </div>
        </div>
        <Button
          size="sm"
          variant="ghost"
          rightIcon={ChevronRight}
          to={complaintsLink({ status: OPEN_WORK_STATUSES, priority_level: 'critical' })}
          className="text-signal-700 hover:bg-signal-100 hover:text-signal-800 dark:text-signal-300 dark:hover:bg-signal-500/15"
        >
          Show all critical
        </Button>
      </div>

      <ul className="mt-4 space-y-2">
        {rows.map((row) => {
          const area = row.location?.area || row.location?.address
          const place = area && !String(row.title ?? '').includes(area) ? area : null
          return (
            <li
              key={row.id}
              className="grid gap-2 rounded-lg border border-signal-200/70 bg-surface px-3.5 py-2.5 lg:grid-cols-[minmax(0,1fr)_auto_auto] lg:items-center lg:gap-4 dark:border-signal-500/25"
            >
              <div className="min-w-0">
                <p className="flex min-w-0 flex-col gap-x-3 sm:flex-row sm:items-baseline">
                  <Link to={complaintPath(row.id)} className="shrink-0 font-semibold text-ink tabular hover:underline">
                    {row.complaint_number}
                  </Link>
                  <span className="min-w-0 truncate text-sm text-ink-2" title={row.title}>
                    {row.title}
                  </span>
                </p>
                {place ? (
                  <p className="mt-0.5 flex items-center gap-1 text-xs text-ink-3">
                    <MapPin aria-hidden className="size-3.5 shrink-0" />
                    <span className="truncate">{place}</span>
                  </p>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={row.status} label={row.status_display} size="sm" />
                <SLAIndicator compact dueAt={row.sla_due_at} status={row.status} isOverdue={row.is_overdue} createdAt={row.created_at} />
              </div>
              <div className="flex items-center gap-2">
                {typeof onAccept === 'function' && canAcceptRow(row, currentUserId) ? (
                  <Button
                    size="sm"
                    leftIcon={ClipboardCheck}
                    loading={acceptingId === row.id}
                    disabled={acceptingId !== null && acceptingId !== row.id}
                    onClick={() => onAccept(row)}
                    className="flex-1 lg:flex-none"
                  >
                    Accept
                    <span className="sr-only"> complaint {row.complaint_number}</span>
                  </Button>
                ) : null}
                <Button size="sm" variant="outline" to={complaintPath(row.id)} className="flex-1 lg:flex-none">
                  Open work order
                  <span className="sr-only"> {row.complaint_number}</span>
                </Button>
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export default CriticalCallout
