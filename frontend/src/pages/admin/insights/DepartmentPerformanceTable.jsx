/**
 * DepartmentPerformanceTable - how each department performs (GET /analytics/departments/ `[{department,
 * total, pending, in_progress, resolved, critical, overdue, avg_resolution_hours, resolution_rate (0-100),
 * sla_compliance (0-100), avg_rating, officer_count, active_workload}]`).
 *
 * Resolution rate and SLA compliance are percents with a bar each (green from 85%, yellow from 70%, orange
 * from 50%, red below - the words and the number always carry the value). Client-side sorting; phones get
 * one card per department.
 *
 * Props:
 * - data, loading
 * - className
 */
import { Star } from 'lucide-react'
import { useMemo, useState } from 'react'
import { DepartmentBadge } from '@/components/complaints'
import { DataTable } from '@/components/ui/DataTable'
import { EmptyState } from '@/components/ui/EmptyState'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { cn } from '@/utils/cn'
import { formatHours, formatNumber } from '@/utils/format'
import { formatPct, formatRating, percentTone, sortRows } from './insightUtils'

const ACCESSORS = {
  department: (row) => row.department?.name ?? '',
  open: (row) => (Number(row.pending) || 0) + (Number(row.in_progress) || 0),
  avg_rating: (row) => (row.avg_rating ? Number(row.avg_rating) : null),
}

function PercentMeter({ value, label }) {
  const number = Number(value)
  const known = value !== null && value !== undefined && Number.isFinite(number)
  return (
    <div className="min-w-32">
      <p className="text-xs font-semibold text-ink tabular">
        {known ? formatPct(number) : <span className="font-normal text-ink-3">No data</span>}
      </p>
      {known ? (
        <div aria-hidden title={`${label} ${formatPct(number)}`}>
          <ProgressBar value={number} size="sm" tone={percentTone(number)} className="mt-1" />
        </div>
      ) : null}
    </div>
  )
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

export function DepartmentPerformanceTable({ data, loading = false, className }) {
  const [sort, setSort] = useState('-total')
  const rows = useMemo(() => sortRows(data, sort, ACCESSORS), [data, sort])

  const columns = [
    {
      key: 'department',
      header: 'Department',
      sortable: true,
      render: (row) => <DepartmentBadge department={row.department} size="sm" />,
    },
    {
      key: 'total',
      header: 'Complaints',
      sortable: true,
      align: 'right',
      render: (row) => (
        <span className="whitespace-nowrap tabular">
          <span className="block font-semibold text-ink">{formatNumber(row.total)}</span>
          <span className="block text-xs text-ink-3">{formatNumber(ACCESSORS.open(row))} open</span>
        </span>
      ),
    },
    {
      key: 'resolution_rate',
      header: 'Resolution rate',
      sortable: true,
      render: (row) => <PercentMeter value={row.resolution_rate} label="Resolution rate" />,
    },
    {
      key: 'sla_compliance',
      header: 'SLA compliance',
      sortable: true,
      render: (row) => <PercentMeter value={row.sla_compliance} label="SLA compliance" />,
    },
    {
      key: 'avg_resolution_hours',
      header: 'Avg resolution',
      sortable: true,
      align: 'right',
      hideOnMobile: true,
      render: (row) => (
        <span className="whitespace-nowrap tabular">{row.resolved ? formatHours(row.avg_resolution_hours) : '—'}</span>
      ),
    },
    { key: 'avg_rating', header: 'Rating', sortable: true, align: 'right', render: (row) => <Rating value={row.avg_rating} /> },
    {
      key: 'overdue',
      header: 'Overdue',
      sortable: true,
      align: 'right',
      hideOnMobile: true,
      render: (row) => (
        <span className={cn('tabular', row.overdue ? 'font-semibold text-signal-600 dark:text-signal-300' : 'text-ink-3')}>
          {formatNumber(row.overdue)}
        </span>
      ),
    },
    {
      key: 'officer_count',
      header: 'Officers',
      sortable: true,
      align: 'right',
      hideOnMobile: true,
      render: (row) => (
        <span className="whitespace-nowrap tabular">
          <span className="block font-semibold text-ink">{formatNumber(row.officer_count)}</span>
          <span className="block text-xs text-ink-3">{formatNumber(row.active_workload)} active</span>
        </span>
      ),
    },
  ]

  return (
    <DataTable
      columns={columns}
      data={rows}
      loading={loading}
      rowKey={(row, index) => row.department?.id ?? index}
      sort={sort}
      onSortChange={setSort}
      caption="Department performance"
      className={cn('relative', className)}
      empty={
        <EmptyState
          compact
          bordered={false}
          title="No departments in this view"
          description="Clear a filter to see every department."
        />
      }
      mobileCard={(row) => (
        <div className="space-y-3 p-4">
          <div className="flex items-center justify-between gap-3">
            <DepartmentBadge department={row.department} size="sm" />
            <span className="text-xs text-ink-3 tabular">
              <span className="font-semibold text-ink">{formatNumber(row.total)}</span> complaints
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="mb-1 text-xs text-ink-3">Resolution rate</p>
              <PercentMeter value={row.resolution_rate} label="Resolution rate" />
            </div>
            <div>
              <p className="mb-1 text-xs text-ink-3">SLA compliance</p>
              <PercentMeter value={row.sla_compliance} label="SLA compliance" />
            </div>
          </div>
          <dl className="grid grid-cols-3 gap-2 text-xs">
            <div>
              <dt className="text-ink-3">Avg resolution</dt>
              <dd className="font-semibold text-ink tabular">{row.resolved ? formatHours(row.avg_resolution_hours) : '—'}</dd>
            </div>
            <div>
              <dt className="text-ink-3">Rating</dt>
              <dd>
                <Rating value={row.avg_rating} />
              </dd>
            </div>
            <div>
              <dt className="text-ink-3">Overdue</dt>
              <dd className="font-semibold text-ink tabular">{formatNumber(row.overdue)}</dd>
            </div>
          </dl>
        </div>
      )}
    />
  )
}

export default DepartmentPerformanceTable
