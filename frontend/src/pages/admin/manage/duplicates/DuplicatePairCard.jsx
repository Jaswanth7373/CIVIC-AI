/**
 * DuplicatePairCard - one possible duplicate pair, the two reports side by side with the evidence between them.
 *
 * Props:
 * - pair: GET /duplicates/ row `{id, complaint: ComplaintMini (newer), similar_complaint: ComplaintMini
 *   (original), text_similarity, image_similarity|null, location_similarity, overall_similarity, distance_m,
 *   category_match, status, status_display, explanation, reviewed_by, reviewed_at, review_notes, created_at}`
 * - onReview(pair, status): opens the review dialog ('confirmed_duplicate' | 'not_duplicate')
 * - decision: the review just saved for this pair (set by the page before the list refreshes), so the card
 *   leaves the queue the way the decision reads; render inside <AnimatePresence>
 *
 * How a pair is scored (ai/duplicate): overall = weighted description, photo and location similarity (weights
 * renormalised when a photo is missing), x0.85 when the categories differ unless the texts are nearly
 * identical. The three components are shown as bars so a reviewer sees WHY the reports were linked.
 *
 * Motion (meaning, not decoration): when a pair first comes into view the two reports slide in toward each
 * other - the AI brought them together - while the overall match counts up and the evidence bars fill to their
 * real values. When a reviewer confirms the duplicate, the newer report slides into the original and the card
 * folds away; "Not a duplicate" lets the card fold away as is; other removals (a tab or page change) are
 * instant. The motion follows the layout: sideways when the reports sit side by side (lg+), vertical when they
 * are stacked (phones, tablets). Reduced motion: no entrance, no exit, the list simply updates.
 *
 * Layout: from xl the two reports share rows with the evidence (CSS subgrid) - their labels on one line, their
 * photos on one band - and the similarity panel sits between the photos, joined to both by short lane-line
 * connectors that draw in once the reports have converged: one road from report to report through the evidence.
 */
import { motion } from 'framer-motion'
import { Check, CopyCheck, CopyX, ImageOff, MapPin, X } from 'lucide-react'
import { useRef } from 'react'
import { Link } from 'react-router-dom'
import { CategoryBadge, PriorityBadge, StatusBadge } from '@/components/complaints'
import { CountUp } from '@/components/motion/CountUp'
import { useInViewOnce, usePrefersReducedMotion } from '@/components/motion/hooks'
import { DURATION, EASE } from '@/components/motion/tokens'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { BREAKPOINTS, useMediaQuery } from '@/hooks/useMediaQuery'
import { cn } from '@/utils/cn'
import { DUPLICATE_STATUS_META } from '@/utils/constants'
import { formatDate, formatDateTime, formatDistance, formatHours, formatPercent, timeAgo, toDate } from '@/utils/format'

const CONFIRMED = 'confirmed_duplicate'
/** How far (px) each report starts from its place before the two converge: sideways, or when stacked. */
const CONVERGE_PX = 28
const CONVERGE_STACKED_PX = 16

const percentText = (value) => formatPercent(value)
/** A short dashed road marking (connector between a photo and the evidence panel). */
const CONNECTOR_STYLE = { backgroundImage: 'repeating-linear-gradient(90deg, #f5b700 0 7px, transparent 7px 11px)' }

function Connector({ side, seen, reduced }) {
  return (
    <motion.span
      aria-hidden
      className={cn(
        'pointer-events-none absolute top-1/2 hidden h-0.5 w-5 -translate-y-1/2 xl:block',
        side === 'left' ? 'right-full origin-right' : 'left-full origin-left',
      )}
      style={CONNECTOR_STYLE}
      initial={reduced ? false : { scaleX: 0 }}
      animate={seen || reduced ? { scaleX: 1 } : undefined}
      transition={{ duration: DURATION.slow, ease: EASE.enter, delay: 0.42 }}
    />
  )
}

