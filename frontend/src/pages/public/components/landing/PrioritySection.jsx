/**
 * "Smart Prioritization" - the five-factor priority formula drawn as one stacked bar.
 *
 * The bar is 100 points wide and split into the default weights (severity 40, public impact 25, location
 * risk 15, frequency 10, duplicates 10). Inside each segment the filled part is what the worked example earned
 * (engine output, see landingContent.PRIORITY_EXAMPLE) and the tint is what it could still have earned, so
 * the reader sees the weights and the score at once. The segments share one informational colour (2 px
 * surface gaps separate them) and are named by the labels aligned underneath; colour stays free for the
 * priority level shown by the PriorityMeter.
 *
 * Choreography: the first time the bar is on screen the factors are added up in order - each segment fills to
 * its real score while its points count up - and then the priority gauge sweeps in to the total. Reduced motion:
 * the finished bar and gauge.
 */
import { motion } from 'framer-motion'
import { useRef } from 'react'
import { PriorityMeter } from '@/components/complaints/PriorityMeter'
import { CountUp } from '@/components/motion/CountUp'
import { useInViewOnce, usePrefersReducedMotion } from '@/components/motion/hooks'
import { EASE } from '@/components/motion/tokens'
import { Badge } from '@/components/ui/Badge'
import { cn } from '@/utils/cn'
import { DEFAULT_LEVEL_THRESHOLDS, LEVEL_META, LEVEL_ORDER } from '@/utils/constants'
import { PRIORITY_EXAMPLE } from './landingContent'
import { LandingHeading, LandingSection } from './LandingSection'

/** Seconds per factor, and the overlap between consecutive factors. */
const STEP = 0.42
const GAP = 0.3

function levelRanges(thresholds = DEFAULT_LEVEL_THRESHOLDS) {
  const starts = [0, thresholds.medium, thresholds.high, thresholds.critical]
  return LEVEL_ORDER.map((key, index) => ({
    key,
    meta: LEVEL_META[key],
    from: starts[index],
    to: index < starts.length - 1 ? starts[index + 1] - 1 : 100,
  }))
}

