/**
 * CategoryPredictions - how many complaints the AI put in each category, with the average confidence of
 * those predictions (GET /analytics/ai/ `predictions_by_category` `[{category: CategoryMini, count,
 * avg_confidence}]`).
 *
 * Nine categories all carry meaning, so every number is printed and a ranked bar gives the shape (one shared
 * scale, longest = most predictions). The bars share ONE neutral magnitude colour (chart palette
 * MAGNITUDE_COLOR): the category's own colour stays on its badge, and red, orange, yellow and green keep meaning
 * severity, status and sentiment on this page. Categories show their short name ("Water Supply") with the full
 * name in the tooltip. When the panel is at least 24rem wide each
 * category is one line (category, bar, count, confidence) under a small header; narrower panels stack the
 * bar under the category. Each row reads as one sentence for screen readers.
 *
 * Props:
 * - data: rows as above
 * - className
 *
 * Motion: the bars grow to their counts one after another, largest first, when the list is first seen.
 */
import { useMemo } from 'react'
import { GrowBar, useChartTheme } from '@/components/charts'
import { CategoryBadge } from '@/components/complaints'
import { STAGGER } from '@/components/motion/tokens'
import { cn } from '@/utils/cn'
import { formatNumber } from '@/utils/format'
import { formatShare, shortCategoryName } from './insightUtils'

const WIDE_GRID = '@sm:grid @sm:grid-cols-[minmax(0,9rem)_minmax(0,1fr)_2.5rem_4.75rem] @sm:items-center @sm:gap-x-3'

export function CategoryPredictions({ data, className }) {
  const { magnitude } = useChartTheme()
  const rows = useMemo(
    () =>
      (Array.isArray(data) ? data.filter(Boolean) : []).slice().sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0)),
    [data],
  )
  const max = Math.max(1, ...rows.map((row) => Number(row.count) || 0))
  if (!rows.length) return null

  return (
    <div className={cn('@container flex min-w-0 flex-col', className)}>
      <div aria-hidden className={cn('mb-2 hidden border-b border-line pb-2 text-xs font-semibold text-ink-2', WIDE_GRID)}>
        <span>Category</span>
        <span>Predictions</span>
        <span />
        <span className="text-right">Confidence</span>
      </div>
      <ol aria-label="AI predictions by category" className="flex flex-1 flex-col justify-between gap-3 @sm:gap-2">
        {rows.map((row, index) => {
          const count = Number(row.count) || 0
          return (
            <li key={row.category?.id ?? row.category?.slug ?? index} className={cn('flex min-w-0 flex-col gap-1.5', WIDE_GRID)}>
              <div className="flex min-w-0 items-center justify-between gap-3 @sm:contents">
                <span className="min-w-0 justify-self-start" title={row.category?.name}>
                  <CategoryBadge
                    category={row.category ? { ...row.category, name: shortCategoryName(row.category.name) } : null}
                    size="sm"
                  />
                </span>
                <span className="shrink-0 text-xs text-ink-3 @sm:order-4 @sm:text-right">
                  <span className="font-semibold text-ink-2 tabular">{formatShare(row.avg_confidence)}</span>
                  <span className="@sm:sr-only"> avg confidence</span>
                </span>
              </div>
              <div className="flex min-w-0 items-center gap-2.5 @sm:contents">
                <GrowBar
                  as="div"
                  ratio={count / max}
                  color={magnitude}
                  delay={Math.min(index, STAGGER.max) * STAGGER.step * 1000}
                  className="h-2 flex-1 @sm:order-2"
                />
                <span className="w-10 text-right text-sm font-semibold text-ink tabular @sm:order-3 @sm:w-auto">
                  {formatNumber(count)}
                  <span className="sr-only"> predictions</span>
                </span>
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

export default CategoryPredictions
