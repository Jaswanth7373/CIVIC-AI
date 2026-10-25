/**
 * ComplaintTable - complaint list as a table where there is room for it, and as ComplaintCards where there is
 * not (phones, tablets, narrow panels).
 *
 * Props:
 * - complaints: ComplaintList[] (the `results` of GET /complaints/)
 * - basePath: e.g. "/admin/complaints"; rows open `${basePath}/${id}` and the action column links there
 * - columns: column keys and/or custom DataTable column objects, in display order. Keys:
 *   number, category, location, priority, severity, status, date, action (the default set), plus
 *   citizen, officer, department, sla, updated, duplicates, confidence.
 * - loading: skeleton rows on first load, a moving lane-line bar while refreshing
 * - sort / onSortChange: server-side ordering string ("-priority_score"); priority, severity, date and
 *   updated columns are sortable and map to the API's `ordering` values
 * - onRowClick(row): overrides the default navigation
 * - empty: custom empty state node
 * - actionLabel: text of the action column's link (default "View")
 * - rowActions(row): extra controls for a row (e.g. an "Accept" button) - shown in the action column (added
 *   when the columns do not include it) and at the bottom of the row's card, so phones keep them too
 * - cardBreakpoint: where the cards give way to the table (default '@4xl': while the table itself is narrower
 *   than 56rem, which the complaint tables need without scrolling sideways; see DataTable for other values)
 * - caption: accessible table caption (default "Complaints")
 * - className
 *
 * Long titles and addresses are capped by fixed-width blocks inside their cells (browsers ignore max-width on
 * table cells in automatic table layout), so one long title cannot push the table wider than the page.
 */
import { ChevronRight, Copy, MapPin } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { Avatar } from '@/components/ui/Avatar'
import { DataTable } from '@/components/ui/DataTable'
import { EmptyState } from '@/components/ui/EmptyState'
import { cn } from '@/utils/cn'
import { formatDate, formatPercent, timeAgo } from '@/utils/format'
import { CategoryBadge } from './CategoryBadge'
import { ComplaintCard } from './ComplaintCard'
import { DepartmentBadge } from './DepartmentBadge'
import { PriorityBadge } from './PriorityBadge'
import { SeverityBadge } from './SeverityBadge'
import { SLAIndicator } from './SLAIndicator'
import { StatusBadge } from './StatusBadge'

const DEFAULT_COMPLAINT_COLUMNS = Object.freeze(['number', 'category', 'location', 'priority', 'severity', 'status', 'date', 'action'])
const DEFAULT_CARD_BREAKPOINT = '@4xl'

function joinPath(basePath, id) {
  return basePath && id != null ? `${basePath.replace(/\/+$/, '')}/${id}` : null
}

function PersonCell({ user, empty }) {
  if (!user) return <span className="text-ink-3">{empty}</span>
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Avatar src={user.avatar} name={user.full_name} size="xs" decorative />
      <span className="truncate">{user.full_name}</span>
    </span>
  )
}

