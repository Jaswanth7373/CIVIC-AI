/**
 * SimilarReports - result of the "is this already reported?" check on the review step
 * (useSimilarReports -> POST /api/ai/duplicates/).
 *
 * Props:
 * - similar: `{status, items, error, retry}` from useSimilarReports
 * - ownIds: Set of the citizen's own complaint ids (useOwnComplaintIds)
 *
 * When matches exist the panel says "Similar issue already reported nearby" and lists them, best match
 * first, with the overall match, distance, status and category. The citizen's own complaints link to their
 * detail page (in a new tab, so the report being written is not lost); complaints filed by other citizens
 * cannot be opened from this account, so "View report" shows what the check returned in a dialog. The
 * check is advisory: submitting is never blocked.
 */
import { CopyCheck, ExternalLink, Eye, MapPin, RotateCcw, Copy, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { CategoryBadge } from '@/components/complaints/CategoryBadge'
import { PriorityBadge } from '@/components/complaints/PriorityBadge'
import { StatusBadge } from '@/components/complaints/StatusBadge'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { Spinner } from '@/components/ui/Spinner'
import { toRatio } from '@/components/ai/aiUtils'
import { getErrorMessage } from '@/utils/errors'
import { formatDate, formatDistance, formatPercent } from '@/utils/format'
import { ComplaintThumb } from '../DashboardPanels'
import { addressLines, complaintPath } from '../complaintHelpers'

function MatchBar({ label, value, missing }) {
  const ratio = toRatio(value)
  if (ratio == null) {
    return (
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-medium text-ink-2">{label}</span>
        <span className="text-ink-3">{missing}</span>
      </div>
    )
  }
  return <ProgressBar value={ratio * 100} tone="blue" size="sm" label={label} showValue valueLabel={formatPercent(ratio)} />
}

function SimilarReportModal({ item, own, onClose }) {
  const complaint = item?.complaint
  const lines = addressLines(complaint?.location)
  return (
    <Modal
      open={Boolean(item)}
      onClose={onClose}
      size="lg"
      title={complaint ? complaint.title || complaint.complaint_number : 'Similar report'}
      description={complaint ? `${complaint.complaint_number}, reported ${formatDate(complaint.created_at)}` : undefined}
      footer={
        <>
          {own && complaint ? (
            <Button variant="outline" leftIcon={ExternalLink} to={complaintPath(complaint.id)} target="_blank" rel="noopener noreferrer">
              Open your complaint
            </Button>
          ) : null}
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      {complaint ? (
        <div className="space-y-4">
          {complaint.thumbnail ? (
            <img
              src={complaint.thumbnail}
              alt={`Photo of ${complaint.complaint_number}`}
              className="max-h-72 w-full rounded-xl bg-sunken object-cover"
            />
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={complaint.status} label={complaint.status_display} size="sm" />
            <CategoryBadge category={complaint.category} size="sm" />
            {complaint.priority_level ? (
              <PriorityBadge level={complaint.priority_level} score={complaint.priority_score} size="sm" />
            ) : null}
          </div>
          {complaint.description ? <p className="text-sm text-ink">{complaint.description}</p> : null}
          {lines.street || lines.locality ? (
            <p className="flex items-start gap-1.5 text-sm text-ink-2">
              <MapPin aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-3" />
              <span>
                {[lines.street, lines.locality].filter(Boolean).join(', ')}
                {item.distance_m != null ? (
                  <span className="text-ink-3 tabular"> ({formatDistance(item.distance_m)} from your pin)</span>
                ) : null}
              </span>
            </p>
          ) : null}
          <div className="rounded-xl bg-surface-2 p-4">
            <p className="mb-3 flex items-baseline justify-between gap-3 text-sm">
              <span className="font-semibold text-ink">How closely it matches your report</span>
              <span className="font-display text-xl font-extrabold text-ink tabular">{formatPercent(item.overall_similarity)}</span>
            </p>
            <div className="grid gap-2.5 sm:grid-cols-3">
              <MatchBar label="Description" value={item.text_similarity} />
              <MatchBar label="Photo" value={item.image_similarity} missing="No photo to compare" />
              <MatchBar label="Location" value={item.location_similarity} />
            </div>
            {item.explanation ? <p className="mt-3 text-xs text-ink-3">{item.explanation}</p> : null}
          </div>
          {!own ? (
            <p className="text-xs text-ink-3">
              Another citizen filed this report, so it cannot be opened from your account. The department already has it on
              record.
            </p>
          ) : null}
        </div>
      ) : null}
    </Modal>
  )
}

function SimilarItem({ item, own, onView }) {
  const complaint = item.complaint
  return (
    <li className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-3 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 gap-3">
        <ComplaintThumb complaint={complaint} size="sm" className="size-14" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-ink-3 tabular">{complaint.complaint_number}</span>
            <StatusBadge status={complaint.status} label={complaint.status_display} size="sm" />
            {own ? <span className="text-xs font-semibold text-primary-ink">Your report</span> : null}
          </div>
          <p className="mt-0.5 line-clamp-2 text-sm font-semibold text-ink">{complaint.title || complaint.description}</p>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
            <CategoryBadge category={complaint.category} size="sm" />
            {item.distance_m != null ? (
              <span className="inline-flex items-center gap-1 tabular">
                <MapPin aria-hidden className="size-3.5" />
                {formatDistance(item.distance_m)} away
              </span>
            ) : null}
            <span className="tabular">Reported {formatDate(complaint.created_at)}</span>
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-line pt-3 sm:flex-col sm:items-end sm:border-t-0 sm:pt-0">
        <p className="text-right leading-none">
          <span className="font-display text-xl font-extrabold text-ink tabular">{formatPercent(item.overall_similarity)}</span>
          <span className="ml-1 text-xs text-ink-3">match</span>
        </p>
        {own ? (
          <Button size="sm" variant="outline" leftIcon={ExternalLink} to={complaintPath(complaint.id)} target="_blank" rel="noopener noreferrer">
            Open your complaint
            <span className="sr-only"> {complaint.complaint_number} (opens in a new tab)</span>
          </Button>
        ) : (
          <Button size="sm" variant="ghost" leftIcon={Eye} onClick={() => onView(item)}>
            View report
            <span className="sr-only"> {complaint.complaint_number}</span>
          </Button>
        )}
      </div>
    </li>
  )
}

export function SimilarReports({ similar, ownIds }) {
  const [viewing, setViewing] = useState(null)
  const [expanded, setExpanded] = useState(false)
  const { status, items = [], error, retry } = similar ?? {}

  if (!status || status === 'idle') return null

  if (status === 'loading') {
    return (
      <div role="status" className="flex items-center gap-2.5 rounded-xl border border-line bg-surface-2 px-4 py-3 text-sm text-ink-2">
        <Spinner size="sm" decorative />
        Checking for similar reports nearby…
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-line bg-surface-2 px-4 py-3">
        <TriangleAlert aria-hidden className="size-4 shrink-0 text-hazard-600 dark:text-hazard-300" />
        <p className="min-w-0 flex-1 text-sm text-ink-2">
          The check for similar reports did not finish ({getErrorMessage(error, 'no answer')}). You can still submit.
        </p>
        <Button size="sm" variant="ghost" leftIcon={RotateCcw} onClick={retry}>
          Check again
        </Button>
      </div>
    )
  }

  if (!items.length) {
    return (
      <p role="status" className="flex items-center gap-2.5 rounded-xl border border-line bg-surface-2 px-4 py-3 text-sm text-ink-2">
        <CopyCheck aria-hidden className="size-4 shrink-0 text-sign-600 dark:text-sign-300" />
        No similar reports nearby. Yours looks new.
      </p>
    )
  }

  const shown = expanded ? items : items.slice(0, 3)
  const viewingOwn = Boolean(viewing && ownIds?.has(viewing.complaint.id))

  return (
    <section
      aria-labelledby="similar-reports-heading"
      className="rounded-xl border border-marking-200 bg-marking-50 p-4 dark:border-marking-500/30 dark:bg-marking-500/10"
    >
      <div className="flex items-start gap-3">
        <Copy aria-hidden className="mt-0.5 size-5 shrink-0 text-marking-700 dark:text-marking-300" />
        <div className="min-w-0">
          <h3 id="similar-reports-heading" className="font-display text-base font-bold text-ink">
            Similar issue already reported nearby
          </h3>
          <p className="mt-0.5 text-sm text-ink-2">
            {items.length === 1 ? 'A report close to your pin looks' : `${items.length} reports close to your pin look`} like
            the same problem. If it is the one you see, there is no need to report it again. If your issue is different, you can
            still submit.
          </p>
        </div>
      </div>
      <ul className="mt-3 space-y-2" aria-label="Similar reports">
        {shown.map((item) => (
          <SimilarItem key={item.complaint.id} item={item} own={Boolean(ownIds?.has(item.complaint.id))} onView={setViewing} />
        ))}
      </ul>
      {items.length > shown.length ? (
        <Button variant="link" size="sm" className="mt-2" onClick={() => setExpanded(true)}>
          Show {items.length - shown.length} more
        </Button>
      ) : null}
      <SimilarReportModal item={viewing} own={viewingOwn} onClose={() => setViewing(null)} />
    </section>
  )
}

export default SimilarReports
