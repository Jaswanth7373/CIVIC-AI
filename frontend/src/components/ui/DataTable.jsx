import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react'
import { useRef, useState } from 'react'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { useScrollEdges } from '@/hooks/useScrollEdges'
import { cn } from '@/utils/cn'
import { EmptyState } from './EmptyState'
import { Skeleton } from './Skeleton'
import { useFrameRem } from './useFrameRem'

const ALIGN = { left: 'text-left', center: 'text-center', right: 'text-right' }
const INTERACTIVE = 'a, button, input, select, textarea, label, summary, [role="menuitem"], [role="menuitemradio"], [data-row-click="ignore"]'

/**
 * Where `mobileCard` cards give way to the table. Viewport breakpoints (`sm`...`xl`, Tailwind's widths) follow the
 * screen width; `@` sizes follow the width the table itself gets (the table frame's content box, in rem), so the
 * sidebar and multi-column page layouts are accounted for.
 */
const CARD_BREAKPOINTS = {
  sm: { query: '(min-width: 40rem)' },
  md: { query: '(min-width: 48rem)' },
  lg: { query: '(min-width: 64rem)' },
  xl: { query: '(min-width: 80rem)' },
  '@2xl': { minRem: 42 },
  '@3xl': { minRem: 48 },
  '@4xl': { minRem: 56 },
  '@5xl': { minRem: 64 },
  '@6xl': { minRem: 72 },
}
const DEFAULT_CARD_BREAKPOINT = '@3xl'
/** How many of the first rows fade in one after another. */
const ENTRANCE_ROWS = 8

/** Soft shadow on the side of a horizontally scrolling table that has more columns out of view. */
function EdgeShadow({ side }) {
  return (
    <span
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-y-0 z-[1] w-6 from-asphalt-950/15 to-transparent dark:from-black/60',
        side === 'start' ? 'left-0 bg-linear-to-r' : 'right-0 bg-linear-to-l',
      )}
    />
  )
}

/** `sort` may be a Django ordering string ("-priority_score") or `{key, direction}`. */
function parseSort(sort) {
  if (!sort) return { key: null, direction: null }
  if (typeof sort === 'string') {
    return sort.startsWith('-') ? { key: sort.slice(1), direction: 'desc' } : { key: sort, direction: 'asc' }
  }
  return { key: sort.key ?? null, direction: sort.direction ?? 'asc' }
}

/** Read `row["category.name"]`-style dotted paths. */
function readPath(row, path) {
  return String(path)
    .split('.')
    .reduce((value, part) => (value == null ? value : value[part]), row)
}

function defaultCell(value) {
  if (value === null || value === undefined || value === '') return <span className="text-ink-3">—</span>
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return value
}

/**
 * Data table for list screens.
 *
 * - Columns: `{key, header, render(row, index), sortable, sortKey, align, className, headerClassName,
 *   hideOnMobile, width}`. Without `render` the value at `key` (dotted paths allowed) is shown.
 * - Sorting is server-side: clicking a sortable header calls `onSortChange` with the next sort in the same
 *   format as `sort` - a Django ordering string ("priority_score" / "-priority_score", the default) or
 *   `{key, direction}`. A new column starts descending (newest / highest first), then toggles.
 * - Rows are clickable (mouse and keyboard: Enter / Space) when `onRowClick` is set; clicks on links,
 *   buttons and inputs inside a row are ignored so row actions keep working.
 * - Narrow spaces: with `mobileCard(row)` rows render as cards until `cardBreakpoint` - by default while the table
 *   itself is narrower than 48rem (`'@3xl'`, a container query, so a sidebar or a half-width card counts too);
 *   a viewport breakpoint (`'md'`, `'lg'`) or another width (`'@4xl'`, `'@5xl'`) can be chosen. Only the shown
 *   form is rendered: the frame is measured before the first paint (and on every resize) and the cards or the
 *   table are mounted, never both hidden behind CSS - that doubled the DOM of every list page. Otherwise the
 *   table scrolls horizontally inside its own frame (never the page) with a shadow on the side that has more
 *   columns, and `hideOnMobile` columns are hidden below md.
 * - `loading` shows skeleton rows on first load and a moving lane-line bar while refreshing.
 * - The first rows to arrive (up to 8) fade in one after another as they replace the skeleton; rows that
 *   arrive later (paging, sorting, refreshes) appear at once. No entrance with reduced motion.
 */
