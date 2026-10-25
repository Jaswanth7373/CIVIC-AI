/**
 * Officer dashboard (/officer/dashboard) - page 16 of the requirements.
 *
 * One request, GET /api/analytics/dashboard/ (officer shape): totals of the complaints assigned to the
 * signed-in officer, average resolution time, workload against capacity, the open-work queue (ten complaints
 * by descending AI priority, then SLA deadline) and the latest timeline events. Every number on the page
 * comes from that response; nothing is computed from a sample.
 *
 * Reading order: the hero (greeting, the department and zone, one sentence on the open work, the next
 * action) with the headline numbers floating on its edge; then the critical complaints (risks to public
 * safety), the priority queue the officer works through, and finally workload and recent activity. The
 * hero's HQ beacon burns in the department's own colour. The headline numbers count up when they arrive; the
 * panels arrive in one short cascade when the data comes quickly, or replace their skeletons on a slow load.
 */
import {
  CircleCheck,
  ClipboardList,
  Construction,
  History,
  Hourglass,
  IdCard,
  ListChecks,
  MapPinned,
  RefreshCw,
  Siren,
  Timer,
} from 'lucide-react'
import { useMemo } from 'react'
import { DepartmentBadge } from '@/components/complaints/DepartmentBadge'
import { StaggerItem } from '@/components/motion/Stagger'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { StatCard } from '@/components/ui/StatCard'
import { useApi } from '@/hooks/useApi'
import { useAuth } from '@/hooks/useAuth'
import { Cascade } from '@/pages/shared/components/Cascade'
import { DashboardHero } from '@/pages/shared/components/DashboardHero'
import { firstNameOf, greetingFor, todayLabel } from '@/pages/shared/components/greeting'
import { useSkeletonGate } from '@/pages/shared/components/useSkeletonGate'
import { analyticsService } from '@/services/analyticsService'
import { cn } from '@/utils/cn'
import { STATUS_GROUPS } from '@/utils/constants'
import { formatHours, formatNumber } from '@/utils/format'
import { ActivityFeed } from './components/ActivityFeed'
import { CriticalCallout } from './components/CriticalCallout'
import { DuplicateReviewCard } from './components/DuplicateReviewCard'
import { OfficerComplaintTable } from './components/OfficerComplaintTable'
import { OPEN_WORK_STATUSES, complaintsLink } from './components/officerUtils'
import { useAcceptComplaint } from './components/useAcceptComplaint'
import { WorkloadMeter } from './components/WorkloadMeter'

/** One sentence on the open work, from the dashboard totals. */
function describeWork(totals) {
  if (!totals) return 'Your open complaints ranked by AI priority, with your workload and the latest updates.'
  const open = Number(totals.assigned) || 0
  const critical = Number(totals.critical) || 0
  const overdue = Number(totals.overdue) || 0
  if (!open) return 'Your queue is clear. New complaints routed to you appear here, highest priority first.'
  const orders = open === 1 ? 'one open work order' : `${formatNumber(open)} open work orders`
  const parts = []
  if (critical) parts.push(critical === 1 ? 'one is critical' : `${formatNumber(critical)} are critical`)
  if (overdue) parts.push(`${overdue === 1 ? 'one is' : `${formatNumber(overdue)} are`} past the SLA deadline`)
  if (!parts.length) return `You have ${orders}, all within the SLA deadline.`
  return `You have ${orders}: ${parts.join(' and ')}.`
}

function IdentityRow({ department, profile }) {
  if (!department && !profile) return null
  return (
    <div className="mt-3.5 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-ink-2">
      {department ? <DepartmentBadge department={department} /> : null}
      {profile?.designation ? <span className="font-medium text-ink">{profile.designation}</span> : null}
      {profile?.employee_id ? (
        <span className="inline-flex items-center gap-1.5">
          <IdCard aria-hidden className="size-4 text-ink-3" />
          <span className="sr-only">Employee ID </span>
          <span className="tabular">{profile.employee_id}</span>
        </span>
      ) : null}
      {profile?.zone ? (
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <MapPinned aria-hidden className="size-4 shrink-0 text-ink-3" />
          <span className="sr-only">Zone </span>
          <span className="min-w-0">{profile.zone}</span>
        </span>
      ) : null}
    </div>
  )
}

