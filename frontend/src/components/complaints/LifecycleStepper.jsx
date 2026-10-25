/**
 * LifecycleStepper - compact horizontal progress through the eight complaint stages
 * (Submitted -> AI analyzed -> Assigned -> Accepted -> In progress -> Resolved -> Verified -> Closed).
 *
 * Props:
 * - status: current complaint status
 * - events: optional TimelineEvent[] - lets a rejected complaint show the stage it was rejected at
 * - showLabels: labels under every stop from the sm breakpoint (default true); phones always show only the
 *   current stage's label plus "Step 5 of 8"
 * - className
 *
 * Completed stages are solid highway-green discs with a tick, the current stage carries a road-marking
 * yellow ring, later stages are hollow; stops are joined by a lane line (yellow dashes up to the current
 * stage, grey ahead). `reopened` puts the complaint back at "Assigned" with a magenta "Reopened" tag;
 * `rejected` stops the road with a red "Rejected" tag. The list is an `<ol>` with `aria-current="step"`.
 *
 * Motion (first time it scrolls into view): the yellow lane paints itself from the first stage to the
 * current one, each completed disc pops as the lane reaches it, the current stage's ring lands and sends out
 * two soft "you are here" pulses, and the stages still ahead fade in. Reduced motion: the finished state.
 */
import { motion } from 'framer-motion'
import { Ban, Check, RotateCcw } from 'lucide-react'
import { useRef, useState } from 'react'
import { EASE } from '@/components/motion/tokens'
import { Badge } from '@/components/ui/Badge'
import { cn } from '@/utils/cn'
import { STEPPER_STAGES, stepperPosition } from './lifecycle'
import { useSequence } from './useSequence'

const MUTED_LANE_X = {
  backgroundImage: 'repeating-linear-gradient(to right, var(--c-line-strong) 0 6px, transparent 6px 11px)',
}
const POP = { type: 'spring', stiffness: 520, damping: 21, mass: 0.7 }

export function LifecycleStepper({ status, events, showLabels = true, className }) {
  const listRef = useRef(null)
  const { currentIndex, flag } = stepperPosition(status, events)
  const current = STEPPER_STAGES[currentIndex]
  const total = STEPPER_STAGES.length
  const finished = status === 'closed'
  const sequence = useSequence(listRef, { count: total, step: 0.11, maxTotal: 0.95 })
  const animate = sequence.play
  const shown = sequence.inView
  // The "you are here" pulses outlive the entrance cascade, so they are decided once, at mount.
  const [pulse] = useState(sequence.play)

  return (
    <div className={cn('min-w-0', className)}>
      <div className="mb-2 flex flex-wrap items-center gap-2 sm:hidden">
        <p className="text-sm font-semibold text-ink">{current.label}</p>
        <span className="text-xs text-ink-3 tabular">
          Step {currentIndex + 1} of {total}
        </span>
        {flag === 'reopened' ? (
          <Badge tone="magenta" size="sm" icon={RotateCcw}>
            Reopened
          </Badge>
        ) : null}
        {flag === 'rejected' ? (
          <Badge tone="red" size="sm" icon={Ban}>
            Rejected
          </Badge>
        ) : null}
      </div>

      <ol ref={listRef} aria-label="Complaint progress" className="flex w-full items-start">
        {STEPPER_STAGES.map((stage, index) => {
          const done = index < currentIndex || (finished && index === currentIndex)
          const isCurrent = index === currentIndex && !finished
          const stopped = flag === 'rejected' && index > currentIndex
          const reached = index <= currentIndex
          const Icon = stage.icon
          const start = sequence.delay(index)
          return (
            <li
              key={stage.key}
              aria-current={index === currentIndex ? 'step' : undefined}
              className="relative flex min-w-0 flex-1 flex-col items-center"
            >
              {index > 0 ? (
                <motion.span
                  aria-hidden
                  className={cn('absolute right-1/2 top-[13px] h-[3px] w-full -translate-y-1/2', reached && 'lane-line-x')}
                  style={reached ? undefined : { ...MUTED_LANE_X, opacity: stopped ? 0.4 : 1 }}
                  {...(animate
                    ? reached
                      ? {
                          // the lane paints from the previous stop to this one, arriving as this disc pops
                          initial: { clipPath: 'inset(0% 100% 0% 0%)' },
                          animate: shown ? { clipPath: 'inset(0% 0% 0% 0%)' } : undefined,
                          transition: { duration: sequence.step, ease: 'linear', delay: sequence.delay(index - 1) + 0.04 },
                        }
                      : {
                          initial: { opacity: 0 },
                          animate: shown ? { opacity: stopped ? 0.4 : 1 } : undefined,
                          transition: { duration: 0.3, delay: start },
                        }
                    : {})}
                />
              ) : null}
              <motion.span
                className={cn(
                  'relative z-10 grid size-[26px] place-items-center rounded-full',
                  done && 'bg-sign-600 text-white',
                  isCurrent && 'bg-surface text-ink ring-[3px] ring-marking-500',
                  !done && !isCurrent && 'bg-surface text-ink-3 ring-1 ring-line-strong',
                  flag === 'rejected' && isCurrent && 'ring-signal-500',
                )}
                {...(animate
                  ? reached
                    ? {
                        initial: { opacity: 0, scale: isCurrent ? 1.5 : 0.35 },
                        animate: shown ? { opacity: 1, scale: 1 } : undefined,
                        transition: { ...POP, delay: start },
                      }
                    : {
                        initial: { opacity: 0 },
                        animate: shown ? { opacity: 1 } : undefined,
                        transition: { duration: 0.3, ease: EASE.standard, delay: start },
                      }
                  : {})}
              >
                {isCurrent && pulse && !sequence.reduced ? (
                  <motion.span
                    aria-hidden
                    className={cn('pointer-events-none absolute -inset-1 rounded-full border-2', flag === 'rejected' ? 'border-signal-400' : 'border-marking-400')}
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={shown ? { opacity: [0, 0.8, 0], scale: [0.9, 1.25, 1.9] } : undefined}
                    transition={{ duration: 1.1, ease: EASE.standard, delay: start + 0.3, repeat: 1, repeatDelay: 0.3 }}
                  />
                ) : null}
                {done ? (
                  <Check aria-hidden className="size-3.5" strokeWidth={3} />
                ) : (
                  <Icon aria-hidden className="size-3.5" strokeWidth={2.2} />
                )}
                <span className="sr-only">
                  {stage.label}
                  {done ? ', completed' : isCurrent ? ', current stage' : ', not reached yet'}
                </span>
              </motion.span>
              {showLabels ? (
                <span
                  aria-hidden
                  className={cn(
                    'mt-1.5 hidden max-w-full px-0.5 text-center text-[11px] leading-tight sm:block',
                    isCurrent ? 'font-bold text-ink' : done ? 'font-medium text-ink-2' : 'text-ink-3',
                  )}
                >
                  {stage.label}
                </span>
              ) : null}
            </li>
          )
        })}
      </ol>

      {flag ? (
        <div className="mt-2 hidden sm:block">
          {flag === 'reopened' ? (
            <Badge tone="magenta" size="sm" icon={RotateCcw}>
              Reopened - waiting for the officer to accept the work again
            </Badge>
          ) : (
            <Badge tone="red" size="sm" icon={Ban}>
              Rejected at step {currentIndex + 1}: {current.label}
            </Badge>
          )}
        </div>
      ) : null}
    </div>
  )
}

export default LifecycleStepper
