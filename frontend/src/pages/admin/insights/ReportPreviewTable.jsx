/**
 * ReportPreviewTable - the live preview of a report (GET /analytics/reports/?format=json `columns: [{key,
 * label}]`, `rows: [dict keyed by column key]`), formatted for reading and for print.
 *
 * Cell formatting is derived from the data, never from a per-report list, so new report columns just work:
 * - null / '' -> em dash; booleans -> Yes / No; ISO timestamps -> "17 Oct 2026, 2:30 PM";
 * - numbers are right-aligned with tabular figures; a "(%)" column prints "75%", an "(h)" column "46.7 h"
 *   (the unit moves from the header into the cell);
 * - in grouped reports (the summary report's first column, "Section") a repeated group name is shown once.
 * Screen: the table scrolls inside its container with a sticky header. On phones text columns and headers wrap,
 * so a narrow report (the summary: section, metric, value) fits without hiding its values off to the side;
 * wide reports still scroll inside the frame. Print: no scrolling, every column wraps, smaller type (the
 * browser's print view of the Reports page).
 *
 * Props:
 * - columns, rows: as above
 * - groupFirstColumn: show the first column only when its value changes (default false)
 * - className
 */
import { useMemo } from 'react'
import { cn } from '@/utils/cn'
import { formatDateTime, formatNumber } from '@/utils/format'

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/
const UNIT = /\s*\((%|h)\)\s*$/i

function parseColumn(column, rows) {
  const label = String(column.label ?? column.key)
  const unitMatch = UNIT.exec(label)
  const values = rows.map((row) => row?.[column.key]).filter((value) => value !== null && value !== undefined && value !== '')
  const numeric = values.length > 0 && values.every((value) => typeof value === 'number')
  const long = !numeric && values.some((value) => typeof value === 'string' && value.length > 40)
  return {
    key: column.key,
    label: unitMatch ? label.replace(UNIT, '') : label,
    unit: unitMatch ? unitMatch[1].toLowerCase() : null,
    numeric,
    long,
  }
}

function formatCell(value, column) {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'number') {
    const digits = Number.isInteger(value) ? 0 : 2
    if (column.unit === '%') return `${formatNumber(value, { digits: 1 })}%`
    if (column.unit === 'h') return `${formatNumber(value, { digits: 1 })} h`
    return formatNumber(value, { digits })
  }
  if (typeof value === 'string' && ISO_DATETIME.test(value)) return formatDateTime(value)
  if (Array.isArray(value)) return value.join(', ')
  return String(value)
}

export function ReportPreviewTable({ columns = [], rows = [], groupFirstColumn = false, className }) {
  const parsed = useMemo(() => columns.map((column) => parseColumn(column, rows)), [columns, rows])

  return (
    <div
      className={cn(
        'scrollbar-thin relative max-h-[38rem] overflow-auto rounded-lg border border-line print:max-h-none print:overflow-visible print:rounded-none print:border-0',
        className,
      )}
    >
      <table className="w-full border-collapse text-left text-sm print:text-[10px]">
        <thead className="sticky top-0 z-10 bg-surface-2 print:static">
          <tr className="border-b border-line-strong">
            {parsed.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cn(
                  'px-3 py-2 text-xs font-semibold text-ink-2 sm:whitespace-nowrap print:whitespace-normal print:px-1.5 print:py-1',
                  column.numeric ? 'text-right' : 'text-left',
                )}
              >
                {column.label}
                {column.unit ? <span className="sr-only"> ({column.unit === '%' ? 'percent' : 'hours'})</span> : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => {
            const groupStart = groupFirstColumn && rowIndex > 0 && row?.[parsed[0]?.key] !== rows[rowIndex - 1]?.[parsed[0]?.key]
            return (
              <tr
                key={rowIndex}
                className={cn(
                  'border-b border-line last:border-0 even:bg-surface-2/50 print:break-inside-avoid print:even:bg-transparent',
                  groupStart && 'border-t border-t-line-strong',
                )}
              >
                {parsed.map((column, columnIndex) => {
                  const value = row?.[column.key]
                  const hideRepeat =
                    groupFirstColumn && columnIndex === 0 && rowIndex > 0 && value === rows[rowIndex - 1]?.[column.key]
                  const text = formatCell(value, column)
                  const Cell = columnIndex === 0 ? 'th' : 'td'
                  return (
                    <Cell
                      key={column.key}
                      scope={columnIndex === 0 ? 'row' : undefined}
                      title={column.long && typeof value === 'string' ? value : undefined}
                      className={cn(
                        'px-3 py-2 align-top print:px-1.5 print:py-1',
                        columnIndex === 0 ? 'font-medium text-ink' : 'text-ink-2',
                        column.numeric && 'whitespace-nowrap text-right tabular',
                        !column.numeric && !column.long && 'sm:whitespace-nowrap print:whitespace-normal',
                        column.long && 'min-w-56 max-w-sm print:min-w-0 print:max-w-none',
                      )}
                    >
                      {hideRepeat ? (
                        <span className="sr-only">{text}</span>
                      ) : column.long ? (
                        <span className="line-clamp-2 print:line-clamp-none">{text}</span>
                      ) : (
                        text
                      )}
                    </Cell>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export default ReportPreviewTable
