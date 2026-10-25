/**
 * ScoreBands - how a verification score maps to a verdict, with the live thresholds from the AI
 * configuration and a marker at the current score.
 *
 * Props:
 * - resolvedThreshold / partialThreshold: AIConfiguration `verification_resolved_threshold` /
 *   `verification_partial_threshold` (defaults 70 / 45, used until the configuration has loaded)
 * - score: the latest verification score (optional)
 * - status: the latest verdict; it decides the highlighted band (a needs-manual-review verdict highlights none)
 * - className
 *
 * The bands follow the verification engine: score >= resolved -> likely resolved, >= partial -> partially
 * resolved, otherwise not resolved. Two rules override the score and are stated under the scale: poor photo
 * quality or a different scene -> needs manual review; an issue still visible in the after photo -> not
 * resolved (the score is capped below the partial threshold).
 *
 * Motion: the first time the scale is seen, the marker sweeps up from zero to the score and the verdict's band
 * lights up when it lands (reduced motion: the final reading at once).
 */
import { motion } from 'framer-motion'
import { UserSearch } from 'lucide-react'
import { useRef, useState } from 'react'
import { useInViewOnce, usePrefersReducedMotion } from '@/components/motion/hooks'
import { DURATION, EASE } from '@/components/motion/tokens'
import { cn } from '@/utils/cn'
import { VERIFICATION_META } from '@/utils/constants'

export function ScoreBands({ resolvedThreshold = 70, partialThreshold = 45, score, status, className }) {
  const scaleRef = useRef(null)
  const reduced = usePrefersReducedMotion()
  const seen = useInViewOnce(scaleRef, { amount: 0.6, margin: '0px' })
  const [landed, setLanded] = useState(false)
  const lit = reduced || landed
  const resolved = Math.min(100, Math.max(2, Number(resolvedThreshold) || 70))
  const partial = Math.min(resolved - 1, Math.max(1, Number(partialThreshold) || 45))
  const hasScore = score !== null && score !== undefined && Number.isFinite(Number(score))
  const value = hasScore ? Math.min(100, Math.max(0, Number(score))) : null
  const bands = [
    { key: 'not_resolved', from: 0, to: partial - 1, width: partial },
    { key: 'partially_resolved', from: partial, to: resolved - 1, width: resolved - partial },
    { key: 'likely_resolved', from: resolved, to: 100, width: 100 - resolved },
  ]
  const byScore = hasScore ? bands.find((band) => value >= band.from && value <= band.to + 0.999)?.key : null
  const current = status ? (bands.some((band) => band.key === status) ? status : null) : byScore

  return (
    <div className={cn('min-w-0', className)}>
      <div
        ref={scaleRef}
        role="img"
        aria-label={`Score bands: not resolved below ${partial}, partially resolved from ${partial}, likely resolved from ${resolved}${
          hasScore ? `. Current score ${Math.round(value)}.` : '.'
        }`}
        className="relative pt-3"
      >
        <div className="flex h-2.5 w-full gap-0.5">
          {bands.map((band, index) => (
            <span
              key={band.key}
              aria-hidden
              className={cn(
                'block h-full transition-opacity duration-300 ease-standard',
                index === 0 && 'rounded-l-full',
                index === bands.length - 1 && 'rounded-r-full',
              )}
              style={{
                flexBasis: `${band.width}%`,
                backgroundColor: VERIFICATION_META[band.key].color,
                opacity: !hasScore || (current === band.key && lit) ? 1 : 0.32,
              }}
            />
          ))}
        </div>
        {hasScore ? (
          <motion.span
            aria-hidden
            className="absolute top-0 flex -translate-x-1/2 flex-col items-center"
            initial={reduced ? false : { left: '0%' }}
            animate={reduced || seen ? { left: `${value}%` } : { left: '0%' }}
            transition={{ duration: DURATION.count, ease: EASE.count }}
            onAnimationComplete={() => {
              if (seen) setLanded(true)
            }}
          >
            <span className="block border-x-[5px] border-t-[7px] border-x-transparent border-t-ink" />
            <span className="block h-4 w-0.5 rounded-full bg-ink ring-2 ring-surface" />
          </motion.span>
        ) : null}
      </div>
      <ul className="mt-3 space-y-1.5 text-xs">
        {bands
          .slice()
          .reverse()
          .map((band) => {
            const meta = VERIFICATION_META[band.key]
            const Icon = meta.icon
            return (
              <li
                key={band.key}
                className={cn('flex items-center justify-between gap-3', current === band.key ? 'font-semibold text-ink' : 'text-ink-2')}
              >
                <span className="flex items-center gap-1.5">
                  <Icon aria-hidden className="size-3.5" style={{ color: meta.color }} />
                  {meta.label}
                </span>
                <span className="tabular">
                  {band.from}–{band.to}
                </span>
              </li>
            )
          })}
      </ul>
      {status === 'needs_manual_review' ? (
        <p className="mt-3 flex items-start gap-1.5 rounded-md bg-guide-50 px-2.5 py-2 text-xs text-guide-700 dark:bg-guide-500/15 dark:text-guide-200">
          <UserSearch aria-hidden className="mt-px size-3.5 shrink-0" />
          The latest verdict is {VERIFICATION_META.needs_manual_review.label.toLowerCase()}: the photos could not be compared, so the score
          does not decide it.
        </p>
      ) : null}
      <p className="mt-3 text-xs text-ink-3">
        Whatever the score, poor photo quality or a different scene means {VERIFICATION_META.needs_manual_review.label.toLowerCase()}, and
        an issue that is still visible in the after photo keeps the verdict at not resolved.
      </p>
    </div>
  )
}

export default ScoreBands