/** Column definitions by key (DataTable column objects). */
function columnDefinitions(basePath, actionLabel, { slaColumn = false, rowActions } = {}) {
  return {
    number: {
      key: 'number',
      header: 'Complaint',
      render: (row) => (
        <div className="min-w-0 max-w-72">
          <p className="text-xs font-semibold text-ink-3 tabular">{row.complaint_number}</p>
          <p className="truncate font-semibold text-ink" title={row.title}>
            {row.title || row.description}
          </p>
        </div>
      ),
    },
    category: { key: 'category', header: 'Category', render: (row) => <CategoryBadge category={row.category} size="sm" /> },
    location: {
      key: 'location',
      header: 'Location',
      hideOnMobile: true,
      render: (row) => {
        const location = row.location ?? {}
        const primary = location.area || location.city || location.address
        return primary ? (
          <span className="flex min-w-0 max-w-56 items-start gap-1.5" title={location.address || primary}>
            <MapPin aria-hidden className="mt-0.5 size-3.5 shrink-0 text-ink-3" />
            <span className="min-w-0">
              <span className="block truncate">{primary}</span>
              {location.address && location.address !== primary ? (
                <span className="block truncate text-xs text-ink-3">{location.address}</span>
              ) : null}
            </span>
          </span>
        ) : (
          <span className="text-ink-3">—</span>
        )
      },
    },
    priority: {
      key: 'priority',
      header: 'Priority',
      sortable: true,
      sortKey: 'priority_score',
      render: (row) => <PriorityBadge level={row.priority_level} score={row.priority_score} size="sm" />,
    },
    severity: {
      key: 'severity',
      header: 'Severity',
      sortable: true,
      sortKey: 'severity_score',
      render: (row) => <SeverityBadge severity={row.severity} size="sm" />,
    },
    status: {
      key: 'status',
      header: 'Status',
      render: (row) => (
        <div className="flex flex-col items-start gap-1">
          <StatusBadge status={row.status} label={row.status_display} size="sm" />
          {row.is_overdue && !slaColumn ? (
            <SLAIndicator compact dueAt={row.sla_due_at} status={row.status} isOverdue createdAt={row.created_at} />
          ) : null}
        </div>
      ),
    },
    date: {
      key: 'date',
      header: 'Reported',
      sortable: true,
      sortKey: 'created_at',
      render: (row) => (
        <span className="whitespace-nowrap">
          <time dateTime={row.created_at} className="block tabular">
            {formatDate(row.created_at)}
          </time>
          <span className="block text-xs text-ink-3">{timeAgo(row.created_at)}</span>
        </span>
      ),
    },
    updated: {
      key: 'updated',
      header: 'Updated',
      sortable: true,
      sortKey: 'updated_at',
      hideOnMobile: true,
      render: (row) => (
        <time dateTime={row.updated_at} className="whitespace-nowrap text-ink-2 tabular" title={formatDate(row.updated_at)}>
          {timeAgo(row.updated_at)}
        </time>
      ),
    },
    citizen: {
      key: 'citizen',
      header: 'Citizen',
      hideOnMobile: true,
      render: (row) => <PersonCell user={row.citizen} empty="—" />,
    },
    officer: {
      key: 'officer',
      header: 'Officer',
      hideOnMobile: true,
      render: (row) => <PersonCell user={row.assigned_officer} empty="Not assigned" />,
    },
    department: {
      key: 'department',
      header: 'Department',
      hideOnMobile: true,
      render: (row) => <DepartmentBadge department={row.department} size="sm" />,
    },
    sla: {
      key: 'sla',
      header: 'SLA',
      render: (row) => (
        <SLAIndicator
          compact
          dueAt={row.sla_due_at}
          status={row.status}
          resolvedAt={row.resolved_at}
          isOverdue={row.is_overdue}
          createdAt={row.created_at}
        />
      ),
    },
    duplicates: {
      key: 'duplicates',
      header: 'Duplicates',
      align: 'right',
      hideOnMobile: true,
      render: (row) =>
        row.duplicate_count > 0 ? (
          <span
            className={cn(
              'inline-flex items-center gap-1 font-semibold tabular',
              row.has_pending_duplicates ? 'text-hazard-700 dark:text-hazard-300' : 'text-ink-2',
            )}
            title={row.has_pending_duplicates ? 'Some links still need review' : 'All links reviewed'}
          >
            <Copy aria-hidden className="size-3.5" />
            {row.duplicate_count}
          </span>
        ) : (
          <span className="text-ink-3 tabular">0</span>
        ),
    },
    confidence: {
      key: 'confidence',
      header: 'AI confidence',
      align: 'right',
      hideOnMobile: true,
      render: (row) => (
        <span className="tabular">{row.ai_confidence == null ? '—' : formatPercent(row.ai_confidence)}</span>
      ),
    },
    action: {
      key: 'action',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (row) => {
        const href = joinPath(basePath, row.id)
        const extra = rowActions?.(row)
        if (!href && !extra) return null
        return (
          <span className="inline-flex items-center justify-end gap-2">
            {extra}
            {href ? (
              <Link
                to={href}
                className="inline-flex items-center gap-0.5 whitespace-nowrap rounded-md px-2 py-1 text-sm font-semibold text-primary-ink transition-colors hover:bg-primary-soft pointer-coarse:min-h-11"
              >
                {actionLabel}
                <span className="sr-only"> {row.complaint_number}</span>
                <ChevronRight aria-hidden className="size-4" />
              </Link>
            ) : null}
          </span>
        )
      },
    },
  }
}

export function ComplaintTable({
  complaints = [],
  basePath,
  columns = DEFAULT_COMPLAINT_COLUMNS,
  loading = false,
  sort,
  onSortChange,
  onRowClick,
  empty,
  actionLabel = 'View',
  rowActions,
  cardBreakpoint = DEFAULT_CARD_BREAKPOINT,
  caption = 'Complaints',
  className,
}) {
  const navigate = useNavigate()
  const listed = Array.isArray(columns) && columns.length ? columns : DEFAULT_COMPLAINT_COLUMNS
  // Row actions live in the action column; add it when the requested columns leave it out.
  const requested = typeof rowActions === 'function' && !listed.includes('action') ? [...listed, 'action'] : listed
  const definitions = columnDefinitions(basePath, actionLabel, { slaColumn: requested.includes('sla'), rowActions })
  const resolved = requested
    .map((column) => (typeof column === 'string' ? definitions[column] : column))
    .filter(Boolean)
  const handleRowClick = onRowClick ?? (basePath ? (row) => navigate(joinPath(basePath, row.id)) : undefined)

  return (
    <DataTable
      columns={resolved}
      data={complaints}
      loading={loading}
      rowKey="id"
      sort={sort}
      onSortChange={onSortChange}
      onRowClick={handleRowClick}
      caption={caption}
      className={className}
      cardBreakpoint={cardBreakpoint}
      empty={
        empty ?? (
          <EmptyState
            bordered={false}
            compact
            icon={MapPin}
            title="No complaints match"
            description="Try clearing a filter or widening the date range."
          />
        )
      }
      mobileCard={(row) => <ComplaintCard complaint={row} interactive={false} actions={rowActions?.(row)} className="p-3.5" />}
    />
  )
}

export default ComplaintTable