function ReportPanel({ complaint, role, from, column, seen, reduced, sideBySide, decision, merges }) {
  if (!complaint) return null
  const location = complaint.location ?? {}
  const start = sideBySide ? { x: from * CONVERGE_PX, y: 0 } : { x: 0, y: from * CONVERGE_STACKED_PX }
  const merge = sideBySide ? { x: '42%' } : { y: '36%' }
  return (
    <motion.article
      className={cn('min-w-0 xl:row-span-3 xl:row-start-1 xl:grid xl:grid-rows-subgrid', column)}
      aria-label={`${role}: ${complaint.complaint_number}`}
      initial={reduced ? false : { opacity: 0, ...start }}
      animate={seen || reduced ? { opacity: 1, x: 0, y: 0 } : undefined}
      exit={
        reduced || !merges || decision !== CONFIRMED
          ? undefined
          : { ...merge, opacity: 0, scale: 0.94, transition: { duration: DURATION.slower, ease: EASE.inOut } }
      }
      transition={{ duration: DURATION.slower, ease: EASE.enter, delay: 0.04 }}
    >
      <p className="mb-2 text-xs font-medium text-ink-3">{role}</p>
      <div className="relative mb-3 overflow-hidden rounded-lg bg-sunken xl:mb-0 xl:h-full xl:w-full" style={{ aspectRatio: '2 / 1' }}>
        {complaint.thumbnail ? (
          <img src={complaint.thumbnail} alt={`Photo of ${complaint.complaint_number}`} loading="lazy" className="absolute inset-0 size-full object-cover" />
        ) : (
          <div className="absolute inset-0 grid place-items-center text-center text-xs text-ink-3">
            <span>
              <ImageOff aria-hidden className="mx-auto mb-1 size-5" />
              No photo
            </span>
          </div>
        )}
      </div>
      <div className="min-w-0 xl:pt-3">
        <Link to={`/admin/complaints/${complaint.id}`} className="text-sm font-semibold text-primary-ink tabular hover:underline">
          {complaint.complaint_number}
        </Link>
        <h3 className="mt-0.5 line-clamp-2 font-display text-[15px] font-bold leading-snug text-ink">{complaint.title}</h3>
        <p className="mt-1 line-clamp-3 text-sm text-ink-2">{complaint.description}</p>
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <StatusBadge status={complaint.status} label={complaint.status_display} size="sm" />
          <PriorityBadge level={complaint.priority_level} score={complaint.priority_score} size="sm" />
          <CategoryBadge category={complaint.category} size="sm" />
        </div>
        <p className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-ink-3">
          {location.area || location.address ? (
            <span className="inline-flex min-w-0 items-center gap-1">
              <MapPin aria-hidden className="size-3.5 shrink-0" />
              <span className="truncate">{location.address || location.area}</span>
            </span>
          ) : null}
          <time dateTime={complaint.created_at} title={formatDateTime(complaint.created_at)} className="tabular">
            Reported {formatDate(complaint.created_at)}
          </time>
        </p>
      </div>
    </motion.article>
  )
}

function SimilarityBar({ label, value, missing }) {
  if (value === null || value === undefined) {
    return (
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-medium text-ink-2">{label}</span>
        <span className="inline-flex items-center gap-1 text-ink-3">
          <ImageOff aria-hidden className="size-3.5" />
          {missing}
        </span>
      </div>
    )
  }
  const ratio = Math.min(1, Math.max(0, Number(value) || 0))
  return <ProgressBar value={ratio * 100} tone="blue" size="sm" label={label} showValue valueLabel={formatPercent(ratio)} />
}

