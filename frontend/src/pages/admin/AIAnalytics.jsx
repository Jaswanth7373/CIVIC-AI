/**
 * AI analytics (/admin/ai-analytics) - how the AI engine performs on real complaints.
 *
 * Data (all filtered by the page's date range / department / category, stored in the URL):
 * - analytics/ai          -> mode + model info, confidences, agreement, review / override counts, category
 *                            match rate, confidence histogram, predictions by category, confusion pairs,
 *                            duplicate stats, verification outcomes, processing time, severity distribution
 * - analytics/officers    -> officer workload table
 * - analytics/departments -> department performance table
 * - ai/config             -> the live thresholds quoted in the explanations (review threshold, duplicate
 *                            similarity, verification bands)
 * Units: confidences and utilisation are fractions 0-1; rates are percents 0-100.
 *
 * The page opens on model performance: the AI mode is one line (AIModeBanner) whose details unfold on request.
 * When two or more of the analytics requests fail, the page shows ONE error with "Retry all" instead of one
 * error box per panel; an isolated failure keeps its own panel error.
 *
 * Motion: the key figures are read by the AI scan and count up (KpiStrip), the duplicate statistics count up,
 * charts and bars play their entrance when they scroll in, the confusion matrix settles along its diagonal.
 * These entrances play once per browser session (useSessionIntro).
 *
 * Coming back: like the admin dashboard, every response is cached per filter (stale-while-revalidate,
 * useCachedApi), so a return to this page paints the last figures at once - no skeletons, no replayed
 * entrances - and refreshes them in the background.
 */
import {
  ArrowUpRight,
  BrainCircuit,
  CircleCheck,
  Gauge,
  GitCompareArrows,
  SlidersHorizontal,
  Timer,
  UserSearch,
} from 'lucide-react'
import { useMemo } from 'react'
import { BarChartCard, ChartCard, ChartEntranceContext, DonutChart, useChartTheme } from '@/components/charts'
import { ConfidenceBar } from '@/components/ai'
import { CountUp } from '@/components/motion/CountUp'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { PageHeader } from '@/components/ui/PageHeader'
import { Skeleton } from '@/components/ui/Skeleton'
import { aiService } from '@/services/aiService'
import { analyticsService } from '@/services/analyticsService'
import { DUPLICATE_STATUS_META, LEVEL_META, VERIFICATION_META } from '@/utils/constants'
import { getErrorMessage } from '@/utils/errors'
import { formatNumber } from '@/utils/format'
import { AIModeBanner } from './insights/AIModeBanner'
import { CategoryPredictions } from './insights/CategoryPredictions'
import { ConfusionMatrix } from './insights/ConfusionMatrix'
import { DepartmentPerformanceTable } from './insights/DepartmentPerformanceTable'
import { InsightFilterBar } from './insights/InsightFilterBar'
import { InvalidFiltersAlert } from './insights/InvalidFiltersAlert'
import {
  complaintsHref,
  countLabel,
  filterValidationError,
  formatMs,
  formatPct,
  formatShare,
  markColor,
  niceAxisMax,
} from './insights/insightUtils'
import { KpiStrip } from './insights/KpiStrip'
import { ModelRegistry } from './insights/ModelRegistry'
import { OfficerWorkloadTable } from './insights/OfficerWorkloadTable'
import { SplitBar } from './insights/SplitBar'
import { useCachedApi, useSessionIntro } from './insights/useCachedApi'
import { useInsightFilters, useReferenceData } from './insights/useInsightFilters'

const REVIEW_COLOR = '#e8730c' // hazard-500: below the review threshold (warning, not a series hue)
const CONFIDENCE_COLOR = '#1f5fad' // guide-500: one hue for every other bucket

/** Lower bound of a histogram bucket such as "20-30%". */
function bucketStart(bucket) {
  const value = Number.parseFloat(String(bucket ?? '').split('-')[0])
  return Number.isFinite(value) ? value : null
}

/**
 * A labelled figure; numbers count up the first time they are seen in the session (`format` writes them).
 * `intro={false}` (a return visit) shows the value at once.
 */
