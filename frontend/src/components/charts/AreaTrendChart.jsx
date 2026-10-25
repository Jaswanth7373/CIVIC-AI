/**
 * AreaTrendChart - a value over time as a line with a light area wash; `stacked` turns several series
 * into stacked bands (part-to-whole over time, e.g. complaints per category per week).
 *
 *   <AreaTrendChart title="Submitted complaints" data={trends.series} yKey="submitted" seriesLabel="Submitted" />
 *   <AreaTrendChart title="By category" data={trends.category_series} stacked
 *     series={seriesFromCategories(trends.categories)} />   // one series per category, in its own colour
 *
 * Props: see TrendChart (data, xKey, series | yKey + seriesLabel + color, stacked, maxSeries,
 * valueFormatter, yTickFormatter, domain, reference, height, ChartCard props, caption, animate). Series past
 * `maxSeries` (default 8) fold into one grey "All others" band instead of an unreadable ninth hue.
 */
import { TrendChart } from './TrendChart'

export function AreaTrendChart(props) {
  return <TrendChart {...props} variant="area" />
}

export default AreaTrendChart