export function DuplicatePairCard({ pair, onReview, decision }) {
  const cardRef = useRef(null)
  const reduced = usePrefersReducedMotion()
  const sideBySide = useMediaQuery(BREAKPOINTS.lg)
  const seen = useInViewOnce(cardRef)
  const meta = DUPLICATE_STATUS_META[pair.status] ?? { label: pair.status_display ?? pair.status, tone: 'neutral' }
  const pending = pair.status === 'pending_review'
  const newer = toDate(pair.complaint?.created_at)
  const original = toDate(pair.similar_complaint?.created_at)
  const gapHours = newer && original ? (newer.getTime() - original.getTime()) / 3_600_000 : null

  // Leaving the queue: reviewed pairs fold away (a confirmed one after its merge); anything else is instant.
  const exit = reduced || !decision
    ? { opacity: 0, transition: { duration: 0 } }
    : {
        opacity: 0,
        height: 0,
        transition: {
          height: { duration: DURATION.slow, ease: EASE.inOut, delay: decision === CONFIRMED ? 0.32 : 0.12 },
          opacity: { duration: DURATION.base, ease: EASE.exit, delay: decision === CONFIRMED ? 0.28 : 0 },
        },
      }

  return (
    <motion.li
      ref={cardRef}
      layout={reduced ? false : 'position'}
      exit={exit}
      className="overflow-hidden rounded-xl border border-line bg-surface"
    >
      <div className="flex flex-col gap-2.5 border-b border-line px-4 py-3.5 sm:flex-row sm:items-start sm:gap-5 sm:px-5">
        <div className="flex shrink-0 items-baseline gap-2">
          <CountUp
            value={Number(pair.overall_similarity)}
            format={percentText}
            className="font-display text-3xl font-extrabold leading-none text-ink tabular"
          />
          <span className="text-xs font-medium text-ink-3">overall match</span>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={meta.tone} size="sm" icon={meta.icon}>
              {meta.label}
            </Badge>
            <span
              className={cn(
                'inline-flex items-center gap-1 text-xs font-semibold',
                pair.category_match ? 'text-sign-700 dark:text-sign-300' : 'text-hazard-700 dark:text-hazard-300',
              )}
            >
              {pair.category_match ? <Check aria-hidden className="size-3.5" /> : <X aria-hidden className="size-3.5" />}
              {pair.category_match ? 'Same category' : 'Different category'}
            </span>
            {pair.distance_m != null ? (
              <span className="inline-flex items-center gap-1 text-xs font-semibold text-ink-2 tabular">
                <MapPin aria-hidden className="size-3.5 text-ink-3" />
                {formatDistance(pair.distance_m)} apart
              </span>
            ) : null}
          </div>
          {pair.explanation ? <p className="text-sm text-ink-2">{pair.explanation}</p> : null}
        </div>
      </div>

      <div className="grid gap-5 px-4 py-4 sm:px-5 lg:grid-cols-[minmax(0,1fr)_14rem_minmax(0,1fr)] xl:grid-rows-[auto_auto_auto] xl:gap-y-0">
        <ReportPanel
          complaint={pair.complaint}
          role="Newer report"
          column="xl:col-start-1"
          from={-1}
          seen={seen}
          reduced={reduced}
          sideBySide={sideBySide}
          decision={decision}
          merges
        />
        <motion.div
          className="relative flex flex-col justify-center gap-3 rounded-lg bg-surface-2 p-3.5 lg:self-center xl:col-start-2 xl:row-start-2"
          initial={reduced ? false : { opacity: 0, scale: 0.96 }}
          animate={seen || reduced ? { opacity: 1, scale: 1 } : undefined}
          exit={reduced || decision !== CONFIRMED ? undefined : { opacity: 0, transition: { duration: DURATION.fast } }}
          transition={{ duration: DURATION.slow, ease: EASE.enter, delay: 0.16 }}
        >
          <Connector side="left" seen={seen} reduced={reduced} />
          <Connector side="right" seen={seen} reduced={reduced} />
          <p className="text-xs font-medium text-ink-3">Similarity</p>
          <SimilarityBar label="Description" value={pair.text_similarity} />
          <SimilarityBar label="Photo" value={pair.image_similarity} missing="No photo to compare" />
          <SimilarityBar label="Location" value={pair.location_similarity} />
          {gapHours != null ? (
            <p className="border-t border-line pt-2.5 text-xs text-ink-2">
              Reported <span className="font-semibold text-ink tabular">{formatHours(Math.abs(gapHours))}</span>{' '}
              {gapHours >= 0 ? 'after' : 'before'} the original
            </p>
          ) : null}
        </motion.div>
        <ReportPanel
          complaint={pair.similar_complaint}
          role="Earlier report (original)"
          column="xl:col-start-3"
          from={1}
          seen={seen}
          reduced={reduced}
          sideBySide={sideBySide}
          decision={decision}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-surface-2 px-4 py-3 sm:px-5">
        {pending ? (
          <p className="text-xs text-ink-3">
            Detected{' '}
            <time dateTime={pair.created_at} title={formatDateTime(pair.created_at)}>
              {timeAgo(pair.created_at)}
            </time>
          </p>
        ) : (
          <p className="min-w-0 text-xs text-ink-3">
            Reviewed by <span className="font-semibold text-ink-2">{pair.reviewed_by?.full_name ?? 'an administrator'}</span>
            {pair.reviewed_at ? (
              <>
                {' on '}
                <time dateTime={pair.reviewed_at} className="tabular">
                  {formatDateTime(pair.reviewed_at)}
                </time>
              </>
            ) : null}
            {pair.review_notes ? <span className="mt-0.5 block text-ink-2">“{pair.review_notes}”</span> : null}
          </p>
        )}
        {pending ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" leftIcon={CopyX} onClick={() => onReview(pair, 'not_duplicate')}>
              Not a duplicate
            </Button>
            <Button variant="warning" size="sm" leftIcon={CopyCheck} onClick={() => onReview(pair, 'confirmed_duplicate')}>
              Confirm duplicate
            </Button>
          </div>
        ) : null}
      </div>
    </motion.li>
  )
}

export default DuplicatePairCard
