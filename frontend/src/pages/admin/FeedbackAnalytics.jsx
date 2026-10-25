/**
 * Feedback analytics (/admin/feedback) - what citizens say after their complaints are resolved.
 *
 * - GET /analytics/sentiment/ (date range on the feedback date, department / category on its complaint,
 *   `period` week | month): positive / neutral / negative shares, average rating, satisfaction, rating
 *   distribution, sentiment by department and category, sentiment and rating over time, top keywords.
 * - GET /feedback/ for the recent-feedback table: the same filters plus its own sentiment and rating
 *   filters, paginated, newest first; every row links to its complaint.
 * Percent values from the API are 0-100; the sentiment score is -1..+1.
 *
 * Motion: the key figures are read by the AI scan and count up (KpiStrip); charts, rating bars and keyword
 * bars play their entrance when they scroll in. Reduced motion: final values at once.
 */
import { FileText, Frown, Meh, MessageSquareText, MessagesSquare, Smile, Star, ThumbsUp } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ChartCard, DonutChart, LineTrendChart, RatingBars, StackedBarChart } from '@/components/charts'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { PageHeader } from '@/components/ui/PageHeader'
import { Pagination } from '@/components/ui/Pagination'
import { Select } from '@/components/ui/Select'
import { Skeleton } from '@/components/ui/Skeleton'
import { useApi } from '@/hooks/useApi'
import { BREAKPOINTS, useMediaQuery } from '@/hooks/useMediaQuery'
import { analyticsService } from '@/services/analyticsService'
import { feedbackService } from '@/services/feedbackService'
import { RATING_LABELS, SENTIMENT_META, SENTIMENT_OPTIONS } from '@/utils/constants'
import { formatDate, formatNumber } from '@/utils/format'
import { FeedbackTable } from './insights/FeedbackTable'
import { InsightFilterBar } from './insights/InsightFilterBar'
import { InvalidFiltersAlert } from './insights/InvalidFiltersAlert'
import {
  countLabel,
  filterValidationError,
  formatPct,
  formatRating,
  shortCategoryName,
  withFilters,
} from './insights/insightUtils'
import { KeywordLists } from './insights/KeywordLists'
import { KpiStrip } from './insights/KpiStrip'
import { SegmentedControl } from './insights/SegmentedControl'
import { useInsightFilters, useReferenceData } from './insights/useInsightFilters'

const PAGE_SIZE = 10
const PERIODS = [
  { value: 'week', label: 'Week', adjective: 'Weekly' },
  { value: 'month', label: 'Month', adjective: 'Monthly' },
]
const SHARE_OPTIONS = [
  { value: 'share', label: 'Share' },
  { value: 'count', label: 'Count' },
]
/** A percent figure that may be missing: the number (it counts up) or the empty dash. */
const percentValue = (value) => (value == null ? '—' : Number(value))
const ratingText = (value) => Number(value).toFixed(1)

const RATING_OPTIONS = [5, 4, 3, 2, 1].map((rating) => ({
  value: String(rating),
  label: `${rating} star${rating === 1 ? '' : 's'}, ${RATING_LABELS[rating].toLowerCase()}`,
}))

