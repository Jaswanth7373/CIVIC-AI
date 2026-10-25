/**
 * SplitBar - a thin 100% bar of a few parts (e.g. duplicate pairs: confirmed / not duplicates / pending),
 * optionally with a legend that carries every value and share as text.
 *
 * Marks: 2 px surface gaps between segments, rounded outer ends, colours that carry meaning (pass them in).
 * The legend is the accessible version; the bar itself is hidden from screen readers when a legend is shown,
 * otherwise it is a labelled image ("Pending 25, In progress 32, ...").
 *
 * Props:
 * - segments: `[{key, label, value, color}]` (zero values are skipped in the bar, kept in the legend)
 * - size: 'sm' (6 px) | 'md' (10 px), default 'md'
 * - legend: show the legend (default true)
 * - label: accessible summary prefix (default "Split")
 * - className
 *
 * Motion: the first time the bar is seen it is drawn from left to right (a wipe over the whole bar, so the
 * segments keep their true proportions throughout); with reduced motion it is simply there.
 */
import { useRef } from 'react'
import { useInViewOnce } from '@/components/motion/hooks'
import { cn } from '@/utils/cn'
import { formatNumber, formatPercent } from '@/utils/format'

const HEIGHTS = { sm: 'h-1.5', md: 'h-2.5' }

export function SplitBar({ segments = [], size = 'md', legend = true, label = 'Split', className }) {
  const barRef = useRef(null)
  const seen = useInViewOnce(barRef)
  const items = segments.filter(Boolean).map((segment) => ({ ...segment, value: Math.max(0, Number(segment.value) || 0) }))
  const total = items.reduce((sum, segment) => sum + segment.value, 0)
  const summary = `${label}: ${items.map((segment) => `${segment.label} ${formatNumber(segment.value)}`).join(', ')}`

  return (
    <div className={cn('min-w-0', className)}>
      <div
        ref={barRef}
        role={legend ? undefined : 'img'}
        aria-hidden={legend || undefined}
        aria-label={legend ? undefined : summary}
        className={cn(
          'flex w-full gap-0.5 overflow-hidden rounded-full bg-sunken transition-[clip-path] duration-1000 ease-enter',
          HEIGHTS[size] ?? HEIGHTS.md,
        )}
        style={{ clipPath: seen ? 'inset(0 0 0 0 round 9999px)' : 'inset(0 100% 0 0 round 9999px)' }}
      >
        {total
          ? items
              .filter((segment) => segment.value > 0)
              .map((segment) => (
                <span
                  key={segment.key}
                  title={`${segment.label}: ${formatNumber(segment.value)}`}
                  className="h-full min-w-[3px]"
                  style={{ flex: `${segment.value} 1 0%`, backgroundColor: segment.color }}
                />
              ))
          : null}
      </div>
      {legend ? (
        <ul className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5 text-xs" aria-label={label}>
          {items.map((segment) => (
            <li key={segment.key} className="inline-flex items-center gap-1.5">
              <span aria-hidden className="size-2.5 shrink-0 rounded-[3px]" style={{ backgroundColor: segment.color }} />
              <span className="text-ink-2">{segment.label}</span>
              <span className="font-semibold text-ink tabular">{formatNumber(segment.value)}</span>
              {total ? <span className="text-ink-3 tabular">{formatPercent(segment.value / total)}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

export default SplitBar
