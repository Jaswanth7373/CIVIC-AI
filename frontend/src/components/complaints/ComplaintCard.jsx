/**
 * ComplaintCard - one complaint as a card (mobile lists, dashboards, the table's small-screen layout).
 *
 * Props:
 * - complaint: ComplaintList or ComplaintMini `{id, complaint_number, title, description, status, category,
 *   thumbnail, location: {area, address, city}, priority_score, priority_level, created_at, sla_due_at,
 *   is_overdue, duplicate_count, has_pending_duplicates, needs_manual_review, ...}`
 * - basePath: e.g. "/citizen/complaints" -> the card links to `${basePath}/${id}`
 * - to: explicit link target (wins over basePath)
 * - interactive: false renders a plain element even when a link target is known (use it when a parent
 *   such as DataTable already makes the row clickable, to avoid nested interactive elements)
 * - showSla: show the SLA countdown for open complaints (default true)
 * - actions: extra content at the bottom right (e.g. a "Give feedback" button)
 * - className
 */
import { Copy, MapPin, UserSearch } from 'lucide-react'
import { Link } from 'react-router-dom'
import { readableInk, safeColor } from '@/components/charts/palette'
import { cn } from '@/utils/cn'
import { STATUS_GROUPS } from '@/utils/constants'
import { formatDateTime, timeAgo } from '@/utils/format'
import { getIcon, renderIcon } from '@/utils/icons'
import { CategoryBadge } from './CategoryBadge'
import { PriorityBadge } from './PriorityBadge'
import { SeverityBadge } from './SeverityBadge'
import { SLAIndicator } from './SLAIndicator'
import { StatusBadge } from './StatusBadge'

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

export function ComplaintCard({ complaint, basePath, to, interactive = true, showSla = true, actions, className }) {
  if (!complaint) return null
  const href = to ?? (basePath && complaint.id != null ? `${basePath.replace(/\/+$/, '')}/${complaint.id}` : null)
  const location = complaint.location ?? {}
  const place = location.area || location.address || location.city
  const isOpen = STATUS_GROUPS.open.includes(complaint.status)
  const title = complaint.title || complaint.description || 'Untitled complaint'
  const linked = Boolean(href && interactive)

  const body = (
    <>
      <Thumbnail complaint={complaint} />
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <span className="pt-0.5 text-xs font-semibold text-ink-3 tabular">{complaint.complaint_number}</span>
          <StatusBadge status={complaint.status} label={complaint.status_display} size="sm" />
        </div>
        <p className="mt-0.5 line-clamp-2 text-sm font-semibold text-ink">
          {linked ? (
            <Link
              to={href}
              className="rounded-sm outline-hidden after:absolute after:inset-0 after:rounded-xl focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-focus"
            >
              {title}
            </Link>
          ) : (
            title
          )}
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <CategoryBadge category={complaint.category} size="sm" />
          {complaint.priority_level || complaint.priority_score != null ? (
            <PriorityBadge level={complaint.priority_level} score={complaint.priority_score} withLabel size="sm" />
          ) : null}
          {complaint.severity ? <SeverityBadge severity={complaint.severity} withLabel size="sm" /> : null}
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
        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-ink-3">
          {place ? (
            <span className="inline-flex min-w-0 items-center gap-1">
              <MapPin aria-hidden className="size-3.5 shrink-0" />
              <span className="truncate">{place}</span>
            </span>
          ) : null}
          <span className="flex items-center gap-2">
            {showSla && isOpen && complaint.sla_due_at ? (
              <SLAIndicator
                compact
                dueAt={complaint.sla_due_at}
                status={complaint.status}
                isOverdue={complaint.is_overdue}
                createdAt={complaint.created_at}
              />
            ) : null}
            {complaint.created_at ? (
              <time dateTime={complaint.created_at} title={formatDateTime(complaint.created_at)} className="tabular">
                {timeAgo(complaint.created_at)}
              </time>
            ) : null}
          </span>
        </div>
        {actions ? <div className="relative z-10 mt-2.5 flex flex-wrap justify-end gap-2">{actions}</div> : null}
      </div>
    </>
  )

  return (
    <article
      className={cn('relative flex min-w-0 gap-3 p-4', linked && 'rounded-xl transition-colors hover:bg-surface-2', className)}
    >
      {body}
    </article>
  )
}

export default ComplaintCard
