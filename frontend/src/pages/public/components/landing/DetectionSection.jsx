/**
 * "AI Issue Detection" - how the vision engine names an issue, and the live list of civic categories the AI
 * recognises (GET /api/categories/, public): each category with the words the text model understands
 * (English, Hinglish and Telugu keywords stored in the database) and its base severity.
 *
 * Choreography: the first time the list is on screen, the AI scan band (the same road-marking yellow light that
 * sweeps the 3D city) passes down it once; as it crosses each category, that row lights up and its base severity
 * bar fills to its real value. Reduced motion: the finished list, no scan.
 */
import { motion } from 'framer-motion'
import { Camera, Cpu, FlaskConical, ScanSearch } from 'lucide-react'
import { useRef } from 'react'
import { CategoryBadge } from '@/components/complaints/CategoryBadge'
import { useInViewOnce, usePrefersReducedMotion } from '@/components/motion/hooks'
import { EASE } from '@/components/motion/tokens'
import { Button } from '@/components/ui/Button'
import { ErrorState } from '@/components/ui/ErrorState'
import { Skeleton } from '@/components/ui/Skeleton'
import { formatNumber } from '@/utils/format'
import { LandingHeading, LandingSection } from './LandingSection'

const VISION_CHAIN = [
  {
    icon: Cpu,
    title: 'Trained detector',
    text: 'A YOLOv8 object detector draws a box around each issue when trained weights are installed.',
  },
  {
    icon: ScanSearch,
    title: 'Zero-shot fallback',
    text: 'Without them, CLIP compares the photo with a description of every category. Its region is approximate, so it is drawn dashed.',
  },
  {
    icon: FlaskConical,
    title: 'Demo AI Mode',
    text: 'Transparent OpenCV colour, texture and shape rules. Confidence is capped at 75% and every result says it is a demo.',
  },
]

/** Seconds the scan takes to cross the whole list. */
const SCAN_SECONDS = 1.8

/**
 * Up to six keywords: the first three (usually the plain English terms) and the last three (where the
 * reference data keeps the Hinglish / Telugu words such as "gaddha" or "chettu"), plus how many are left out.
 */
function keywordSample(keywords) {
  const list = Array.isArray(keywords) ? keywords.filter(Boolean) : []
  if (list.length <= 6) return { shown: list, more: 0 }
  return { shown: [...list.slice(0, 3), ...list.slice(-3)], more: list.length - 6 }
}

