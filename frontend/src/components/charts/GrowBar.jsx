/**
 * GrowBar - a thin HTML meter (track + fill) whose fill grows to its real value the first time it scrolls
 * into view, and glides to new values afterwards. For list-style charts drawn in HTML (rating distribution,
 * predictions by category, keyword ranks) where every number is also printed as text next to the bar.
 *
 * - Decorative: the track is `aria-hidden`; the row's text carries the value.
 * - `delay` (ms) staggers the bars of one list (index x STAGGER step); applied to later changes too, so an
 *   updated list re-settles in the same order.
 * - Reduced motion: the fill is drawn at its value at once (useInViewOnce is true, transitions are off).
 * - Without an entrance (ChartEntranceContext false, a return visit) the fill starts at its value; later
 *   changes still glide.
 *
 * Props: ratio (0..1), color (fill colour; or use fillClassName), delay, as ('span' | 'div'), className (track
 * classes: height, flex sizing), fillClassName.
 */
import { useContext, useRef } from 'react'
import { useInViewOnce } from '@/components/motion/hooks'
import { cn } from '@/utils/cn'
import { ChartEntranceContext } from './chartContext'

export function GrowBar({ ratio, color, delay = 0, as: Track = 'span', className, fillClassName }) {
  const trackRef = useRef(null)
  const seen = useInViewOnce(trackRef)
  const entrance = useContext(ChartEntranceContext)
  const percent = Math.min(1, Math.max(0, Number(ratio) || 0)) * 100
  return (
    <Track ref={trackRef} aria-hidden className={cn('block overflow-hidden rounded-full bg-sunken', className)}>
      <span
        className={cn('block h-full rounded-full transition-[width] duration-700 ease-enter', fillClassName)}
        style={{
          width: `${seen || !entrance ? percent : 0}%`,
          backgroundColor: color,
          transitionDelay: delay ? `${Math.round(delay)}ms` : undefined,
        }}
      />
    </Track>
  )
}

export default GrowBar
