/**
 * WorkloadDrawer - what an officer is working on right now.
 *
 * Data: GET /officers/{id}/workload/ -> `{active, capacity, utilization (0..1), overloaded, critical,
 * by_status: {assigned, accepted, in_progress, reopened}, complaints: [ComplaintList] (open queue, highest
 * priority first)}`. The status split is one stacked bar in the lifecycle status colours with a labelled
 * legend (the counts are also written out), and each open complaint links to its admin page.
 *
 * Props: open, onClose, officer (OfficerOut | null), onEdit(officer)
 */
import { ClipboardCheck, Pencil, Siren } from 'lucide-react'
import { ComplaintCard, DepartmentBadge } from '@/components/complaints'
import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { Drawer } from '@/components/ui/Drawer'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Skeleton } from '@/components/ui/Skeleton'
import { useApi } from '@/hooks/useApi'
import { officerService } from '@/services'
import { cn } from '@/utils/cn'
import { STATUS_META } from '@/utils/constants'
import { formatHours, formatNumber } from '@/utils/format'
import { WorkloadBar } from '../shared/WorkloadBar'

const STATUS_KEYS = ['assigned', 'accepted', 'in_progress', 'reopened']

function StatusSplit({ byStatus }) {
  const entries = STATUS_KEYS.map((key) => ({ key, value: Number(byStatus?.[key]) || 0, meta: STATUS_META[key] }))
  const total = entries.reduce((sum, entry) => sum + entry.value, 0)
  if (!total) return null
  return (
    <div>
      <p className="mb-2 text-xs font-medium text-ink-3">Open work by status</p>
      <div className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full" aria-hidden>
        {entries
          .filter((entry) => entry.value > 0)
          .map((entry) => (
            <span key={entry.key} className="h-full first:rounded-l-full last:rounded-r-full" style={{ flexBasis: `${(entry.value / total) * 100}%`, backgroundColor: entry.meta.color }} />
          ))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
        {entries.map((entry) => (
          <li key={entry.key} className={cn('flex items-center gap-1.5', !entry.value && 'text-ink-3')}>
            <span aria-hidden className="size-2.5 rounded-[2px]" style={{ backgroundColor: entry.meta.color }} />
            <span className="font-semibold text-ink tabular">{formatNumber(entry.value)}</span>
            {entry.meta.label}
          </li>
        ))}
      </ul>
    </div>
  )
}

function Figure({ label, value, tone }) {
  return (
    <div className="rounded-lg bg-surface-2 px-3 py-2.5">
      <p className="text-xs text-ink-3">{label}</p>
      <p className={cn('mt-0.5 font-display text-xl font-extrabold tabular', tone === 'red' ? 'text-signal-600 dark:text-signal-300' : 'text-ink')}>
        {value}
      </p>
    </div>
  )
}

export function WorkloadDrawer({ open, onClose, officer, onEdit }) {
  const officerId = officer?.id
  const workload = useApi(
    () => officerService.workload(officerId).then((result) => ({ ...result, officerId })),
    [officerId],
    { immediate: open && officerId != null },
  )
  // Never show the previous officer's numbers while another officer's workload is loading.
  const data = workload.data?.officerId === officerId ? workload.data : null
  const complaints = Array.isArray(data?.complaints) ? data.complaints : []
  const name = officer?.user?.full_name ?? 'Officer'

  return (
    <Drawer
      open={open}
      onClose={onClose}
      side="right"
      size="lg"
      title="Workload"
      description={officer ? `${name}, ${officer.designation || 'officer'}` : undefined}
      footer={
        officer ? (
          <Button variant="outline" leftIcon={Pencil} onClick={() => onEdit?.(officer)}>
            Edit officer
          </Button>
        ) : null
      }
    >
      {officer ? (
        <div className="space-y-6">
          <div className="flex items-center gap-3">
            <Avatar src={officer.user?.avatar} name={name} size="lg" decorative />
            <div className="min-w-0">
              <p className="font-display text-lg font-bold text-ink">{name}</p>
              <p className="text-xs text-ink-3 tabular">{[officer.employee_id, officer.zone].filter(Boolean).join(', ')}</p>
              {officer.department ? <DepartmentBadge department={officer.department} size="sm" className="mt-1.5" /> : null}
            </div>
          </div>

          {workload.error && !data ? (
            <ErrorState compact title="The workload could not be loaded" error={workload.error} onRetry={() => workload.refetch()} />
          ) : !data ? (
            <div aria-hidden className="space-y-3">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : (
            <>
              <WorkloadBar active={data.active} capacity={data.capacity} utilization={data.utilization} overloaded={data.overloaded} />
              <div className="grid grid-cols-3 gap-2">
                <Figure label="Open now" value={formatNumber(data.active)} />
                <Figure label="Critical" value={formatNumber(data.critical)} tone={data.critical ? 'red' : undefined} />
                <Figure label="Avg. resolution" value={formatHours(officer.avg_resolution_hours)} />
              </div>
              <StatusSplit byStatus={data.by_status} />

              <section>
                <h3 className="mb-2 flex items-center gap-2 text-sm font-bold text-ink">
                  Open complaints
                  {data.critical ? (
                    <span className="inline-flex items-center gap-1 text-xs font-semibold text-signal-600 dark:text-signal-300">
                      <Siren aria-hidden className="size-3.5" />
                      {formatNumber(data.critical)} critical
                    </span>
                  ) : null}
                </h3>
                {complaints.length ? (
                  <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
                    {complaints.map((complaint) => (
                      <li key={complaint.id}>
                        <ComplaintCard complaint={complaint} basePath="/admin/complaints" className="p-3.5" />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <EmptyState
                    compact
                    icon={ClipboardCheck}
                    title="No open complaints"
                    description={`${name} has nothing assigned right now and can take new work.`}
                  />
                )}
              </section>
            </>
          )}
        </div>
      ) : null}
    </Drawer>
  )
}

export default WorkloadDrawer
