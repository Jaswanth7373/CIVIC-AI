/**
 * Citizen dashboard (/citizen/dashboard).
 *
 * One request - GET /api/analytics/dashboard/ (citizen shape) - feeds the whole screen: the hero (greeting,
 * a one-sentence summary of what is open, the next action) with the four status-group counters floating on
 * its edge (each a link to the matching filtered list), the resolved complaints waiting for a rating, the
 * active complaint with its compact timeline, civic points, the latest notifications and the five most
 * recent complaints. Nothing on the page is computed from fixed numbers; empty states invite the next action
 * ("Report an issue"), and the yellow road-marking "Report an issue" button is the screen's main action.
 *
 * Motion: the counters count up once their numbers arrive. The panels below arrive in one short cascade when
 * the data comes quickly; on a slow connection skeletons show after 300 ms and the content then replaces them
 * without a second animation (useSkeletonGate). With reduced motion everything is simply there.
 */
import { CircleCheck, ClipboardList, Construction, Hourglass, MapPin, MapPinPlus, Route, Star } from 'lucide-react'
import { ComplaintTable } from '@/components/complaints/ComplaintTable'
import { StaggerItem } from '@/components/motion/Stagger'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Skeleton } from '@/components/ui/Skeleton'
import { StatCard } from '@/components/ui/StatCard'
import { useApi } from '@/hooks/useApi'
import { useAuth } from '@/hooks/useAuth'
import { Cascade } from '@/pages/shared/components/Cascade'
import { DashboardHero } from '@/pages/shared/components/DashboardHero'
import { firstNameOf, greetingFor, todayLabel } from '@/pages/shared/components/greeting'
import { useSkeletonGate } from '@/pages/shared/components/useSkeletonGate'
import { analyticsService } from '@/services/analyticsService'
import { cn } from '@/utils/cn'
import { LINKED_NUMBER_COLUMN } from './components/complaintColumns'
import { STATUS_GROUP_LINKS, trackingPath } from './components/complaintHelpers'
import { ActiveComplaintPanel, CivicPointsPanel, FeedbackRequestsStrip, LatestUpdatesPanel } from './components/DashboardPanels'

function describeTotals(totals) {
  if (!totals) return 'Your reports, where each one stands, and what needs your attention.'
  const open = (Number(totals.pending) || 0) + (Number(totals.in_progress) || 0)
  if (!totals.total) {
    return 'Spotted a pothole, an overflowing bin or a dark streetlight? Report it with a photo and the AI routes it to the right department.'
  }
  if (!open) return 'None of your complaints are open right now. New updates will appear here as they happen.'
  return `${open === 1 ? '1 complaint is' : `${open} complaints are`} still open. Every step is shown here as it happens.`
}

/** The second hero action: rate waiting fixes first, else follow the active complaint, else the list. */
function SecondaryAction({ data }) {
  const requests = Array.isArray(data?.feedback_requests) ? data.feedback_requests.filter((item) => item?.complaint) : []
  if (requests.length) {
    const to = requests.length === 1 ? `/citizen/feedback?complaint=${requests[0].complaint.id}` : '/citizen/feedback'
    return (
      <Button variant="outline" size="lg" leftIcon={Star} to={to} className="w-full sm:w-auto">
        {requests.length === 1 ? 'Rate the fix' : `Rate ${requests.length} fixes`}
      </Button>
    )
  }
  const active = data?.active_complaint?.complaint
  if (active) {
    return (
      <Button variant="outline" size="lg" leftIcon={Route} to={trackingPath(active.id)} className="w-full sm:w-auto">
        Track active complaint
      </Button>
    )
  }
  return (
    <Button variant="outline" size="lg" leftIcon={ClipboardList} to={STATUS_GROUP_LINKS.all} className="w-full sm:w-auto">
      My complaints
    </Button>
  )
}

const TILE_CLASS = 'h-full elev-floating hover:elev-overlay'

