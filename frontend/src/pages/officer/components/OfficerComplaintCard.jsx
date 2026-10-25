/**
 * OfficerComplaintCard - one complaint of an officer's list as a linked card. It is the small-screen layout of
 * OfficerComplaintTable, so it carries every column of the officer table (BUILD_SPEC requirement 30): complaint
 * ID, category, location, priority, severity, status, date and the action. It also shows the SLA countdown, the
 * AI flags (possible duplicates, manual review) and, in the department scope, who the complaint is assigned to.
 *
 * Props:
 * - complaint: ComplaintList row
 * - to: link target (the officer complaint page); the title link covers the whole card
 * - showOfficer: name the assigned officer ("Assigned to you" for the signed-in officer)
 * - currentUserId: id of the signed-in officer
 * - actions: node at the bottom right (the Accept button), stacked above the card link
 * - className
 *
 * Priority depth: a rail along the left edge is a small gauge of the real AI priority score - filled from the
 * bottom to the score, in the level's colour, over a tint of the same colour - so a glance down the queue
 * reads urgency before any text. (The list it sits in lifts critical and high cards onto higher elevations.)
 * The rail fills up the first time the card is seen; with reduced motion it is simply full.
 *
 * Why not the shared ComplaintCard: that is the citizen-facing card, without severity or officer. Priority and
 * severity share one colour scale, so here both badges carry their word ("Critical priority 82", "High
 * severity") and cannot be mistaken for each other.
 */
import { Copy, MapPin, UserRound, UserSearch } from 'lucide-react'
import { useRef } from 'react'
import { Link } from 'react-router-dom'
import { readableInk, safeColor, withAlpha } from '@/components/charts/palette'
import { CategoryBadge } from '@/components/complaints/CategoryBadge'
import { PriorityBadge } from '@/components/complaints/PriorityBadge'
import { SeverityBadge } from '@/components/complaints/SeverityBadge'
import { SLAIndicator } from '@/components/complaints/SLAIndicator'
import { StatusBadge } from '@/components/complaints/StatusBadge'
import { useInViewOnce } from '@/components/motion/hooks'
import { cn } from '@/utils/cn'
import { LEVEL_META, STATUS_GROUPS, scoreToLevel } from '@/utils/constants'
import { formatDateTime, timeAgo } from '@/utils/format'
import { getIcon, renderIcon } from '@/utils/icons'
import { isAssignedTo, locationSummary, shortDate } from './officerUtils'

/** The citizen's photo, or the category icon on the category colour when there is none. */
function Thumbnail({ complaint }) {
  if (complaint.thumbnail) {
    return (
      <img
        src={complaint.thumbnail}
        alt=""
        loading="lazy"
        decoding="async"
        className="size-16 shrink-0 rounded-lg bg-sunken object-cover sm:size-[72px]"
      />
    )
  }
  const fill = safeColor(complaint.category?.color, '#6a7a77')
  return (
    <span
      aria-hidden
      className="grid size-16 shrink-0 place-items-center rounded-lg sm:size-[72px]"
      style={{ backgroundColor: fill, color: readableInk(fill) }}
    >
      {renderIcon(getIcon(complaint.category?.icon || complaint.category?.slug), { className: 'size-7', strokeWidth: 2 })}
    </span>
  )
}

/** Left-edge gauge of the priority score (decorative: the badge says the level and the score in words). */
function PriorityRail({ score, level }) {
  const ref = useRef(null)
  const seen = useInViewOnce(ref, { amount: 0.4, margin: '0px' })
  const number = Number(score)
  if (!Number.isFinite(number)) return null
  const value = Math.min(100, Math.max(0, number))
  const meta = LEVEL_META[level] ?? LEVEL_META[scoreToLevel(value)]
  return (
    <span
      ref={ref}
      aria-hidden
      className="absolute inset-y-2 left-1.5 w-1 overflow-hidden rounded-full"
      style={{ backgroundColor: withAlpha(meta.color, 0.2) }}
    >
      <span
        className="absolute inset-x-0 bottom-0 rounded-full transition-[height] duration-700 ease-enter"
        style={{ height: seen ? `${Math.max(6, value)}%` : '0%', backgroundColor: meta.color }}
      />
    </span>
  )
}

