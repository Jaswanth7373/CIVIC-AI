/**
 * "Citizen Feedback" - how a rating and a sentence of feedback become a sentiment and an outcome. The two
 * feedback examples were scored by the real sentiment engine (worked examples, landingContent.FEEDBACK_EXAMPLES);
 * the reopen window comes live from GET /api/system/config/ (`reopen_window_days`).
 *
 * Choreography: the first time a piece of feedback is on screen its stars land one by one up to the citizen's
 * rating, the key phrases the sentiment model picked up are marked in the quote like a highlighter pass (green
 * for positive, red for negative), and the sentiment score counts to its value. Reduced motion: the finished
 * rows (phrases already marked).
 */
import { motion } from 'framer-motion'
import { Archive, BellRing, RotateCcw, Star } from 'lucide-react'
import { Fragment, useRef } from 'react'
import { CountUp } from '@/components/motion/CountUp'
import { useInViewOnce, usePrefersReducedMotion } from '@/components/motion/hooks'
import { SPRING } from '@/components/motion/tokens'
import { Badge } from '@/components/ui/Badge'
import { useConfig } from '@/hooks/useConfig'
import { cn } from '@/utils/cn'
import { SENTIMENT_META } from '@/utils/constants'
import { formatNumber } from '@/utils/format'
import { FEEDBACK_EXAMPLES } from './landingContent'
import { LandingHeading, LandingSection } from './LandingSection'

/** Seconds between two stars, and when the phrases start to be marked. */
const STAR_STEP = 0.08
const MARK_START = 0.55
const MARK_STEP = 0.32

