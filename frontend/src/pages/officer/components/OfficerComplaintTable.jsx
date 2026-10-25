/**
 * OfficerComplaintTable - an officer's complaint list: Complaint ID, Category, Location, Priority, Severity,
 * Status, Date and Action (BUILD_SPEC requirement 30), as a table when its container is at least 64rem wide and
 * as linked cards below that (where eight columns would only scroll sideways and hide the actions).
 *
 * Props:
 * - complaints: ComplaintList[]
 * - loading: skeleton rows on first load, a moving lane-line bar while refreshing
 * - sort / onSortChange: server-side ordering string ("-priority_score"); omit both for a fixed order
 *   (the dashboard queue is already sorted by priority on the server)
 * - currentUserId: rows assigned to this officer and waiting for acceptance get an "Accept" button
 * - onAccept(row): accept handler (returns a promise); `acceptingId` marks the row in flight
 * - showOfficer: name the assigned officer under each complaint (department scope)
 * - empty: empty-state node
 * - caption: accessible table caption
 * - cardLayout: how the cards are laid out below the table width - 'stack' (default: separate cards whose
 *   elevation rises with the priority level, critical cards closest to the reader) or 'divided' (one panel
 *   with dividers, for a list that already sits inside a card such as the dashboard queue)
 * - className
 *
 * Why not the shared ComplaintTable: its small-screen cards carry no actions, severity or officer and switch at
 * md, and an officer on site must be able to judge and accept a complaint from a phone or tablet. The cells and
 * the cards (OfficerComplaintCard) reuse the same badges, so every layout looks the same.
 *
 * Reading order: the work-order title is the line people read (up to two lines, never cut to a few words), with
 * the complaint number as a small tabular caption above it - as on the cards. The narrow columns keep their
 * width small (category and location truncate, severity is a dot and a word, the "View" link is a labelled
 * chevron - the whole row opens the complaint), so the title gets the room.
 */
import { ChevronRight, ClipboardCheck, MapPin, UserRound } from 'lucide-react'
import { useRef } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { CategoryBadge } from '@/components/complaints/CategoryBadge'
import { PriorityBadge } from '@/components/complaints/PriorityBadge'
import { SeverityBadge } from '@/components/complaints/SeverityBadge'
import { SLAIndicator } from '@/components/complaints/SLAIndicator'
import { StatusBadge } from '@/components/complaints/StatusBadge'
import { Button } from '@/components/ui/Button'
import { DataTable } from '@/components/ui/DataTable'
import { EmptyState } from '@/components/ui/EmptyState'
import { Skeleton } from '@/components/ui/Skeleton'
import { useFrameRem } from '@/components/ui/useFrameRem'
import { cn } from '@/utils/cn'
import { STATUS_GROUPS } from '@/utils/constants'
import { formatDateTime, timeAgo } from '@/utils/format'
import { OfficerComplaintCard } from './OfficerComplaintCard'
import { canAcceptRow, complaintPath, locationSummary, shortDate } from './officerUtils'

function AcceptButton({ row, onAccept, accepting, disabled, compact = false, className }) {
  return (
    <Button
      size="sm"
      variant="secondary"
      leftIcon={compact ? undefined : ClipboardCheck}
      loading={accepting}
      disabled={disabled}
      onClick={() => onAccept(row)}
      className={className}
    >
      Accept
      <span className="sr-only"> complaint {row.complaint_number}</span>
    </Button>
  )
}

