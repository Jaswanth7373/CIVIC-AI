/**
 * SegmentedControl - pick one of a few options (chart period "Day / Week / Month", "Count / Share").
 *
 * WAI-ARIA radio group: the group is labelled, the selected option has tabindex 0 (roving tabindex) and the
 * arrow keys, Home and End move the selection. Looks like the chart / table toggle of ChartCard, so the two
 * kinds of switches in a card header read as one family.
 *
 * Props:
 * - options: `[{value, label, title?}]`
 * - value: selected value
 * - onChange(value)
 * - label: accessible name of the group (required, e.g. "Time period")
 * - className
 *
 * Motion: the selected option's raised thumb slides to the new choice on the indicator spring (shared layout,
 * like the app's tab and navigation markers); with reduced motion it simply moves.
 */
import { motion } from 'framer-motion'
import { useId, useRef } from 'react'
import { SPRING } from '@/components/motion/tokens'
import { cn } from '@/utils/cn'

export function SegmentedControl({ options = [], value, onChange, label, className }) {
  const groupRef = useRef(null)
  const thumbId = useId()

  const select = (next) => {
    if (!next) return
    onChange?.(next.value)
    groupRef.current?.querySelector(`[data-value="${CSS.escape(String(next.value))}"]`)?.focus()
  }

  const handleKeyDown = (event) => {
    const index = options.findIndex((option) => option.value === value)
    const moves = {
      ArrowRight: index + 1,
      ArrowDown: index + 1,
      ArrowLeft: index - 1,
      ArrowUp: index - 1,
      Home: 0,
      End: options.length - 1,
    }
    if (!(event.key in moves) || !options.length) return
    event.preventDefault()
    select(options[(moves[event.key] + options.length) % options.length])
  }

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={label}
      onKeyDown={handleKeyDown}
      className={cn('isolate inline-flex shrink-0 rounded-lg bg-sunken p-0.5', className)}
    >
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={active}
            data-value={option.value}
            tabIndex={active ? 0 : -1}
            title={option.title}
            onClick={() => onChange?.(option.value)}
            className={cn(
              'relative inline-flex items-center justify-center rounded-md px-2.5 py-1 text-xs font-semibold transition-colors pointer-coarse:min-h-11 pointer-coarse:min-w-11',
              active ? 'text-ink' : 'text-ink-3 hover:text-ink',
            )}
          >
            {/* The thumb travels under every label: labels sit on a higher layer of the group. */}
            {active ? (
              <motion.span
                aria-hidden
                layoutId={`segment-thumb-${thumbId}`}
                transition={SPRING.indicator}
                className="absolute inset-0 rounded-md bg-surface shadow-[var(--shadow-raise)]"
              />
            ) : null}
            <span className="relative z-10">{option.label}</span>
          </button>
        )
      })}
    </div>
  )
}

export default SegmentedControl