function CategoryRows({ categories, scanning, animated }) {
  const count = categories.length
  return (
    <ul className="divide-y divide-line">
      {categories.map((category, index) => {
        const { shown, more } = keywordSample(category.keywords)
        const base = Number(category.base_severity) || 0
        // The moment the scan line crosses the middle of this row.
        const at = ((index + 0.5) / Math.max(count, 1)) * SCAN_SECONDS
        return (
          <li
            key={category.id}
            className="relative grid gap-x-6 gap-y-2 px-4 py-3.5 sm:grid-cols-[14rem_minmax(0,1fr)_7rem] sm:items-center sm:px-5"
          >
            {animated ? (
              <motion.span
                aria-hidden
                className="pointer-events-none absolute inset-0 bg-marking-400/0"
                initial={false}
                animate={scanning ? { backgroundColor: ['rgb(251 196 26 / 0)', 'rgb(251 196 26 / 0.12)', 'rgb(251 196 26 / 0)'] } : undefined}
                transition={{ duration: 0.9, delay: at, times: [0, 0.18, 1], ease: 'easeOut' }}
              />
            ) : null}
            <div className="relative min-w-0">
              <CategoryBadge category={category} />
            </div>
            <p className="relative min-w-0 text-sm text-ink-2">
              <span className="sr-only">Words it understands: </span>
              {shown.length ? shown.join(', ') : 'Learns from the category name'}
              {more ? <span className="text-ink-3"> and {more} more</span> : null}
            </p>
            <div className="relative flex items-center gap-2" title="Base severity before the photo, text and location are considered">
              <span className="shrink-0 text-xs text-ink-3 sm:sr-only">Base severity</span>
              <span aria-hidden className="h-1.5 flex-1 overflow-hidden rounded-full bg-sunken">
                <motion.span
                  className="block h-full origin-left rounded-full bg-guide-500"
                  style={{ width: `${Math.min(100, base)}%` }}
                  initial={animated ? { scaleX: 0 } : false}
                  animate={{ scaleX: !animated || scanning ? 1 : 0 }}
                  transition={{ duration: 0.7, delay: animated ? at : 0, ease: EASE.enter }}
                />
              </span>
              <span className="w-7 text-right text-xs font-semibold text-ink tabular">{formatNumber(base)}</span>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

export function DetectionSection({ categories, loading, error, onRetry, onTryOwn }) {
  const list = Array.isArray(categories) ? categories : []
  const reduced = usePrefersReducedMotion()
  const tableRef = useRef(null)
  const seen = useInViewOnce(tableRef, { margin: '0px 0px -25% 0px' })
  const animated = !reduced
  const scanning = seen && list.length > 0

  return (
    <LandingSection id="ai-issue-detection" labelledBy="detection-title" tone="surface">
      <div className="grid gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16">
        <div>
          <LandingHeading
            id="detection-title"
            title="AI Issue Detection"
            lead="CivicAI looks at a photo the way an inspector would: it names the issue, marks where it is and estimates how bad it looks."
          />
          <ol className="mt-10 space-y-6">
            {VISION_CHAIN.map((step) => (
              <li key={step.title} className="flex gap-4">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-asphalt-900 text-marking-400 ring-1 ring-inset ring-white/10 dark:bg-asphalt-800">
                  <step.icon aria-hidden className="size-[18px]" />
                </span>
                <div>
                  <h3 className="font-display text-base font-bold text-ink sm:text-[17px]">{step.title}</h3>
                  <p className="mt-1 text-[15px] leading-relaxed text-ink-2">{step.text}</p>
                </div>
              </li>
            ))}
          </ol>
          <Button className="mt-10" variant="secondary" leftIcon={Camera} onClick={onTryOwn}>
            Try your own photo
          </Button>
        </div>

        <div
          ref={tableRef}
          className="relative min-w-0 overflow-hidden rounded-2xl border border-line bg-surface elev-raised lg:self-start"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-4 sm:px-5">
            <h3 className="font-display text-base font-bold text-ink">What CivicAI recognises</h3>
            {list.length ? (
              <p className="text-xs text-ink-3">
                {list.length} categories, live from the database
              </p>
            ) : null}
          </div>
          <div className="hidden grid-cols-[14rem_minmax(0,1fr)_7rem] gap-x-6 border-b border-line bg-surface-2 px-5 py-2 text-xs font-semibold text-ink-3 sm:grid">
            <span>Category</span>
            <span>Words the text model understands</span>
            <span className="text-right">Base severity</span>
          </div>
          <div className="relative">
            {loading && !list.length ? (
              <div aria-hidden className="space-y-4 px-5 py-4">
                {Array.from({ length: 6 }, (_, index) => (
                  <div key={index} className="flex items-center gap-6">
                    <Skeleton className="h-6 w-44" />
                    <Skeleton className="h-4 flex-1" />
                  </div>
                ))}
              </div>
            ) : error && !list.length ? (
              <ErrorState compact bordered={false} title="Categories could not load" error={error} onRetry={onRetry} />
            ) : (
              <CategoryRows categories={list} scanning={scanning} animated={animated} />
            )}
            {animated && scanning ? (
              <motion.span
                aria-hidden
                className="pointer-events-none absolute inset-0"
                initial={{ y: '-100%', opacity: 1 }}
                animate={{ y: '0%', opacity: [1, 1, 0] }}
                transition={{ y: { duration: SCAN_SECONDS, ease: 'linear' }, opacity: { duration: SCAN_SECONDS + 0.35, times: [0, 0.82, 1] } }}
              >
                <span className="detect-scan" />
              </motion.span>
            ) : null}
          </div>
          <p className="border-t border-line bg-surface-2 px-4 py-3 text-xs text-ink-3 sm:px-5">
            Categories are data, not code: an administrator can add one with its own keywords and the AI starts using it
            immediately, without retraining.
          </p>
        </div>
      </div>
    </LandingSection>
  )
}

export default DetectionSection
