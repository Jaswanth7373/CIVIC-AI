import { useRef } from 'react'
import { useInViewOnce } from '@/components/motion/hooks'
import { cn } from '@/utils/cn'
import { resolveTone, toneBar } from './tones'

const HEIGHTS = { sm: 'h-1.5', md: 'h-2', lg: 'h-3' }

/**
 * Horizontal progress / proportion bar with `role="progressbar"` semantics.
 *
 * Motion: the fill grows from empty to its real value the first time the bar is seen, and glides to new
 * values afterwards. The ARIA value is always the real one; with reduced motion the fill is drawn at once.
 *
 * @param {object} props
 * @param {number} props.value
 * @param {number} [props.max=100]
 * @param {'neutral'|'green'|'yellow'|'orange'|'red'|'blue'|'violet'|'teal'|'magenta'|'slate'} [props.tone='green']
 * @param {'sm'|'md'|'lg'} [props.size='md']
 * @param {import('react').ReactNode} [props.label] text above the bar (also the accessible name when a string)
 * @param {boolean} [props.showValue] shows the percentage (or `valueLabel`) at the right
 * @param {import('react').ReactNode} [props.valueLabel] custom value text, e.g. "35/40"
 */
export function ProgressBar({ value = 0, max = 100, tone = 'green', size = 'md', label, showValue = false, valueLabel, className }) {
  const trackRef = useRef(null)
  const seen = useInViewOnce(trackRef, { amount: 0.5, margin: '0px' })
  const safeMax = Number(max) > 0 ? Number(max) : 100
  const number = Number(value) || 0
  const percent = Math.min(100, Math.max(0, (number / safeMax) * 100))
  return (
    <div className={cn('w-full', className)}>
      {label || showValue ? (
        <div className="mb-1.5 flex items-baseline justify-between gap-3 text-xs">
          {label ? <span className="font-medium text-ink-2">{label}</span> : <span />}
          {showValue ? <span className="font-semibold text-ink tabular">{valueLabel ?? `${Math.round(percent)}%`}</span> : null}
        </div>
      ) : null}
      <div
        ref={trackRef}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={safeMax}
        aria-valuenow={number}
        aria-valuetext={typeof valueLabel === 'string' ? valueLabel : `${Math.round(percent)}%`}
        aria-label={typeof label === 'string' ? label : undefined}
        className={cn('w-full overflow-hidden rounded-full bg-sunken', HEIGHTS[size] ?? HEIGHTS.md)}
      >
        <div
          className={cn('h-full rounded-full transition-[width] duration-700 ease-enter', toneBar[resolveTone(tone)])}
          style={{ width: `${seen ? percent : 0}%` }}
        />
      </div>
    </div>
  )
}

export default ProgressBar