function officerText(complaint, currentUserId) {
  const officer = complaint.assigned_officer
  if (!officer) return 'Not assigned yet'
  if (isAssignedTo(complaint, currentUserId)) return 'Assigned to you'
  return `Assigned to ${officer.full_name || 'another officer'}`
}

export function OfficerComplaintCard({ complaint, to, showOfficer = false, currentUserId, actions, className }) {
  if (!complaint) return null
  const title = complaint.title || complaint.description || 'Untitled complaint'
  const place = locationSummary(complaint.location)
  const isOpen = STATUS_GROUPS.open.includes(complaint.status)

  return (
    <article className={cn('relative flex min-w-0 gap-3 py-3.5 pl-5 pr-3.5 transition-colors hover:bg-surface-2 sm:py-4 sm:pl-6 sm:pr-4', className)}>
      <PriorityRail score={complaint.priority_score} level={complaint.priority_level} />
      <Thumbnail complaint={complaint} />
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <span className="pt-0.5 text-xs font-semibold text-ink-3 tabular">{complaint.complaint_number}</span>
          <StatusBadge status={complaint.status} label={complaint.status_display} size="sm" />
        </div>
        <p className="mt-0.5 line-clamp-2 text-sm font-semibold text-ink">
          {to ? (
            <Link
              to={to}
              className="rounded-sm outline-hidden after:absolute after:inset-0 after:rounded-[inherit] focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-focus"
            >
              {title}
            </Link>
          ) : (
            title
          )}
        </p>

        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <CategoryBadge category={complaint.category} size="sm" />
          <PriorityBadge level={complaint.priority_level} score={complaint.priority_score} withLabel size="sm" />
          <SeverityBadge severity={complaint.severity} withLabel size="sm" />
          {complaint.needs_manual_review ? (
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-guide-700 dark:text-guide-200">
              <UserSearch aria-hidden className="size-3.5" />
              Needs review
            </span>
          ) : null}
          {complaint.duplicate_count > 0 ? (
            <span
              title={`${complaint.duplicate_count} similar ${complaint.duplicate_count === 1 ? 'report' : 'reports'} nearby`}
              className="inline-flex items-center gap-1 text-[11px] font-semibold text-hazard-700 tabular dark:text-hazard-300"
            >
              <Copy aria-hidden className="size-3.5" />
              {complaint.duplicate_count}
              <span className="sr-only"> similar {complaint.duplicate_count === 1 ? 'report' : 'reports'}</span>
            </span>
          ) : null}
        </div>

        {place || showOfficer ? (
          <div className="mt-1.5 space-y-1 text-xs text-ink-2">
            {place ? (
              <p className="flex min-w-0 items-center gap-1" title={place.full}>
                <MapPin aria-hidden className="size-3.5 shrink-0 text-ink-3" />
                <span className="sr-only">Location: </span>
                {place.gps ? (
                  <span className="truncate tabular">
                    {place.primary}, {place.secondary}
                  </span>
                ) : (
                  <span className="truncate">
                    {place.primary}
                    {place.secondary ? (
                      <span className="text-ink-3">
                        <span aria-hidden> · </span>
                        <span className="sr-only">, </span>
                        {place.secondary}
                      </span>
                    ) : null}
                  </span>
                )}
              </p>
            ) : null}
            {showOfficer ? (
              <p className="flex min-w-0 items-center gap-1">
                <UserRound aria-hidden className="size-3.5 shrink-0 text-ink-3" />
                <span className="truncate">{officerText(complaint, currentUserId)}</span>
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-ink-3">
          {isOpen && complaint.sla_due_at ? (
            <SLAIndicator
              compact
              dueAt={complaint.sla_due_at}
              status={complaint.status}
              isOverdue={complaint.is_overdue}
              createdAt={complaint.created_at}
            />
          ) : null}
          {complaint.created_at ? (
            <span className="ml-auto whitespace-nowrap">
              <span className="sr-only">Reported </span>
              <time dateTime={complaint.created_at} title={formatDateTime(complaint.created_at)} className="tabular">
                {shortDate(complaint.created_at)}
              </time>
              <span aria-hidden> · </span>
              <span className="sr-only">, </span>
              {timeAgo(complaint.created_at)}
            </span>
          ) : null}
        </div>

        {actions ? <div className="relative z-10 mt-2.5 flex flex-wrap justify-end gap-2">{actions}</div> : null}
      </div>
    </article>
  )
}

export default OfficerComplaintCard
