/**
 * ChartTooltip - Recharts `content` component styled with the design tokens.
 *
 * Usage: `<Tooltip content={<ChartTooltip valueFormatter={formatHours} />} />` (Recharts injects `active`,
 * `payload` and `label`).
 *
 * Props (besides the injected ones):
 * - valueFormatter(value, entry): default Indian-grouped numbers
 * - labelFormatter(label, payload): tooltip title (default: the row's `__label`, else the axis label)
 * - getColor(entry): key colour of a row (default: the row's `__color`, else the series colour)
 * - showTotal: add a "Total" row (stacked charts)
 * - hideZero: drop zero rows (stacked charts with many series)
 *
 * Reading rules: the VALUE leads in strong ink and the series name follows in muted ink (the reader already
 * knows the series and wants the number); every series at the hovered position is listed, keyed by a short
 * stroke of its colour - text itself never takes the series colour. Labels are rendered as React text nodes,
 * so names coming from the API can never inject markup.
 *
 * Look: a floating layer of the elevation system (`bg-elevated`, `elev-floating`), the hovered date or item
 * as a small header over a hairline, values in tabular figures. It rises in over 180 ms when it appears
 * (`chart-tooltip`, styles/admin.css) and glides between items with the wrappers' TOOLTIP_MOTION.
 */
import { formatNumber } from '@/utils/format'
import '@/styles/admin.css'

export function ChartTooltip({ active, payload, label, valueFormatter = formatNumber, labelFormatter, getColor, showTotal = false, hideZero = false }) {
  if (!active || !Array.isArray(payload) || !payload.length) return null
  const rows = payload.filter((entry) => entry && entry.value !== null && entry.value !== undefined && !entry.hide && !(hideZero && Number(entry.value) === 0))
  if (!rows.length) return null
  const datum = rows[0]?.payload
  const title = labelFormatter ? labelFormatter(label, payload) : (datum?.__label ?? label)
  const total = showTotal ? rows.reduce((sum, entry) => sum + (Number(entry.value) || 0), 0) : null
  const hasTitle = title !== null && title !== undefined && title !== ''

  return (
    <div className="chart-tooltip pointer-events-none min-w-40 max-w-72 rounded-lg border border-line bg-elevated px-3 py-2.5 text-xs text-ink elev-floating">
      {hasTitle ? <p className="mb-2 border-b border-line pb-1.5 font-display text-[13px] font-bold leading-tight text-ink">{title}</p> : null}
      <ul className="space-y-1.5">
        {rows.map((entry, index) => {
          const color = getColor?.(entry) ?? entry.payload?.__color ?? entry.color ?? entry.fill ?? entry.stroke
          return (
            <li key={`${entry.dataKey ?? entry.name ?? index}`} className="flex items-center gap-2">
              <span aria-hidden className="h-[3px] w-3.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
              <span className="text-[13px] font-bold leading-none text-ink tabular">{valueFormatter(entry.value, entry)}</span>
              <span className="min-w-0 truncate text-ink-3">{entry.name}</span>
            </li>
          )
        })}
        {total !== null ? (
          <li className="mt-1.5 flex items-center gap-2 border-t border-line pt-1.5">
            <span aria-hidden className="w-3.5 shrink-0" />
            <span className="text-[13px] font-bold leading-none text-ink tabular">{valueFormatter(total)}</span>
            <span className="text-ink-3">Total</span>
          </li>
        ) : null}
      </ul>
    </div>
  )
}

export default ChartTooltip
