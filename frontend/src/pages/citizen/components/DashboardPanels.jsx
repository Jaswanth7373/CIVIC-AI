/**
 * Panels of the citizen dashboard (GET /api/analytics/dashboard/, citizen shape):
 * - ActiveComplaintPanel: the complaint still being worked on, with its compact lane-line timeline
 * - FeedbackRequestsStrip: resolved complaints waiting for the citizen's rating, each with a "Rate the fix" CTA
 * - CivicPointsPanel: the citizen's civic points and how they are earned (the backend's award rules)
 * - LatestUpdatesPanel: the five newest notifications; choosing one marks it read and opens its complaint
 */
import { Award, BellOff, Building2, CalendarClock, MapPin, MapPinPlus, Route, Star, UserRound } from 'lucide-react'
import { Link } from 'react-router-dom'
import { ComplaintTimeline } from '@/components/complaints/ComplaintTimeline'
import { CategoryBadge } from '@/components/complaints/CategoryBadge'
import { PriorityBadge } from '@/components/complaints/PriorityBadge'
import { SLAIndicator } from '@/components/complaints/SLAIndicator'
import { StatusBadge } from '@/components/complaints/StatusBadge'
import { readableInk, safeColor } from '@/components/charts/palette'
import { CountUp } from '@/components/motion/CountUp'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Skeleton } from '@/components/ui/Skeleton'
import { NotificationItem } from '@/pages/shared/components/NotificationItem'
import { useOpenNotification } from '@/pages/shared/components/useOpenNotification'
import { cn } from '@/utils/cn'
import { formatDate, formatDateTime, formatNumber, timeAgo } from '@/utils/format'
import { getIcon, renderIcon } from '@/utils/icons'
import { complaintPath, placeLabel, trackingPath } from './complaintHelpers'

const formatWhole = (value) => formatNumber(value)

/** Complaint photo, or a plate in the category colour with its icon when there is no photo. */
export function ComplaintThumb({ complaint, size = 'md', className }) {
  const sizes = { sm: 'size-11 rounded-lg', md: 'size-20 rounded-xl sm:size-24', lg: 'size-28 rounded-xl' }
  if (complaint?.thumbnail) {
    return (
      <img
        src={complaint.thumbnail}
        alt=""
        loading="lazy"
        decoding="async"
        className={cn('shrink-0 bg-sunken object-cover', sizes[size] ?? sizes.md, className)}
      />
    )
  }
  const fill = safeColor(complaint?.category?.color, '#6a7a77')
  return (
    <span
      aria-hidden
      className={cn('grid shrink-0 place-items-center', sizes[size] ?? sizes.md, className)}
      style={{ backgroundColor: fill, color: readableInk(fill) }}
    >
      {renderIcon(getIcon(complaint?.category?.icon || complaint?.category?.slug), {
        className: size === 'sm' ? 'size-5' : 'size-8',
        strokeWidth: 2,
      })}
    </span>
  )
}

function FactRow({ icon: Icon, label, children }) {
  return (
    <div className="flex items-start gap-2.5 py-1.5">
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-3" />
      <dt className="sr-only">{label}</dt>
      <dd className="min-w-0 text-sm text-ink-2">{children}</dd>
    </div>
  )
}