export default function FeedbackAnalytics() {
  const wide = useMediaQuery(BREAKPOINTS.sm)
  const [searchParams, setSearchParams] = useSearchParams()
  const { filters, params, setFilters, reset, activeCount } = useInsightFilters()
  const { departments, categories } = useReferenceData()
  const [period, setPeriod] = useState('week')
  const [departmentView, setDepartmentView] = useState('share')
  const [categoryView, setCategoryView] = useState('share')

  const sentimentFilter = searchParams.get('sentiment') ?? ''
  const ratingFilter = searchParams.get('rating') ?? ''
  const page = Math.max(1, Number.parseInt(searchParams.get('page') ?? '', 10) || 1)

  const sentiment = useApi(
    () => analyticsService.sentiment({ ...params, period, days: period === 'month' ? 365 : 182 }),
    [params, period],
  )
  const feedback = useApi(
    () =>
      feedbackService.list({
        ...params,
        sentiment: sentimentFilter,
        rating: ratingFilter,
        ordering: '-created_at',
        page,
        page_size: PAGE_SIZE,
      }),
    [params, sentimentFilter, ratingFilter, page],
  )

  const data = sentiment.data
  const total = data?.total_feedback ?? 0
  const counts = useMemo(() => new Map((data?.distribution ?? []).map((row) => [row.sentiment, row.count])), [data])
  const periodMeta = PERIODS.find((item) => item.value === period) ?? PERIODS[0]
  const filtered = activeCount > 0

  const setTableParam = (key, value) =>
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current)
        if (value) next.set(key, value)
        else next.delete(key)
        next.delete('page')
        return next
      },
      { replace: true },
    )
  const setPage = (nextPage) =>
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      if (nextPage > 1) next.set('page', String(nextPage))
      else next.delete('page')
      return next
    })

  const kpis = [
    {
      key: 'positive',
      label: 'Positive',
      value: data ? percentValue(data.positive_pct) : null,
      format: formatPct,
      icon: Smile,
      tone: 'green',
      hint: data ? `${countLabel(counts.get('positive'), 'comment')}` : null,
    },
    {
      key: 'neutral',
      label: 'Neutral',
      value: data ? percentValue(data.neutral_pct) : null,
      format: formatPct,
      icon: Meh,
      hint: data ? `${countLabel(counts.get('neutral'), 'comment')}` : null,
    },
    {
      key: 'negative',
      label: 'Negative',
      value: data ? percentValue(data.negative_pct) : null,
      format: formatPct,
      icon: Frown,
      tone: 'red',
      hint: data ? `${countLabel(counts.get('negative'), 'comment')}` : null,
    },
    {
      key: 'rating',
      label: 'Average rating',
      value: data ? (Number(data.average_rating) ? Number(data.average_rating) : '—') : null,
      format: ratingText,
      unit: data?.average_rating ? '/ 5' : null,
      icon: Star,
      tone: 'yellow',
      hint: 'Stars given to resolved complaints',
    },
    {
      key: 'total',
      label: 'Total feedback',
      value: data?.total_feedback,
      icon: MessageSquareText,
      hint: 'Ratings received in the period',
    },
    {
      key: 'satisfaction',
      label: 'Satisfaction rate',
      value: data ? percentValue(data.satisfaction_rate) : null,
      format: formatPct,
      icon: ThumbsUp,
      tone: 'green',
      hint: 'Rated 4 or 5 stars',
    },
  ]

  const sentimentSeries = [
    { key: 'positive', label: SENTIMENT_META.positive.label, color: SENTIMENT_META.positive.color },
    { key: 'neutral', label: SENTIMENT_META.neutral.label, color: SENTIMENT_META.neutral.color },
    { key: 'negative', label: SENTIMENT_META.negative.label, color: SENTIMENT_META.negative.color },
  ]
  // Weeks without feedback have no average (the API sends 0.0); a gap is honest, a dip to zero is not.
  const ratingTrend = useMemo(
    () => (data?.over_time ?? []).map((row) => ({ ...row, avg_rating: row.total ? row.avg_rating : null })),
    [data],
  )
  // Short category names ("Water Supply") keep the bars readable; the colours and order match the other charts.
  const categoryRows = useMemo(
    () => (data?.by_category ?? []).map((row) => ({ ...row, label: shortCategoryName(row.category?.name) })),
    [data],
  )
  const departmentRows = data?.by_department ?? []
  const barHeight = Math.max(departmentRows.length, categoryRows.length, 1) * 40 + 36
  const windowText = data?.over_time?.length
    ? `${periodMeta.adjective} feedback from ${formatDate(data.over_time[0].date)}`
    : `${periodMeta.adjective} feedback`

  const emptyMessage = filtered
    ? 'No feedback matches these filters. Widen the date range or clear a filter.'
    : 'Feedback appears once citizens rate their resolved complaints.'
  const loadingFirst = sentiment.loading && !data
  const invalidFilters = filterValidationError([sentiment.error])
  const results = feedback.data?.results ?? []

  const periodControl = (
    <SegmentedControl
      label="Time period"
      options={PERIODS.map(({ value, label }) => ({ value, label }))}
      value={period}
      onChange={setPeriod}
    />
  )

  return (
    <>
      <PageHeader
        title="Feedback analytics"
        description="What citizens say once their complaints are resolved, scored by the sentiment model."
        actions={
          <Button variant="secondary" leftIcon={FileText} to={withFilters('/admin/reports', params, { report: 'feedback' })}>
            Feedback report
          </Button>
        }
      />

      <InsightFilterBar
        filters={filters}
        onChange={setFilters}
        onReset={reset}
        activeCount={activeCount}
        departments={departments}
        categories={categories}
        className="mb-4"
      />

      {invalidFilters ? (
        <InvalidFiltersAlert error={invalidFilters} onReset={reset} />
      ) : sentiment.error && !data ? (
        <ErrorState error={sentiment.error} onRetry={sentiment.refetch} title="Feedback analytics could not load" />
      ) : (
        <>
          <KpiStrip items={kpis} loading={loadingFirst} label="Feedback key figures" className="elev-raised" />

          {data && !total ? (
            <EmptyState
              className="mt-4"
              icon={MessagesSquare}
              title={filtered ? 'No feedback matches these filters' : 'No feedback yet'}
              description={emptyMessage}
              action={
                filtered ? (
                  <Button variant="outline" onClick={reset}>
                    Clear filters
                  </Button>
                ) : null
              }
            />
          ) : (
            <>
              <div className="mt-4 grid gap-4 xl:grid-cols-12">
                <ChartCard
                  className="xl:col-span-8"
                  title="Sentiment over time"
                  description={windowText}
                  actions={wide ? periodControl : null}
                  loading={sentiment.loading}
                >
                  {wide ? null : <div className="mb-3">{periodControl}</div>}
                  <StackedBarChart caption="Sentiment over time" data={data?.over_time} series={sentimentSeries} height={260} />
                </ChartCard>

                <DonutChart
                  className="xl:col-span-4"
                  title="Sentiment split"
                  description="Feedback by analysed sentiment"
                  data={data?.distribution}
                  centerLabel="Feedback"
                  height={200}
                  loading={sentiment.loading}
                  emptyDescription={emptyMessage}
                />
              </div>

              <div className="mt-4 grid gap-4 xl:grid-cols-12">
                <RatingBars
                  className="xl:col-span-4"
                  title="Rating distribution"
                  description={
                    data?.total_feedback
                      ? `${formatPct(data.satisfaction_rate)} rated 4 or 5 stars`
                      : 'Stars given to resolved complaints'
                  }
                  data={data?.rating_distribution}
                  average={data?.average_rating || null}
                  total={data?.total_feedback}
                  loading={sentiment.loading}
                />
                <LineTrendChart
                  className="xl:col-span-8"
                  title="Average rating over time"
                  description={`${periodMeta.adjective} average of the stars given (gaps mean no feedback)`}
                  data={ratingTrend}
                  yKey="avg_rating"
                  seriesLabel="Average rating"
                  color="#cc9600"
                  domain={[0, 5]}
                  valueFormatter={(value) => formatRating(value)}
                  yTickFormatter={(value) => formatNumber(value)}
                  height={230}
                  loading={sentiment.loading}
                  emptyDescription={emptyMessage}
                />
              </div>

              <div className="mt-4 grid gap-4 xl:grid-cols-2">
                <StackedBarChart
                  title="Sentiment by department"
                  description={
                    departmentView === 'share'
                      ? 'Share of positive, neutral and negative feedback'
                      : 'Feedback received per department'
                  }
                  actions={
                    <SegmentedControl
                      label="Show department sentiment as"
                      options={SHARE_OPTIONS}
                      value={departmentView}
                      onChange={setDepartmentView}
                    />
                  }
                  data={departmentRows}
                  series={sentimentSeries}
                  horizontal
                  percent={departmentView === 'share'}
                  height={barHeight}
                  loading={sentiment.loading}
                  emptyDescription={emptyMessage}
                />
                <StackedBarChart
                  title="Sentiment by category"
                  description={
                    categoryView === 'share'
                      ? 'Share of positive, neutral and negative feedback'
                      : 'Feedback received per category'
                  }
                  actions={
                    <SegmentedControl
                      label="Show category sentiment as"
                      options={SHARE_OPTIONS}
                      value={categoryView}
                      onChange={setCategoryView}
                    />
                  }
                  data={categoryRows}
                  xKey="label"
                  series={sentimentSeries}
                  horizontal
                  percent={categoryView === 'share'}
                  height={barHeight}
                  loading={sentiment.loading}
                  emptyDescription={emptyMessage}
                />
              </div>

              <Card className="mt-4 min-w-0">
                <CardHeader
                  title="Top keywords"
                  description="Words and phrases that appear most in positive and in negative comments"
                />
                <CardBody>{loadingFirst ? <Skeleton lines={8} /> : <KeywordLists keywords={data?.top_keywords} />}</CardBody>
              </Card>
            </>
          )}
        </>
      )}

      {invalidFilters || (data && !total) ? null : (
        <Card className="mt-4 min-w-0">
          <CardHeader
            title="Recent feedback"
            description={
              feedback.data
                ? `${countLabel(feedback.data.count, 'comment')}, newest first. Select one to open its complaint.`
                : 'Newest first'
            }
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  aria-label="Filter feedback by sentiment"
                  size="sm"
                  placeholder="All sentiments"
                  options={SENTIMENT_OPTIONS}
                  value={sentimentFilter}
                  onChange={(event) => setTableParam('sentiment', event.target.value)}
                  containerClassName="w-auto min-w-36"
                />
                <Select
                  aria-label="Filter feedback by rating"
                  size="sm"
                  placeholder="All ratings"
                  options={RATING_OPTIONS}
                  value={ratingFilter}
                  onChange={(event) => setTableParam('rating', event.target.value)}
                  containerClassName="w-auto min-w-36"
                />
              </div>
            }
          />
          {feedback.error && !feedback.data ? (
            <ErrorState
              compact
              bordered={false}
              error={feedback.error}
              onRetry={feedback.refetch}
              title="Recent feedback could not load"
            />
          ) : (
            <>
              <FeedbackTable
                data={results}
                loading={feedback.loading}
                className="rounded-none border-0"
                empty={
                  <EmptyState
                    compact
                    bordered={false}
                    icon={MessagesSquare}
                    title="No feedback matches"
                    description={
                      sentimentFilter || ratingFilter || filtered
                        ? 'Try another sentiment or rating, or clear the page filters.'
                        : 'Comments appear here as citizens rate resolved complaints.'
                    }
                    action={
                      sentimentFilter || ratingFilter ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            setSearchParams(
                              (current) => {
                                const next = new URLSearchParams(current)
                                next.delete('sentiment')
                                next.delete('rating')
                                next.delete('page')
                                return next
                              },
                              { replace: true },
                            )
                          }
                        >
                          Show all feedback
                        </Button>
                      ) : null
                    }
                  />
                }
              />
              {feedback.data?.total_pages > 1 ? (
                // Local fix: the shared Pagination's previous / next buttons are inline-grid, which stacks the chevron
                // above the label; flex keeps them on one line (reported to the foundation owner).
                <div className="border-t border-line px-4 py-3 sm:px-5 [&_nav_button]:inline-flex [&_nav_button]:items-center [&_nav_button]:justify-center">
                  <Pagination
                    page={feedback.data.page ?? page}
                    totalPages={feedback.data.total_pages}
                    count={feedback.data.count}
                    pageSize={feedback.data.page_size ?? PAGE_SIZE}
                    onPageChange={setPage}
                  />
                </div>
              ) : null}
            </>
          )}
        </Card>
      )}
    </>
  )
}
