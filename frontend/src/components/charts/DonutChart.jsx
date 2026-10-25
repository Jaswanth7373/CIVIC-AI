/**
 * DonutChart - part-to-whole at a glance, with the total in the centre and a value / share legend.
 *
 * Props:
 * - data: rows, e.g. `overview.status_distribution` `[{status, label, count}]`,
 *   `overview.severity_distribution` `[{level, label, count}]`, `sentiment.distribution`
 *   `[{sentiment, label, count, percentage}]`, `ai.verification.by_status`
 * - nameKey (alias labelKey): slice label key (default: label > name > nested entity name)
 * - valueKey (alias dataKey): slice value key (default: count > value > total)
 * - getColor(row, index) / colorKey: slice colours. Default: the row's MEANING colour - status, level,
 *   sentiment or verification colours from utils/constants, or its category / department colour - else the
 *   palette in fixed slot order
 * - maxSlices: slices beyond this (smallest first) fold into one grey "All others" slice (default 6)
 * - hideZero: leave zero-count rows out of the ring and legend (default true)
 * - valueFormatter(value): numbers in the centre, legend, tooltip and table
 * - centerLabel: caption under the centre total (default "Total"); centerValue: override the total
 * - height: ring height (default 220)
 * - ChartCard props: title, description, icon, actions, loading, empty, emptyTitle, emptyDescription,
 *   error, onRetry, footer, className; caption (accessible name;
 *   default: title, else the ChartCard title)
 * - animate: play the entrance animation (default true; always off when the user prefers reduced motion)
 *
 * Slices are separated by 2 px surface gaps (stroke in the surface colour), start at 12 o'clock and keep
 * the data order (status order is itself meaningful). The legend lists every slice with its value and
 * share, so no value depends on hovering or on colour; the hovered slice grows slightly. The table view lists
 * every row, including the ones folded into "All others".
 *
 * Motion: when the ring scrolls into view the slices sweep round a quiet track ring from twelve o'clock and
 * the centre total counts up; the legend is there from the start (no layout shift). Reduced motion: final.
 */
import { useMemo } from 'react'
import { Pie, PieChart, ResponsiveContainer, Sector, Tooltip } from 'recharts'
import { CountUp } from '@/components/motion/CountUp'
import { formatNumber, formatPercent } from '@/utils/format'
import { PIE_MOTION, TOOLTIP_MOTION } from './chartMotion'
import { ChartShell } from './ChartShell'
import { useChartCaption } from './chartContext'
import { ChartTooltip } from './ChartTooltip'
import { FOLDED_KEY, datumLabel, inferValueKey, meaningColor, toFinite } from './chartUtils'
import { isHexColor, paletteColor } from './palette'
import { useChartTheme } from './useChartTheme'

const TRACK = [{ value: 1 }]

