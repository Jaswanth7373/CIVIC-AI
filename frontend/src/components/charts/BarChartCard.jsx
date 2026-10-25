/**
 * BarChartCard - vertical columns in a ChartCard (distributions, histograms, per-category counts).
 *
 * Props:
 * - data: rows, e.g. `overview.priority_histogram` `[{bucket: "0-9", count}]`,
 *   `overview.resolution_time_distribution`, `ai.confidence_histogram`, `analytics/categories` rows
 * - xKey: category axis key (default: the constants label of a status / level / sentiment row, else
 *   label > name > bucket > date > nested category / department name)
 * - yKey (alias dataKey): value key of a single series (default: count > value > total)
 * - series: `[{key, label, color}]` for grouped columns (two or more series get a legend)
 * - getColor(row, index) / colorKey: colour of each column in a single series. Default: the row's meaning
 *   colour (status / level / sentiment colour, or its category / department colour), else palette slot 1
 * - color: one colour for every column of a single series
 * - showValues: value labels on the column caps (default: single series with at most 12 columns)
 * - valueFormatter(value): values in labels, tooltip and table (default Indian-grouped numbers)
 * - xTickFormatter(label): category axis tick text
 * - xTickInterval: Recharts `interval` of the category axis (default 'preserveStartEnd'). Ordered buckets (a
 *   histogram) pass 'equidistantPreserveStart' so a crowded axis keeps a regular cadence (0, 20, 40, 60, 80 %)
 *   instead of jumping to the last label (0, 20, 40, 60, 90 %)
 * - yTickFormatter(value): value axis tick text (default compact numbers; `valueFormatter` when `domain` is set)
 * - domain: value axis domain, e.g. `[0, 1]` for rates
 * - height: plot height (default 260 or the ChartCard's height)
 * - ChartCard props: title, description, icon, actions, loading, empty, emptyTitle, emptyDescription,
 *   error, onRetry, footer, className; caption: accessible name (default: title, else the ChartCard title)
 * - animate: play the entrance animation (default true; always off when the user prefers reduced motion)
 *
 * Marks follow the CivicAI chart spec: columns at most 24px wide with 4px rounded caps and square bases on
 * one baseline, solid hairline horizontal gridlines only, compact tick numbers, the hovered column lifts
 * (lighter fill) over a rounded hover band and its tooltip lists the value first. Inside a ChartCard it
 * renders bare.
 *
 * Motion: when the plot scrolls into view the columns rise one after another to their real values (value
 * labels fade in once they stand); later data changes morph column by column. Reduced motion: drawn at once.
 */
