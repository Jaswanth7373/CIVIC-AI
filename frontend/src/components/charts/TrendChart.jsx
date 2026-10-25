/**
 * TrendChart - shared implementation of LineTrendChart and AreaTrendChart (values over time).
 *
 * Props:
 * - variant: 'line' | 'area'
 * - data: time-ordered rows, e.g. `trends.series` `[{date, label: "Oct 1", submitted, resolved, critical}]`,
 *   `trends.resolution_time_trend` `[{date, label, avg_hours}]`, `sentiment.over_time`
 * - xKey: time axis key (default: label > name > date)
 * - series: `[{key, label, color}]` (two or more get a legend whose items toggle the series); or
 * - yKey (alias dataKey) + seriesLabel / color for one series
 * - stacked (area only): stack the series (part-to-whole over time); the tooltip then adds a total
 * - maxSeries: series beyond this fold into one grey "All others" series (default 8)
 * - valueFormatter(value): tooltip / table values (e.g. formatHours); yTickFormatter(value): axis ticks
 * - domain: value axis domain
 * - reference: `{y, label}` draws a dashed reference line (e.g. an SLA target)
 * - height: plot height (default 260 or the ChartCard's height)
 * - ChartCard props: title, description, icon, actions, loading, empty, emptyTitle, emptyDescription,
 *   error, onRetry, footer, className; caption (accessible name;
 *   default: title, else the ChartCard title)
 * - animate: play the entrance animation (default true; always off when the user prefers reduced motion)
 *
 * Marks: 2 px monotone lines, area fills as a light wash of the series colour (stacked bands a little
 * stronger, each band edge drawn as its line), no dots except on sparse data (<= 2 points, where a line
 * alone would be invisible) and on the hovered point (a 9 px dot with a surface rim inside a soft halo). The
 * hover layer is a vertical crosshair - the AI scan head, a thin road-marking line in a band of light - that
 * snaps to the nearest date and lists every series. A single series gets its last value printed at the line
 * end; multi-series charts rely on the legend, tooltip and table instead of end labels that could collide.
 *
 * Motion: the plot mounts when it scrolls into view, lines draw left to right like a pen stroke (areas rise
 * from the baseline), the tooltip glides from date to date. Reduced motion: drawn at once.
 */
