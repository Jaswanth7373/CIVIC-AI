/**
 * DuplicateReviewCard - open complaints in the officer's queue that have possible duplicate reports still
 * waiting for a review (`has_pending_duplicates` on the dashboard queue rows).
 *
 * Props: { complaints: ComplaintList[], loading, className }
 *
 * Reviewing is real work reduction: a confirmed duplicate is merged into the original and leaves the queue,
 * so the card links straight to the duplicates section of each work order.
 */
import { Copy, CopyCheck } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Skeleton } from '@/components/ui/Skeleton'
import { formatNumber } from '@/utils/format'
import { complaintPath } from './officerUtils'

export function DuplicateReviewCard({ complaints = [], loading = false, className }) {
  const rows = (Array.isArray(complaints) ? complaints : []).filter((row) => row.has_pending_duplicates)

  return (
    <Card className={className}>
      <CardHeader title="Duplicates to review" icon={Copy} description="Reports the AI linked to your open complaints." />
      <CardBody>
        {loading && !rows.length ? (
          <div className="space-y-3" aria-hidden>
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : rows.length ? (
          <ul className="divide-y divide-line">
            {rows.map((row) => (
              <li key={row.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-ink tabular">{row.complaint_number}</p>
                  <p className="truncate text-xs text-ink-2" title={row.title}>
                    {row.title}
                  </p>
                </div>
                <span
                  className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-hazard-700 tabular dark:text-hazard-300"
                  title="Possible duplicate reports"
                >
                  <Copy aria-hidden className="size-3.5" />
                  {formatNumber(row.duplicate_count)}
                  <span className="sr-only"> possible duplicates</span>
                </span>
                <Button size="sm" variant="outline" to={`${complaintPath(row.id)}#duplicates`}>
                  Review
                  <span className="sr-only"> duplicates of {row.complaint_number}</span>
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={CopyCheck}
            compact
            bordered={false}
            title="Nothing to review"
            description="When the AI links a new report to one of your open complaints, it shows up here."
          />
        )}
      </CardBody>
    </Card>
  )
}

export default DuplicateReviewCard