export function OfficerComplaintTable({
  complaints = [],
  loading = false,
  sort,
  onSortChange,
  currentUserId,
  onAccept,
  acceptingId = null,
  showOfficer = false,
  empty,
  caption = 'Complaints',
  cardLayout = 'stack',
  className,
}) {
  const navigate = useNavigate()
  // Table from 64rem of container width (the eight columns), cards below; measured before the first paint.
  const frameRef = useRef(null)
  const frameRem = useFrameRem(frameRef)
  const layout = frameRem === null ? null : frameRem >= 64 ? 'table' : 'cards'
  const acceptable = (row) => typeof onAccept === 'function' && canAcceptRow(row, currentUserId)
  const anyAccepting = acceptingId !== null

  const columns = [
    {
      key: 'number',
      header: 'Complaint ID',
      render: (row) => {
        const officer = row.assigned_officer
        const self = officer && currentUserId != null && String(officer.id) === String(currentUserId)
        const title = row.title || row.description
        return (
          <div className="min-w-32 max-w-[26rem]">
            <p className="text-xs font-semibold text-ink-2 tabular">{row.complaint_number}</p>
            <p className="line-clamp-2 text-sm font-semibold leading-snug text-ink" title={title}>
              {title}
            </p>
            {showOfficer ? (
              <p className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-ink-3">
                <UserRound aria-hidden className="size-3 shrink-0" />
                <span className="truncate">{officer ? (self ? 'Assigned to you' : officer.full_name) : 'Not assigned yet'}</span>
              </p>
            ) : null}
          </div>
        )
      },
    },
    {
      key: 'category',
      header: 'Category',
      className: 'max-w-32',
      render: (row) => (
        <span className="flex min-w-0" title={row.category?.name}>
          <CategoryBadge category={row.category} size="sm" />
        </span>
      ),
    },
    {
      key: 'location',
      header: 'Location',
      className: 'max-w-28',
      render: (row) => {
        const place = locationSummary(row.location)
        if (!place) return <span className="text-ink-3">—</span>
        // A GPS-only location shows latitude over longitude, in the same style; a named place its landmark below.
        return (
          <span className="block min-w-0" title={place.full}>
            <span className={cn('block truncate', place.gps && 'tabular')}>{place.primary}</span>
            {place.secondary ? (
              <span className={cn('block truncate', place.gps ? 'tabular' : 'text-xs text-ink-3')}>{place.secondary}</span>
            ) : null}
          </span>
        )
      },
    },
    {
      key: 'priority',
      header: 'Priority',
      sortable: true,
      sortKey: 'priority_score',
      render: (row) => <PriorityBadge level={row.priority_level} score={row.priority_score} size="sm" />,
    },
    {
      key: 'severity',
      header: 'Severity',
      sortable: true,
      sortKey: 'severity_score',
      render: (row) => <SeverityBadge severity={row.severity} size="sm" />,
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => (
        <div className="flex flex-col items-start gap-1">
          <StatusBadge status={row.status} label={row.status_display} size="sm" />
          {STATUS_GROUPS.open.includes(row.status) && row.sla_due_at ? (
            <SLAIndicator compact dueAt={row.sla_due_at} status={row.status} isOverdue={row.is_overdue} createdAt={row.created_at} />
          ) : null}
        </div>
      ),
    },
    {
      key: 'date',
      header: 'Date',
      sortable: true,
      sortKey: 'created_at',
      render: (row) => (
        <span className="whitespace-nowrap">
          <time dateTime={row.created_at} title={formatDateTime(row.created_at)} className="block tabular">
            {shortDate(row.created_at)}
          </time>
          <span className="block text-xs text-ink-3">{timeAgo(row.created_at)}</span>
        </span>
      ),
    },
    {
      key: 'action',
      header: 'Action',
      align: 'right',
      render: (row) => (
        <div className="flex items-center justify-end gap-1">
          {acceptable(row) ? (
            <AcceptButton
              compact
              row={row}
              onAccept={onAccept}
              accepting={acceptingId === row.id}
              disabled={anyAccepting && acceptingId !== row.id}
            />
          ) : null}
          {/* The whole row opens the complaint; the link is its compact, labelled stand-in for keyboards. */}
          <Link
            to={complaintPath(row.id)}
            title={`View complaint ${row.complaint_number}`}
            className="relative grid size-8 place-items-center rounded-md text-primary-ink transition-colors hover:bg-primary-soft pointer-coarse:size-11"
          >
            <span className="sr-only">View complaint {row.complaint_number}</span>
            <ChevronRight aria-hidden className="size-[18px]" />
          </Link>
        </div>
      ),
    },
  ].map((column) => ({ ...column, className: cn('px-3', column.className), headerClassName: 'px-3' }))

  const emptyNode = empty ?? (
    <EmptyState
      bordered={false}
      compact
      icon={MapPin}
      title="No complaints match"
      description="Try clearing a filter or widening the date range."
    />
  )
  const renderAccept = (row) =>
    acceptable(row) ? (
      <AcceptButton row={row} onAccept={onAccept} accepting={acceptingId === row.id} disabled={anyAccepting && acceptingId !== row.id} />
    ) : null

  // The switch follows the container's width (64rem = the width the eight columns need), so the table appears as
  // soon as its container is wide enough - whatever the viewport, sidebar or page layout around it. Only the
  // shown layout is rendered (the frame is measured before the first paint), never both behind CSS.
  return (
    <div ref={frameRef} className="@container min-w-0">
      {layout === 'cards' ? (
        <ComplaintCardList
          complaints={complaints}
          loading={loading}
          empty={emptyNode}
          caption={caption}
          renderActions={renderAccept}
          showOfficer={showOfficer}
          currentUserId={currentUserId}
          layout={cardLayout}
          className={className}
        />
      ) : null}
      {layout === 'table' ? (
        <DataTable
          columns={columns}
          data={complaints}
          loading={loading}
          rowKey="id"
          sort={sort}
          onSortChange={onSortChange}
          onRowClick={(row) => navigate(complaintPath(row.id))}
          caption={caption}
          className={cn('relative', className)}
          empty={emptyNode}
        />
      ) : null}
    </div>
  )
}

