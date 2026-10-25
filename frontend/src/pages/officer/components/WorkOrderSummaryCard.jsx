/**
 * WorkOrderSummaryCard - the complaint in a nutshell, for the side column of the resolution pages: photo,
 * number, title, category, priority, status, place and a way back to the full work order.
 *
 * Props: { complaint: ComplaintDetail, className }
 */
import { ClipboardList, MapPin } from 'lucide-react'
import { CategoryBadge } from '@/components/complaints/CategoryBadge'
import { PriorityBadge } from '@/components/complaints/PriorityBadge'
import { StatusBadge } from '@/components/complaints/StatusBadge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { citizenPhoto, complaintPath, placeLine } from './officerUtils'

export function WorkOrderSummaryCard({ complaint, className }) {
  const photo = citizenPhoto(complaint)
  const place = placeLine(complaint.location)
  return (
    <Card className={className}>
      <CardHeader title="Work order" icon={ClipboardList} />
      <CardBody className="space-y-3">
        {photo ? (
          <img
            src={photo}
            alt={`Citizen's photo: ${complaint.title || complaint.complaint_number}`}
            className="aspect-video w-full rounded-lg bg-sunken object-cover"
            loading="lazy"
          />
        ) : null}
        <div className="min-w-0">
          <p className="text-xs font-semibold text-ink-3 tabular">{complaint.complaint_number}</p>
          <p className="font-semibold text-ink">{complaint.title || complaint.description}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge status={complaint.status} label={complaint.status_display} size="sm" />
          <PriorityBadge level={complaint.priority_level} score={complaint.priority_score} size="sm" />
          <CategoryBadge category={complaint.category} size="sm" />
        </div>
        {place ? (
          <p className="flex items-start gap-1.5 text-sm text-ink-2">
            <MapPin aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-3" />
            <span className="min-w-0">{place}</span>
          </p>
        ) : null}
        <Button variant="outline" size="sm" fullWidth to={complaintPath(complaint.id)}>
          Open full work order
        </Button>
      </CardBody>
    </Card>
  )
}

export default WorkOrderSummaryCard
