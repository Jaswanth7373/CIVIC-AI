/**
 * ChartCard - the panel every chart sits in: title, description, actions, and the loading / empty / error
 * states, plus a chart / table toggle.
 *
 * Props:
 * - title, description, icon, actions: card header (actions sit right of the title, e.g. a period select)
 * - loading: first load (no data yet) -> skeleton; refetch while a chart is already shown -> the chart stays
 *   on screen dimmed with a moving lane-line bar (no layout jump, no skeleton flash)
 * - empty: true -> default empty state; a string -> its description; a node -> rendered as the empty state.
 *   Charts inside also show their own empty state when their data is empty, so `empty` is optional.
 * - emptyTitle / emptyDescription / emptyIcon: copy for the default empty state
 * - error / onRetry: failure state with a "Try again" button (under ChartErrorModeContext 'quiet' - the page
 *   shows one error for all its requests - a muted "not available" placeholder instead)
 * - height: plot height in px for the chart inside (each chart has a sensible default otherwise)
 * - footer: content under the chart (a note, a link to the report)
 * - className, bodyClassName
 * - children: a chart wrapper (BarChartCard, DonutChart ...) or any custom content
 *
 * Chart wrappers rendered inside register with the card (chartContext.js). Then the header offers the
 * "Table" view - the same numbers as an accessible table, the twin every chart must have - and the card knows
 * it may keep the previous chart visible during a refetch.
 */
import { motion } from 'framer-motion'
import { ChartColumn, CloudOff, Table2 } from 'lucide-react'
import { isValidElement, useCallback, useContext, useId, useMemo, useState } from 'react'
import { SPRING } from '@/components/motion/tokens'
import { Card, CardBody, CardFooter, CardHeader } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { cn } from '@/utils/cn'
import { ChartCardContext, ChartErrorModeContext } from './chartContext'

const DEFAULT_SKELETON_HEIGHT = 260

/**
 * Chart / table switch. The raised thumb slides between the two on the indicator spring (labels stay above
 * it); labels show when the card itself has room, so narrow cards keep the switch beside their title.
 */
function ViewToggle({ view, onChange }) {
  const thumbId = useId()
  const options = [
    { id: 'chart', label: 'Chart', icon: ChartColumn },
    { id: 'table', label: 'Table', icon: Table2 },
  ]
  return (
    <div role="group" aria-label="Show as" className="isolate inline-flex rounded-lg bg-sunken p-0.5">
      {options.map((option) => {
        const Icon = option.icon
        const active = view === option.id
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={active}
            title={`Show as ${option.label.toLowerCase()}`}
            onClick={() => onChange(option.id)}
            className={cn(
              'relative inline-flex items-center justify-center rounded-md px-2 py-1 text-xs font-semibold transition-colors pointer-coarse:min-h-11 pointer-coarse:min-w-11',
              active ? 'text-ink' : 'text-ink-3 hover:text-ink',
            )}
          >
            {active ? (
              <motion.span
                aria-hidden
                layoutId={`chart-view-${thumbId}`}
                transition={SPRING.indicator}
                className="absolute inset-0 rounded-md bg-surface shadow-[var(--shadow-raise)]"
              />
            ) : null}
            <span className="relative z-10 inline-flex items-center gap-1">
              <Icon aria-hidden className="size-3.5" />
              <span className="sr-only @md/card:not-sr-only">{option.label}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

export function ChartCard({
  title,
  description,
  icon,
  actions,
  loading = false,
  empty,
  emptyTitle = 'No data yet',
  emptyDescription = 'Numbers appear here as soon as there is activity for the selected filters.',
  emptyIcon = ChartColumn,
  error,
  onRetry,
  height,
  footer,
  className,
  bodyClassName,
  children,
}) {
  const errorMode = useContext(ChartErrorModeContext)
  const [view, setView] = useState('chart')
  const [charts, setCharts] = useState({ withData: 0, withTable: 0 })

  const register = useCallback((hasData, hasTable) => {
    const table = hasData && hasTable ? 1 : 0
    const data = hasData ? 1 : 0
    setCharts((current) => ({ withData: current.withData + data, withTable: current.withTable + table }))
    return () => setCharts((current) => ({ withData: current.withData - data, withTable: current.withTable - table }))
  }, [])
  const caption = typeof title === 'string' ? title : undefined
  const context = useMemo(() => ({ height, view, register, caption }), [height, view, register, caption])

  const emptyFlag = empty === true || typeof empty === 'string' || isValidElement(empty)
  // Skeleton only while nothing useful is on screen yet; a refetch keeps the mounted chart (dimmed).
  const showSkeleton = loading && (emptyFlag || charts.withData === 0)
  const showEmpty = !loading && !error && emptyFlag
  const refreshing = loading && !showSkeleton
  const tableAvailable = charts.withTable > 0 && !showSkeleton && !showEmpty && !error

  let body
  if (error && errorMode === 'quiet') {
    body = (
      <p
        className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-line px-4 text-center text-sm text-ink-3"
        style={{ minHeight: Math.min(height ?? DEFAULT_SKELETON_HEIGHT, 200) }}
      >
        <CloudOff aria-hidden className="size-5" />
        Not available right now
      </p>
    )
  } else if (error) {
    body = <ErrorState compact bordered={false} error={error} onRetry={onRetry} title="Chart could not load" />
  } else if (showSkeleton) {
    body = (
      <div aria-hidden className="animate-pulse rounded-lg bg-sunken" style={{ height: height ?? DEFAULT_SKELETON_HEIGHT }} />
    )
  } else if (showEmpty) {
    body = isValidElement(empty) ? (
      empty
    ) : (
      <EmptyState
        compact
        bordered={false}
        icon={emptyIcon}
        title={emptyTitle}
        description={typeof empty === 'string' ? empty : emptyDescription}
      />
    )
  } else {
    body = (
      <div className={cn('transition-opacity duration-200', refreshing && 'opacity-60')}>
        <ChartCardContext value={context}>{children}</ChartCardContext>
      </div>
    )
  }

  return (
    <Card className={cn('@container/card relative flex flex-col', className)} aria-busy={loading || undefined}>
      {refreshing ? (
        <div aria-hidden className="absolute inset-x-0 top-0 h-0.5 overflow-hidden rounded-t-xl">
          <div className="lane-line-x animate-lane h-full w-full" />
        </div>
      ) : null}
      {title || description || actions || tableAvailable ? (
        <CardHeader
          title={title}
          description={description}
          icon={icon}
          actions={
            actions || tableAvailable ? (
              <>
                {actions}
                {tableAvailable ? <ViewToggle view={view} onChange={setView} /> : null}
              </>
            ) : null
          }
        />
      ) : null}
      <CardBody className={cn('min-w-0 flex-1', bodyClassName)}>{body}</CardBody>
      {footer ? <CardFooter className="justify-start text-xs text-ink-2">{footer}</CardFooter> : null}
    </Card>
  )
}

export default ChartCard