export default function CitizenDashboard() {
  const { user } = useAuth()
  const { data, loading, error, refetch } = useApi(() => analyticsService.dashboard(), [])
  const firstName = firstNameOf(user)
  const pending = !data && loading
  const totals = data?.totals
  const failed = Boolean(error && !data)
  const gate = useSkeletonGate(pending)

  return (
    <>
      <DashboardHero
        title={`${greetingFor()}${firstName ? `, ${firstName}` : ''}`}
        documentTitle="Dashboard"
        kicker={todayLabel()}
        description={describeTotals(totals)}
        loading={pending}
        sceneKey="citizen"
        actions={
          <>
            <Button variant="warning" size="lg" leftIcon={MapPinPlus} to="/citizen/report" className="w-full sm:w-auto">
              Report an issue
            </Button>
            {data ? (
              <SecondaryAction data={data} />
            ) : pending ? (
              // Holds the second action's slot (full width on phones), so the row never grows when it arrives.
              <div className="app-hero-pending w-full sm:w-44">
                <Skeleton className="h-12 w-full rounded-lg" />
              </div>
            ) : null}
          </>
        }
      >
        {failed ? null : (
          <section aria-label="Complaint counts" className="app-tiles grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-4">
            <div className="min-w-0">
              <StatCard
                label="Total"
                value={totals?.total ?? null}
                icon={ClipboardList}
                to={STATUS_GROUP_LINKS.all}
                loading={pending}
                hint={totals?.rejected ? `Including ${totals.rejected} rejected` : 'Every complaint you have filed'}
                className={TILE_CLASS}
              />
            </div>
            <div className="min-w-0">
              <StatCard
                label="Pending"
                value={totals?.pending ?? null}
                icon={Hourglass}
                tone="blue"
                to={STATUS_GROUP_LINKS.pending}
                loading={pending}
                hint="Received, work not started"
                className={TILE_CLASS}
              />
            </div>
            <div className="min-w-0">
              <StatCard
                label="In progress"
                value={totals?.in_progress ?? null}
                icon={Construction}
                tone="yellow"
                to={STATUS_GROUP_LINKS.in_progress}
                loading={pending}
                hint="An officer is on it"
                className={TILE_CLASS}
              />
            </div>
            <div className="min-w-0">
              <StatCard
                label="Resolved"
                value={totals?.resolved ?? null}
                icon={CircleCheck}
                tone="green"
                to={STATUS_GROUP_LINKS.resolved}
                loading={pending}
                hint="Fixed, verified or closed"
                className={TILE_CLASS}
              />
            </div>
          </section>
        )}
      </DashboardHero>

      {failed ? (
        <ErrorState title="Your dashboard could not be loaded" error={error} onRetry={refetch} />
      ) : (
        <Cascade ready={gate.cascade} className={cn('space-y-5', gate.waiting && 'invisible')} delay={0.12}>
          {data?.feedback_requests?.length ? (
            <StaggerItem index={0}>
              <FeedbackRequestsStrip requests={data.feedback_requests} />
            </StaggerItem>
          ) : null}

          <StaggerItem index={1} className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <ActiveComplaintPanel active={data?.active_complaint} loading={pending} />
            <div className="min-w-0 space-y-5">
              <CivicPointsPanel points={data?.civic_points} loading={pending} />
              <LatestUpdatesPanel notifications={data?.notifications} loading={pending} />
            </div>
          </StaggerItem>

          <StaggerItem index={2} as="section" aria-labelledby="recent-complaints-heading" className="min-w-0">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 id="recent-complaints-heading" className="font-display text-base font-bold text-ink">
                Recent complaints
              </h2>
              <Button variant="link" size="sm" to={STATUS_GROUP_LINKS.all}>
                View all complaints
              </Button>
            </div>
            <ComplaintTable
              complaints={data?.recent_complaints ?? []}
              loading={pending}
              basePath="/citizen/complaints"
              columns={[LINKED_NUMBER_COLUMN, 'category', 'priority', 'status', 'date']}
              caption="Your five most recent complaints"
              // `relative` makes the table frame the containing block of the sr-only labels inside cells that
              // are scrolled out of view, so they are clipped instead of widening the page.
              className="relative"
              empty={
                <EmptyState
                  bordered={false}
                  compact
                  icon={MapPin}
                  title="No complaints yet"
                  description="Report your first issue with a photo and a short description. It takes about a minute."
                  action={
                    <Button variant="warning" leftIcon={MapPinPlus} to="/citizen/report">
                      Report an issue
                    </Button>
                  }
                />
              }
            />
          </StaggerItem>
        </Cascade>
      )}
    </>
  )
}
