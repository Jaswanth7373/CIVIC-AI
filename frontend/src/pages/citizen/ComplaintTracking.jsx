/**
 * Track complaint (/citizen/complaints/:id/track) - the LIVE view of one complaint.
 *
 * The details page is the complaint's record (title, chips, report, photo, AI analysis, the full lifecycle stepper
 * and who handles it). This page answers "what is happening now", so it does not repeat that header block: the
 * title is "Live tracking" with the complaint number and title as one quiet context line, then the status as a
 * road-sign plate with how far along the road it is (step N of 8) and the service deadline countdown, the latest
 * update as it arrives, what happens next, the work zone on a mini map and the full timeline with absolute
 * timestamps. On phones "what happens next" and the work zone come before the (long) timeline.
 *
 * Live updates: GET /api/complaints/{id}/ is polled every 30 seconds while the tab is visible (and right
 * away when the tab becomes visible again after more than 30 seconds). The page keeps showing the last data
 * during a refresh, announces new timeline events with a toast and a polite live region, and says when it
 * last checked. A failed refresh keeps the data on screen and retries on the next tick.
 *
 * Once the fix is in and waiting for the citizen's rating, the header leads straight to the rating; on phones a
 * dock carries the same button once the header has scrolled out of view.
 */
import { CircleDashed, ClipboardList, Flag, RefreshCw, Star, TriangleAlert } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { readableInk, safeColor } from '@/components/charts/palette'
import { ComplaintTimeline } from '@/components/complaints/ComplaintTimeline'
import { STEPPER_STAGES, lifecycleProgress, stepperPosition } from '@/components/complaints/lifecycle'
import { MobileActionDock } from '@/components/complaints/MobileActionDock'
import { SLAIndicator } from '@/components/complaints/SLAIndicator'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { ErrorState } from '@/components/ui/ErrorState'
import { PageHeader } from '@/components/ui/PageHeader'
import { useApi } from '@/hooks/useApi'
import { useToast } from '@/hooks/useToast'
import { complaintService } from '@/services/complaintService'
import { cn } from '@/utils/cn'
import { ACTION_LABELS, getEventMeta, getStatusMeta } from '@/utils/constants'
import { getErrorStatus } from '@/utils/errors'
import { formatDateTime, formatTime, timeAgo } from '@/utils/format'
import { LocationCard } from './components/ComplaintPanels'
import { ComplaintNotFound, ComplaintPageSkeleton } from './components/ComplaintPageStates'
import { complaintPath, latestEvent } from './components/complaintHelpers'

const REFRESH_MS = 30_000

/** What each upcoming lifecycle stop means for the citizen, said in the future tense. */
const NEXT_STEP_COPY = {
  submitted: 'Your complaint is received and stored.',
  ai_analyzed: 'The AI classifies the issue and scores how severe it is.',
  priority_assigned: 'A priority score decides how soon it is handled.',
  department_assigned: 'The complaint goes to the department responsible for it.',
  officer_assigned: 'An available officer close to the spot is assigned.',
  accepted: 'The officer accepts the work and plans the visit.',
  in_progress: 'Field work on the issue starts.',
  resolved: 'The officer fixes the issue and uploads an after photo.',
  verified: 'The AI compares the before and after photos to confirm the fix.',
  feedback: 'You rate the fix, which closes the complaint.',
}

function LiveIndicator({ refreshing, failed, checkedAt }) {
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-3" aria-live="off">
      <span className="inline-flex items-center gap-1.5 font-semibold text-ink-2">
        <span aria-hidden className="relative flex size-2">
          {!failed ? <span className="absolute inline-flex size-full animate-ping rounded-full bg-sign-400 opacity-70" /> : null}
          <span className={cn('relative inline-flex size-2 rounded-full', failed ? 'bg-hazard-500' : 'bg-sign-500')} />
        </span>
        {failed ? 'Connection problem' : 'Live'}
      </span>
      <span>
        {refreshing
          ? 'Checking for updates…'
          : failed
            ? 'The last refresh failed. Trying again in 30 seconds.'
            : `Refreshes every 30 seconds${checkedAt ? `, last checked at ${formatTime(checkedAt)}` : ''}.`}
      </span>
    </p>
  )
}

/** How far along its road the complaint is: "Step 5 of 8" over a lane-line bar (the details page has the stepper). */
function RoadProgress({ status, events }) {
  const { currentIndex, flag } = stepperPosition(status, events)
  const total = STEPPER_STAGES.length
  const step = currentIndex + 1
  const label =
    flag === 'rejected'
      ? `Stopped at step ${step} of ${total}`
      : flag === 'reopened'
        ? `Reopened: back at step ${step} of ${total}`
        : `Step ${step} of ${total}`
  return (
    <div>
      <p className="flex items-baseline justify-between gap-3 text-xs font-medium text-ink-3">
        <span>Progress</span>
        <span className="font-semibold text-ink-2 tabular">{label}</span>
      </p>
      <div
        role="progressbar"
        aria-label="Progress along the complaint's road"
        aria-valuemin={1}
        aria-valuemax={total}
        aria-valuenow={step}
        aria-valuetext={label}
        className="mt-1.5 flex h-1.5 gap-0.5"
      >
        {STEPPER_STAGES.map((stage, index) => (
          <span
            key={stage.key}
            className={cn(
              'h-full flex-1 first:rounded-l-full last:rounded-r-full',
              index < step ? (flag === 'rejected' ? 'bg-signal-500' : 'bg-primary') : 'bg-sunken',
            )}
          />
        ))}
      </div>
    </div>
  )
}

