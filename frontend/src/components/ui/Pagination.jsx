import { motion } from 'framer-motion'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useId } from 'react'
import { SPRING } from '@/components/motion/tokens'
import { cn } from '@/utils/cn'
import { formatNumber } from '@/utils/format'

/** Page numbers to show: first, last, the current page and its neighbours, with gaps ("…") between. */
function getPageItems(page, totalPages) {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, index) => index + 1)
  let start = Math.max(2, page - 1)
  let end = Math.min(totalPages - 1, page + 1)
  if (page <= 3) {
    start = 2
    end = 4
  } else if (page >= totalPages - 2) {
    start = totalPages - 3
    end = totalPages - 1
  }
  const items = [1]
  if (start > 2) items.push('gap-start')
  for (let number = start; number <= end; number += 1) items.push(number)
  if (end < totalPages - 1) items.push('gap-end')
  items.push(totalPages)
  return items
}

const buttonClass =
  'inline-grid h-9 min-w-9 place-items-center rounded-lg px-2 text-sm font-semibold transition-colors disabled:pointer-events-none disabled:opacity-45 pointer-coarse:h-11 pointer-coarse:min-w-11'

/** Previous / Next: chevron and label side by side (a grid would stack them). */
const stepClass =
  'inline-flex h-9 min-w-9 items-center justify-center gap-1 rounded-lg border border-line bg-surface px-2.5 text-sm font-semibold text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink disabled:pointer-events-none disabled:opacity-45 pointer-coarse:h-11 pointer-coarse:min-w-11'

/**
 * Pagination for the API's `{count, page, page_size, total_pages}` envelope:
 * "Showing 21-40 of 132" + previous / next + page numbers (numbers collapse to "Page 2 of 7" on phones).
 * The current-page marker slides to the chosen number.
 *
 * @param {{page: number, totalPages: number, count?: number, pageSize?: number, onPageChange: (page: number) => void, className?: string}} props
 */
export function Pagination({ page = 1, totalPages = 1, count, pageSize, onPageChange, className }) {
  const markerId = `${useId()}-page-marker`
  const total = Math.max(1, Number(totalPages) || 1)
  const current = Math.min(Math.max(1, Number(page) || 1), total)
  const hasCount = typeof count === 'number'
  if (hasCount && count === 0) return null

  const from = hasCount && pageSize ? (current - 1) * pageSize + 1 : null
  const to = hasCount && pageSize ? Math.min(count, current * pageSize) : null
  const go = (next) => {
    if (next >= 1 && next <= total && next !== current) onPageChange?.(next)
  }

  return (
    <nav
      aria-label="Pagination"
      className={cn('flex flex-col items-center justify-between gap-3 text-sm sm:flex-row', className)}
    >
      <p className="text-ink-3 tabular">
        {from != null ? (
          <>
            Showing <span className="font-semibold text-ink-2">{formatNumber(from)}</span>–
            <span className="font-semibold text-ink-2">{formatNumber(to)}</span> of{' '}
            <span className="font-semibold text-ink-2">{formatNumber(count)}</span>
          </>
        ) : (
          <>
            Page {current} of {total}
          </>
        )}
      </p>
      {total > 1 ? (
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => go(current - 1)}
            disabled={current <= 1}
            className={stepClass}
            aria-label="Previous page"
          >
            <ChevronLeft aria-hidden className="size-4" />
            <span className="hidden sm:inline">Previous</span>
          </button>
          <span className="px-2 text-ink-2 tabular sm:hidden">
            {current} / {total}
          </span>
          <ul className="hidden items-center gap-1 sm:flex">
            {getPageItems(current, total).map((item) =>
              typeof item === 'number' ? (
                <li key={item}>
                  <button
                    type="button"
                    onClick={() => go(item)}
                    aria-current={item === current ? 'page' : undefined}
                    aria-label={`Page ${item}`}
                    className={cn(
                      buttonClass,
                      'relative tabular',
                      item === current ? 'text-surface' : 'text-ink-2 hover:bg-sunken hover:text-ink',
                    )}
                  >
                    {/* Marker on layer 0, numbers on layer 1: it slides under the other numbers, never over them. */}
                    {item === current ? (
                      <motion.span aria-hidden layoutId={markerId} transition={SPRING.indicator} className="absolute inset-0 z-0 rounded-lg bg-ink" />
                    ) : null}
                    <span className="relative z-[1]">{item}</span>
                  </button>
                </li>
              ) : (
                <li key={item} aria-hidden className="px-1 text-ink-3">
                  …
                </li>
              ),
            )}
          </ul>
          <button
            type="button"
            onClick={() => go(current + 1)}
            disabled={current >= total}
            className={stepClass}
            aria-label="Next page"
          >
            <span className="hidden sm:inline">Next</span>
            <ChevronRight aria-hidden className="size-4" />
          </button>
        </div>
      ) : null}
    </nav>
  )
}

export default Pagination
