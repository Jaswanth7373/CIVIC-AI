/**
 * HorizontalBarChart - ranked horizontal bars, for long names (categories, departments, officers).
 *
 * Props:
 * - data: rows, e.g. `analytics/categories` `[{category: CategoryMini, total, ...}]`,
 *   `analytics/departments` rows, `ai.predictions_by_category`
 * - labelKey (alias xKey): label key (default: label > name > nested category / department / officer name)
 * - valueKey (aliases yKey, dataKey): value key (default: count > value > total)
 * - sort: 'desc' (default) | 'asc' | 'none' - bars are ranked so the order itself reads as a ranking
 * - limit: show at most this many bars (the rest stay in the table view)
 * - getColor(row, index) / colorKey / color: bar colours; default the row's meaning colour (a status / level /
 *   sentiment colour, or the row's own `color`), else palette slot 1. Rows of a category / department /
 *   officer are ranked in ONE neutral magnitude colour - the length is the message - and their own colour
 *   marks the chip in front of the label, so red, orange, yellow and green keep meaning severity, status and
 *   sentiment on the same page.
 * - valueFormatter(value): labels at the bar ends, tooltip and table (e.g. formatPercent for rates)
 * - domain: value axis domain, e.g. `[0, 1]` for rates
 * - showValues: value at each bar end (default true)
 * - height: default grows with the number of bars (36 px each)
 * - ChartCard props: title, description, icon, actions, loading, empty, emptyTitle, emptyDescription,
 *   error, onRetry, footer, className; caption (accessible name;
 *   default: title, else the ChartCard title)
 * - animate: play the entrance animation (default true; always off when the user prefers reduced motion)
 *
 * Bars are at most 24 px thick with a 4 px rounded data end and a square base; long labels are shortened on
 * the axis (full names in the tooltip and table). Inside a ChartCard it renders bare.
 *
 * Motion: when the plot scrolls into view the bars extend one after another, top of the ranking first, to
 * their real values; the end labels fade in once they stand. Reduced motion: drawn at once.
 */