/**
 * Elevation of a stacked card by priority level: the more urgent, the closer to the reader. Critical cards
 * also carry a faint signal-red edge, so the depth never rests on the shadow alone.
 */
const DEPTH = {
  critical: 'elev-floating border-signal-200 dark:border-signal-500/35',
  high: 'elev-raised',
  medium: 'elev-base',
  low: 'elev-base',
}

/**
 * When the container is narrower than the eight columns (phones, tablets, small laptops), each complaint becomes
 * a linked card with the same fields and badges and its Accept action - stacked as separate cards with priority
 * depth, or in one divided panel (`layout="divided"`).
 */
function ComplaintCardList({ complaints = [], loading, empty, caption, renderActions, showOfficer, currentUserId, layout, className }) {
  const rows = Array.isArray(complaints) ? complaints : []
  const stacked = layout !== 'divided'
  const refreshBar =
    loading && rows.length ? (
      <div aria-hidden className={cn('h-1 overflow-hidden bg-sunken', stacked && 'mb-2.5 rounded-full')}>
        <div className="lane-line-x animate-lane h-full w-full" />
      </div>
    ) : null
  const skeleton = (
    <ul aria-hidden className={stacked ? 'space-y-2.5' : 'divide-y divide-line'}>
      {[0, 1, 2, 3].map((index) => (
        <li key={index} className={cn('flex gap-3 p-4', stacked && 'rounded-xl border border-line bg-surface')}>
          <Skeleton className="size-16 shrink-0 rounded-lg" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-1/3" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </li>
      ))}
    </ul>
  )
  const card = (row) => (
    <OfficerComplaintCard
      complaint={row}
      to={complaintPath(row.id)}
      showOfficer={showOfficer}
      currentUserId={currentUserId}
      actions={renderActions(row)}
      className={stacked ? 'rounded-xl' : undefined}
    />
  )

  if (stacked) {
    return (
      <div className={cn('relative min-w-0', className)} aria-busy={loading || undefined}>
        {refreshBar}
        {loading && !rows.length ? (
          skeleton
        ) : rows.length ? (
          <ul aria-label={caption} className="space-y-2.5">
            {rows.map((row, index) => (
              <li
                key={row.id}
                className={cn(
                  'animate-row-in rounded-xl border border-line bg-surface transition-shadow duration-200 motion-reduce:animate-none',
                  DEPTH[row.priority_level] ?? 'elev-base',
                )}
                style={{ animationDelay: `${Math.min(index, 7) * 45}ms` }}
              >
                {card(row)}
              </li>
            ))}
          </ul>
        ) : (
          <div className="rounded-xl border border-line bg-surface">{empty}</div>
        )}
      </div>
    )
  }

  return (
    <div
      className={cn('relative min-w-0 overflow-hidden rounded-xl border border-line bg-surface', className)}
      aria-busy={loading || undefined}
    >
      {refreshBar}
      {loading && !rows.length ? (
        skeleton
      ) : rows.length ? (
        <ul aria-label={caption} className="divide-y divide-line">
          {rows.map((row) => (
            <li key={row.id}>{card(row)}</li>
          ))}
        </ul>
      ) : (
        empty
      )}
    </div>
  )
}

export default OfficerComplaintTable
