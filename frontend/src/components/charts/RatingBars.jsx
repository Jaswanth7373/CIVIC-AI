/**
 * RatingBars - the 5-to-1 star distribution of citizen feedback, with the average rating.
 *
 * Props:
 * - data: `sentiment.rating_distribution` `[{rating: 1..5, count}]` (missing ratings count as 0)
 * - average: average rating to show (default: computed from the distribution)
 * - total: number of ratings (default: the sum of the counts)
 * - showSummary: the average + stars + total header (default true)
 * - ChartCard props: title, description, icon, actions, loading, empty, emptyTitle, emptyDescription,
 *   error, onRetry, footer, className - with a `title` it renders in its own ChartCard
 *
 * Plain HTML bars in one hue (the road-marking yellow of the stars), highest rating on top, each row
 * showing its count and share, so every number is visible without hovering - the list itself is the
 * accessible version (each row is announced as "5 stars: 42 ratings, 61%").
 *
 * Motion: the average counts up and the bars grow to their shares one after another (5 stars first) when the
 * list scrolls into view. Reduced motion: final values at once.
 */
import { Star } from 'lucide-react'
import { CountUp } from '@/components/motion/CountUp'
import { STAGGER } from '@/components/motion/tokens'
import { EmptyState } from '@/components/ui/EmptyState'
import { StarRating } from '@/components/ui/StarRating'
import { formatNumber, formatPercent } from '@/utils/format'
import { ChartCard } from './ChartCard'
import { useChartCard, useChartRegistration } from './chartContext'
import { GrowBar } from './GrowBar'

const oneDecimal = (value) => Number(value).toFixed(1)

function RatingList({ data, average, total, showSummary }) {
  const counts = new Map()
  for (const row of Array.isArray(data) ? data : []) {
    const rating = Math.round(Number(row?.rating))
    if (rating >= 1 && rating <= 5) counts.set(rating, (counts.get(rating) ?? 0) + Math.max(0, Number(row?.count) || 0))
  }
  const sum = [1, 2, 3, 4, 5].reduce((acc, rating) => acc + (counts.get(rating) ?? 0), 0)
  // Inside a ChartCard: keep the list on screen during refetches; the list is its own table (no toggle).
  useChartRegistration(useChartCard(), sum > 0, false)
  const count = total ?? sum
  const mean = average ?? (sum ? [1, 2, 3, 4, 5].reduce((acc, rating) => acc + rating * (counts.get(rating) ?? 0), 0) / sum : null)

  if (!sum) {
    return (
      <EmptyState
        compact
        bordered={false}
        icon={Star}
        title="No ratings yet"
        description="Ratings appear here when citizens give feedback on resolved complaints."
      />
    )
  }

  return (
    <div className="min-w-0">
      {showSummary ? (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <CountUp
            as="p"
            value={mean == null ? null : Number(mean)}
            format={oneDecimal}
            className="font-display text-4xl font-extrabold leading-none text-ink tabular"
          />
          <div>
            <StarRating value={Number(mean) || 0} readOnly size="sm" label="Average rating" />
            <p className="mt-0.5 text-xs text-ink-3 tabular">
              from {formatNumber(count)} rating{count === 1 ? '' : 's'}
            </p>
          </div>
        </div>
      ) : null}
      <ul className="space-y-2" aria-label="Rating distribution">
        {[5, 4, 3, 2, 1].map((rating, index) => {
          const value = counts.get(rating) ?? 0
          const share = sum ? value / sum : 0
          return (
            <li key={rating} className="grid grid-cols-[3rem_minmax(0,1fr)_4.5rem] items-center gap-3 text-sm">
              <span className="inline-flex items-center gap-1 font-semibold text-ink-2 tabular">
                {rating}
                <Star aria-hidden className="size-3.5 fill-marking-500 text-marking-500" />
                <span className="sr-only"> star{rating === 1 ? '' : 's'}:</span>
              </span>
              <GrowBar ratio={share} delay={index * STAGGER.step * 1000} className="h-2" fillClassName="bg-marking-500" />
              <span className="text-right text-xs text-ink-3 tabular">
                <span className="font-semibold text-ink">{formatNumber(value)}</span>
                <span className="sr-only"> ratings,</span> <span className="ml-1">{formatPercent(share)}</span>
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

export function RatingBars({
  data,
  average,
  total,
  showSummary = true,
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
  const card = useChartCard()
  const list = <RatingList data={data} average={average} total={total} showSummary={showSummary} />
  if (card || !(title || description)) return list
  return (
    <ChartCard
      title={title}
      description={description}
      icon={icon}
      actions={actions}
      loading={loading}
      empty={empty}
      emptyTitle={emptyTitle}
      emptyDescription={emptyDescription}
      error={error}
      onRetry={onRetry}
      footer={footer}
      className={className}
      height={180}
    >
      {list}
    </ChartCard>
  )
}

export default RatingBars
