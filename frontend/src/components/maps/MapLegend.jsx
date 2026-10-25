/**
 * MapLegend - what the colours and shapes on a map mean.
 *
 * Props:
 * - items: `[{key, label, color, shape: 'pin' | 'circle' | 'dot'}]`
 * - categories: CategoryMini list -> one pin entry per category (in its own colour)
 * - levels: true adds the four severity levels as circles (for HotspotLayer)
 * - showCritical: adds the "critical priority" pin badge entry (default true when categories are given)
 * - title: default "Legend"
 * - position: Leaflet corner when rendered inside a map (default 'bottomleft')
 * - className
 *
 * Inside a map (any child of BaseMap / ComplaintMap, detected through InsideMapContext) it renders as a
 * Leaflet control (MapControl);
 * anywhere else it renders inline, e.g. under the map on small screens. It is a disclosure (`<details>`),
 * so it can be folded away on a phone; it starts open from the md breakpoint.
 */
import { useContext } from 'react'
import { safeColor, withAlpha } from '@/components/charts/palette'
import { BREAKPOINTS, useMediaQuery } from '@/hooks/useMediaQuery'
import { cn } from '@/utils/cn'
import { LEVEL_META, LEVEL_ORDER } from '@/utils/constants'
import { InsideMapContext } from './mapContext'
import { MapControl } from './MapControl'

function Swatch({ shape, color }) {
  const fill = safeColor(color, '#6a7a77')
  if (shape === 'circle') {
    return (
      <span
        aria-hidden
        className="size-3.5 shrink-0 rounded-full border-2"
        style={{ borderColor: fill, backgroundColor: withAlpha(fill, 0.22) }}
      />
    )
  }
  if (shape === 'critical') {
    return (
      <span aria-hidden className="relative size-3.5 shrink-0">
        <span className="absolute inset-0.5 rounded-full bg-asphalt-400" />
        <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-signal-500 ring-1 ring-white" />
      </span>
    )
  }
  if (shape === 'dot') return <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: fill }} />
  return (
    <svg aria-hidden viewBox="0 0 28 36" className="h-4 w-3.5 shrink-0">
      <path
        d="M14 1.2C7.1 1.2 1.6 6.6 1.6 13.3c0 8.3 10.4 19.2 11.5 20.3a1.3 1.3 0 0 0 1.8 0c1.1-1.1 11.5-12 11.5-20.3C26.4 6.6 20.9 1.2 14 1.2Z"
        fill={fill}
        stroke="#ffffff"
        strokeWidth="2"
      />
    </svg>
  )
}

export function MapLegend({ items, categories, levels = false, showCritical, title = 'Legend', position = 'bottomleft', className }) {
  const insideMap = useContext(InsideMapContext)
  const wide = useMediaQuery(BREAKPOINTS.md)
  const entries = items
    ? items
    : [
        ...(categories ?? []).map((category) => ({
          key: `category-${category.slug ?? category.id ?? category.name}`,
          label: category.name,
          color: category.color,
          shape: 'pin',
        })),
        ...((showCritical ?? Boolean(categories?.length))
          ? [{ key: 'critical', label: 'Critical priority', shape: 'critical' }]
          : []),
        ...(levels
          ? LEVEL_ORDER.map((level) => ({
              key: `level-${level}`,
              label: `${LEVEL_META[level].label} severity`,
              color: LEVEL_META[level].color,
              shape: 'circle',
            }))
          : []),
      ]
  if (!entries.length) return null

  const content = (
    <details
      open={wide || undefined}
      className={cn(
        'group max-w-[min(16rem,calc(100vw-5rem))] rounded-lg border border-line bg-surface/95 text-xs text-ink shadow-[var(--shadow-overlay)] backdrop-blur-sm',
        !insideMap && 'shadow-none',
        className,
      )}
    >
      <summary className="cursor-pointer select-none rounded-lg px-3 py-2 font-semibold text-ink marker:text-ink-3 pointer-coarse:min-h-11 pointer-coarse:py-3">
        {title}
      </summary>
      <ul className="scrollbar-thin max-h-52 space-y-1.5 overflow-y-auto px-3 pb-2.5">
        {entries.map((entry) => (
          <li key={entry.key ?? entry.label} className="flex items-center gap-2">
            <Swatch shape={entry.shape} color={entry.color} />
            <span className="min-w-0 truncate text-ink-2">{entry.label}</span>
          </li>
        ))}
      </ul>
    </details>
  )

  return insideMap ? <MapControl position={position}>{content}</MapControl> : content
}

export default MapLegend
