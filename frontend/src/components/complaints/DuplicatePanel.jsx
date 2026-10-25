/**
 * DuplicatePanel - possible duplicate reports of a complaint, with the evidence behind each match.
 *
 * Props:
 * - duplicates: DuplicateLink[] `{id, direction: 'original' | 'duplicate', other: ComplaintMini,
 *   text_similarity, image_similarity | null, location_similarity, overall_similarity, distance_m,
 *   category_match, status, status_display, explanation, reviewed_by, reviewed_at, created_at}`
 *   `direction: "original"` means `other` is the EARLIER report this complaint may duplicate;
 *   `direction: "duplicate"` means `other` is a newer report that may duplicate this one.
 * - canReview: show "Confirm duplicate" / "Not a duplicate" on links still pending review
 * - onReview(id, status, link): called with 'confirmed_duplicate' | 'not_duplicate'; may return a promise
 *   (the clicked button shows a spinner until it settles; a rejection is shown under the item)
 * - basePath: e.g. "/admin/complaints"; the other complaint's number links to `${basePath}/${other.id}`
 * - loading: skeletons while the list loads
 * - className
 *
 * How a match is scored (ai/duplicate): overall = weighted text, image and location similarity (the
 * weights are renormalised when a photo is missing), multiplied by 0.85 when the categories differ unless
 * the texts are almost identical. Each component is shown as its own bar so a reviewer can see WHY two
 * reports were linked before confirming.
 */
import { Check, CopyCheck, CopyX, ImageOff, MapPin, TriangleAlert, X } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { Skeleton } from '@/components/ui/Skeleton'
import { cn } from '@/utils/cn'
import { DUPLICATE_STATUS_META } from '@/utils/constants'
import { getErrorMessage } from '@/utils/errors'
import { formatDate, formatDateTime, formatDistance, formatPercent } from '@/utils/format'
import { CategoryBadge } from './CategoryBadge'
import { StatusBadge } from './StatusBadge'

function SimilarityRow({ label, value, missing }) {
  if (value == null) {
    return (
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-medium text-ink-2">{label}</span>
        <span className="inline-flex items-center gap-1 text-ink-3">
          <ImageOff aria-hidden className="size-3.5" />
          {missing}
        </span>
      </div>
    )
  }
  const ratio = Math.min(1, Math.max(0, Number(value) || 0))
  return <ProgressBar value={ratio * 100} max={100} tone="blue" size="sm" label={label} showValue valueLabel={formatPercent(ratio)} />
}

