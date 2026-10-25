/**
 * AssignmentCard - why this complaint landed with this officer.
 *
 * Props: { assignment: Assignment | null, history: Assignment[], mine: the viewer is the assigned officer, className }
 *
 * The officer recommendation (BUILD_SPEC 3.4) scores the department's officers on free capacity, distance to
 * the site, availability and track record; the human-readable reasons are stored with the assignment. A
 * manual assignment or reassignment by an administrator shows who made it and their notes instead.
 */
import { Check, UserCheck } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { ASSIGNMENT_STATUS_META, ASSIGNMENT_TYPE_LABELS } from '@/utils/constants'
import { formatDateTime, formatPercent } from '@/utils/format'

export function AssignmentCard({ assignment, history = [], mine = true, className }) {
  const earlier = (Array.isArray(history) ? history : []).filter((item) => item && item.id !== assignment?.id)
  const status = assignment ? ASSIGNMENT_STATUS_META[assignment.status] : null
  const reasons = Array.isArray(assignment?.recommendation_reasons) ? assignment.recommendation_reasons.filter(Boolean) : []
  const score = Number(assignment?.recommendation_score)

  return (
    <Card className={className}>
      <CardHeader title="Assignment" icon={UserCheck} />
      <CardBody className="space-y-4">
        {assignment ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="blue" size="sm">
                {assignment.assignment_type_display || ASSIGNMENT_TYPE_LABELS[assignment.assignment_type] || 'Assignment'}
              </Badge>
              {status ? (
                <Badge tone={status.tone} size="sm">
                  {assignment.status_display || status.label}
                </Badge>
              ) : null}
              <span className="text-xs text-ink-3 tabular">
                {assignment.assigned_by ? `By ${assignment.assigned_by.full_name}, ` : ''}
                {formatDateTime(assignment.assigned_at)}
              </span>
            </div>
            {Number.isFinite(score) && score > 0 ? (
              <ProgressBar
                value={score * 100}
                max={100}
                tone="blue"
                size="sm"
                label="Recommendation score"
                showValue
                valueLabel={formatPercent(score)}
              />
            ) : null}
            {reasons.length ? (
              <div>
                <p className="mb-1.5 text-xs font-semibold text-ink-2">
                  {mine ? 'Why you were recommended' : `Why ${assignment.officer?.full_name ?? 'this officer'} was recommended`}
                </p>
                <ul className="space-y-1 text-sm text-ink-2">
                  {reasons.map((reason) => (
                    <li key={reason} className="flex items-start gap-2">
                      <Check aria-hidden className="mt-0.5 size-3.5 shrink-0 text-sign-600 dark:text-sign-300" />
                      <span>{reason}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {assignment.notes ? (
              <p className="rounded-lg border-l-[3px] border-line-strong bg-surface-2 px-3 py-2 text-sm text-ink-2">{assignment.notes}</p>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-ink-3">No officer is assigned to this complaint at the moment.</p>
        )}
        {earlier.length ? (
          <p className="border-t border-line pt-3 text-xs text-ink-3">
            {earlier.length === 1 ? 'One earlier assignment' : `${earlier.length} earlier assignments`}:{' '}
            {earlier
              .map((item) => `${item.officer?.full_name ?? 'Officer'} (${(item.status_display || item.status || '').toLowerCase()})`)
              .join(', ')}
          </p>
        ) : null}
      </CardBody>
    </Card>
  )
}

export default AssignmentCard
