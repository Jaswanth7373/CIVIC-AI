/**
 * "Duplicate Detection" - two reports of the same pothole and the three similarity signals the duplicate
 * engine combines (description, photo, location). The scores are the engine's real output for these two
 * reports (worked example, see landingContent.DUPLICATE_EXAMPLE), labelled as such on the page.
 *
 * Choreography: the first time the reports are on screen the new report slides in against the earlier one and
 * the two are linked (the dashed connector draws, a link badge snaps on); the three signals fill, the overall
 * similarity runs past the duplicate threshold - the marker lights up as it is crossed - and only then the
 * verdict appears. Reduced motion: the finished comparison.
 */
import { motion } from 'framer-motion'
import { Link2 } from 'lucide-react'
import { useRef } from 'react'
import { useInViewOnce, usePrefersReducedMotion } from '@/components/motion/hooks'
import { EASE, SPRING } from '@/components/motion/tokens'
import { Badge } from '@/components/ui/Badge'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { cn } from '@/utils/cn'
import { DUPLICATE_STATUS_META } from '@/utils/constants'
import { percent } from './demoUtils'
import { DUPLICATE_EXAMPLE } from './landingContent'
import { LandingHeading, LandingSection } from './LandingSection'

const METHODS = {
  text: 'Text embeddings compared by cosine similarity (TF-IDF in demo mode, MiniLM in production).',
  image: 'Perceptual hashes and colour histograms of both photos (plus CLIP embeddings in production).',
  location: 'Map distance with a smooth fall-off: 100% at the same spot, close to 0 beyond 450 m.',
}

/** Seconds: the slips meet, then the overall bar fills. */
const MEET = 0.75
const FILL_START = 0.9
const FILL_SECONDS = 1.2

/**
 * Fraction of an eased animation's duration at which its progress reaches `target` (cubic-bezier [x1, y1, x2, y2],
 * solved numerically) - when the overall bar's fill passes the threshold marker.
 */
function timeAtProgress([x1, y1, x2, y2], target) {
  const bezier = (t, a, b) => 3 * (1 - t) * (1 - t) * t * a + 3 * (1 - t) * t * t * b + t * t * t
  let low = 0
  let high = 1
  for (let i = 0; i < 30; i += 1) {
    const mid = (low + high) / 2
    if (bezier(mid, y1, y2) < target) low = mid
    else high = mid
  }
  return bezier((low + high) / 2, x1, x2)
}

function ReportSlip({ report, className }) {
  return (
    <div className={cn('flex items-center gap-4 rounded-2xl border border-line bg-surface p-3 elev-raised', className)}>
      <img src={report.photo} alt="" loading="lazy" decoding="async" className="size-20 shrink-0 rounded-xl object-cover sm:size-24" />
      <div className="min-w-0">
        <p className="text-xs font-medium text-ink-3">{report.label}</p>
        <p className="mt-1 font-display text-base font-bold leading-snug text-ink sm:text-[17px]">“{report.text}”</p>
      </div>
    </div>
  )
}

