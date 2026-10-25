/**
 * ChartLegend - accessible HTML legend for charts with two or more series.
 *
 * Props:
 * - items: `[{key, label, color, value?}]`
 * - shape: swatch that mirrors the mark - 'rect' (bars, areas) | 'line' (lines) | 'dot' (default 'rect')
 * - hidden: Set of hidden keys; with `onToggle(key)` every item becomes a toggle button (aria-pressed),
 *   so a series can be hidden to read the others - its colour never moves to another series
 * - formatValue: formatter for the optional `value` shown after the label
 * - className
 *
 * A legend is the dependable identity channel: it is always present for multi-series charts, so colour is
 * never the only way to tell series apart. Text stays in ink colours; only the swatch carries the hue.
 */
import { cn } from '@/utils/cn'

function Swatch({ shape, color, muted }) {
  const style = { backgroundColor: color, opacity: muted ? 0.35 : 1 }
  if (shape === 'line') return <span aria-hidden className="h-[3px] w-3.5 shrink-0 rounded-full" style={style} />
  if (shape === 'dot') return <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={style} />
  return <span aria-hidden className="size-2.5 shrink-0 rounded-[3px]" style={style} />
}

export function ChartLegend({ items = [], shape = 'rect', hidden, onToggle, formatValue, className }) {
  if (!items.length) return null
  const toggleable = typeof onToggle === 'function'
  return (
    <ul className={cn('flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-ink-2', className)} aria-label="Legend">
      {items.map((item) => {
        const isHidden = hidden?.has(item.key) ?? false
        const content = (
          <>
            <Swatch shape={shape} color={item.color} muted={isHidden} />
            <span className={cn('min-w-0 truncate', isHidden && 'text-ink-3 line-through')}>{item.label}</span>
            {item.value !== undefined && item.value !== null ? (
              <span className="font-semibold text-ink tabular">{formatValue ? formatValue(item.value) : item.value}</span>
            ) : null}
          </>
        )
        return (
          <li key={item.key} className="min-w-0">
            {toggleable ? (
              <button
                type="button"
                aria-pressed={!isHidden}
                title={isHidden ? `Show ${item.label}` : `Hide ${item.label}`}
                onClick={() => onToggle(item.key)}
                className="inline-flex max-w-full items-center gap-1.5 rounded-md px-1 py-0.5 transition-colors hover:bg-sunken hover:text-ink pointer-coarse:min-h-11 pointer-coarse:px-2"
              >
                {content}
              </button>
            ) : (
              <span className="inline-flex max-w-full items-center gap-1.5">{content}</span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

export default ChartLegend