export function DataTable({
  columns = [],
  data = [],
  loading = false,
  rowKey = 'id',
  onRowClick,
  sort,
  onSortChange,
  empty,
  mobileCard,
  cardBreakpoint = DEFAULT_CARD_BREAKPOINT,
  caption,
  skeletonRows = 5,
  rowClassName,
  className,
}) {
  const [scrollerRef, edges] = useScrollEdges()
  const switchAt = CARD_BREAKPOINTS[cardBreakpoint] ?? CARD_BREAKPOINTS[DEFAULT_CARD_BREAKPOINT]
  const frameRef = useRef(null)
  const measureFrame = Boolean(mobileCard) && !switchAt.query
  // The frame's content width in rem (what a container query on it would see); null until measured.
  const frameRem = useFrameRem(frameRef, measureFrame)
  const wideViewport = useMediaQuery(switchAt.query ?? 'not all')
  // 'cards' | 'table' | null (not measured yet: the layout effect measures before the first paint).
  const layout = !mobileCard
    ? 'table'
    : switchAt.query
      ? wideViewport
        ? 'table'
        : 'cards'
      : frameRem === null
        ? null
        : frameRem >= switchAt.minRem
          ? 'table'
          : 'cards'
  const rows = Array.isArray(data) ? data : []
  const sortState = parseSort(sort)
  const showSkeleton = loading && rows.length === 0
  const refreshing = loading && rows.length > 0
  const clickable = typeof onRowClick === 'function'

  const keyOf = (row, index) => (typeof rowKey === 'function' ? rowKey(row, index) : (row?.[rowKey] ?? index))

  // Keys of the first rows ever shown: only they play the entrance (derived state, set once during render).
  const [firstRows, setFirstRows] = useState(null)
  if (firstRows === null && !showSkeleton && rows.length > 0) {
    setFirstRows(new Set(rows.slice(0, ENTRANCE_ROWS).map((row, index) => keyOf(row, index))))
  }
  const entrance = (row, index) =>
    firstRows?.has(keyOf(row, index))
      ? { className: 'animate-row-in motion-reduce:animate-none', style: { animationDelay: `${index * 45}ms` } }
      : { className: undefined, style: undefined }

  const toggleSort = (column) => {
    const key = column.sortKey ?? column.key
    const direction = sortState.key === key && sortState.direction === 'desc' ? 'asc' : 'desc'
    const objectFormat = sort !== null && typeof sort === 'object'
    onSortChange?.(objectFormat ? { key, direction } : direction === 'desc' ? `-${key}` : key)
  }

  const handleRowClick = (event, row) => {
    if (!clickable || event.target.closest(INTERACTIVE)) return
    onRowClick(row)
  }

  const handleRowKeyDown = (event, row) => {
    if (!clickable || event.target !== event.currentTarget) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onRowClick(row)
    }
  }

  const emptyNode = empty ?? (
    <EmptyState bordered={false} compact title="Nothing to show yet" description="Records will appear here as soon as they exist." />
  )

  const renderCell = (column, row, index) => (column.render ? column.render(row, index) : defaultCell(readPath(row, column.key)))

  return (
    <div
      ref={frameRef}
      className={cn(
        // `relative`: the frame is the containing block of absolutely positioned content in the cells (sr-only
        // labels), so content scrolled out of view is clipped here instead of widening the page.
        'relative min-w-0 overflow-hidden rounded-xl border border-line bg-surface',
        measureFrame && '@container',
        className,
      )}
      aria-busy={loading || undefined}
    >
      {refreshing ? (
        <div aria-hidden className="h-1 overflow-hidden bg-sunken">
          <div className="lane-line-x animate-lane h-full w-full" />
        </div>
      ) : null}

      {mobileCard && layout === 'cards' ? (
        <div>
          {showSkeleton ? (
            <ul aria-hidden className="divide-y divide-line">
              {Array.from({ length: Math.min(skeletonRows, 4) }, (_, index) => (
                <li key={index} className="space-y-2 p-4">
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-3 w-2/3" />
                </li>
              ))}
            </ul>
          ) : rows.length === 0 ? (
            emptyNode
          ) : (
            <ul className="divide-y divide-line">
              {rows.map((row, index) => {
                const enter = entrance(row, index)
                return (
                  <li
                    key={keyOf(row, index)}
                    tabIndex={clickable ? 0 : undefined}
                    onClick={(event) => handleRowClick(event, row)}
                    onKeyDown={(event) => handleRowKeyDown(event, row)}
                    style={enter.style}
                    className={cn(enter.className, clickable && 'cursor-pointer transition-colors hover:bg-surface-2 focus-visible:-outline-offset-2')}
                  >
                    {mobileCard(row, index)}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      ) : null}

      {layout === 'table' ? (
        <div className="relative">
          <div ref={scrollerRef} className="scrollbar-thin relative overflow-x-auto">
            <table className="w-full min-w-full border-collapse text-left text-sm">
              {caption ? <caption className="sr-only">{caption}</caption> : null}
              <thead className="bg-surface-2">
                <tr className="border-b border-line">
                  {columns.map((column) => {
                    const key = column.sortKey ?? column.key
                    const active = column.sortable && sortState.key === key
                    const ariaSort = active ? (sortState.direction === 'desc' ? 'descending' : 'ascending') : undefined
                    const SortIcon = active ? (sortState.direction === 'desc' ? ArrowDown : ArrowUp) : ChevronsUpDown
                    return (
                      <th
                        key={column.key}
                        scope="col"
                        aria-sort={ariaSort}
                        style={column.width ? { width: column.width } : undefined}
                        className={cn(
                          'whitespace-nowrap px-4 py-2.5 text-xs font-semibold text-ink-2',
                          ALIGN[column.align] ?? ALIGN.left,
                          column.hideOnMobile && 'hidden md:table-cell',
                          column.headerClassName,
                        )}
                      >
                        {column.sortable && onSortChange ? (
                          <button
                            type="button"
                            onClick={() => toggleSort(column)}
                            className={cn(
                              'inline-flex items-center gap-1 rounded-sm transition-colors hover:text-ink',
                              // Touch: a 44px target that fills the header cell's padding, so the row stays 44px.
                              'pointer-coarse:-my-2.5 pointer-coarse:min-h-11 pointer-coarse:min-w-11',
                              active && 'text-ink',
                              column.align === 'right' && 'flex-row-reverse',
                            )}
                          >
                            {column.header}
                            <SortIcon aria-hidden className={cn('size-3.5', !active && 'text-ink-3')} />
                          </button>
                        ) : (
                          column.header
                        )}
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody>
                {showSkeleton ? (
                  Array.from({ length: skeletonRows }, (_, rowIndex) => (
                    <tr key={`skeleton-${rowIndex}`} aria-hidden className="border-b border-line last:border-0">
                      {columns.map((column) => (
                        <td key={column.key} className={cn('px-4 py-3.5', column.hideOnMobile && 'hidden md:table-cell')}>
                          <Skeleton className="h-3.5 w-full max-w-36" />
                        </td>
                      ))}
                    </tr>
                  ))
                ) : rows.length === 0 ? (
                  <tr>
                    <td colSpan={Math.max(1, columns.length)} className="p-0">
                      {emptyNode}
                    </td>
                  </tr>
                ) : (
                  rows.map((row, index) => (
                    <tr
                      key={keyOf(row, index)}
                      tabIndex={clickable ? 0 : undefined}
                      onClick={(event) => handleRowClick(event, row)}
                      onKeyDown={(event) => handleRowKeyDown(event, row)}
                      style={entrance(row, index).style}
                      className={cn(
                        'border-b border-line transition-colors last:border-0',
                        entrance(row, index).className,
                        clickable && 'cursor-pointer hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:-outline-offset-2',
                        typeof rowClassName === 'function' ? rowClassName(row, index) : rowClassName,
                      )}
                    >
                      {columns.map((column) => (
                        <td
                          key={column.key}
                          className={cn(
                            'px-4 py-3 align-middle text-ink',
                            ALIGN[column.align] ?? ALIGN.left,
                            column.hideOnMobile && 'hidden md:table-cell',
                            column.className,
                          )}
                        >
                          {renderCell(column, row, index)}
                        </td>
                      ))}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {edges.start ? <EdgeShadow side="start" /> : null}
          {edges.end ? <EdgeShadow side="end" /> : null}
        </div>
      ) : null}
    </div>
  )
}

export default DataTable