export default function OfficerDashboard() {
  const { user } = useAuth()
  const { data, loading, error, refetch } = useApi(() => analyticsService.dashboard(), [])
  const { accept, acceptingId } = useAcceptComplaint({ onAccepted: () => refetch() })

  const totals = data?.totals ?? {}
  const queue = useMemo(() => (Array.isArray(data?.queue) ? data.queue : []), [data])
  const critical = useMemo(() => queue.filter((row) => row.priority_level === 'critical'), [queue])
  const profile = user?.officer_profile ?? null
  const department = data?.department ?? profile?.department ?? null
  const firstLoad = loading && !data
  // Panels cascade in when the data comes quickly; on a slow load skeletons show after 300 ms instead.
  const gate = useSkeletonGate(firstLoad)
  const openCount = Number(totals.assigned) || 0

  const firstName = firstNameOf(user)
  const hero = (tilesNode) => (
    <DashboardHero
      title={`${greetingFor()}${firstName ? `, ${firstName}` : ''}`}
      documentTitle="Officer dashboard"
      kicker={todayLabel()}
      description={describeWork(data?.totals)}
      loading={firstLoad}
      meta={<IdentityRow department={department} profile={profile} />}
      beaconColor={department?.color}
      sceneKey="officer"
      actions={
        <>
          <Button
            size="lg"
            leftIcon={ClipboardList}
            to={complaintsLink({ status: OPEN_WORK_STATUSES })}
            className="flex-1 sm:flex-none"
          >
            Open work queue
          </Button>
          <Button
            variant="outline"
            size="lg"
            leftIcon={RefreshCw}
            onClick={() => refetch()}
            loading={loading && Boolean(data)}
            disabled={firstLoad}
          >
            Refresh
          </Button>
        </>
      }
    >
      {tilesNode}
    </DashboardHero>
  )

  if (error && !data) {
    return (
      <>
        {hero(null)}
        <ErrorState title="The dashboard could not be loaded" error={error} onRetry={() => refetch()} />
      </>
    )
  }

  const overdue = Number(totals.overdue) || 0
  const tiles = [
    {
      key: 'assigned',
      label: 'Assigned to me',
      value: totals.assigned,
      icon: ClipboardList,
      tone: 'neutral',
      hint: overdue ? `${formatNumber(overdue)} past the SLA deadline` : 'All within the SLA deadline',
      to: complaintsLink({ status: OPEN_WORK_STATUSES }),
    },
    {
      key: 'critical',
      label: 'Critical',
      value: totals.critical,
      icon: Siren,
      tone: 'red',
      hint: 'Highest priority, act first',
      to: complaintsLink({ status: OPEN_WORK_STATUSES, priority_level: 'critical' }),
    },
    {
      key: 'pending',
      label: 'Pending acceptance',
      value: totals.pending,
      icon: Hourglass,
      tone: 'blue',
      hint: 'Assigned or reopened, waiting for you',
      to: complaintsLink({ status: STATUS_GROUPS.pending.filter((status) => OPEN_WORK_STATUSES.includes(status)) }),
    },
    {
      key: 'in_progress',
      label: 'In progress',
      value: totals.in_progress,
      icon: Construction,
      tone: 'yellow',
      hint: 'Accepted or under way',
      to: complaintsLink({ status: STATUS_GROUPS.in_progress }),
    },
    {
      key: 'resolved',
      label: 'Resolved',
      value: totals.resolved,
      icon: CircleCheck,
      tone: 'green',
      hint: 'Resolved, verified or closed',
      to: complaintsLink({ status: STATUS_GROUPS.resolved, ordering: '-updated_at' }),
    },
    {
      key: 'avg',
      label: 'Resolution time',
      value: data?.avg_resolution_hours == null ? '—' : formatHours(data.avg_resolution_hours),
      icon: Timer,
      tone: 'neutral',
      hint: data?.avg_resolution_hours == null ? 'Shown after your first resolution' : 'Average, from report to resolution',
    },
  ]

  return (
    <>
      {hero(
        <section aria-label="Key numbers" className="app-tiles grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3 2xl:grid-cols-6">
          {tiles.map((tile) => (
            <div key={tile.key} className="min-w-0">
              <StatCard
                label={tile.label}
                value={firstLoad ? null : (tile.value ?? 0)}
                icon={tile.icon}
                tone={tile.tone}
                hint={tile.hint}
                to={tile.to}
                loading={firstLoad}
                className={cn('h-full elev-floating', tile.to && 'hover:elev-overlay')}
              />
            </div>
          ))}
        </section>,
      )}

      {/* Keyed on the first load: on a slow load the skeleton body is swapped for the real one in a single frame
          (all new nodes), so the critical callout that arrives with the data is not inserted above an
          already-visible Priority queue skeleton and nothing on screen shifts. */}
      <Cascade
        key={firstLoad ? 'first-load' : 'loaded'}
        ready={gate.cascade}
        className={cn(gate.waiting && 'invisible')}
        delay={0.12}
      >
        {critical.length ? (
          <StaggerItem index={0}>
            <CriticalCallout
              complaints={critical}
              total={totals.critical}
              currentUserId={user?.id}
              onAccept={accept}
              acceptingId={acceptingId}
              className="mb-5"
            />
          </StaggerItem>
        ) : null}

        <StaggerItem index={1}>
          <Card className="mb-5">
            <CardHeader
              title="Priority queue"
              icon={ListChecks}
              description="Open complaints assigned to you, highest AI priority first, then the nearest SLA deadline."
              actions={
                openCount > queue.length ? (
                  <Button size="sm" variant="ghost" to={complaintsLink({ status: OPEN_WORK_STATUSES })}>
                    View all {formatNumber(openCount)}
                  </Button>
                ) : null
              }
            />
            <CardBody className="p-0 sm:p-0">
              <OfficerComplaintTable
                complaints={queue}
                loading={loading}
                currentUserId={user?.id}
                onAccept={accept}
                acceptingId={acceptingId}
                caption="Priority queue"
                cardLayout="divided"
                className="rounded-none border-0"
                empty={
                  <EmptyState
                    bordered={false}
                    compact
                    icon={CircleCheck}
                    title="Your queue is clear"
                    description="New complaints routed to you appear here, ordered by priority. Meanwhile you can follow your department's complaints."
                    action={
                      <Button variant="outline" to={complaintsLink({ scope: 'department' })}>
                        View department complaints
                      </Button>
                    }
                  />
                }
              />
            </CardBody>
            {queue.length && openCount > queue.length ? (
              <p className="rounded-b-xl border-t border-line bg-surface-2 px-4 py-2.5 text-xs text-ink-3 sm:px-5">
                Showing the top {formatNumber(queue.length)} of {formatNumber(openCount)} open complaints.
              </p>
            ) : null}
          </Card>
        </StaggerItem>

        <StaggerItem index={2} className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(320px,380px)]">
          <div className="grid min-w-0 gap-5 md:grid-cols-2 md:items-start xl:order-last xl:block xl:space-y-5">
            <WorkloadMeter
              workload={data?.workload}
              pending={totals.pending}
              inProgress={totals.in_progress}
              loading={firstLoad}
            />
            <DuplicateReviewCard complaints={queue} loading={firstLoad} />
          </div>
          <Card className="xl:self-start">
            <CardHeader
              title="Recent activity"
              icon={History}
              description="The latest updates on your complaints, newest first."
            />
            <CardBody>
              <ActivityFeed events={data?.recent_activity} loading={firstLoad} />
            </CardBody>
          </Card>
        </StaggerItem>
      </Cascade>
    </>
  )
}