export function DuplicateSection() {
  const example = DUPLICATE_EXAMPLE
  const status = DUPLICATE_STATUS_META.pending_review
  const isDuplicate = example.overall >= example.threshold && example.distanceM <= example.radiusM
  const reduced = usePrefersReducedMotion()
  const animated = !reduced
  const pairRef = useRef(null)
  const panelRef = useRef(null)
  const linked = useInViewOnce(pairRef, { margin: '0px 0px -25% 0px' })
  const measured = useInViewOnce(panelRef, { margin: '0px 0px -25% 0px' })
  // When the fill passes the threshold marker (the fill is drawn to `overall`, the marker sits at `threshold`).
  const crossAt = FILL_START + FILL_SECONDS * timeAtProgress(EASE.enter, Math.min(1, example.threshold / example.overall))

  return (
    <LandingSection id="duplicate-detection" labelledBy="duplicate-title" tone="bg" joined>
      <LandingHeading
        layout="center"
        size="xl"
        id="duplicate-title"
        title="Duplicate Detection"
        lead="When ten people report the same pothole, the department should get one job, not ten. Every new report is compared with recent reports nearby before it is routed."
      />

      <div className="mt-12 grid gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-14">
        <div ref={pairRef} className="min-w-0">
          <ReportSlip report={example.original} />
          <div className="relative flex items-center gap-3 py-2.5 pl-12 sm:pl-14">
            <span aria-hidden className="relative h-12 w-0.5">
              <motion.span
                className="absolute inset-0 origin-top border-l-2 border-dashed border-line-strong"
                initial={animated ? { scaleY: 0 } : false}
                animate={{ scaleY: !animated || linked ? 1 : 0 }}
                transition={{ duration: 0.45, delay: animated ? MEET * 0.6 : 0, ease: EASE.standard }}
              />
            </span>
            <span className="rounded-md bg-sunken px-2 py-0.5 text-xs font-semibold text-ink-2">{example.distanceM} m apart</span>
            <motion.span
              aria-hidden
              className="grid size-8 place-items-center rounded-full bg-marking-500 text-asphalt-950 shadow-[0_6px_14px_-6px_rgb(204_150_0/0.8)]"
              initial={animated ? { scale: 0, rotate: -45 } : false}
              animate={!animated || linked ? { scale: 1, rotate: 0 } : undefined}
              transition={{ ...SPRING.bouncy, delay: animated ? MEET : 0 }}
            >
              <Link2 className="size-4" />
            </motion.span>
          </div>
          <motion.div
            initial={animated ? { y: 56, x: 18, rotate: 2.5, opacity: 0 } : false}
            animate={!animated || linked ? { y: 0, x: 0, rotate: 0, opacity: 1 } : undefined}
            transition={{ type: 'spring', duration: MEET + 0.15, bounce: 0.18 }}
          >
            <ReportSlip report={example.incoming} />
          </motion.div>
          <p className="mt-4 text-sm text-ink-3">
            The second photo is the same spot photographed again, so lighting and framing differ slightly.
          </p>
        </div>

        <div ref={panelRef} className="min-w-0 rounded-2xl border border-line bg-surface p-5 elev-raised sm:p-6">
          <ul className="space-y-5">
            {example.signals.map((signal) => (
              <li key={signal.key}>
                <ProgressBar
                  value={signal.value * 100}
                  tone="blue"
                  size="md"
                  label={signal.label}
                  showValue
                  valueLabel={
                    <>
                      {percent(signal.value)}
                      <span className="ml-2 font-normal text-ink-3">weight {signal.weight}</span>
                    </>
                  }
                />
                <p className="mt-1.5 text-xs text-ink-3">{METHODS[signal.key]}</p>
              </li>
            ))}
          </ul>

          <div className="mt-6 border-t border-line pt-5">
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-sm font-semibold text-ink">Overall similarity</p>
              <p className="font-display text-3xl font-extrabold leading-none tracking-tight text-ink tabular">
                {percent(example.overall)}
              </p>
            </div>
            <div className="relative mt-3 pb-6">
              <div
                role="meter"
                aria-label="Overall similarity"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(example.overall * 100)}
                aria-valuetext={`${percent(example.overall)}, duplicate threshold ${percent(example.threshold)}`}
                className="h-3 w-full overflow-hidden rounded-full bg-sunken"
              >
                <motion.span
                  className="block h-full origin-left rounded-full bg-asphalt-800 dark:bg-asphalt-300"
                  style={{ width: `${example.overall * 100}%` }}
                  initial={animated ? { scaleX: 0 } : false}
                  animate={{ scaleX: !animated || measured ? 1 : 0 }}
                  transition={{ duration: FILL_SECONDS, delay: animated ? FILL_START : 0, ease: EASE.enter }}
                />
              </div>
              <span aria-hidden className="absolute top-[-4px] h-5 w-0.5 -translate-x-1/2" style={{ left: `${example.threshold * 100}%` }}>
                <span className="absolute inset-0 rounded-full bg-ink" />
                {animated ? (
                  // The moment the fill crosses the threshold: a short road-marking flash on the marker.
                  <motion.span
                    className="absolute -inset-x-1 -inset-y-1 rounded-full bg-marking-400 shadow-[0_0_14px_2px_rgb(251_196_26/0.75)]"
                    initial={{ opacity: 0 }}
                    animate={measured ? { opacity: [0, 1, 0] } : undefined}
                    transition={{ duration: 0.9, delay: crossAt, times: [0, 0.2, 1], ease: 'easeOut' }}
                  />
                ) : null}
              </span>
              <span
                aria-hidden
                className="absolute top-5 -translate-x-1/2 whitespace-nowrap text-[11px] font-semibold text-ink-2"
                style={{ left: `${example.threshold * 100}%` }}
              >
                threshold {percent(example.threshold)}
              </span>
            </div>
            <p className="text-sm text-ink-3">
              Overall = 0.4 × description + 0.3 × photo + 0.3 × location, lowered by 15% when the two reports have
              different categories.
            </p>
          </div>

          {isDuplicate ? (
            <motion.div
              className="mt-5 flex flex-col gap-3 rounded-xl border border-line bg-surface-2 p-4 sm:flex-row sm:items-start"
              initial={animated ? { opacity: 0, y: 10 } : false}
              animate={!animated || measured ? { opacity: 1, y: 0 } : undefined}
              transition={{ duration: 0.5, delay: animated ? crossAt + 0.2 : 0, ease: EASE.enter }}
            >
              <Badge tone={status.tone} icon={status.icon}>
                {status.label}
              </Badge>
              <div className="min-w-0 text-sm text-ink-2">
                <p className="font-semibold text-ink">{example.explanation}</p>
                <p className="mt-1">
                  Above the threshold and within {example.radiusM} m, so the new report is linked to the earlier one and an
                  officer or administrator confirms it.
                </p>
              </div>
            </motion.div>
          ) : null}

          <p className="mt-4 flex items-center gap-1.5 text-xs text-ink-3">
            <Link2 aria-hidden className="size-3.5" />
            Worked example: scores computed by the CivicAI duplicate engine for these two reports.
          </p>
        </div>
      </div>
    </LandingSection>
  )
}

export default DuplicateSection