import { useMemo, useState } from 'react'
import { Area, AreaChart, CartesianGrid, LabelList, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { formatNumber } from '@/utils/format'
import { HaloDot, ScanCrosshair } from './ChartCursors'
import { ChartLegend } from './ChartLegend'
import { AREA_MOTION, LINE_MOTION, TOOLTIP_MOTION } from './chartMotion'
import { ChartShell } from './ChartShell'
import { useChartCaption } from './chartContext'
import { ChartTooltip } from './ChartTooltip'
import { axisNumber, datumLabel, foldSeries, hasValues, inferValueKey, normalizeSeries, toFinite } from './chartUtils'
import { isHexColor } from './palette'
import { useChartTheme } from './useChartTheme'

export function TrendChart({
  variant = 'line',
  data,
  xKey,
  series,
  yKey,
  dataKey,
  seriesLabel,
  color,
  stacked = false,
  maxSeries = 8,
  valueFormatter = formatNumber,
  yTickFormatter,
  domain,
  reference,
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
  const labelKey = xKey
  const multi = Array.isArray(series) && series.length > 1

  const { rows: foldedRows, series: seriesList } = useMemo(() => {
    if (multi) return foldSeries(rows, normalizeSeries(series, theme.mode), { maxSeries, mode: theme.mode })
    const single = Array.isArray(series) && series[0] ? (typeof series[0] === 'string' ? { key: series[0] } : series[0]) : {}
    const key = yKey ?? dataKey ?? single.key ?? inferValueKey(rows)
    const label = seriesLabel ?? single.label ?? (typeof title === 'string' ? title : 'Value')
    const seriesColor = isHexColor(color) ? color : isHexColor(single.color) ? single.color : theme.palette[0]
    return { rows, series: [{ key, label, color: seriesColor }] }
  }, [multi, rows, series, theme.mode, theme.palette, maxSeries, yKey, dataKey, seriesLabel, title, color])

  const chartRows = useMemo(
    () => foldedRows.map((row, index) => ({ ...row, __key: row.date ?? index, __label: datumLabel(row, labelKey) })),
    [foldedRows, labelKey],
  )
  const keys = seriesList.map((entry) => entry.key)
  const visible = seriesList.filter((entry) => !hidden.has(entry.key))
  const dataPresent = chartRows.length > 0 && hasValues(chartRows, keys)
  const sparse = chartRows.length <= 2
  const integers = chartRows.every((row) => keys.every((key) => Number.isInteger(toFinite(row[key]) ?? 0)))
  const lastIndex = chartRows.length - 1
  const isArea = variant === 'area'
  const ChartComponent = isArea ? AreaChart : LineChart
  const fillOpacity = isArea ? (stacked ? 0.22 : seriesList.length > 1 ? 0.08 : 0.12) : 0

  const toggle = (key) =>
    setHidden((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else if (next.size < seriesList.length - 1) next.add(key) // never hide the last visible series
      return next
    })

  const table = {
    columns: [
      { key: '__label', label: 'Date' },
      ...seriesList.map((entry) => ({ key: entry.key, label: entry.label, align: 'right', format: (value) => (value == null ? '—' : valueFormatter(value)) })),
    ],
    rows: chartRows,
  }

  const endLabel = (props) => {
    if (props.index !== lastIndex || props.value == null) return null
    return (
      <text x={props.x} y={props.y - 10} textAnchor="end" fill={theme.ink2} fontSize={11} fontWeight={600}>
        {valueFormatter(props.value)}
      </text>
    )
  }

  return (
    <ChartShell
      card={{ title, description, icon, actions, loading, empty, emptyTitle, emptyDescription, error, onRetry, footer, className }}
      hasData={dataPresent}
      height={height}
      caption={caption}
      table={table}
      animate={theme.animate}
      legend={
        seriesList.length > 1 ? (
          <ChartLegend items={seriesList} shape={isArea ? 'rect' : 'line'} hidden={hidden} onToggle={toggle} />
        ) : null
      }
    >
      {(plotHeight) => (
        <ResponsiveContainer width="100%" height={plotHeight}>
          <ChartComponent data={chartRows} margin={{ top: 16, right: 22, bottom: 0, left: 0 }} title={svgTitle}>
            <CartesianGrid vertical={false} stroke={theme.grid} />
            <XAxis
              dataKey="__label"
              tickLine={false}
              axisLine={{ stroke: theme.axis }}
              tick={{ fill: theme.tick, fontSize: 12 }}
              interval="preserveStartEnd"
              minTickGap={16}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tick={{ fill: theme.tick, fontSize: 12 }}
              tickFormatter={yTickFormatter ?? axisNumber}
              allowDecimals={!integers}
              domain={domain}
              width={48}
            />
            <Tooltip
              cursor={<ScanCrosshair core={theme.scanCore} glow={theme.scanGlow} />}
              isAnimationActive={theme.animate}
              {...TOOLTIP_MOTION}
              content={<ChartTooltip valueFormatter={(value) => valueFormatter(value)} getColor={(entry) => entry.stroke ?? entry.color} showTotal={isArea && stacked && visible.length > 1} />}
            />
            {reference && toFinite(reference.y) != null ? (
              <ReferenceLine
                y={reference.y}
                stroke={theme.ink3}
                strokeDasharray="4 4"
                label={reference.label ? { value: reference.label, position: 'insideTopLeft', fill: theme.ink3, fontSize: 11 } : undefined}
              />
            ) : null}
            {visible.map((entry) => {
              const common = {
                type: 'monotone',
                dataKey: entry.key,
                name: entry.label,
                stroke: entry.color,
                strokeWidth: 2,
                isAnimationActive: theme.animate,
                ...(isArea ? AREA_MOTION : LINE_MOTION),
                connectNulls: false,
                dot: sparse ? { r: 4, strokeWidth: 2, stroke: theme.surface, fill: entry.color } : false,
                activeDot: (dot) => <HaloDot cx={dot.cx} cy={dot.cy} color={entry.color} rim={theme.surface} />,
              }
              const label = seriesList.length === 1 ? <LabelList dataKey={entry.key} content={endLabel} /> : null
              return isArea ? (
                <Area {...common} key={entry.key} fill={entry.color} fillOpacity={fillOpacity} stackId={stacked ? 'stack' : undefined}>
                  {label}
                </Area>
              ) : (
                <Line {...common} key={entry.key}>
                  {label}
                </Line>
              )
            })}
          </ChartComponent>
        </ResponsiveContainer>
      )}
    </ChartShell>
  )
}

export default TrendChart
