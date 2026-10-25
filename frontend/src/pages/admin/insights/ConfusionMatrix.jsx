/**
 * ConfusionMatrix - the AI's category (rows) against the final category after officers / admins reviewed
 * the complaint (columns), from GET /analytics/ai/ `confusion` `[{ai, final, count}]` (category slugs).
 *
 * Reading it: the diagonal (outlined) holds the complaints whose AI category was kept; anything off the
 * diagonal is a correction ("the AI said drainage, the final category is pothole"). Cells are shaded in ONE
 * hue by their share of the row (sequential: more is darker) and always print their count, so nothing relies
 * on colour; the last column is each AI category's match rate. A real <table> with row and column headers,
 * scrolling inside its own container on narrow screens (the first column stays pinned).
 *
 * Props:
 * - data: `[{ai, final, count}]`
 * - intro: play the settle-in wave when first seen (default true); false on a return visit in the same session
 * - categories: CategoryMini / CategoryOut list (names, colours, display order)
 * - className
 *
 * Motion: the first time the matrix is seen its cells settle in as a wave from the top-left corner along the
 * diagonal (styles/admin.css `.ops-cell-in`); with reduced motion they are simply there.
 */
import { useMemo, useRef } from 'react'
import { Tag } from 'lucide-react'
import { useInViewOnce, usePrefersReducedMotion } from '@/components/motion/hooks'
import { readableInk, safeColor, useChartTheme, withAlpha } from '@/components/charts'
import { CategoryBadge } from '@/components/complaints'
import { cn } from '@/utils/cn'
import { formatNumber, formatPercent } from '@/utils/format'
import { getIcon, renderIcon } from '@/utils/icons'
import { markColor, shortCategoryName } from './insightUtils'
import '@/styles/admin.css'

const HUE = '#1f5fad'
/** Delay between neighbouring diagonals of the entrance wave (ms). */
const WAVE_STEP = 26

/** The table's scrolling frame; it owns the in-view trigger of the entrance wave (mounted with the table). */
function MatrixFrame({ children }) {
  const frameRef = useRef(null)
  const seen = useInViewOnce(frameRef)
  return (
    <div ref={frameRef} data-seen={seen || undefined} className="scrollbar-thin relative overflow-x-auto rounded-lg border border-line">
      {children}
    </div>
  )
}

function humanize(slug) {
  const text = String(slug ?? '')
    .replace(/[_-]+/g, ' ')
    .trim()
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Unknown'
}

export function ConfusionMatrix({ data, categories = [], intro = true, className }) {
  const theme = useChartTheme()
  const reduced = usePrefersReducedMotion()
  const hue = markColor(HUE, theme.mode)

  const { order, cells, rowTotals, correct, total } = useMemo(() => {
    const rows = (Array.isArray(data) ? data : []).filter((row) => row && Number(row.count) > 0)
    const present = new Set()
    const cellMap = new Map()
    const totals = new Map()
    let diagonal = 0
    let sum = 0
    rows.forEach((row) => {
      const ai = String(row.ai || 'unknown')
      const final = String(row.final || 'unknown')
      const count = Number(row.count) || 0
      present.add(ai)
      present.add(final)
      cellMap.set(`${ai}|${final}`, (cellMap.get(`${ai}|${final}`) ?? 0) + count)
      totals.set(ai, (totals.get(ai) ?? 0) + count)
      if (ai === final) diagonal += count
      sum += count
    })
    const known = categories.map((category) => String(category.slug)).filter((slug) => present.has(slug))
    const extra = [...present].filter((slug) => !known.includes(slug)).sort()
    return { order: [...known, ...extra], cells: cellMap, rowTotals: totals, correct: diagonal, total: sum }
  }, [data, categories])

  const categoryOf = (slug) => {
    const match = categories.find((category) => String(category.slug) === slug)
    return match ?? { slug, name: humanize(slug), icon: slug }
  }

  if (!total) return null

  return (
    <div className={cn('min-w-0', className)}>
      <p className="mb-3 text-sm text-ink-2">
        <span className="font-semibold text-ink tabular">{formatNumber(correct)}</span> of{' '}
        <span className="tabular">{formatNumber(total)}</span> AI categories were kept after review (
        <span className="tabular">{formatPercent(correct / total, { digits: 1 })}</span>). Rows are the AI&apos;s choice, columns
        the final category in the same order.
      </p>
      <MatrixFrame>
        <table className="w-full border-collapse text-xs">
          <caption className="sr-only">AI category compared with the final category after review</caption>
          <thead className="bg-surface-2">
            <tr className="border-b border-line">
              <th scope="col" className="sticky left-0 z-10 bg-surface-2 px-3 py-2 text-left font-semibold text-ink-2">
                AI category <span className="sr-only">(rows)</span>
              </th>
              {order.map((slug) => {
                const category = categoryOf(slug)
                const fill = safeColor(category.color)
                return (
                  <th key={slug} scope="col" title={category.name} className="w-11 min-w-11 px-0.5 py-2 text-center align-bottom">
                    {/* Same order as the rows, shown as the category's sign plate; the name is for screen readers. */}
                    <span
                      aria-hidden
                      className="mx-auto grid size-6 place-items-center rounded-[5px]"
                      style={{ backgroundColor: fill, color: readableInk(fill) }}
                    >
                      {renderIcon(getIcon(category.icon || category.slug, Tag), { className: 'size-3.5', strokeWidth: 2.4 })}
                    </span>
                    <span className="sr-only">{category.name}</span>
                  </th>
                )
              })}
              <th scope="col" className="px-3 py-2 text-right font-semibold text-ink-2">
                Match
              </th>
            </tr>
          </thead>
          <tbody>
            {order.map((ai, rowIndex) => {
              const rowTotal = rowTotals.get(ai) ?? 0
              const category = categoryOf(ai)
              return (
                <tr key={ai} className="border-b border-line last:border-0">
                  <th scope="row" className="sticky left-0 z-10 bg-surface px-3 py-1.5 text-left font-normal">
                    <CategoryBadge category={{ ...category, name: shortCategoryName(category.name) }} size="sm" />
                  </th>
                  {order.map((final, columnIndex) => {
                    const count = cells.get(`${ai}|${final}`) ?? 0
                    const share = rowTotal ? count / rowTotal : 0
                    const strong = share > 0.5
                    return (
                      <td
                        key={final}
                        className="p-0.5 text-center"
                        title={`AI ${category.name}, final ${categoryOf(final).name}: ${formatNumber(count)}`}
                      >
                        <span
                          className={cn(
                            'grid h-8 place-items-center rounded-[4px] font-semibold tabular',
                            ai === final && 'ring-1 ring-inset ring-line-strong',
                            count ? (strong ? 'text-white dark:text-asphalt-950' : 'text-ink') : 'text-ink-3',
                            !reduced && intro && 'ops-cell-in',
                          )}
                          style={{
                            backgroundColor: count ? withAlpha(hue, 0.12 + share * 0.78) : undefined,
                            '--cell-delay': reduced || !intro ? undefined : `${(rowIndex + columnIndex) * WAVE_STEP}ms`,
                          }}
                        >
                          {count ? formatNumber(count) : <span aria-label="0">·</span>}
                        </span>
                      </td>
                    )
                  })}
                  <td className="px-3 py-1.5 text-right font-semibold text-ink tabular">
                    {rowTotal ? formatPercent((cells.get(`${ai}|${ai}`) ?? 0) / rowTotal) : '—'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </MatrixFrame>
    </div>
  )
}

export default ConfusionMatrix
