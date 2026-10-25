/**
 * ChartTable - the table twin of a chart: the same numbers as rows and columns.
 *
 * Props:
 * - caption: what the table shows (the chart title)
 * - columns: `[{key, label, align: 'left' | 'right', format(value, row)}]`
 * - rows: plain objects keyed by the column keys
 * - srOnly: render for screen readers only (used when a chart is shown on its own, without a ChartCard)
 * - className
 *
 * Every chart offers this view (ChartCard's chart / table toggle): it is the WCAG-friendly equivalent of
 * the graphic, gives exact values without hovering, and works without colour vision.
 */
import { cn } from '@/utils/cn'

export function ChartTable({ caption, columns = [], rows = [], srOnly = false, className }) {
  return (
    // `relative` makes the scroller the containing block of absolutely positioned cell content (sr-only text),
    // so rows or columns scrolled out of view are clipped here instead of lengthening or widening the page.
    <div className={cn(srOnly ? 'sr-only' : 'scrollbar-thin relative max-h-[26rem] overflow-auto rounded-lg border border-line', className)}>
      <table className="w-full border-collapse text-left text-sm">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead className="sticky top-0 bg-surface-2">
          <tr className="border-b border-line">
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cn('whitespace-nowrap px-3 py-2 text-xs font-semibold text-ink-2', column.align === 'right' ? 'text-right' : 'text-left')}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={row.__key ?? index} className="border-b border-line last:border-0">
              {columns.map((column, columnIndex) => {
                const value = row[column.key]
                const text = column.format ? column.format(value, row) : value
                const Cell = columnIndex === 0 ? 'th' : 'td'
                return (
                  <Cell
                    key={column.key}
                    scope={columnIndex === 0 ? 'row' : undefined}
                    className={cn(
                      'px-3 py-1.5 align-top',
                      columnIndex === 0 ? 'font-medium text-ink' : 'text-ink-2',
                      column.align === 'right' && 'text-right tabular',
                    )}
                  >
                    {text === null || text === undefined || text === '' ? '—' : text}
                  </Cell>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default ChartTable