export function ActiveComplaintPanel({ active, loading }) {
  if (loading) {
    return (
      <Card aria-busy="true">
        <CardHeader title="Active complaint" />
        <CardBody className="grid gap-6 md:grid-cols-2">
          <div className="flex gap-4">
            <Skeleton className="size-20 shrink-0 rounded-xl sm:size-24" />
            <div className="flex-1 space-y-2.5">
              <Skeleton className="h-3 w-28" />
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          </div>
          <Skeleton lines={4} />
        </CardBody>
      </Card>
    )
  }

  if (!active?.complaint) {
    return (
      <Card>
        <CardHeader title="Active complaint" />
        <EmptyState
          bordered={false}
          compact
          icon={Route}
          title="Nothing open right now"
          description="When you report an issue, its progress from submission to the fix shows up here."
          action={
            <Button variant="outline" leftIcon={MapPinPlus} to="/citizen/report">
              Report an issue
            </Button>
          }
        />
      </Card>
    )
  }

  const { complaint, timeline } = active
  const location = complaint.location ?? {}
  return (
    // The key card of the page: raised above the flat panels, with the road marking along its top edge.
    <Card className="overflow-hidden elev-raised">
      <div aria-hidden className="lane-line-x h-[3px]" />
      <CardHeader
        title="Active complaint"
        description="Your most recent complaint that is still being worked on."
        actions={
          <Button size="sm" variant="ghost" leftIcon={Route} to={trackingPath(complaint.id)}>
            Track progress
          </Button>
        }
      />
      <CardBody className="grid gap-6 md:grid-cols-2">
        <div className="min-w-0">
          <div className="flex gap-4">
            <ComplaintThumb complaint={complaint} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold text-ink-3 tabular">{complaint.complaint_number}</span>
                <StatusBadge status={complaint.status} label={complaint.status_display} size="sm" />
              </div>
              <h3 className="mt-1 line-clamp-2 font-display text-base font-bold leading-snug text-ink">
                <Link to={complaintPath(complaint.id)} className="hover:underline">
                  {complaint.title || complaint.description}
                </Link>
              </h3>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <CategoryBadge category={complaint.category} size="sm" />
                <PriorityBadge level={complaint.priority_level} score={complaint.priority_score} size="sm" />
              </div>
            </div>
          </div>
          <dl className="mt-4 divide-y divide-line border-t border-line">
            {placeLabel(location) ? (
              <FactRow icon={MapPin} label="Location">
                {location.address || placeLabel(location)}
              </FactRow>
            ) : null}
            <FactRow icon={Building2} label="Department">
              {complaint.department?.name ?? 'Routing in progress'}
            </FactRow>
            <FactRow icon={UserRound} label="Officer">
              {complaint.assigned_officer ? (
                <>
                  <span className="font-semibold text-ink">{complaint.assigned_officer.full_name}</span> is handling it
                </>
              ) : (
                'An officer will be assigned soon'
              )}
            </FactRow>
            <FactRow icon={CalendarClock} label="Reported">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <time dateTime={complaint.created_at} title={formatDateTime(complaint.created_at)} className="tabular">
                  Reported {formatDate(complaint.created_at)}
                </time>
                <SLAIndicator
                  compact
                  dueAt={complaint.sla_due_at}
                  status={complaint.status}
                  isOverdue={complaint.is_overdue}
                  createdAt={complaint.created_at}
                />
              </span>
            </FactRow>
          </dl>
        </div>
        <div className="min-w-0 border-t border-line pt-5 md:border-l md:border-t-0 md:pl-6 md:pt-0">
          <p className="mb-3 text-xs font-semibold text-ink-3">Latest updates</p>
          <ComplaintTimeline events={timeline} status={complaint.status} compact maxEvents={4} />
        </div>
      </CardBody>
    </Card>
  )
}

