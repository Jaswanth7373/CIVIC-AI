/**
 * ComplaintHeader - the work-order header of the officer's complaint pages.
 *
 * Props:
 * - complaint: ComplaintDetail
 * - page: 'details' | 'resolve' | 'verify' - decides the breadcrumb trail and the default title
 * - title / description: override the heading (the details page uses the complaint title)
 * - actions: buttons on the right (they wrap below the title on phones)
 * - showMeta: the place / reported-time line (default true)
 *
 * The breadcrumb carries the complaint number, so the number is visible on every page of the work order and
 * the officer can always step back to the list or the complaint. The badge row repeats what decides the order
 * of work - status, priority, severity and the SLA clock - in the same colours as everywhere else.
 */
import { CalendarClock, MapPin } from 'lucide-react'
import { CategoryBadge } from '@/components/complaints/CategoryBadge'
import { PriorityBadge } from '@/components/complaints/PriorityBadge'
import { SeverityBadge } from '@/components/complaints/SeverityBadge'
import { SLAIndicator } from '@/components/complaints/SLAIndicator'
import { StatusBadge } from '@/components/complaints/StatusBadge'
import { PageHeader } from '@/components/ui/PageHeader'
import { formatDateTime, timeAgo } from '@/utils/format'
import { OFFICER_BASE_PATH, complaintPath, placeLine } from './officerUtils'

const PAGE_LABELS = { resolve: 'Resolution update', verify: 'Resolution verification' }

export function ComplaintHeader({ complaint, page = 'details', title, description, actions, showMeta = true }) {
  const number = complaint.complaint_number
  const breadcrumbs =
    page === 'details'
      ? [{ label: 'Assigned complaints', to: OFFICER_BASE_PATH }, { label: number }]
      : [
          { label: 'Assigned complaints', to: OFFICER_BASE_PATH },
          { label: number, to: complaintPath(complaint.id) },
          { label: PAGE_LABELS[page] },
        ]
  const heading = title ?? (page === 'details' ? complaint.title || number : PAGE_LABELS[page])
  const documentTitle = page === 'details' ? `${number} ${complaint.title ?? ''}`.trim() : `${PAGE_LABELS[page]} ${number}`
  const place = placeLine(complaint.location)

  return (
    <PageHeader breadcrumbs={breadcrumbs} title={heading} description={description} actions={actions} documentTitle={documentTitle}>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <StatusBadge status={complaint.status} label={complaint.status_display} />
        <PriorityBadge level={complaint.priority_level} score={complaint.priority_score} withLabel />
        <SeverityBadge severity={complaint.severity} withLabel />
        <SLAIndicator
          dueAt={complaint.sla_due_at}
          status={complaint.status}
          resolvedAt={complaint.resolved_at}
          isOverdue={complaint.is_overdue}
          createdAt={complaint.created_at}
        />
        <CategoryBadge category={complaint.category} />
      </div>
      {showMeta ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-2">
          {place ? (
            <span className="inline-flex min-w-0 items-start gap-1.5">
              <MapPin aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-3" />
              <span className="min-w-0">{place}</span>
            </span>
          ) : null}
          {complaint.created_at ? (
            <span className="inline-flex items-center gap-1.5">
              <CalendarClock aria-hidden className="size-4 shrink-0 text-ink-3" />
              <span>
                Reported{' '}
                <time dateTime={complaint.created_at} title={formatDateTime(complaint.created_at)}>
                  {timeAgo(complaint.created_at)}
                </time>
              </span>
            </span>
          ) : null}
        </div>
      ) : null}
    </PageHeader>
  )
}

export default ComplaintHeader