function DuplicateItem({ link, canReview, onReview, basePath }) {
  const [pending, setPending] = useState(null)
  const [error, setError] = useState(null)
  const other = link.other ?? {}
  const meta = DUPLICATE_STATUS_META[link.status] ?? { label: link.status_display ?? link.status, tone: 'neutral' }
  const href = basePath && other.id != null ? `${basePath.replace(/\/+$/, '')}/${other.id}` : null
  const isOriginal = link.direction === 'original'
  const reviewable = canReview && link.status === 'pending_review' && typeof onReview === 'function'

  const review = async (status) => {
    setPending(status)
    setError(null)
    try {
      await onReview(link.id, status, link)
    } catch (reviewError) {
      setError(getErrorMessage(reviewError, 'The review could not be saved. Try again.'))
    } finally {
      setPending(null)
    }
  }

  return (
    <li className="rounded-xl border border-line bg-surface p-4">
      <div className="flex gap-3">
        {other.thumbnail ? (
          <img src={other.thumbnail} alt="" loading="lazy" className="size-14 shrink-0 rounded-lg bg-sunken object-cover" />
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone="slate" size="sm">
              {isOriginal ? 'Earlier report' : 'Newer report'}
            </Badge>
            <Badge tone={meta.tone} size="sm" icon={meta.icon}>
              {meta.label}
            </Badge>
          </div>
          <p className="mt-1.5 text-sm text-ink-2">
            {isOriginal ? 'This complaint may repeat ' : 'May repeat this complaint: '}
            {href ? (
              <Link to={href} className="font-semibold text-primary-ink tabular hover:underline">
                {other.complaint_number}
              </Link>
            ) : (
              <span className="font-semibold text-ink tabular">{other.complaint_number}</span>
            )}
          </p>
          {other.title ? <p className="mt-0.5 line-clamp-2 text-sm font-semibold text-ink">{other.title}</p> : null}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-3">
            <CategoryBadge category={other.category} size="sm" />
            {other.status ? <StatusBadge status={other.status} label={other.status_display} size="sm" /> : null}
            {link.distance_m != null ? (
              <span className="inline-flex items-center gap-1 tabular">
                <MapPin aria-hidden className="size-3.5" />
                {formatDistance(link.distance_m)} away
              </span>
            ) : null}
            {other.created_at ? <span className="tabular">Reported {formatDate(other.created_at)}</span> : null}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <p className="font-display text-2xl font-extrabold leading-none text-ink tabular">
            {formatPercent(link.overall_similarity)}
          </p>
          <p className="mt-1 text-[11px] font-medium text-ink-3">overall match</p>
        </div>
      </div>

      <div className="mt-3 grid gap-2.5 @lg:grid-cols-3">
        <SimilarityRow label="Description" value={link.text_similarity} />
        <SimilarityRow label="Photo" value={link.image_similarity} missing="No photo to compare" />
        <SimilarityRow label="Location" value={link.location_similarity} />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span
          className={cn(
            'inline-flex items-center gap-1 font-semibold',
            link.category_match ? 'text-sign-700 dark:text-sign-300' : 'text-hazard-700 dark:text-hazard-300',
          )}
        >
          {link.category_match ? <Check aria-hidden className="size-3.5" /> : <X aria-hidden className="size-3.5" />}
          {link.category_match ? 'Same category' : 'Different category'}
        </span>
        {link.reviewed_by ? (
          <span className="text-ink-3">
            Reviewed by {link.reviewed_by.full_name}
            {link.reviewed_at ? (
              <>
                {' on '}
                <time dateTime={link.reviewed_at} className="tabular">
                  {formatDateTime(link.reviewed_at)}
                </time>
              </>
            ) : null}
          </span>
        ) : null}
      </div>

      {link.explanation ? <p className="mt-2 text-sm text-ink-2">{link.explanation}</p> : null}

      {error ? (
        <p role="alert" className="mt-2 flex items-start gap-1.5 text-xs font-medium text-signal-600 dark:text-signal-300">
          <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
          {error}
        </p>
      ) : null}

      {reviewable ? (
        <div className="mt-3 flex flex-wrap justify-end gap-2 border-t border-line pt-3">
          <Button
            variant="outline"
            size="sm"
            leftIcon={CopyX}
            loading={pending === 'not_duplicate'}
            disabled={pending !== null}
            onClick={() => review('not_duplicate')}
          >
            Not a duplicate
          </Button>
          <Button
            variant="warning"
            size="sm"
            leftIcon={CopyCheck}
            loading={pending === 'confirmed_duplicate'}
            disabled={pending !== null}
            onClick={() => review('confirmed_duplicate')}
          >
            Confirm duplicate
          </Button>
        </div>
      ) : null}
    </li>
  )
}

export function DuplicatePanel({ duplicates = [], canReview = false, onReview, basePath, loading = false, className }) {
  const links = Array.isArray(duplicates) ? duplicates : []

  if (loading && !links.length) {
    return (
      <ul aria-hidden className={cn('space-y-3', className)}>
        {[0, 1].map((index) => (
          <li key={index} className="space-y-2 rounded-xl border border-line p-4">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="h-2 w-full" />
          </li>
        ))}
      </ul>
    )
  }

  if (!links.length) {
    return (
      <EmptyState
        icon={CopyCheck}
        compact
        bordered={false}
        title="No possible duplicates"
        description="The AI compared this report with nearby complaints and found no close match."
        className={className}
      />
    )
  }

  const pendingCount = links.filter((link) => link.status === 'pending_review').length
  return (
    <div className={cn('@container min-w-0', className)}>
      {pendingCount && canReview ? (
        <p className="mb-3 text-sm text-ink-2">
          {pendingCount === 1 ? '1 link needs' : `${pendingCount} links need`} your review. Confirming merges the newer
          report into the original and closes it.
        </p>
      ) : null}
      <ul className="space-y-3" aria-label="Possible duplicates">
        {links.map((link) => (
          <DuplicateItem key={link.id} link={link} canReview={canReview} onReview={onReview} basePath={basePath} />
        ))}
      </ul>
    </div>
  )
}

export default DuplicatePanel