/** The newest timeline event, large: the heart of the live view. */
function LatestUpdate({ latest, failed, className }) {
  const meta = latest ? getEventMeta(latest.event) : null
  return (
    <section aria-labelledby="latest-update-heading" className={cn('min-w-0', className)}>
      <h2 id="latest-update-heading" className="flex items-center gap-2 text-xs font-medium text-ink-3">
        {/* static: the header's live indicator already pulses */}
        <span aria-hidden className={cn('inline-flex size-2 rounded-full', failed ? 'bg-hazard-500' : 'bg-sign-500')} />
        Latest update
      </h2>
      {latest ? (
        <>
          <p className="mt-1.5 font-display text-xl font-extrabold leading-tight text-ink">{meta?.label ?? latest.event_display}</p>
          <p className="mt-0.5 text-sm text-ink-2">
            <time dateTime={latest.timestamp} title={formatDateTime(latest.timestamp)}>
              {timeAgo(latest.timestamp)}
            </time>
            {latest.actor_label ? <span>, by {latest.actor_label}</span> : null}
          </p>
          {latest.remarks ? <p className="mt-2 line-clamp-3 text-sm text-ink-2">{latest.remarks}</p> : null}
        </>
      ) : (
        <p className="mt-1.5 text-sm text-ink-3">No updates yet. They appear here as soon as they happen.</p>
      )}
    </section>
  )
}

