/**
 * WorkOrderFactsCard - the service-level clock and the key dates of a complaint.
 *
 * Props: { complaint: ComplaintDetail, className }
 *
 * The SLA deadline comes from the category / department SLA set by the administrators; the indicator turns
 * yellow when less than a quarter of the window is left and red once it has passed. Lifecycle dates appear
 * only once they happened, so the list grows as the work moves on.
 */
import { CalendarClock } from 'lucide-react'
import { CategoryBadge } from '@/components/complaints/CategoryBadge'
import { DepartmentBadge } from '@/components/complaints/DepartmentBadge'
import { SLAIndicator } from '@/components/complaints/SLAIndicator'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { formatDateTime } from '@/utils/format'

function Row({ label, children }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line py-2 last:border-0 last:pb-0">
      <dt className="shrink-0 text-ink-3">{label}</dt>
      <dd className="min-w-0 text-right font-medium text-ink tabular">{children}</dd>
    </div>
  )
}

export function WorkOrderFactsCard({ complaint, className }) {
  const reportedDiffers = complaint.reported_category && complaint.category && complaint.reported_category.id !== complaint.category.id
  return (
    <Card className={className}>
      <CardHeader title="Service level and dates" icon={CalendarClock} />
      <CardBody className="pt-2">
        <dl className="text-sm">
          <Row label="SLA deadline">
            <span className="flex flex-col items-end gap-1">
              {formatDateTime(complaint.sla_due_at)}
              <SLAIndicator
                compact
                dueAt={complaint.sla_due_at}
                status={complaint.status}
                resolvedAt={complaint.resolved_at}
                isOverdue={complaint.is_overdue}
                createdAt={complaint.created_at}
              />
            </span>
          </Row>
          <Row label="Department">
            <DepartmentBadge department={complaint.department} size="sm" />
          </Row>
          <Row label="Reported">{formatDateTime(complaint.created_at)}</Row>
          {complaint.incident_at ? <Row label="Issue noticed">{formatDateTime(complaint.incident_at)}</Row> : null}
          {complaint.accepted_at ? <Row label="Accepted">{formatDateTime(complaint.accepted_at)}</Row> : null}
          {complaint.resolved_at ? <Row label="Resolved">{formatDateTime(complaint.resolved_at)}</Row> : null}
          {complaint.verified_at ? <Row label="Verified">{formatDateTime(complaint.verified_at)}</Row> : null}
          {complaint.closed_at ? <Row label="Closed">{formatDateTime(complaint.closed_at)}</Row> : null}
          {complaint.reopen_count > 0 ? (
            <Row label="Reopened">{complaint.reopen_count === 1 ? 'Once' : `${complaint.reopen_count} times`}</Row>
          ) : null}
          {reportedDiffers ? (
            <Row label="Citizen chose">
              <CategoryBadge category={complaint.reported_category} size="sm" />
            </Row>
          ) : null}
        </dl>
      </CardBody>
    </Card>
  )
}

export default WorkOrderFactsCard
