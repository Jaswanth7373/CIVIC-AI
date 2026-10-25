/**
 * Building blocks shared by the complaint details and tracking pages (ComplaintDetail from
 * GET /api/complaints/{id}/):
 * - ComplaintMetaRow: number, status, demo flag, reported time and SLA under the page title
 * - HandledBy: department + the officer handling the complaint (from the active assignment, or the last one)
 * - StatusFacts: "who is on it / by when / what happened last" facts strip
 * - LocationCard: static mini map with OpenStreetMap / directions links and the address lines (the tracking page
 *   titles it "Work zone")
 */
import { Building2, CalendarClock, History, MapPin, Phone, UserRound } from 'lucide-react'
import { DepartmentBadge } from '@/components/complaints/DepartmentBadge'
import { SLAIndicator } from '@/components/complaints/SLAIndicator'
import { StatusBadge } from '@/components/complaints/StatusBadge'
import { MiniMap } from '@/components/maps/MiniMap'
import { safeColor } from '@/components/charts/palette'
import { Avatar } from '@/components/ui/Avatar'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { cn } from '@/utils/cn'
import { getEventMeta } from '@/utils/constants'
import { formatDateTime, timeAgo } from '@/utils/format'
import { addressLines, handlingOfficer, latestEvent } from './complaintHelpers'

export function ComplaintMetaRow({ complaint, className }) {
  return (
    <div className={cn('mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-ink-2', className)}>
      <span className="font-semibold text-ink-3 tabular">{complaint.complaint_number}</span>
      <StatusBadge status={complaint.status} label={complaint.status_display} />
      <time dateTime={complaint.created_at} title={formatDateTime(complaint.created_at)} className="tabular">
        Reported {timeAgo(complaint.created_at)}
      </time>
      <SLAIndicator
        dueAt={complaint.sla_due_at}
        status={complaint.status}
        resolvedAt={complaint.resolved_at}
        isOverdue={complaint.is_overdue}
        createdAt={complaint.created_at}
      />
    </div>
  )
}

/** Department + officer block. `size="lg"` is the roomier tracking-page variant. */
export function HandledBy({ complaint, size = 'md' }) {
  const handler = handlingOfficer(complaint)
  const officer = handler?.officer
  const assignment = handler?.assignment
  const department = complaint.department ?? officer?.department ?? null
  return (
    <div className="min-w-0 space-y-3">
      {officer ? (
        <div className="flex min-w-0 items-start gap-3">
          <Avatar src={officer.avatar} name={officer.full_name} size={size === 'lg' ? 'lg' : 'md'} decorative />
          <div className="min-w-0">
            <p className="truncate font-semibold text-ink">{officer.full_name}</p>
            {officer.designation ? <p className="text-xs text-ink-2">{officer.designation}</p> : null}
            {officer.zone ? <p className="text-xs text-ink-3">{officer.zone}</p> : null}
            {officer.phone ? (
              <a
                href={`tel:${officer.phone}`}
                className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-primary-ink hover:underline pointer-coarse:min-h-11"
              >
                <Phone aria-hidden className="size-3.5" />
                Call {officer.phone}
              </a>
            ) : null}
          </div>
        </div>
      ) : (
        <p className="flex items-center gap-2 text-sm text-ink-2">
          <UserRound aria-hidden className="size-4 text-ink-3" />
          No officer assigned yet. The department assigns one shortly.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <DepartmentBadge department={department} size="sm" />
        {assignment?.assignment_type_display ? (
          <span className="text-xs text-ink-3">{assignment.assignment_type_display}</span>
        ) : null}
      </div>
    </div>
  )
}

function Fact({ icon: Icon, label, children }) {
  return (
    <div className="min-w-0">
      <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-ink-3">
        <Icon aria-hidden className="size-3.5" />
        {label}
      </p>
      {children}
    </div>
  )
}

/** Three facts a citizen asks first: who is on it, by when, and what happened last. */
export function StatusFacts({ complaint, events, className }) {
  const latest = latestEvent(events ?? complaint.timeline)
  const latestMeta = latest ? getEventMeta(latest.event) : null
  const due = complaint.sla_due_at
  return (
    <div className={cn('grid gap-5 md:grid-cols-3', className)}>
      <Fact icon={Building2} label="Handled by">
        <HandledBy complaint={complaint} />
      </Fact>
      <Fact icon={CalendarClock} label="Service deadline">
        {complaint.status === 'rejected' ? (
          <p className="text-sm text-ink-2">No deadline applies to a rejected complaint.</p>
        ) : due ? (
          <>
            <p className="text-sm font-semibold text-ink tabular">
              <time dateTime={due}>{formatDateTime(due)}</time>
            </p>
            <SLAIndicator
              compact
              dueAt={due}
              status={complaint.status}
              resolvedAt={complaint.resolved_at}
              isOverdue={complaint.is_overdue}
              createdAt={complaint.created_at}
              className="mt-1"
            />
            {complaint.category?.name ? (
              <p className="mt-1 text-xs text-ink-3">From the service level for {complaint.category.name}.</p>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-ink-2">The deadline is set once the complaint is routed to a department.</p>
        )}
      </Fact>
      <Fact icon={History} label="Latest update">
        {latest ? (
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink">{latestMeta?.label ?? latest.event_display}</p>
            <p className="text-xs text-ink-3">
              <time dateTime={latest.timestamp} title={formatDateTime(latest.timestamp)}>
                {timeAgo(latest.timestamp)}
              </time>
              {latest.actor_label ? <span>, by {latest.actor_label}</span> : null}
            </p>
            {latest.remarks ? <p className="mt-1 line-clamp-2 text-xs text-ink-2">{latest.remarks}</p> : null}
          </div>
        ) : (
          <p className="text-sm text-ink-3">No updates yet.</p>
        )}
      </Fact>
    </div>
  )
}

export function LocationCard({ complaint, title = 'Location', className }) {
  const location = complaint.location ?? {}
  const lines = addressLines(location)
  return (
    <Card className={className}>
      <CardHeader title={title} icon={MapPin} />
      <CardBody className="space-y-3">
        <MiniMap
          lat={location.latitude}
          lng={location.longitude}
          color={safeColor(complaint.category?.color, '#0b6e4f')}
          height={180}
          label={`Map of ${complaint.complaint_number}`}
        />
        <address className="space-y-0.5 text-sm not-italic">
          {lines.street ? <p className="font-medium text-ink">{lines.street}</p> : null}
          {lines.landmark ? <p className="text-ink-2">Near {lines.landmark}</p> : null}
          {lines.locality ? <p className="text-ink-2">{lines.locality}</p> : null}
          {location.latitude != null && location.longitude != null ? (
            <p className="pt-1 text-xs text-ink-3 tabular">
              {Number(location.latitude).toFixed(6)}, {Number(location.longitude).toFixed(6)}
            </p>
          ) : null}
        </address>
      </CardBody>
    </Card>
  )
}