export default function ComplaintTracking() {
  const { id } = useParams()
  const toast = useToast()
  const [checkedAt, setCheckedAt] = useState(null)
  const { data: complaint, loading, error, refetch } = useApi(() => complaintService.get(id), [id], {
    onSuccess: () => setCheckedAt(new Date()),
  })

  // The header's "Give feedback": the phone dock only appears once it has scrolled out of view.
  const feedbackActionRef = useRef(null)

  // Poll while the tab is visible; catch up immediately when it becomes visible again.
  const lastRunRef = useRef(0)
  useEffect(() => {
    lastRunRef.current = Date.now()
    const tick = () => {
      lastRunRef.current = Date.now()
      refetch()
    }
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') tick()
    }, REFRESH_MS)
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastRunRef.current >= REFRESH_MS) tick()
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [id, refetch])

  const timeline = useMemo(() => complaint?.timeline ?? [], [complaint])
  const latest = useMemo(() => latestEvent(timeline), [timeline])
  const progress = useMemo(() => lifecycleProgress(timeline, complaint?.status), [timeline, complaint?.status])

  // Announce events that arrive through polling (not the ones present on first load).
  const seenLatestRef = useRef(null)
  const [announcement, setAnnouncement] = useState('')
  useEffect(() => {
    if (!latest || String(complaint?.id) !== String(id)) return
    const key = `${complaint.id}:${latest.id}`
    if (seenLatestRef.current && seenLatestRef.current !== key && seenLatestRef.current.startsWith(`${complaint.id}:`)) {
      const label = getEventMeta(latest.event).label
      toast.info('New update on your complaint', label)
      setAnnouncement(`New update: ${label}.`)
    }
    seenLatestRef.current = key
  }, [latest, complaint, id, toast])

  if (!complaint || String(complaint.id) !== String(id)) {
    if (error) {
      return getErrorStatus(error) === 404 ? (
        <ComplaintNotFound />
      ) : (
        <ErrorState title="Tracking could not be loaded" error={error} onRetry={refetch} />
      )
    }
    return <ComplaintPageSkeleton variant="tracking" />
  }

  const status = getStatusMeta(complaint.status)
  const StatusIcon = status.icon
  const statusColor = safeColor(status.color, '#52615f')
  const statusInk = readableInk(statusColor)
  const next = progress.nextStep
  const NextIcon = next?.icon ?? Flag
  const canFeedback = (complaint.allowed_actions ?? []).includes('feedback')
  const feedbackPath = `/citizen/feedback?complaint=${complaint.id}`

  return (
    <>
      <PageHeader
        back={{ to: complaintPath(complaint.id), label: 'Complaint details' }}
        title={
          <>
            Live tracking<span className="sr-only">, {complaint.complaint_number}</span>
          </>
        }
        documentTitle={`Track ${complaint.complaint_number}`}
        actions={
          <>
            {canFeedback ? (
              <Button ref={feedbackActionRef} leftIcon={Star} to={feedbackPath}>
                {ACTION_LABELS.feedback}
              </Button>
            ) : null}
            <Button variant="outline" leftIcon={ClipboardList} to={complaintPath(complaint.id)}>
              View details
            </Button>
            <Button variant="ghost" leftIcon={RefreshCw} loading={loading} onClick={() => refetch()}>
              Refresh now
            </Button>
          </>
        }
      >
        {/* one quiet context line instead of the details page's title and chips */}
        <p className="mt-1.5 max-w-3xl truncate text-sm text-ink-2" title={complaint.title || undefined}>
          <span className="font-semibold text-ink-3 tabular">{complaint.complaint_number}</span>
          {complaint.title ? (
            <>
              <span aria-hidden className="px-1.5 text-ink-3">
                ·
              </span>
              {complaint.title}
            </>
          ) : null}
        </p>
        <div className="mt-2.5">
          <LiveIndicator refreshing={loading} failed={Boolean(error)} checkedAt={checkedAt} />
        </div>
      </PageHeader>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>

      <div className="space-y-5">
        <Card className="elev-raised">
          <CardBody className="grid gap-6 sm:px-6 sm:py-6 md:grid-cols-2 md:gap-0">
            <div className="min-w-0 space-y-5 md:pr-8">
              <div className="flex items-start gap-4">
                {/* the status as a road sign plate: its colour, an inset border, the icon in readable ink */}
                <span aria-hidden className="relative grid size-14 shrink-0 place-items-center">
                  <svg viewBox="0 0 48 48" className="absolute inset-0 size-full drop-shadow-[0_6px_10px_rgb(15_22_23/0.18)]">
                    <rect x="1" y="1" width="46" height="46" rx="11" fill={statusColor} />
                    <rect x="4.5" y="4.5" width="39" height="39" rx="8" fill="none" stroke={statusInk} strokeOpacity="0.8" strokeWidth="1.6" />
                  </svg>
                  <StatusIcon className="relative size-6" style={{ color: statusInk }} strokeWidth={2.3} />
                </span>
                <div className="min-w-0">
                  <p className="text-xs font-medium text-ink-3">Current status</p>
                  <p className="font-display text-2xl font-extrabold leading-tight text-ink">{status.label}</p>
                  {status.description ? <p className="mt-1 text-sm text-ink-2">{status.description}</p> : null}
                  <SLAIndicator
                    className="mt-2.5"
                    dueAt={complaint.sla_due_at}
                    status={complaint.status}
                    resolvedAt={complaint.resolved_at}
                    isOverdue={complaint.is_overdue}
                    createdAt={complaint.created_at}
                  />
                </div>
              </div>
              <RoadProgress status={complaint.status} events={timeline} />
            </div>
            <LatestUpdate
              latest={latest}
              failed={Boolean(error)}
              className="border-t border-line pt-5 md:border-l md:border-t-0 md:pl-8 md:pt-0"
            />
          </CardBody>
        </Card>

        {error && complaint ? (
          <p role="status" className="flex items-center gap-2 text-sm text-hazard-700 dark:text-hazard-300">
            <TriangleAlert aria-hidden className="size-4" />
            Showing the last known state. The page keeps trying to refresh.
          </p>
        ) : null}

        {/* DOM order (next step, work zone, then the long timeline) is the phone order; from lg the timeline
            takes the left column and the side column sticks on the right. */}
        <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_20rem] xl:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="min-w-0 space-y-5 lg:sticky lg:top-24 lg:col-start-2 lg:row-start-1">
            <Card>
              <CardHeader title="What happens next" />
              <CardBody>
                {next ? (
                  <div className="flex items-start gap-3">
                    <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-dashed border-line-strong text-ink-2">
                      <NextIcon aria-hidden className="size-4" />
                    </span>
                    <div className="min-w-0">
                      <p className="font-semibold text-ink">{next.label}</p>
                      <p className="text-sm text-ink-2">{NEXT_STEP_COPY[next.key] ?? next.description}</p>
                      {progress.upcoming.length > 1 ? (
                        <p className="mt-1 text-xs text-ink-3">
                          {progress.upcoming.length - 1} more {progress.upcoming.length - 1 === 1 ? 'step' : 'steps'} after
                          that.
                        </p>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <p className="flex items-start gap-2 text-sm text-ink-2">
                    <CircleDashed aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-3" />
                    {complaint.status === 'rejected'
                      ? 'Nothing else is planned for this complaint. You can report the issue again with more detail.'
                      : 'This complaint has reached the end of its road.'}
                  </p>
                )}
              </CardBody>
            </Card>

            <LocationCard complaint={complaint} title="Work zone" />
          </div>

          <Card className="lg:col-start-1 lg:row-start-1">
            <CardHeader
              title="Full timeline"
              description="Every step of this complaint, oldest first, with the exact time and who acted."
            />
            <CardBody className="sm:px-6">
              <ComplaintTimeline events={timeline} status={complaint.status} />
            </CardBody>
          </Card>
        </div>
      </div>

      {canFeedback ? (
        <MobileActionDock
          label="Complaint actions"
          eyebrow={complaint.complaint_number}
          title="The fix is in. How did it go?"
          icon={Star}
          watch={feedbackActionRef}
        >
          <Button leftIcon={Star} to={feedbackPath}>
            {ACTION_LABELS.feedback}
          </Button>
        </MobileActionDock>
      ) : null}
    </>
  )
}