function Stat({ label, value, format, hint, intro = true, className }) {
  const valueClass = 'mt-1 font-display text-2xl font-extrabold leading-none text-ink tabular'
  return (
    <div className={className}>
      <p className="text-xs font-medium text-ink-2">{label}</p>
      {intro ? (
        <CountUp as="p" value={value} format={format} className={valueClass} />
      ) : (
        <p className={valueClass}>{typeof value === 'number' ? (format ? format(value) : formatNumber(value)) : (value ?? '—')}</p>
      )}
      {hint ? <p className="mt-1.5 text-xs text-ink-3">{hint}</p> : null}
    </div>
  )
}

export default function AIAnalytics() {
  const theme = useChartTheme()
  const { filters, params, setFilters, reset, activeCount } = useInsightFilters()
  const { departments: departmentList, categories: categoryList } = useReferenceData()

  // Cached per filter (shared with the dashboard's 'departments'): a return paints the last figures at once.
  const ai = useCachedApi('ai', () => analyticsService.ai(params), [params])
  const officers = useCachedApi('officers', () => analyticsService.officers(params), [params])
  const departments = useCachedApi('departments', () => analyticsService.departments(params), [params])
  const config = useCachedApi('ai-config', () => aiService.getConfig(), [])
  const intro = useSessionIntro('admin-ai-analytics')

  const data = ai.data
  const settings = config.data
  const reviewThreshold = settings?.min_category_confidence != null ? Number(settings.min_category_confidence) * 100 : null
  const filtered = activeCount > 0
  const hasPredictions = Boolean(data?.total_predictions)

  const kpis = [
    {
      key: 'predictions',
      label: 'Predictions analysed',
      value: data?.total_predictions,
      icon: BrainCircuit,
      hint: data ? `${countLabel(data.analyzed_complaints, 'complaint')} in this view` : null,
    },
    {
      key: 'confidence',
      label: 'Average confidence',
      value: data ? (data.avg_confidence == null ? '—' : Number(data.avg_confidence)) : null,
      format: formatShare,
      icon: Gauge,
      tone: 'blue',
      hint: 'Fused image and text decision',
    },
    {
      key: 'agreement',
      label: 'Modality agreement',
      value: data ? (data.modality_agreement_rate == null ? '—' : Number(data.modality_agreement_rate)) : null,
      format: formatPct,
      icon: GitCompareArrows,
      tone: 'teal',
      hint: 'Image and text chose the same category',
    },
    {
      key: 'match',
      label: 'AI vs final category',
      value: data ? (data.ai_category_match_rate == null ? '—' : Number(data.ai_category_match_rate)) : null,
      format: formatPct,
      icon: CircleCheck,
      tone: 'green',
      hint: 'Final category is the one the AI chose',
    },
    {
      key: 'review',
      label: 'Needs review',
      value: data?.needs_review_count,
      icon: UserSearch,
      tone: 'orange',
      hint: 'Low confidence or conflicting signals',
      to: complaintsHref(params, { needs_review: 'true' }),
    },
    {
      key: 'overrides',
      label: 'AI overrides',
      value: data?.override_count,
      icon: SlidersHorizontal,
      tone: 'violet',
      hint: data ? `${formatPct(data.override_rate)} of analysed complaints` : null,
    },
    {
      key: 'speed',
      label: 'Average processing time',
      value: data ? (data.avg_processing_ms == null ? '—' : Number(data.avg_processing_ms)) : null,
      format: formatMs,
      icon: Timer,
      hint: 'Whole AI pipeline per complaint',
    },
  ]

  const histogramColor = (row) => {
    const start = bucketStart(row.bucket)
    if (reviewThreshold != null && start != null && start < reviewThreshold) return REVIEW_COLOR
    return markColor(CONFIDENCE_COLOR, theme.mode)
  }

  const duplicates = data?.duplicates
  const reviewed = (duplicates?.confirmed ?? 0) + (duplicates?.rejected ?? 0)
  const verification = data?.verification
  const verificationRows = useMemo(() => (verification?.by_status ?? []).filter((row) => row.count > 0), [verification])

  const emptyMessage = filtered
    ? 'No AI analyses match these filters. Widen the date range or clear a filter.'
    : 'AI numbers appear as soon as citizens submit complaints.'
  const loadingFirst = ai.loading && !data
  const invalidFilters = filterValidationError([ai.error, officers.error, departments.error])
  const failed = ai.error && !data && !invalidFilters
  // Two or more failed analytics requests: one page-level error with one retry for all of them.
  const requests = [
    { api: ai, part: 'AI analytics' },
    { api: officers, part: 'officer workload' },
    { api: departments, part: 'department performance' },
  ]
  const failedRequests = invalidFilters ? [] : requests.filter(({ api }) => api.error && !api.data)
  const outage = failedRequests.length >= 2
  const blackout = failedRequests.length === requests.length
  const retryAll = () => {
    requests.forEach(({ api }) => api.refetch())
    if (config.error) config.refetch()
  }
  const showOfficers = !(outage && officers.error && !officers.data)
  const showDepartments = !(outage && departments.error && !departments.data)

  return (
    <ChartEntranceContext value={intro}>
      <PageHeader
        title="AI analytics"
        description="How the AI engine performs on real complaints: confidence, agreement with the final decisions, duplicate detection and resolution checks."
        actions={
          <Button variant="outline" leftIcon={SlidersHorizontal} to="/admin/settings">
            AI settings
          </Button>
        }
      />

      <InsightFilterBar
        filters={filters}
        onChange={setFilters}
        onReset={reset}
        activeCount={activeCount}
        departments={departmentList}
        categories={categoryList}
        className="mb-4"
      />

      {invalidFilters ? (
        <InvalidFiltersAlert error={invalidFilters} onReset={reset} />
      ) : outage ? (
        <ErrorState
          className={failed ? undefined : 'mb-4'}
          compact={!failed}
          title={blackout ? "The analytics service can't be reached" : 'Part of AI analytics could not load'}
          message={`${
            blackout
              ? "None of this page's figures could load."
              : `Not available right now: ${failedRequests.map(({ part }) => part).join(' and ')}.`
          } ${getErrorMessage(failedRequests[0].api.error).replace(/([^.!?])$/, '$1.')}`}
          onRetry={retryAll}
          retryLabel="Retry all"
        />
      ) : null}

      {invalidFilters || (failed && outage) ? null : failed ? (
        <ErrorState error={ai.error} onRetry={ai.refetch} title="AI analytics could not load" />
      ) : (
        <>
          {loadingFirst ? (
            <Skeleton className="mb-4 h-11 w-full rounded-xl" />
          ) : (
            <AIModeBanner modelInfo={data?.model_info} className="mb-4" />
          )}

          <KpiStrip items={kpis} loading={loadingFirst} intro={intro} label="AI key figures" className="elev-raised" />

          {data && !hasPredictions ? (
            <EmptyState
              className="mt-4"
              icon={BrainCircuit}
              title={filtered ? 'No AI analyses match these filters' : 'No AI analyses yet'}
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
              {/* Row 1: how sure the models are. */}
              <div className="mt-4 grid gap-4 xl:grid-cols-3">
                <Card className="flex min-w-0 flex-col">
                  <CardHeader title="Model confidence" description="Average confidence of each model" />
                  <CardBody className="flex flex-1 flex-col gap-4">
                    {loadingFirst ? (
                      <Skeleton lines={6} />
                    ) : (
                      <>
                        <ConfidenceBar
                          label="Image model"
                          detail={data?.is_demo ? 'Demo heuristics cap image confidence at 75%' : 'Vision model on the photo'}
                          value={data?.avg_image_confidence}
                        />
                        <ConfidenceBar
                          label="Text model"
                          detail="Classifier on the complaint description"
                          value={data?.avg_text_confidence}
                        />
                        <ConfidenceBar
                          label="Fused decision"
                          detail="Image and text, with location and citizen hints"
                          value={data?.avg_confidence}
                        />
                        {reviewThreshold != null ? (
                          <p className="mt-auto border-t border-line pt-3 text-xs text-ink-3">
                            Below <span className="font-semibold text-ink-2 tabular">{formatNumber(reviewThreshold)}%</span> fused
                            confidence, or when confident modalities disagree, a complaint is flagged for manual review.
                          </p>
                        ) : null}
                      </>
                    )}
                  </CardBody>
                </Card>

                <BarChartCard
                  title="Confidence distribution"
                  description="Fused confidence of each prediction"
                  footer={
                    reviewThreshold != null ? (
                      <span className="inline-flex items-center gap-1.5">
                        <span aria-hidden className="size-2.5 shrink-0 rounded-[3px]" style={{ backgroundColor: REVIEW_COLOR }} />
                        Orange buckets are under the {formatNumber(reviewThreshold)}% review threshold
                      </span>
                    ) : null
                  }
                  data={data?.confidence_histogram}
                  xKey="bucket"
                  series={[{ key: 'count', label: 'Predictions' }]}
                  getColor={histogramColor}
                  xTickFormatter={(value) => String(value).replace(/-\d+%$/, '%')}
                  xTickInterval="equidistantPreserveStart"
                  domain={[0, niceAxisMax]}
                  height={240}
                  loading={ai.loading}
                  emptyDescription={emptyMessage}
                />

                <BarChartCard
                  title="Severity distribution"
                  description="Severity assessed by the engine"
                  data={data?.severity_distribution}
                  series={[{ key: 'count', label: 'Complaints' }]}
                  getColor={(row) => markColor(LEVEL_META[row.level]?.color, theme.mode)}
                  domain={[0, niceAxisMax]}
                  height={240}
                  loading={ai.loading}
                  emptyDescription={emptyMessage}
                />
              </div>

              {/* Row 2: what the AI decided and whether it held. */}
              <div className="mt-4 grid gap-4 xl:grid-cols-12">
                <Card className="flex min-w-0 flex-col xl:col-span-5">
                  <CardHeader
                    title="Predictions by category"
                    description="Complaints per AI category and how confident the model was"
                  />
                  <CardBody className="flex flex-1 flex-col">
                    {loadingFirst ? (
                      <Skeleton lines={9} />
                    ) : data?.predictions_by_category?.length ? (
                      <CategoryPredictions data={data.predictions_by_category} className="flex-1" />
                    ) : (
                      <EmptyState compact bordered={false} title="No predictions yet" description={emptyMessage} />
                    )}
                  </CardBody>
                </Card>

                <Card className="min-w-0 xl:col-span-7">
                  <CardHeader
                    title="AI category vs final category"
                    description="Where reviewers kept or corrected the AI's choice"
                  />
                  <CardBody>
                    {loadingFirst ? (
                      <Skeleton className="h-80 w-full" />
                    ) : data?.confusion?.length ? (
                      <ConfusionMatrix data={data.confusion} categories={categoryList} intro={intro} />
                    ) : (
                      <EmptyState compact bordered={false} title="Nothing to compare yet" description={emptyMessage} />
                    )}
                  </CardBody>
                </Card>
              </div>

              {/* Row 3: duplicates and resolution checks. */}
              <div className="mt-4 grid gap-4 xl:grid-cols-12">
                <Card className="flex min-w-0 flex-col xl:col-span-5">
                  <CardHeader
                    title="Duplicate detection"
                    description="Complaint pairs the engine flagged as the same issue"
                    actions={
                      <Button variant="link" size="sm" to="/admin/duplicates" rightIcon={ArrowUpRight}>
                        Review duplicates
                      </Button>
                    }
                  />
                  <CardBody className="flex flex-1 flex-col gap-5">
                    {loadingFirst ? (
                      <Skeleton lines={5} />
                    ) : (
                      <>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4">
                          <Stat intro={intro} label="Detected" value={Number(duplicates?.detected) || 0} />
                          <Stat intro={intro} label="Pending review" value={Number(duplicates?.pending) || 0} />
                          <Stat intro={intro} label="Confirmed" value={Number(duplicates?.confirmed) || 0} />
                          <Stat intro={intro} label="Not duplicates" value={Number(duplicates?.rejected) || 0} />
                        </div>
                        <SplitBar
                          label="Duplicate pairs by review outcome"
                          segments={[
                            {
                              key: 'confirmed',
                              label: DUPLICATE_STATUS_META.confirmed_duplicate.label,
                              value: duplicates?.confirmed,
                              color: '#e8730c',
                            },
                            {
                              key: 'rejected',
                              label: DUPLICATE_STATUS_META.not_duplicate.label,
                              value: duplicates?.rejected,
                              color: '#8c9a96',
                            },
                            {
                              key: 'pending',
                              label: DUPLICATE_STATUS_META.pending_review.label,
                              value: duplicates?.pending,
                              color: '#f5b700',
                            },
                          ]}
                        />
                        <div className="mt-auto flex flex-wrap items-end justify-between gap-3 border-t border-line pt-4">
                          <Stat
                            intro={intro}
                            label="Precision"
                            value={reviewed && duplicates?.precision != null ? Number(duplicates.precision) : '—'}
                            format={formatPct}
                            hint={
                              reviewed
                                ? `${formatNumber(duplicates.confirmed)} of ${countLabel(reviewed, 'reviewed pair')} were real duplicates`
                                : 'Shown once reviewers have decided on flagged pairs'
                            }
                          />
                          {settings ? (
                            <p className="max-w-60 text-xs text-ink-3">
                              Flagged at{' '}
                              <span className="font-semibold text-ink-2 tabular">
                                {formatNumber(Number(settings.duplicate_threshold) * 100)}%
                              </span>{' '}
                              similarity within{' '}
                              <span className="font-semibold text-ink-2 tabular">
                                {formatNumber(settings.duplicate_radius_m)} m
                              </span>
                              .
                            </p>
                          ) : null}
                        </div>
                      </>
                    )}
                  </CardBody>
                </Card>

                <ChartCard
                  className="xl:col-span-7"
                  title="Resolution verification"
                  description="AI-assisted before and after photo checks of resolved work"
                  loading={ai.loading}
                  empty={
                    data && !verification?.total
                      ? 'Verification results appear once officers resolve complaints with photos.'
                      : undefined
                  }
                  emptyTitle="No checks yet"
                  footer={
                    verification?.total ? (
                      <span className="flex flex-wrap gap-x-6 gap-y-1">
                        <span>
                          Average score{' '}
                          <span className="font-semibold text-ink tabular">
                            {formatNumber(verification.avg_score, { digits: 1 })}/100
                          </span>
                        </span>
                        <span>
                          Manual overrides{' '}
                          <span className="font-semibold text-ink tabular">{formatNumber(verification.manual_overrides)}</span>
                        </span>
                        {settings ? (
                          <span>
                            Likely resolved from{' '}
                            <span className="font-semibold text-ink tabular">
                              {formatNumber(settings.verification_resolved_threshold)}
                            </span>
                            , partially from{' '}
                            <span className="font-semibold text-ink tabular">
                              {formatNumber(settings.verification_partial_threshold)}
                            </span>
                          </span>
                        ) : null}
                      </span>
                    ) : null
                  }
                >
                  <DonutChart
                    data={verificationRows}
                    caption="Resolution verification outcomes"
                    centerLabel="Checks"
                    getColor={(row) => markColor(VERIFICATION_META[row.status]?.color, theme.mode)}
                  />
                </ChartCard>
              </div>
            </>
          )}
        </>
      )}

      {invalidFilters ? null : (
        <>
          {/* Row 4: people. */}
          {showOfficers ? (
            <Card className="mt-4 min-w-0">
              <CardHeader
                title="Officer workload"
                description="Active complaints against each officer's capacity, with their track record"
                actions={
                  <Button variant="link" size="sm" to="/admin/officers" rightIcon={ArrowUpRight}>
                    Manage officers
                  </Button>
                }
              />
              {officers.error && !officers.data ? (
                <ErrorState
                  compact
                  bordered={false}
                  error={officers.error}
                  onRetry={officers.refetch}
                  title="Officer workload could not load"
                />
              ) : (
                <OfficerWorkloadTable data={officers.data ?? []} loading={officers.loading} className="rounded-t-none border-0" />
              )}
            </Card>
          ) : null}

          {showDepartments ? (
            <Card className="mt-4 min-w-0">
              <CardHeader
                title="Department performance"
                description="Resolution rate, SLA compliance and citizen rating per department"
              />
              {departments.error && !departments.data ? (
                <ErrorState
                  compact
                  bordered={false}
                  error={departments.error}
                  onRetry={departments.refetch}
                  title="Department performance could not load"
                />
              ) : (
                <DepartmentPerformanceTable
                  data={departments.data ?? []}
                  loading={departments.loading}
                  className="rounded-t-none border-0"
                />
              )}
            </Card>
          ) : null}

          {data?.model_info ? (
            <Card className="mt-4 min-w-0">
              <CardHeader
                title="Models and versions"
                description="Every model and engine component the server reports, with its live status"
              />
              <ModelRegistry modelInfo={data.model_info} className="pt-1" />
            </Card>
          ) : null}
        </>
      )}
    </ChartEntranceContext>
  )
}