import { useMemo } from 'react'
import { Bar, BarChart, CartesianGrid, LabelList, Rectangle, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { formatNumber } from '@/utils/format'
import { HoverBand } from './ChartCursors'
import { ChartLegend } from './ChartLegend'
import { TOOLTIP_MOTION, barMotion } from './chartMotion'
import { ChartShell } from './ChartShell'
import { useChartCaption } from './chartContext'
import { ChartTooltip } from './ChartTooltip'
import { axisNumber, datumLabel, hasValues, inferValueKey, meaningColor, normalizeSeries, shortenLabel, toFinite } from './chartUtils'
import { isHexColor } from './palette'
import { useChartTheme } from './useChartTheme'

export function BarChartCard({
  data,
  xKey,
  yKey,
  dataKey,
  series,
  getColor,
  colorKey,
  color,
  showValues,
  valueFormatter = formatNumber,
  xTickFormatter,
  xTickInterval = 'preserveStartEnd',
  yTickFormatter,
  domain,
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
  const rows = useMemo(() => (Array.isArray(data) ? data.filter(Boolean) : []), [data])
  const labelKey = xKey
  const multi = Array.isArray(series) && series.length > 1

  const seriesList = useMemo(() => {
    if (multi) return normalizeSeries(series, theme.mode)
    const single = Array.isArray(series) && series[0] ? (typeof series[0] === 'string' ? { key: series[0] } : series[0]) : {}
    const key = yKey ?? dataKey ?? single.key ?? inferValueKey(rows)
    return [{ key, label: single.label ?? (typeof title === 'string' ? title : 'Value'), color: isHexColor(single.color) ? single.color : null }]
  }, [multi, series, theme.mode, yKey, dataKey, rows, title])

  const chartRows = useMemo(
    () =>
      rows.map((row, index) => {
        const custom = getColor?.(row, index) ?? (colorKey ? row[colorKey] : null)
        const fallback = isHexColor(color) ? color : (seriesList[0]?.color ?? theme.palette[0])
        return {
          ...row,
          __key: row.id ?? `${datumLabel(row, labelKey)}-${index}`,
          __label: datumLabel(row, labelKey),
          __color: isHexColor(custom) ? custom : (meaningColor(row) ?? fallback),
        }
      }),
    [rows, getColor, colorKey, color, seriesList, theme.palette, labelKey],
  )

  const keys = seriesList.map((entry) => entry.key)
  const dataPresent = chartRows.length > 0 && hasValues(chartRows, keys)
  const labelValues = showValues ?? (!multi && chartRows.length <= 12)
  const integers = chartRows.every((row) => keys.every((key) => Number.isInteger(toFinite(row[key]) ?? 0)))
  const rise = useMemo(() => barMotion(chartRows.length), [chartRows.length])

  const table = {
    columns: [
      { key: '__label', label: typeof title === 'string' ? title : 'Item' },
      ...seriesList.map((entry) => ({ key: entry.key, label: entry.label, align: 'right', format: (value) => (value == null ? '—' : valueFormatter(value)) })),
    ],
    rows: chartRows,
  }

  return (
    <ChartShell
      forceCard
      card={{ title, description, icon, actions, loading, empty, emptyTitle, emptyDescription, error, onRetry, footer, className }}
      hasData={dataPresent}
      height={height}
      caption={caption}
      table={table}
      animate={theme.animate}
      legend={multi ? <ChartLegend items={seriesList} shape="rect" /> : null}
    >
      {(plotHeight) => (
        <ResponsiveContainer width="100%" height={plotHeight}>
          <BarChart data={chartRows} margin={{ top: labelValues ? 22 : 8, right: 16, bottom: 0, left: 0 }} barCategoryGap="24%" barGap={2} title={svgTitle}>
            <CartesianGrid vertical={false} stroke={theme.grid} />
            <XAxis
              dataKey="__label"
              tickLine={false}
              axisLine={{ stroke: theme.axis }}
              tick={{ fill: theme.tick, fontSize: 12 }}
              tickFormatter={xTickFormatter ?? ((value) => shortenLabel(value, 14))}
              interval={xTickInterval}
              minTickGap={6}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tick={{ fill: theme.tick, fontSize: 12 }}
              tickFormatter={yTickFormatter ?? ((value) => (domain ? valueFormatter(value) : axisNumber(value)))}
              allowDecimals={!integers}
              domain={domain}
              width={48}
            />
            <Tooltip
              cursor={<HoverBand tint={theme.cursor} />}
              isAnimationActive={theme.animate}
              {...TOOLTIP_MOTION}
              content={<ChartTooltip valueFormatter={(value) => valueFormatter(value)} getColor={multi ? (entry) => entry.color : undefined} />}
            />
            {seriesList.map((entry) => (
              <Bar
                key={entry.key}
                dataKey={entry.key}
                name={entry.label}
                fill={entry.color ?? theme.palette[0]}
                maxBarSize={24}
                radius={[4, 4, 0, 0]}
                isAnimationActive={theme.animate}
                {...rise}
                activeBar
                shape={(props) => (
                  <Rectangle
                    {...props}
                    fill={multi ? entry.color : (props.payload?.__color ?? entry.color ?? theme.palette[0])}
                    fillOpacity={props.isActive ? 0.78 : 1}
                  />
                )}
              >
                {labelValues ? (
                  <LabelList
                    dataKey={entry.key}
                    position="top"
                    offset={6}
                    fill={theme.ink2}
                    fontSize={11}
                    fontWeight={600}
                    formatter={(value) => (toFinite(value) ? valueFormatter(value) : '')}
                  />
                ) : null}
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
      )}
    </ChartShell>
  )
}

export default BarChartCard
