/**
 * OfficerWorkloadTable - every officer's live load and track record (GET /analytics/officers/
 * `[{officer: OfficerMini, department, active, capacity, utilization (0-1), overloaded, is_available,
 * resolved_total, resolved_30d, avg_resolution_hours, avg_rating, critical_active}]`).
 *
 * Workload is "active / capacity" with the shared WorkloadBar, so it reads exactly like the officer list and the
 * officer's own dashboard: green while there is room, yellow "Near capacity" from 80 %, red "Over capacity" when
 * overloaded (more active complaints than capacity). Columns sort on the client (the list is complete); phones
 * get one card per officer.
 *
 * Props:
 * - data, loading
 * - className
 */
import { Star } from 'lucide-react'
import { useMemo, useState } from 'react'
import { DepartmentBadge } from '@/components/complaints'
import { Avatar } from '@/components/ui/Avatar'
import { Badge } from '@/components/ui/Badge'
import { DataTable } from '@/components/ui/DataTable'
import { EmptyState } from '@/components/ui/EmptyState'
import { cn } from '@/utils/cn'
import { formatHours, formatNumber } from '@/utils/format'
import { WorkloadBar } from '../manage/shared/WorkloadBar'
import { formatRating, sortRows } from './insightUtils'

const ACCESSORS = {
  name: (row) => row.officer?.full_name ?? '',
  department: (row) => row.department?.name ?? '',
  utilization: (row) => (row.overloaded ? 10 : 0) + (Number(row.utilization) || 0),
  avg_rating: (row) => (row.avg_rating ? Number(row.avg_rating) : null),
  avg_resolution_hours: (row) => (row.resolved_total ? row.avg_resolution_hours : null),
}

function Workload({ row, compact = false }) {
  return (
    <WorkloadBar
      active={row.active}
      capacity={row.capacity}
      utilization={row.utilization}
      overloaded={row.overloaded}
      compact={compact}
      className="min-w-40"
    />
  )
}

/** Average resolution time; officers who have not resolved anything yet have no average. */
function avgHours(row) {
  return row.resolved_total && row.avg_resolution_hours != null ? formatHours(row.avg_resolution_hours) : '—'
}

function Rating({ value }) {
  if (!value) return <span className="text-xs text-ink-3">No ratings</span>
  return (
    <span className="inline-flex items-center gap-1 font-semibold text-ink tabular">
      <Star aria-hidden className="size-3.5 fill-marking-500 text-marking-500" />
      {formatRating(value)}
    </span>
  )
}

function Availability({ available }) {
  return available ? (
    <Badge tone="green" size="sm" dot>
      Available
    </Badge>
  ) : (
    <Badge tone="neutral" size="sm" dot>
      Unavailable
    </Badge>
  )
}

export function OfficerWorkloadTable({ data, loading = false, className }) {
  const [sort, setSort] = useState('-utilization')
  const rows = useMemo(() => sortRows(data, sort, ACCESSORS), [data, sort])

  const columns = [
    {
      key: 'name',
      header: 'Officer',
      sortable: true,
      render: (row) => (
        <div className="flex min-w-44 items-center gap-2.5">
          <Avatar src={row.officer?.avatar} name={row.officer?.full_name} size="sm" decorative />
          <div className="min-w-0">
            <p className="truncate font-semibold text-ink">{row.officer?.full_name}</p>
            <p className="truncate text-xs text-ink-3 tabular" title={row.officer?.designation || undefined}>
              {row.officer?.employee_id || row.officer?.email}
            </p>
          </div>
        </div>
      ),
    },
    {
      key: 'department',
      header: 'Department',
      sortable: true,
      hideOnMobile: true,
      render: (row) => <DepartmentBadge department={row.department} size="sm" />,
    },
    { key: 'utilization', header: 'Workload', sortable: true, render: (row) => <Workload row={row} compact /> },
    {
      key: 'critical_active',
      header: 'Critical',
      sortable: true,
      align: 'right',
      render: (row) => (
        <span
          className={cn('tabular', row.critical_active ? 'font-semibold text-signal-600 dark:text-signal-300' : 'text-ink-3')}
        >
          {formatNumber(row.critical_active)}
        </span>
      ),
    },
    {
      key: 'resolved_total',
      header: 'Resolved',
      sortable: true,
      align: 'right',
      render: (row) => (
        <span className="whitespace-nowrap tabular">
          <span className="block font-semibold text-ink">{formatNumber(row.resolved_total)}</span>
          <span className="block text-xs text-ink-3">{formatNumber(row.resolved_30d)} in 30 days</span>
        </span>
      ),
    },
    {
      key: 'avg_resolution_hours',
      header: 'Avg time',
      sortable: true,
      align: 'right',
      render: (row) => <span className="whitespace-nowrap tabular">{avgHours(row)}</span>,
    },
    { key: 'avg_rating', header: 'Rating', sortable: true, align: 'right', render: (row) => <Rating value={row.avg_rating} /> },
    { key: 'is_available', header: 'Status', hideOnMobile: true, render: (row) => <Availability available={row.is_available} /> },
  ]

  return (
    <DataTable
      columns={columns}
      data={rows}
      loading={loading}
      rowKey={(row, index) => row.officer?.id ?? index}
      sort={sort}
      onSortChange={setSort}
      caption="Officer workload and track record"
      className={cn('relative', className)}
      empty={
        <EmptyState
          compact
          bordered={false}
          title="No officers in this view"
          description="Officers appear here once they are added to a department."
        />
      }
      mobileCard={(row) => (
        <div className="space-y-2.5 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <Avatar src={row.officer?.avatar} name={row.officer?.full_name} size="sm" decorative />
              <div className="min-w-0">
                <p className="truncate font-semibold text-ink">{row.officer?.full_name}</p>
                <p className="truncate text-xs text-ink-3 tabular">{row.officer?.employee_id}</p>
              </div>
            </div>
            <Availability available={row.is_available} />
          </div>
          <DepartmentBadge department={row.department} size="sm" />
          <Workload row={row} />
          <dl className="grid grid-cols-4 gap-2 text-xs">
            <div>
              <dt className="text-ink-3">Critical</dt>
              <dd className="font-semibold text-ink tabular">{formatNumber(row.critical_active)}</dd>
            </div>
            <div>
              <dt className="text-ink-3">Resolved</dt>
              <dd className="font-semibold text-ink tabular">{formatNumber(row.resolved_total)}</dd>
            </div>
            <div>
              <dt className="text-ink-3">Avg time</dt>
              <dd className="font-semibold text-ink tabular">{avgHours(row)}</dd>
            </div>
            <div>
              <dt className="text-ink-3">Rating</dt>
              <dd>
                <Rating value={row.avg_rating} />
              </dd>
            </div>
          </dl>
        </div>
      )}
    />
  )
}

export default OfficerWorkloadTable
