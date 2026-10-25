/**
 * LineTrendChart - one or more values over time as 2 px lines with a snapping crosshair tooltip.
 *
 * Typical data: `trends.series` (submitted / resolved / critical per day, week or month),
 * `trends.resolution_time_trend` (avg_hours), `sentiment.over_time` (avg_rating).
 *
 *   <LineTrendChart title="Complaints over time" data={trends.series}
 *     series={[{ key: 'submitted', label: 'Submitted' }, { key: 'resolved', label: 'Resolved' }]} />
 *
 * Props: see TrendChart (data, xKey, series | yKey + seriesLabel + color, valueFormatter, yTickFormatter,
 * domain, reference, maxSeries, height, ChartCard props, caption, animate). Two or more series get a legend whose
 * items toggle series; one series shows its latest value at the line end.
 */
import { TrendChart } from './TrendChart'

export function LineTrendChart(props) {
  return <TrendChart {...props} variant="line" stacked={false} />
}

export default LineTrendChart
