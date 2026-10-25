/**
 * Recharts wrappers (BUILD_SPEC 5.7): `import { ChartCard, DonutChart, useChartTheme } from '@/components/charts'`.
 * Every chart accepts `data` plus key props, renders an accessible legend for multi-series data, a
 * token-styled tooltip and a table twin, and shows loading / empty states through ChartCard.
 *
 * Motion (chartMotion.js): plots mount when they scroll into view and play one entrance - bars rise one after
 * another, lines draw, donuts sweep - with a scan-head crosshair and a gliding tooltip on hover; GrowBar is
 * the same entrance for HTML meter bars. Reduced motion: every chart is drawn at its final state.
 */
export { AreaTrendChart } from './AreaTrendChart'
export { BarChartCard } from './BarChartCard'
export { ChartCard } from './ChartCard'
export { HaloDot, HoverBand, ScanCrosshair } from './ChartCursors'
export { ChartLegend } from './ChartLegend'
export { ChartShell } from './ChartShell'
export { ChartTable } from './ChartTable'
export { ChartTooltip } from './ChartTooltip'
export { DonutChart } from './DonutChart'
export { GrowBar } from './GrowBar'
export { HorizontalBarChart } from './HorizontalBarChart'
export { LineTrendChart } from './LineTrendChart'
export { RatingBars } from './RatingBars'
export { StackedBarChart } from './StackedBarChart'
export { TrendChart } from './TrendChart'
export {
  ChartCardContext,
  ChartEntranceContext,
  ChartErrorModeContext,
  useChartCaption,
  useChartCard,
  useChartRegistration,
} from './chartContext'
export { AREA_MOTION, CHART_EASING, LINE_MOTION, PIE_MOTION, TOOLTIP_MOTION, barMotion } from './chartMotion'
export {
  FOLDED_KEY,
  axisNumber,
  datumLabel,
  entityColor,
  foldSeries,
  inferValueKey,
  meaningColor,
  normalizeSeries,
  seriesFromCategories,
  shortenLabel,
} from './chartUtils'
export {
  CHART_PALETTE,
  MAGNITUDE_COLOR,
  OTHER_SERIES_COLOR,
  contrastRatio,
  isHexColor,
  paletteColor,
  readableInk,
  safeColor,
  withAlpha,
} from './palette'
export { readChartTheme, useChartTheme } from './useChartTheme'