export function FeedbackRequestsStrip({ requests }) {
  const list = Array.isArray(requests) ? requests.filter((item) => item?.complaint) : []
  if (!list.length) return null
  const shown = list.slice(0, 4)
  const more = list.length - shown.length
  const count = list.length
  return (
    <section aria-labelledby="feedback-requests-heading" className="rounded-xl border border-line bg-surface p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-marking-50 text-marking-700 dark:bg-marking-500/15 dark:text-marking-300">
          <Star aria-hidden className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="feedback-requests-heading" className="font-display text-base font-bold text-ink">
            {count === 1 ? '1 fix is waiting for your rating' : `${count} fixes are waiting for your rating`}
          </h2>
          <p className="mt-0.5 text-sm text-ink-2">Your rating closes the complaint and tells the department how the work went.</p>
        </div>
        {more > 0 ? (
          <Button variant="link" size="sm" to="/citizen/feedback" className="hidden shrink-0 sm:inline-flex">
            See all {count}
          </Button>
        ) : null}
      </div>
      <ul className={cn('mt-4 grid min-w-0 gap-2', shown.length > 1 ? 'md:grid-cols-2' : 'max-w-2xl')}>
        {shown.map(({ complaint, resolved_at: resolvedAt }) => (
          <li
            key={complaint.id}
            className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5 rounded-lg border border-line bg-surface-2 p-2.5 sm:grid-cols-[auto_minmax(0,1fr)_auto]"
          >
            <ComplaintThumb complaint={complaint} size="sm" />
            <div className="min-w-0">
              <p className="text-xs font-semibold text-ink-3 tabular">{complaint.complaint_number}</p>
              <p className="truncate text-sm font-semibold text-ink" title={complaint.title}>
                {complaint.title}
              </p>
              {resolvedAt ? (
                <p className="text-xs text-ink-3">
                  Resolved{' '}
                  <time dateTime={resolvedAt} title={formatDateTime(resolvedAt)}>
                    {timeAgo(resolvedAt)}
                  </time>
                </p>
              ) : null}
            </div>
            <Button
              size="sm"
              variant="secondary"
              leftIcon={Star}
              to={`/citizen/feedback?complaint=${complaint.id}`}
              className="col-span-2 sm:col-span-1"
            >
              Rate the fix
              <span className="sr-only"> for {complaint.complaint_number}</span>
            </Button>
          </li>
        ))}
      </ul>
      {more > 0 ? (
        <Button variant="link" size="sm" to="/citizen/feedback" className="mt-3 sm:hidden">
          See all {count} feedback requests
        </Button>
      ) : null}
    </section>
  )
}

const POINT_RULES = [
  { label: 'Each issue you report', points: 10 },
  { label: 'Each fix that is verified', points: 15 },
  { label: 'Each resolution you rate', points: 5 },
]

export function CivicPointsPanel({ points, loading }) {
  return (
    <Card className="p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-ink-2">Civic points</p>
          {loading ? (
            <Skeleton className="mt-2 h-9 w-24" />
          ) : (
            <CountUp
              as="p"
              value={Number(points) || 0}
              format={formatWhole}
              className="mt-2 font-display text-4xl font-extrabold leading-none tracking-tight text-ink tabular"
            />
          )}
        </div>
        <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-sign-50 text-sign-700 dark:bg-sign-500/15 dark:text-sign-300">
          <Award aria-hidden className="size-5" />
        </span>
      </div>
      <dl className="mt-4 space-y-1.5 border-t border-line pt-3 text-sm">
        {POINT_RULES.map((rule) => (
          <div key={rule.label} className="flex items-baseline justify-between gap-3">
            <dt className="text-ink-2">{rule.label}</dt>
            <dd className="font-semibold text-ink tabular">+{rule.points}</dd>
          </div>
        ))}
      </dl>
    </Card>
  )
}

export function LatestUpdatesPanel({ notifications, loading }) {
  const open = useOpenNotification()
  const list = Array.isArray(notifications) ? notifications : []
  return (
    <Card>
      <CardHeader
        title="Latest updates"
        actions={
          <Button variant="link" size="sm" to="/citizen/notifications">
            View all
          </Button>
        }
      />
      {loading ? (
        <ul aria-hidden className="divide-y divide-line">
          {[0, 1, 2].map((index) => (
            <li key={index} className="flex gap-3 px-4 py-3">
              <Skeleton circle className="size-8 shrink-0" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3.5 w-2/3" />
                <Skeleton className="h-3 w-full" />
              </div>
            </li>
          ))}
        </ul>
      ) : list.length ? (
        <ul className="divide-y divide-line">
          {list.map((notification) => (
            <NotificationItem key={notification.id} notification={notification} onOpen={open} compact />
          ))}
        </ul>
      ) : (
        <EmptyState
          bordered={false}
          compact
          icon={BellOff}
          titleAs="p"
          title="No updates yet"
          description="Every step of your complaints, from AI analysis to the fix, is announced here."
        />
      )}
    </Card>
  )
}
