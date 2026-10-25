/**
 * ActivityFeed - the latest timeline events across the officer's complaints (dashboard `recent_activity`:
 * TimelineEvent + `complaint_number` + `complaint_id`), newest first.
 *
 * Props: { events, loading, initialCount (entries shown before "Show all", default 6), className }
 *
 * Each entry names what happened (EVENT_META label and icon), which complaint it belongs to (a link to the
 * work order), who did it - the CivicAI engine or a person - and when, with the remark clamped to two
 * lines. Internal notes keep their "Internal" tag so an officer never mistakes them for public updates.
 */
import { Bot, ChevronDown, EyeOff, History, UserRound } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { Skeleton } from '@/components/ui/Skeleton'
import { resolveTone, toneChip } from '@/components/ui/tones'
import { cn } from '@/utils/cn'
import { EVENT_META, getEventMeta } from '@/utils/constants'
import { formatDateTime, timeAgo } from '@/utils/format'
import { complaintPath } from './officerUtils'

function actorOf(event) {
  return event.actor_label || event.changed_by?.full_name || 'CivicAI Engine'
}

export function ActivityFeed({ events = [], loading = false, initialCount = 6, className }) {
  const [expanded, setExpanded] = useState(false)
  const items = Array.isArray(events) ? events : []
  const hidden = expanded ? 0 : Math.max(0, items.length - initialCount)
  const shown = hidden ? items.slice(0, initialCount) : items

  if (loading && !items.length) {
    return (
      <ul aria-hidden className={cn('space-y-4', className)}>
        {[0, 1, 2, 3].map((index) => (
          <li key={index} className="flex gap-3">
            <Skeleton className="size-8 shrink-0 rounded-lg" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3.5 w-2/3" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          </li>
        ))}
      </ul>
    )
  }

  if (!items.length) {
    return (
      <EmptyState
        icon={History}
        compact
        bordered={false}
        title="No activity yet"
        description="Updates on your complaints - assignments, AI analysis, status changes - appear here as they happen."
        className={className}
      />
    )
  }

  return (
    <div className={className}>
      <ol aria-label="Recent activity" className="divide-y divide-line">
        {shown.map((event) => {
          const meta = getEventMeta(event.event)
          const Icon = meta.icon
          const label = EVENT_META[event.event] ? meta.label : event.event_display || meta.label
          const system = !event.changed_by && actorOf(event) === 'CivicAI Engine'
          const ActorIcon = system ? Bot : UserRound
          return (
            <li key={event.id} className="flex gap-3 py-3 first:pt-0 last:pb-0">
              <span
                aria-hidden
                className={cn('mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg', toneChip[resolveTone(meta.tone)])}
              >
                <Icon className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                  <p className="text-sm font-semibold text-ink">
                    {label}
                    {event.complaint_id != null ? (
                      <>
                        {' '}
                        <span className="sr-only">on</span>
                        <Link
                          to={complaintPath(event.complaint_id)}
                          className="ml-1 whitespace-nowrap font-semibold text-primary-ink tabular hover:underline"
                        >
                          {event.complaint_number}
                        </Link>
                      </>
                    ) : null}
                  </p>
                  <time dateTime={event.timestamp} title={formatDateTime(event.timestamp)} className="shrink-0 text-xs text-ink-3 tabular">
                    {timeAgo(event.timestamp)}
                  </time>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-ink-2">
                  <span className="inline-flex min-w-0 items-center gap-1">
                    <ActorIcon aria-hidden className="size-3.5 shrink-0 text-ink-3" />
                    <span className="truncate">{actorOf(event)}</span>
                  </span>
                  {event.is_public === false ? (
                    <Badge tone="neutral" size="sm" icon={EyeOff}>
                      Internal
                    </Badge>
                  ) : null}
                </div>
                {event.remarks ? <p className="mt-1 line-clamp-2 text-xs text-ink-2">{event.remarks}</p> : null}
              </div>
            </li>
          )
        })}
      </ol>
      {hidden ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-3 inline-flex items-center gap-1 rounded-md text-xs font-semibold text-primary-ink hover:underline pointer-coarse:min-h-11"
        >
          <ChevronDown aria-hidden className="size-3.5" />
          Show {hidden} more {hidden === 1 ? 'update' : 'updates'}
        </button>
      ) : null}
    </div>
  )
}

export default ActivityFeed
