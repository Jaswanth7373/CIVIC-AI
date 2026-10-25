/**
 * StackedBarChart - part-to-whole per item: each bar is split into series segments.
 *
 * Props:
 * - data: rows, e.g. `analytics/departments` `[{department, pending, in_progress, resolved, ...}]`,
 *   `sentiment.by_department` `[{department, positive, neutral, negative, total}]`, `trends.category_series`
 * - series: `[{key, label, color}]` (required) - colours default to the palette in fixed order; pass the
 *   meaning colours where they exist (e.g. STATUS_META / SENTIMENT_META colours)
 * - xKey (alias labelKey): category key (default: label > name > nested department / category name)
 * - horizontal: bars run left to right (better for long department names); default vertical columns
 * - percent: 100% stacks (shares instead of counts); the tooltip and table still show the counts
 * - maxSeries: series beyond this fold into a grey "All others" segment (default 8)
 * - valueFormatter(value): tooltip / table numbers
 * - height: default 260 (vertical) or 40 px per bar (horizontal)
 * - ChartCard props: title, description, icon, actions, loading, empty, emptyTitle, emptyDescription,
 *   error, onRetry, footer, className; caption (accessible name;
 *   default: title, else the ChartCard title)
 * - animate: play the entrance animation (default true; always off when the user prefers reduced motion)
 *
 * Marks: segments are separated by 2 px gaps in the surface colour; only the outer end of the whole stack is
 * rounded (Recharts BarStack radius), bars are at most 24 px thick. The legend toggles series; the tooltip
 * lists every segment of the hovered bar plus the total.
 *
 * Motion: when the plot scrolls into view each stack grows from the baseline as one piece, the stacks one
 * after another; later data changes (a period or share / count switch) morph stack by stack.
 */
import { useMemo, useState } from 'react'
import { Bar, BarChart, BarStack, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { formatNumber, formatPercent } from '@/utils/format'
import { HoverBand } from './ChartCursors'
import { ChartLegend } from './ChartLegend'
import { TOOLTIP_MOTION, barMotion } from './chartMotion'
import { ChartShell } from './ChartShell'
import { useChartCaption } from './chartContext'
import { ChartTooltip } from './ChartTooltip'
import { axisNumber, datumLabel, estimateTextWidth, foldSeries, hasValues, normalizeSeries, shortenLabel, toFinite } from './chartUtils'
import { useChartTheme } from './useChartTheme'

const MAX_LABEL = 24

export function StackedBarChart({
  data,
  series,
  xKey,
  labelKey,
  horizontal = false,
  percent = false,
  maxSeries = 8,
  valueFormatter = formatNumber,
  height,
  caption,
  animate = true,
  title,
  description,
  icon,
  actions,
  loading,
  empty,
  emptyTitle,
  emptyDescription,
  error,
  onRetry,
  footer,
  className,
}) {
  const theme = useChartTheme({ animate })
  const svgTitle = useChartCaption(caption, title)
  const [hidden, setHidden] = useState(() => new Set())
  const rows = useMemo(() => (Array.isArray(data) ? data.filter(Boolean) : []), [data])
  const nameKey = xKey ?? labelKey

  const { rows: foldedRows, series: seriesList } = useMemo(
    () => foldSeries(rows, normalizeSeries(series, theme.mode), { maxSeries, mode: theme.mode }),
    [rows, series, theme.mode, maxSeries],
  )
  const chartRows = useMemo(
    () =>
      foldedRows.map((row, index) => {
        const total = seriesList.reduce((sum, entry) => sum + (toFinite(row[entry.key]) ?? 0), 0)
        return { ...row, __key: row.id ?? index, __label: datumLabel(row, nameKey), __total: total }
      }),
    [foldedRows, seriesList, nameKey],
  )

  const keys = seriesList.map((entry) => entry.key)
  const visible = seriesList.filter((entry) => !hidden.has(entry.key))
  const dataPresent = chartRows.length > 0 && hasValues(chartRows, keys)
  const labelWidth = Math.min(200, Math.max(64, ...chartRows.map((row) => estimateTextWidth(shortenLabel(row.__label, MAX_LABEL)) + 12)))
  const plotHeight = height ?? (horizontal ? Math.max(140, chartRows.length * 40 + 36) : undefined)
  const rise = useMemo(() => barMotion(chartRows.length), [chartRows.length])

  const toggle = (key) =>
    setHidden((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else if (next.size < seriesList.length - 1) next.add(key)
      return next
    })

  const table = {
    columns: [
      { key: '__label', label: 'Item' },
      ...seriesList.map((entry) => ({ key: entry.key, label: entry.label, align: 'right', format: (value) => (value == null ? '—' : valueFormatter(value)) })),
      { key: '__total', label: 'Total', align: 'right', format: (value) => valueFormatter(value) },
    ],
    rows: chartRows,
  }

  const valueAxis = {
    tickLine: false,
    axisLine: false,
    tick: { fill: theme.tick, fontSize: 12 },
    tickFormatter: percent ? (value) => formatPercent(value) : axisNumber,
    allowDecimals: percent,
  }
  const categoryAxis = {
    dataKey: '__label',
    tickLine: false,
    axisLine: { stroke: theme.axis },
    tickFormatter: (value) => shortenLabel(value, horizontal ? MAX_LABEL : 14),
  }

  return (
    <ChartShell
      card={{ title, description, icon, actions, loading, empty, emptyTitle, emptyDescription, error, onRetry, footer, className }}
      hasData={dataPresent}
      height={plotHeight}
      caption={caption}
      table={table}
      animate={theme.animate}
      legend={<ChartLegend items={seriesList} shape="rect" hidden={hidden} onToggle={toggle} />}
    >
      {(resolvedHeight) => (
        <ResponsiveContainer width="100%" height={resolvedHeight}>
          <BarChart
            data={chartRows}
            layout={horizontal ? 'vertical' : 'horizontal'}
            stackOffset={percent ? 'expand' : 'none'}
            margin={{ top: 8, right: horizontal ? 22 : 12, bottom: 0, left: 0 }}
            barCategoryGap="26%"
            title={svgTitle}
          >
            <CartesianGrid vertical={horizontal} horizontal={!horizontal} stroke={theme.grid} />
            {horizontal ? (
              <>
                <XAxis type="number" {...valueAxis} />
                <YAxis type="category" {...categoryAxis} width={labelWidth} interval={0} tick={{ fill: theme.ink2, fontSize: 12 }} />
              </>
            ) : (
              <>
                <XAxis {...categoryAxis} tick={{ fill: theme.tick, fontSize: 12 }} interval="preserveStartEnd" minTickGap={6} />
                <YAxis {...valueAxis} width={48} />
              </>
            )}
            <Tooltip
              cursor={<HoverBand tint={theme.cursor} />}
              isAnimationActive={theme.animate}
              {...TOOLTIP_MOTION}
              content={
                <ChartTooltip valueFormatter={(value) => valueFormatter(value)} getColor={(entry) => entry.color ?? entry.fill} showTotal hideZero />
              }
            />
            <BarStack radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]}>
              {visible.map((entry) => (
                <Bar
                  key={entry.key}
                  dataKey={entry.key}
                  name={entry.label}
                  fill={entry.color}
                  stroke={theme.surface}
                  strokeWidth={2}
                  maxBarSize={24}
                  isAnimationActive={theme.animate}
                  {...rise}
                  activeBar={{ fillOpacity: 0.8 }}
                />
              ))}
            </BarStack>
          </BarChart>
        </ResponsiveContainer>
      )}
    </ChartShell>
  )
}

export default StackedBarChart