import { useMemo } from 'react'
import { Bar, BarChart, CartesianGrid, LabelList, Rectangle, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { formatNumber } from '@/utils/format'
import { HoverBand } from './ChartCursors'
import { TOOLTIP_MOTION, barMotion } from './chartMotion'
import { ChartShell } from './ChartShell'
import { useChartCaption } from './chartContext'
import { ChartTooltip } from './ChartTooltip'
import {
  axisNumber,
  datumLabel,
  entityColor,
  estimateTextWidth,
  hasValues,
  inferValueKey,
  meaningColor,
  shortenLabel,
  toFinite,
} from './chartUtils'
import { isHexColor } from './palette'
import { useChartTheme } from './useChartTheme'

const MAX_LABEL = 26
/** Room for an entity chip in front of a label: the chip (8 px) and the gap after it. */
const CHIP_SPACE = 14

/**
 * Category-axis label. Rows of a category / department / officer get a small chip in its own colour in front
 * of the (left-aligned) label; other rows keep the plain right-aligned tick. `x` is where Recharts puts the
 * tick text (the axis line minus tick size and margin, 8 px), so the label column starts `width - 8` before it.
 */
function LabelTick({ x, y, payload, index, rows, width, fill }) {
  const row = rows[index]
  const text = shortenLabel(payload?.value, MAX_LABEL)
  if (!row?.__chip) {
    return (
      <text x={x} y={y} dy="0.355em" textAnchor="end" fill={fill} fontSize={12}>
        {text}
      </text>
    )
  }
  const left = x - width + 8
  return (
    <g>
      <rect x={left} y={y - 4} width={8} height={8} rx={2} fill={row.__chip} />
      <text x={left + CHIP_SPACE} y={y} dy="0.355em" textAnchor="start" fill={fill} fontSize={12}>
        {text}
      </text>
    </g>
  )
}

export function HorizontalBarChart({
  data,
  labelKey,
  xKey,
  valueKey,
  yKey,
  dataKey,
  seriesLabel,
  sort = 'desc',
  limit,
  getColor,
  colorKey,
  color,
  valueFormatter = formatNumber,
  domain,
  showValues = true,
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
  const nameKey = labelKey ?? xKey
  const key = valueKey ?? yKey ?? dataKey ?? inferValueKey(rows)

  const allRows = useMemo(() => {
    const mapped = rows.map((row, index) => {
      const custom = getColor?.(row, index) ?? (colorKey ? row[colorKey] : null)
      const meaning = isHexColor(custom) ? custom : meaningColor(row, { entities: false })
      const entity = meaning ? null : entityColor(row)
      return {
        ...row,
        __key: row.id ?? `${datumLabel(row, nameKey)}-${index}`,
        __label: datumLabel(row, nameKey),
        __value: toFinite(row[key]),
        __color: meaning ?? (entity ? theme.magnitude : isHexColor(color) ? color : theme.palette[0]),
        __chip: entity,
      }
    })
    if (sort === 'none') return mapped
    const direction = sort === 'asc' ? 1 : -1
    return [...mapped].sort((a, b) => direction * ((a.__value ?? -Infinity) - (b.__value ?? -Infinity)))
  }, [rows, getColor, colorKey, color, theme.palette, theme.magnitude, nameKey, key, sort])

  const chartRows = limit ? allRows.slice(0, limit) : allRows
  const dataPresent = chartRows.length > 0 && hasValues(chartRows, ['__value'])
  const chips = chartRows.some((row) => row.__chip)
  const labelWidth =
    Math.min(200, Math.max(64, ...chartRows.map((row) => estimateTextWidth(shortenLabel(row.__label, MAX_LABEL)) + 12))) +
    (chips ? CHIP_SPACE : 0)
  const plotHeight = height ?? Math.max(120, chartRows.length * 36 + 32)
  const name = seriesLabel ?? (typeof title === 'string' ? title : 'Value')
  const rise = useMemo(() => barMotion(chartRows.length), [chartRows.length])

  const table = {
    columns: [
      { key: '__label', label: 'Item' },
      { key: '__value', label: name, align: 'right', format: (value) => (value == null ? '—' : valueFormatter(value)) },
    ],
    rows: allRows,
  }

  return (
    <ChartShell
      card={{ title, description, icon, actions, loading, empty, emptyTitle, emptyDescription, error, onRetry, footer, className }}
      hasData={dataPresent}
      height={plotHeight}
      caption={caption}
      table={table}
      animate={theme.animate}
    >
      {(resolvedHeight) => (
        <ResponsiveContainer width="100%" height={resolvedHeight}>
          <BarChart
            data={chartRows}
            layout="vertical"
            margin={{ top: 4, right: showValues ? 56 : 12, bottom: 0, left: 0 }}
            barCategoryGap="26%"
            title={svgTitle}
          >
            <CartesianGrid horizontal={false} stroke={theme.grid} />
            <XAxis
              type="number"
              tickLine={false}
              axisLine={false}
              tick={{ fill: theme.tick, fontSize: 12 }}
              tickFormatter={(value) => (domain ? valueFormatter(value) : axisNumber(value))}
              domain={domain}
              allowDecimals={!chartRows.every((row) => Number.isInteger(row.__value ?? 0))}
            />
            <YAxis
              type="category"
              dataKey="__label"
              width={labelWidth}
              tickLine={false}
              axisLine={{ stroke: theme.axis }}
              tick={(props) => <LabelTick {...props} rows={chartRows} width={labelWidth} fill={theme.ink2} />}
              interval={0}
            />
            <Tooltip
              cursor={<HoverBand tint={theme.cursor} />}
              isAnimationActive={theme.animate}
              {...TOOLTIP_MOTION}
              content={<ChartTooltip valueFormatter={(value) => valueFormatter(value)} />}
            />
            <Bar
              dataKey="__value"
              name={name}
              fill={theme.palette[0]}
              maxBarSize={24}
              radius={[0, 4, 4, 0]}
              isAnimationActive={theme.animate}
              {...rise}
              activeBar
              shape={(props) => <Rectangle {...props} fill={props.payload?.__color ?? theme.palette[0]} fillOpacity={props.isActive ? 0.78 : 1} />}
            >
              {showValues ? (
                <LabelList
                  dataKey="__value"
                  position="right"
                  offset={6}
                  fill={theme.ink2}
                  fontSize={11}
                  fontWeight={600}
                  formatter={(value) => (value == null ? '' : valueFormatter(value))}
                />
              ) : null}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </ChartShell>
  )
}

export default HorizontalBarChart
