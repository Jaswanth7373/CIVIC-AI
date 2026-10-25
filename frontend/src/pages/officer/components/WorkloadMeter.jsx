/**
 * WorkloadMeter - the officer's open work against their capacity (`max_active_complaints`).
 *
 * Props:
 * - workload: `{active, capacity, utilization (0..1), overloaded}` from the officer dashboard
 * - pending / inProgress: open complaints waiting for acceptance / accepted or under way (dashboard totals)
 * - loading
 * - className
 *
 * Reading: one slot per complaint the officer can carry. Filled slots take the colour of their status
 * (assigned blue, in progress yellow - the same colours as the status badges), empty slots are free
 * capacity. The load level is spelled out in a labelled badge with an icon (never colour alone):
 * under 80% "Room for new work", from 80% "Near capacity", above capacity "Over capacity". With a very large
 * capacity the slots become a continuous bar so they stay readable.
 *
 * Motion: the first time the meter is seen, the filled slots light up one after another, like a column of
 * lane studs switching on (reduced motion: all at once).
 */
import { CircleCheck, Gauge, Siren, TriangleAlert } from 'lucide-react'
import { useRef } from 'react'
import { useInViewOnce } from '@/components/motion/hooks'
import { Badge } from '@/components/ui/Badge'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Skeleton } from '@/components/ui/Skeleton'
import { cn } from '@/utils/cn'
import { STATUS_META } from '@/utils/constants'
import { formatNumber, formatPercent } from '@/utils/format'

const MAX_SLOTS = 30

const LEVELS = {
  ok: { label: 'Room for new work', tone: 'green', icon: CircleCheck },
  high: { label: 'Near capacity', tone: 'yellow', icon: TriangleAlert },
  over: { label: 'Over capacity', tone: 'red', icon: Siren },
}

function levelOf(workload) {
  if (workload?.overloaded) return 'over'
  return Number(workload?.utilization) >= 0.8 ? 'high' : 'ok'
}

function Slots({ pending, inProgress, capacity, active }) {
  const ref = useRef(null)
  const seen = useInViewOnce(ref, { amount: 0.8, margin: '0px' })
  const total = Math.max(capacity, active)
  if (total <= 0) return <div className="h-3 rounded-full bg-sunken" aria-hidden />
  if (total > MAX_SLOTS) {
    const share = (value) => `${Math.min(100, (value / total) * 100)}%`
    return (
      <div aria-hidden className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full bg-sunken">
        <span className="h-full" style={{ width: share(pending), backgroundColor: STATUS_META.assigned.color }} />
        <span className="h-full" style={{ width: share(inProgress), backgroundColor: STATUS_META.in_progress.color }} />
      </div>
    )
  }
  return (
    <div ref={ref} aria-hidden className="flex h-3 w-full gap-0.5">
      {Array.from({ length: total }, (_, index) => {
        const color = index < pending ? STATUS_META.assigned.color : index < pending + inProgress ? STATUS_META.in_progress.color : null
        const beyond = index >= capacity
        return (
          <span
            key={index}
            className={cn(
              'h-full min-w-0 flex-1 first:rounded-l-full last:rounded-r-full',
              !color && 'bg-sunken',
              beyond && 'outline-2 -outline-offset-2 outline-signal-500',
              color && (seen ? 'animate-pop-in motion-reduce:animate-none' : 'opacity-0'),
            )}
            style={color ? { backgroundColor: color, animationDelay: `${index * 55}ms` } : undefined}
          />
        )
      })}
    </div>
  )
}

export function WorkloadMeter({ workload, pending = 0, inProgress = 0, loading = false, className }) {
  const active = Math.max(0, Number(workload?.active) || 0)
  const capacity = Math.max(0, Number(workload?.capacity) || 0)
  const waiting = Math.min(Math.max(0, Number(pending) || 0), active)
  const working = Math.min(Math.max(0, Number(inProgress) || 0), active - waiting)
  const free = Math.max(0, capacity - active)
  const over = Math.max(0, active - capacity)
  const level = LEVELS[levelOf(workload)]

  return (
    <Card className={className}>
      <CardHeader
        title="Workload"
        icon={Gauge}
        description="Open complaints against your capacity."
        actions={
          loading || !workload ? null : (
            <Badge tone={level.tone} icon={level.icon} size="sm">
              {level.label}
            </Badge>
          )
        }
      />
      <CardBody>
        {loading && !workload ? (
          <div className="space-y-3" aria-hidden>
            <Skeleton className="h-8 w-32" />
            <Skeleton className="h-3 w-full" />
            <Skeleton lines={3} />
          </div>
        ) : (
          <>
            <div className="mb-3 flex items-end justify-between gap-3">
              <p className="font-display text-3xl font-extrabold leading-none text-ink tabular">
                {formatNumber(active)}
                <span className="ml-1 text-base font-bold text-ink-3">/ {formatNumber(capacity)}</span>
              </p>
              <p className="text-right text-sm text-ink-2">
                <span className="font-semibold text-ink tabular">{formatPercent(workload?.utilization)}</span> of capacity
              </p>
            </div>
            <div
              role="meter"
              aria-label="Workload"
              aria-valuemin={0}
              aria-valuemax={capacity || 1}
              aria-valuenow={active}
              aria-valuetext={`${active} of ${capacity} complaints, ${level.label}`}
            >
              <Slots pending={waiting} inProgress={working} capacity={capacity} active={active} />
            </div>
            <dl className="mt-4 space-y-2 text-sm">
              <div className="flex items-center justify-between gap-3">
                <dt className="flex items-center gap-2 text-ink-2">
                  <span aria-hidden className="size-2.5 rounded-[3px]" style={{ backgroundColor: STATUS_META.assigned.color }} />
                  Waiting for acceptance
                </dt>
                <dd className="font-semibold text-ink tabular">{formatNumber(waiting)}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="flex items-center gap-2 text-ink-2">
                  <span aria-hidden className="size-2.5 rounded-[3px]" style={{ backgroundColor: STATUS_META.in_progress.color }} />
                  Accepted or in progress
                </dt>
                <dd className="font-semibold text-ink tabular">{formatNumber(working)}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="flex items-center gap-2 text-ink-2">
                  <span aria-hidden className="size-2.5 rounded-[3px] bg-sunken ring-1 ring-inset ring-line-strong" />
                  {over ? 'Over capacity by' : 'Free capacity'}
                </dt>
                <dd className={cn('font-semibold tabular', over ? 'text-signal-600 dark:text-signal-300' : 'text-ink')}>
                  {formatNumber(over || free)}
                </dd>
              </div>
            </dl>
          </>
        )}
      </CardBody>
    </Card>
  )
}

export default WorkloadMeter
