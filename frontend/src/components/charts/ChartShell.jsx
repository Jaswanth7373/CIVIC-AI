/**
 * ChartShell - the frame shared by every chart wrapper; also usable for custom Recharts charts.
 *
 * Props:
 * - card: ChartCard props `{title, description, icon, actions, loading, empty, error, onRetry, footer,
 *   className, emptyTitle, emptyDescription}`. Outside a ChartCard, a chart with a `title` (or `forceCard`)
 *   wraps itself in one; inside a ChartCard it renders bare, so cards are never nested.
 * - forceCard: always render a card when not already inside one (BarChartCard)
 * - hasData: whether there is anything to draw (otherwise an inline empty state)
 * - table: `{columns, rows}` - the chart's table twin (ChartCard's "Table" view; a screen-reader-only table
 *   when the chart is used without a card)
 * - legend: node rendered above the plot (multi-series charts)
 * - height: plot height in px (default: the card's height, else `defaultHeight`)
 * - defaultHeight: the chart type's natural height (default 260)
 * - caption: accessible name of the chart and its table (default: the card title)
 * - fluid: the plot area grows with its content instead of having a fixed height (DonutChart's legend)
 * - animate: false skips the in-view entrance gate (the plot renders at once); default true
 * - children(height, revealed): renders the plot at the resolved height. The plot is first rendered when its
 *   area scrolls into view, so the chart's entrance animation is seen rather than finishing off-screen (at once
 *   with reduced motion or `animate={false}`). Fixed-height plots keep their space while they wait, so nothing
 *   shifts; `fluid` plots are always rendered and get `revealed` to gate their animated part themselves.
 */
import { ChartColumn } from 'lucide-react'
import { useContext, useRef } from 'react'
import { useInViewOnce } from '@/components/motion/hooks'
import { EmptyState } from '@/components/ui/EmptyState'
import { cn } from '@/utils/cn'
import { ChartCard } from './ChartCard'
import { ChartEntranceContext, useChartCard, useChartRegistration } from './chartContext'
import { ChartTable } from './ChartTable'
import '@/styles/admin.css'

/**
 * The plot frame. It owns the in-view observer, so the observed element exists from its first render (the
 * frame only mounts once there is data to draw - an observer set up earlier would have nothing to watch).
 */
function PlotFrame({ height, fluid, caption, animate, children }) {
  const frameRef = useRef(null)
  const seen = useInViewOnce(frameRef)
  // Without an entrance (a return visit) the plot is drawn at once and stays mounted when `animate` turns on.
  const entrance = useContext(ChartEntranceContext)
  const revealed = seen || animate === false || !entrance
  return (
    <div ref={frameRef} role="figure" aria-label={caption || undefined} className="chart-plot tabular min-w-0" style={fluid ? undefined : { height }}>
      {fluid || revealed ? children(height, revealed) : null}
    </div>
  )
}

function ChartBody({ hasData, table, legend, height, defaultHeight, fluid, loading, caption, emptyTitle, emptyDescription, animate, children }) {
  const card = useChartCard()
  useChartRegistration(card, hasData)
  const plotHeight = height ?? card?.height ?? defaultHeight
  const name = caption ?? card?.caption

  if (card?.view === 'table' && hasData && table) {
    return <ChartTable caption={name} columns={table.columns} rows={table.rows} />
  }
  if (!hasData) {
    if (!card && loading) return <div aria-hidden className="animate-pulse rounded-lg bg-sunken" style={{ height: plotHeight }} />
    return (
      <div className="grid place-items-center" style={{ minHeight: Math.min(plotHeight, 220) }}>
        <EmptyState
          compact
          bordered={false}
          icon={ChartColumn}
          title={emptyTitle ?? 'Nothing to chart yet'}
          description={emptyDescription ?? 'Numbers appear here as soon as there is activity for the selected filters.'}
        />
      </div>
    )
  }
  return (
    <div className={cn('min-w-0', !card && loading && 'opacity-60 transition-opacity')}>
      {legend ? <div className="mb-3">{legend}</div> : null}
      <PlotFrame height={plotHeight} fluid={fluid} caption={name} animate={animate}>
        {children}
      </PlotFrame>
      {!card && table ? <ChartTable caption={name} columns={table.columns} rows={table.rows} srOnly /> : null}
    </div>
  )
}

export function ChartShell({
  card = {},
  forceCard = false,
  hasData,
  table,
  legend,
  height,
  defaultHeight = 260,
  fluid = false,
  animate = true,
  caption,
  children,
}) {
  const parentCard = useChartCard()
  const { emptyTitle, emptyDescription, ...cardProps } = card
  const resolvedCaption = caption ?? (typeof cardProps.title === 'string' ? cardProps.title : undefined)
  const body = (
    <ChartBody
      hasData={hasData}
      table={table}
      legend={legend}
      height={height}
      defaultHeight={defaultHeight}
      fluid={fluid}
      animate={animate}
      loading={cardProps.loading}
      caption={resolvedCaption}
      emptyTitle={emptyTitle}
      emptyDescription={emptyDescription}
    >
      {children}
    </ChartBody>
  )
  if (!parentCard && (forceCard || cardProps.title || cardProps.description)) {
    return (
      <ChartCard {...cardProps} height={height} emptyTitle={emptyTitle} emptyDescription={emptyDescription}>
        {body}
      </ChartCard>
    )
  }
  return body
}

export default ChartShell