/** Read-only stars that land one after another (same accessible output as the shared StarRating). */
function CascadeStars({ value, play, animated, label }) {
  return (
    <span role="img" aria-label={`${label}: ${value} out of 5`} className="inline-flex items-center gap-0.5">
      {[0, 1, 2, 3, 4].map((index) => {
        const filled = index < value
        return (
          <span key={index} aria-hidden className="relative inline-flex">
            <Star className="size-[18px] text-line-strong" />
            {filled ? (
              <motion.span
                className="absolute inset-0"
                initial={animated ? { scale: 0.2, opacity: 0, rotate: -30 } : false}
                animate={!animated || play ? { scale: 1, opacity: 1, rotate: 0 } : undefined}
                transition={{ ...SPRING.bouncy, delay: animated ? index * STAR_STEP : 0 }}
              >
                <Star className="size-[18px] fill-marking-500 text-marking-500" />
              </motion.span>
            ) : null}
          </span>
        )
      })}
    </span>
  )
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The quote with the model's key phrases wrapped in highlighter marks (longest phrases first, no overlaps). */
function MarkedQuote({ text, phrases, tone, play, animated }) {
  const sorted = [...phrases].filter(Boolean).sort((a, b) => b.length - a.length)
  if (!sorted.length) return text
  const pattern = new RegExp(`(${sorted.map(escapeRegExp).join('|')})`, 'gi')
  let markIndex = -1
  return text.split(pattern).map((part, index) => {
    const isPhrase = index % 2 === 1
    if (!isPhrase) return <Fragment key={index}>{part}</Fragment>
    markIndex += 1
    const on = !animated || play
    return (
      <mark
        key={index}
        className="phrase-mark"
        data-tone={tone}
        data-on={on || undefined}
        style={animated ? { transitionDelay: `${MARK_START + markIndex * MARK_STEP}s` } : undefined}
      >
        {part}
      </mark>
    )
  })
}

function Outcome({ example, reopenDays }) {
  if (example.sentiment === 'negative') {
    return (
      <ul className="space-y-2 text-sm text-ink-2">
        <li className="flex gap-2">
          <RotateCcw aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-3" />
          <span>
            The citizen is offered to reopen the complaint, which is possible for{' '}
            <span className="font-semibold text-ink">{reopenDays}</span> days after the fix.
          </span>
        </li>
        <li className="flex gap-2">
          <BellRing aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-3" />
          <span>Administrators are alerted to the negative feedback.</span>
        </li>
      </ul>
    )
  }
  return (
    <p className="flex gap-2 text-sm text-ink-2">
      <Archive aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-3" />
      <span>The complaint is closed and the rating counts towards the officer's and department's record.</span>
    </p>
  )
}

function FeedbackRow({ example, reopenDays, animated }) {
  const rowRef = useRef(null)
  const play = useInViewOnce(rowRef, { margin: '0px 0px -22% 0px' })
  const meta = SENTIMENT_META[example.sentiment]
  const sign = example.score > 0 ? '+' : '−'
  // No signed zero: until the count has left 0.00 (and for a score that rounds to it) the figure is a plain 0.
  const formatScore = (value) => {
    const magnitude = Math.round(Math.abs(value) * 100) / 100
    return magnitude === 0 ? formatNumber(0, { digits: 2 }) : `${sign}${formatNumber(magnitude, { digits: 2 })}`
  }
  const scoreDelay = MARK_START + example.phrases.length * MARK_STEP

  return (
    <li ref={rowRef} className="grid gap-5 px-5 py-6 sm:px-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)] lg:gap-8">
      <div className="min-w-0">
        <CascadeStars value={example.rating} play={play} animated={animated} label="Citizen rating" />
        <p className="mt-2.5 text-[15px] leading-relaxed text-ink sm:text-base">
          “
          <MarkedQuote text={example.text} phrases={example.phrases} tone={example.sentiment} play={play} animated={animated} />”
        </p>
      </div>
      <div className="min-w-0">
        <p className="mb-1.5 text-xs font-medium text-ink-3 lg:hidden">Sentiment</p>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={meta.tone} icon={meta.icon}>
            {meta.label}
          </Badge>
          <span className={cn('font-display text-lg font-extrabold leading-none text-ink tabular')}>
            {play || !animated ? <CountUp value={Math.abs(example.score)} format={formatScore} delay={scoreDelay} /> : formatScore(0)}
          </span>
        </div>
        <p className="mt-2.5 text-sm text-ink-2">
          Key phrases: <span className="text-ink">{example.phrases.join(', ')}</span>
        </p>
      </div>
      <div className="min-w-0">
        <p className="mb-1.5 text-xs font-medium text-ink-3 lg:hidden">What happens next</p>
        <Outcome example={example} reopenDays={reopenDays} />
      </div>
    </li>
  )
}

export function FeedbackSection() {
  const { reopenWindowDays } = useConfig()
  const reduced = usePrefersReducedMotion()

  return (
    <LandingSection id="citizen-feedback" labelledBy="feedback-title" tone="surface" joined>
      <LandingHeading
        layout="spread"
        id="feedback-title"
        title="Citizen Feedback"
        lead="The citizen who reported the issue has the last word. Their stars and their words are read by a sentiment model, so a polite five-star review and an angry two-star one lead to different next steps."
      />

      <div className="mt-12 overflow-hidden rounded-2xl border border-line bg-surface elev-raised">
        <div className="hidden grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)] gap-8 border-b border-line bg-surface-2 px-6 py-2.5 text-xs font-semibold text-ink-3 lg:grid">
          <span>Feedback</span>
          <span>Sentiment</span>
          <span>What happens next</span>
        </div>
        <ul className="divide-y divide-line">
          {FEEDBACK_EXAMPLES.map((example) => (
            <FeedbackRow key={example.id} example={example} reopenDays={reopenWindowDays} animated={!reduced} />
          ))}
        </ul>
        <p className="border-t border-line bg-surface-2 px-5 py-3 text-xs text-ink-3 sm:px-6">
          Worked examples, scored by the CivicAI sentiment engine. In Demo AI Mode it is a lexicon model that understands
          negation and civic phrases such as “resolved quickly” or “still not fixed”; in production a RoBERTa model reads
          the text.
        </p>
      </div>
    </LandingSection>
  )
}

export default FeedbackSection