export function DonutChart({
  data,
  nameKey,
  labelKey,
  valueKey,
  dataKey,
  getColor,
  colorKey,
  maxSlices = 6,
  hideZero = true,
  valueFormatter = formatNumber,
  centerLabel = 'Total',
  centerValue,
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
  const labelField = nameKey ?? labelKey
  const valueField = valueKey ?? dataKey ?? inferValueKey(rows)

  const allSlices = useMemo(
    () =>
      rows
        .map((row, index) => {
          const custom = getColor?.(row, index) ?? (colorKey ? row[colorKey] : null)
          return {
            ...row,
            __key: row.id ?? row.status ?? row.level ?? row.sentiment ?? `${datumLabel(row, labelField)}-${index}`,
            __label: datumLabel(row, labelField),
            __value: Math.max(0, toFinite(row[valueField]) ?? 0),
            __color: isHexColor(custom) ? custom : (meaningColor(row) ?? paletteColor(index, theme.mode)),
          }
        })
        .filter((slice) => !hideZero || slice.__value > 0),
    [rows, getColor, colorKey, labelField, valueField, theme.mode, hideZero],
  )

  // More than `maxSlices` segments: keep the largest (in data order) and fold the rest into one grey slice.
  const slices = useMemo(() => {
    if (allSlices.length <= maxSlices) return allSlices
    const ranked = [...allSlices].sort((a, b) => b.__value - a.__value)
    const keep = new Set(ranked.slice(0, Math.max(1, maxSlices - 1)).map((slice) => slice.__key))
    const folded = allSlices.filter((slice) => !keep.has(slice.__key))
    return [
      ...allSlices.filter((slice) => keep.has(slice.__key)),
      {
        __key: FOLDED_KEY,
        __label: `All others (${folded.length})`,
        __value: folded.reduce((sum, slice) => sum + slice.__value, 0),
        __color: theme.otherColor,
      },
    ]
  }, [allSlices, theme.otherColor, maxSlices])

  const total = slices.reduce((sum, slice) => sum + slice.__value, 0)
  const ringHeight = height ?? 220
  const share = (value) => (total > 0 ? value / total : 0)

  const table = {
    columns: [
      { key: '__label', label: 'Segment' },
      { key: '__value', label: 'Count', align: 'right', format: (value) => valueFormatter(value) },
      { key: '__share', label: 'Share', align: 'right', format: (value) => formatPercent(value, { digits: 1 }) },
    ],
    rows: allSlices.map((slice) => ({ ...slice, __share: share(slice.__value) })),
  }

  return (
    <ChartShell
      card={{ title, description, icon, actions, loading, empty, emptyTitle, emptyDescription, error, onRetry, footer, className }}
      hasData={total > 0}
      height={ringHeight}
      fluid
      animate={theme.animate}
      caption={caption}
      table={table}
    >
      {(plotHeight, revealed) => (
        <div className="@container">
          <div className="grid grid-cols-1 items-center gap-4 @lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
          <div className="relative min-w-0" style={{ height: plotHeight }}>
            {revealed ? (
              <ResponsiveContainer width="100%" height="100%">
                {/* No keyboard layer: Recharts' arrow-key stepping only works along a cartesian axis, so on a donut
                    the svg would be an empty tab stop. Every slice's value and share is in the HTML legend. */}
                <PieChart title={svgTitle} accessibilityLayer={false}>
                  <Tooltip
                    isAnimationActive={theme.animate}
                    {...TOOLTIP_MOTION}
                    content={
                      <ChartTooltip
                        labelFormatter={() => null}
                        valueFormatter={(value) => `${valueFormatter(value)} (${formatPercent(share(value), { digits: 1 })})`}
                      />
                    }
                  />
                  {/* The track: a quiet full ring the slices sweep over (not part of the data, no tooltip). */}
                  <Pie
                    data={TRACK}
                    dataKey="value"
                    innerRadius="64%"
                    outerRadius="92%"
                    startAngle={90}
                    endAngle={-270}
                    fill={theme.sunken}
                    stroke="none"
                    isAnimationActive={false}
                    tooltipType="none"
                    rootTabIndex={-1}
                  />
                  <Pie
                    data={slices}
                    dataKey="__value"
                    nameKey="__label"
                    innerRadius="64%"
                    outerRadius="92%"
                    startAngle={90}
                    endAngle={-270}
                    paddingAngle={0}
                    stroke={theme.surface}
                    strokeWidth={2}
                    isAnimationActive={theme.animate}
                    {...PIE_MOTION}
                    rootTabIndex={-1}
                    shape={(props) => (
                      <Sector
                        {...props}
                        fill={props.payload?.__color ?? props.__color}
                        outerRadius={props.isActive ? props.outerRadius + 4 : props.outerRadius}
                      />
                    )}
                  />
                </PieChart>
              </ResponsiveContainer>
            ) : null}
            <div aria-hidden className="pointer-events-none absolute inset-0 grid place-items-center text-center">
              <div>
                <CountUp
                  as="p"
                  value={centerValue ?? total}
                  format={valueFormatter}
                  className="font-display text-2xl font-extrabold leading-none text-ink tabular"
                />
                <p className="mt-1 text-xs font-medium text-ink-3">{centerLabel}</p>
              </div>
            </div>
          </div>
          <ul className="min-w-0 space-y-1.5 text-sm" aria-label="Segments">
            {slices.map((slice) => (
              <li key={slice.__key} className="flex items-center gap-2">
                <span aria-hidden className="size-2.5 shrink-0 rounded-[3px]" style={{ backgroundColor: slice.__color }} />
                <span className="min-w-0 flex-1 truncate text-ink-2" title={slice.__label}>
                  {slice.__label}
                </span>
                <span className="font-semibold text-ink tabular">{valueFormatter(slice.__value)}</span>
                <span className="w-12 text-right text-xs text-ink-3 tabular">{formatPercent(share(slice.__value))}</span>
              </li>
            ))}
          </ul>
          </div>
        </div>
      )}
    </ChartShell>
  )
}

export default DonutChart