function StackedWeights({ components, play, animated }) {
  return (
    <div>
      <div
        role="img"
        aria-label={`Priority bar: ${components.map((part) => `${part.label} ${part.score} of ${part.max} points`).join(', ')}`}
        className="flex h-11 w-full gap-0.5"
      >
        {components.map((part, index) => (
          <span
            key={part.key}
            className={cn(
              'relative h-full overflow-hidden bg-guide-100 dark:bg-guide-500/20',
              index === 0 && 'rounded-l-lg',
              index === components.length - 1 && 'rounded-r-lg',
            )}
            style={{ flexBasis: `${part.max}%` }}
          >
            <motion.span
              className="absolute inset-y-0 left-0 origin-left bg-guide-600 dark:bg-guide-400"
              style={{ width: `${(part.score / part.max) * 100}%` }}
              initial={animated ? { scaleX: 0 } : false}
              animate={{ scaleX: !animated || play ? 1 : 0 }}
              transition={{ duration: STEP + 0.25, delay: animated ? index * GAP : 0, ease: EASE.enter }}
            />
          </span>
        ))}
      </div>

      {/* Large screens: each label sits under its own segment. */}
      <ol aria-hidden className="mt-3.5 hidden gap-0.5 lg:flex">
        {components.map((part, index) => (
          <li key={part.key} className="min-w-0 pr-3" style={{ flexBasis: `${part.max}%` }}>
            <p className="font-display text-[1.375rem] font-extrabold leading-none text-ink tabular">
              {play || !animated ? <CountUp value={part.score} delay={index * GAP} duration={STEP + 0.25} /> : 0}
              <span className="text-sm font-semibold text-ink-3">/{part.max}</span>
            </p>
            <p className="mt-1.5 text-sm font-semibold leading-tight text-ink">{part.label}</p>
            <p className="mt-0.5 text-xs leading-snug text-ink-3">{part.input}</p>
          </li>
        ))}
      </ol>

      {/* Smaller screens: the same information as a list, in bar order. */}
      <ul className="mt-5 space-y-2.5 text-sm lg:sr-only">
        {components.map((part) => (
          <li key={part.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4">
            <span className="min-w-0">
              <span className="block font-semibold text-ink">{part.label}</span>
              <span className="block text-xs text-ink-3">{part.input}</span>
            </span>
            <span className="font-semibold text-ink tabular">
              {part.score}/{part.max}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function PrioritySection() {
  const example = PRIORITY_EXAMPLE
  const ranges = levelRanges()
  const reduced = usePrefersReducedMotion()
  const animated = !reduced
  const figureRef = useRef(null)
  const play = useInViewOnce(figureRef, { margin: '0px 0px -22% 0px' })
  const total = example.components.length * GAP + STEP

  return (
    <LandingSection id="smart-prioritization" labelledBy="priority-title" tone="bg">
      <LandingHeading
        layout="center"
        size="xl"
        id="priority-title"
        title="Smart Prioritization"
        lead="Every complaint gets a priority from 0 to 100, built from five weighted factors and explained in one sentence. Officers work their list from the top."
      />

      <figure ref={figureRef} className="mt-12 min-w-0 overflow-hidden rounded-2xl border border-line bg-surface elev-raised">
        <figcaption className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line px-5 py-4 sm:px-6">
          <span className="font-display text-lg font-bold text-ink">{example.title}</span>
          <span className="text-xs text-ink-3">Worked example, scored by the CivicAI priority engine</span>
        </figcaption>

        <div className="px-5 py-7 sm:px-6">
          <StackedWeights components={example.components} play={play} animated={animated} />
        </div>

        <div className="grid gap-8 border-t border-line bg-surface-2 px-5 py-7 sm:px-6 lg:grid-cols-2 lg:gap-12">
          <motion.div
            className="min-w-0"
            initial={animated ? { clipPath: 'inset(-12% 100% -12% 0)' } : false}
            animate={!animated || play ? { clipPath: 'inset(-12% 0% -12% 0)', transitionEnd: { clipPath: 'none' } } : undefined}
            transition={{ duration: 0.9, delay: animated ? total : 0, ease: EASE.inOut }}
          >
            <PriorityMeter score={example.finalScore} level={example.level} />
            <p className="mt-4 text-[15px] leading-relaxed text-ink-2">{example.explanation}</p>
          </motion.div>
          <div className="min-w-0">
            <h3 className="font-display text-base font-bold text-ink sm:text-[17px]">How the score is built</h3>
            <p className="mt-2.5 rounded-xl bg-sunken px-4 py-3 text-[15px] leading-relaxed text-ink">
              Priority = 40 × severity + 25 × public impact + 15 × location risk + 10 × frequency + 10 × duplicates
            </p>
            <p className="mt-2 text-sm text-ink-3">
              Each factor is a number from 0 to 1. These are the default weights; administrators can tune them, and the
              engine always rescales them to 100.
            </p>
            <ul className="mt-4 flex flex-wrap gap-x-4 gap-y-2" aria-label="Priority levels">
              {ranges.map((range) => (
                <li key={range.key} className="flex items-center gap-1.5">
                  <Badge tone={range.meta.tone} icon={range.meta.icon} size="sm">
                    {range.meta.label}
                  </Badge>
                  <span className="text-sm text-ink-2">
                    {range.from}-{range.to}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </figure>

      <p className="mt-6 max-w-3xl text-[15px] leading-relaxed text-ink-2">
        Frequency and duplicates grow quickly at first and then level off, so the tenth report of a pothole adds less than
        the second. A reopened complaint gets 5 extra points, because the first fix did not hold.
      </p>
    </LandingSection>
  )
}

export default PrioritySection
