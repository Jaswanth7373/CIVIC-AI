/**
 * Admin dashboard (/admin/dashboard) - the city's operations centre: the live picture of the whole city.
 *
 * Every number comes from the analytics API, filtered by ONE filter row (date range, department, category)
 * stored in the URL:
 * - analytics/overview    -> command band (key figures), status / severity / priority distributions, priority
 *                            histogram, resolution-time buckets, recent critical complaints
 * - analytics/categories  -> complaints by category
 * - analytics/departments -> complaints by department, split by status group
 * - analytics/trends      -> submitted vs resolved vs critical over time (day / week / month)
 * - analytics/sentiment   -> sentiment split and citizen satisfaction (feedback given in the period)
 * - analytics/hotspots    -> the City pulse: DBSCAN hotspots as 3D columns or on the map
 * - analytics/alerts      -> hotspot alerts (acknowledge / reopen)
 * "Run checks now" runs the SLA breach check and the hotspot scan immediately; while it runs, the AI scan band
 * sweeps the key figures and the City pulse.
 *
 * First screen: the command band - a night panel (dark in both themes) whose large figures are what needs
 * action now (open critical complaints, complaints past their SLA, pending complaints, each a deep link to the
 * list behind it), with the whole picture (total, in progress, resolved, resolution time, rating) as compact
 * readouts beside them. Then (desktop) where complaints concentrate (City pulse), how activity moves (trend)
 * next to what the hotspot scan flagged, what needs action now (critical complaints), then what and who
 * (categories, departments), the lifecycle and how serious it is, and how fast and how well it was resolved.
 * Phones lead with action: key figures, critical complaints, hotspot alerts, City pulse, trend - and the
 * eight distribution charts wait behind "More analytics".
 *
 * Coming back: the responses are cached per filter (stale-while-revalidate, useCachedApi), so a return to the
 * dashboard paints the last figures at once and refreshes them silently; the entrances (scan pass and
 * count-ups, panel rises, chart draws) play on the first visit of the session only, and a figure that changed
 * since counts from its previous value. Reduced motion: everything is simply there.
 *
 * Failures: when two or more requests fail (or the overview, which feeds six panels), the page shows ONE
 * error with "Retry all" and the affected panels step back to a quiet placeholder; an isolated failure keeps
 * its own panel error. A failed background refresh keeps the last figures and says so next to "Updated".
 */
import {
  ArrowUpRight,
  ChevronDown,
  CircleCheck,
  ClipboardList,
  ClockAlert,
  Construction,
  FileText,
  Hourglass,
  MapPin,
  RefreshCw,
  ScanSearch,
  Siren,
  Star,
  Timer,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import {
  BarChartCard,
  ChartCard,
  ChartEntranceContext,
  ChartErrorModeContext,
  DonutChart,
  HorizontalBarChart,
  LineTrendChart,
  RatingBars,
  StackedBarChart,
  useChartTheme,
} from '@/components/charts'
import { ComplaintTable } from '@/components/complaints'
import { Stagger, StaggerItem } from '@/components/motion'
import { Button } from '@/components/ui/Button'
import { Card, CardHeader } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { IconButton } from '@/components/ui/IconButton'
import { PageHeader } from '@/components/ui/PageHeader'
import { BREAKPOINTS, useMediaQuery } from '@/hooks/useMediaQuery'
import { useToast } from '@/hooks/useToast'
import { analyticsService } from '@/services/analyticsService'
import { cn } from '@/utils/cn'
import { LEVEL_META, STATUS_META } from '@/utils/constants'
import { getErrorMessage } from '@/utils/errors'
import { formatDate, formatHours, formatNumber, formatTime } from '@/utils/format'
import { CityPulseCard } from './insights/CityPulseCard'
import { HotspotAlertList } from './insights/HotspotAlertList'
import { InsightFilterBar } from './insights/InsightFilterBar'
import { InvalidFiltersAlert } from './insights/InvalidFiltersAlert'
import {
  STATUS_GROUP_PARAM,
  bucketLevelColor,
  complaintsHref,
  countLabel,
  filterValidationError,
  formatPct,
  markColor,
  niceAxisMax,
  shortCategoryName,
  withFilters,
} from './insights/insightUtils'
import { KpiStrip } from './insights/KpiStrip'
import { LevelCounts } from './insights/LevelCounts'
import { PanelUnavailable } from './insights/PanelUnavailable'
import { SegmentedControl } from './insights/SegmentedControl'
import { SplitBar } from './insights/SplitBar'
import { useCachedApi, useSessionIntro } from './insights/useCachedApi'
import { useInsightFilters, useReferenceData } from './insights/useInsightFilters'
import '@/styles/admin.css'

/** Trend periods: bucket size + the window used when no date range is selected. */
const PERIODS = [
  { value: 'day', label: 'Day', days: 30, adjective: 'Daily' },
  { value: 'week', label: 'Week', days: 182, adjective: 'Weekly' },
  { value: 'month', label: 'Month', days: 365, adjective: 'Monthly' },
]

/** Average rating with one decimal ("3.9"), also while it counts up. */
const ratingText = (value) => Number(value).toFixed(1)

/**
 * "Complaint" cell of the critical list: number, title (up to two lines) and the area underneath, instead of a
 * separate Location column. Both texts may wrap (line-clamp), so the column can narrow and the whole row,
 * "Open" included, fits the card at 1440 px; narrower screens scroll inside the table.
 */
const CRITICAL_COMPLAINT_COLUMN = {
  key: 'complaint',
  header: 'Complaint',
  className: 'max-w-80',
  render: (row) => {
    const location = row.location ?? {}
    const place = location.area || location.city || location.address
    return (
      <div className="min-w-52">
        <p className="text-xs font-semibold text-ink-3 tabular">{row.complaint_number}</p>
        <p className="line-clamp-2 font-semibold leading-snug text-ink" title={row.title || undefined}>
          {row.title || row.description}
        </p>
        {place ? (
          <p className="mt-0.5 line-clamp-1 text-xs text-ink-3" title={location.address || place}>
            <MapPin aria-hidden className="mr-1 inline size-3 align-[-2px]" />
            {place}
          </p>
        ) : null}
      </div>
    )
  },
}

const CRITICAL_COLUMNS = [CRITICAL_COMPLAINT_COLUMN, 'category', 'priority', 'officer', 'sla', 'action']

/** Alerts carry their dominant category; the department filter follows the category's routing. */
function filterAlerts(alerts, params, categories) {
  const list = Array.isArray(alerts) ? alerts : []
  const departmentOf = new Map(categories.map((category) => [category.id, category.department]))
  return list.filter((alert) => {
    const category = alert.dominant_category
    if (params.category) {
      const value = String(params.category)
      if (!category || (String(category.slug) !== value && String(category.id) !== value)) return false
    }
    if (params.department && String(departmentOf.get(category?.id) ?? '') !== String(params.department)) return false
    return true
  })
}

/** Complaints outside the pending / in progress / resolved groups (rejected or withdrawn). */
function rejectedOf(totals) {
  const total = Number(totals?.total) || 0
  return Math.max(0, total - (totals?.pending ?? 0) - (totals?.in_progress ?? 0) - (Number(totals?.resolved) || 0))
}

/**
 * Thin 100% bar under the total: the share of pending / in progress / resolved / rejected complaints, in the
 * same colours as the department chart (the readouts next to it carry the numbers). `mode` is the surface it
 * sits on - 'dark' in the command band, whatever the page theme.
 */
function StatusGroupBar({ totals, mode }) {
  const total = Number(totals?.total) || 0
  if (!total) return null
  const resolvedCount = Number(totals.resolved) || 0
  const rejected = rejectedOf(totals)
  return (
    <SplitBar
      size="sm"
      legend={false}
      label="Complaints by status group"
      className="mb-2 max-w-80"
      segments={[
        { key: 'pending', label: 'Pending', value: totals.pending, color: markColor(STATUS_META.assigned.color, mode) },
        { key: 'in_progress', label: 'In progress', value: totals.in_progress, color: STATUS_META.in_progress.color },
        { key: 'resolved', label: 'Resolved', value: resolvedCount, color: markColor(STATUS_META.resolved.color, mode) },
        { key: 'rejected', label: 'Rejected', value: rejected, color: STATUS_META.rejected.color },
      ]}
    />
  )
}

/**
 * "Updated 12:37 PM" with a signal dot that rings once whenever new numbers arrive (remounted by the data's
 * own timestamp) - the refresh is acknowledged without anything blinking forever. When a background refresh
 * failed while the last figures stay on screen, it says so (the figures are from that time).
 */
function UpdatedSignal({ generatedAt, loading, refreshFailed }) {
  return (
    <span className="inline-flex items-center gap-2 text-xs text-ink-3" aria-live="polite">
      {generatedAt ? (
        <>
          <span
            key={generatedAt}
            aria-hidden
            className={cn('ops-signal', refreshFailed ? 'text-hazard-500 dark:text-hazard-400' : 'text-sign-500 dark:text-sign-400')}
          />
          {refreshFailed ? `Could not refresh, figures from ${formatTime(generatedAt)}` : `Updated ${formatTime(generatedAt)}`}
        </>
      ) : loading ? (
        'Loading'
      ) : null}
    </span>
  )
}

/**
 * A row of panels that rises in once when it scrolls into view - on the first visit of the session only; a
 * return visit shows the panels where they stand. `items`: `[{key, className, node}]`.
 */
function PanelRow({ rise, className, items }) {
  if (!rise) {
    return (
      <div className={className}>
        {items.map((item) => (
          <div key={item.key} className={item.className}>
            {item.node}
          </div>
        ))}
      </div>
    )
  }
  return (
    <Stagger className={className}>
      {items.map((item, index) => (
        <StaggerItem key={item.key} index={index} className={item.className}>
          {item.node}
        </StaggerItem>
      ))}
    </Stagger>
  )
}

/** "key figures, the trend and hotspot alerts" */
function joinParts(parts) {
  if (parts.length < 2) return parts.join('')
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/** A server message as a sentence ("Simulated server error" -> "Simulated server error."). */
function asSentence(text) {
  const value = String(text ?? '').trim()
  return !value || /[.!?]$/.test(value) ? value : `${value}.`
}

export default function AdminDashboard() {
  const toast = useToast()
  const theme = useChartTheme()
  const wide = useMediaQuery(BREAKPOINTS.sm)
  const phone = !useMediaQuery(BREAKPOINTS.md)
  // Entrances (scan pass, count-ups, panel rises, chart draws) play on the first visit of the session only.
  const intro = useSessionIntro('admin-dashboard')
  const { filters, params, setFilters, reset, activeCount } = useInsightFilters()
  const { departments: departmentList, categories: categoryList } = useReferenceData()
  const [period, setPeriod] = useState('week')
  const [running, setRunning] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const periodMeta = PERIODS.find((item) => item.value === period) ?? PERIODS[1]

  // Stale-while-revalidate: a return visit paints the last responses at once and refreshes them silently.
  const overview = useCachedApi('overview', () => analyticsService.overview(params), [params])
  const categories = useCachedApi('categories', () => analyticsService.categories(params), [params])
  const departments = useCachedApi('departments', () => analyticsService.departments(params), [params])
  const trends = useCachedApi('trends', () => analyticsService.trends({ ...params, period, days: periodMeta.days }), [
    params,
    period,
    periodMeta.days,
  ])
  const sentiment = useCachedApi('sentiment', () => analyticsService.sentiment(params), [params])
  const hotspots = useCachedApi('hotspots', () => analyticsService.hotspots(params), [params])
  const alerts = useCachedApi('alerts', () => analyticsService.alerts(), [])
  const requests = [
    { api: overview, part: 'key figures' },
    { api: categories, part: 'categories' },
    { api: departments, part: 'departments' },
    { api: trends, part: 'the trend' },
    { api: sentiment, part: 'sentiment' },
    { api: hotspots, part: 'hotspots' },
    { api: alerts, part: 'hotspot alerts' },
  ]

  const data = overview.data
  const totals = data?.totals
  const total = totals?.total ?? 0
  const filtered = activeCount > 0

  const refreshAll = () => {
    requests.forEach(({ api }) => api.refetch())
  }

  const runChecks = async () => {
    setRunning(true)
    try {
      const result = await analyticsService.runChecks()
      const summary = `${countLabel(result?.sla_alerts, 'SLA alert')} and ${countLabel(result?.hotspot_alerts, 'new hotspot alert')} raised.`
      if (result?.errors && Object.keys(result.errors).length) {
        toast.warning('Checks finished with problems', `${summary} ${Object.values(result.errors).join(' ')}`)
      } else {
        toast.success('Checks complete', summary)
      }
      alerts.refetch()
      overview.refetch()
      hotspots.refetch()
    } catch (error) {
      toast.error('Could not run checks', getErrorMessage(error))
    } finally {
      setRunning(false)
    }
  }

  const acknowledge = async (alert, value) => {
    try {
      const updated = await analyticsService.acknowledgeAlert(alert.id, value)
      alerts.setData((list) => (Array.isArray(list) ? list.map((item) => (item.id === updated.id ? updated : item)) : list))
      toast.success(
        value ? 'Alert acknowledged' : 'Alert reopened',
        `${updated.area_name || 'Hotspot'}: ${countLabel(updated.complaint_count, 'complaint')}`,
      )
    } catch (error) {
      toast.error(value ? 'Could not acknowledge alert' : 'Could not reopen alert', getErrorMessage(error))
      throw error
    }
  }

  /* ---- failures: one page-level error instead of one per panel ------------------------------------------- */
  const invalidFilters = filterValidationError([
    overview.error,
    categories.error,
    departments.error,
    trends.error,
    sentiment.error,
    hotspots.error,
  ])
  const failed = invalidFilters ? [] : requests.filter(({ api }) => api.error && !api.data)
  // Two failed requests - or the overview, which feeds six panels - would mean a wall of error boxes: the
  // page shows ONE error with "Retry all" and the affected panels step back to a quiet placeholder.
  const outage = failed.length >= 2 || failed.some(({ api }) => api === overview)
  const blackout = failed.length === requests.length
  const refreshFailed = requests.some(({ api }) => api.error && api.data)
  const quiet = (api) => outage && Boolean(api.error) && !api.data

  /* ---- derived chart data ------------------------------------------------------------------------------ */
  const kpis = [
    // What needs action now: the large figures that lead the command band.
    {
      key: 'critical',
      label: 'Critical',
      value: totals?.critical,
      icon: Siren,
      tone: 'red',
      primary: true,
      alert: (totals?.critical ?? 0) > 0,
      hint: 'Open with critical priority',
      to: complaintsHref(params, { priority_level: 'critical', status: STATUS_GROUP_PARAM.open }),
    },
    {
      key: 'overdue',
      label: 'Past SLA',
      value: totals?.overdue,
      icon: ClockAlert,
      tone: 'orange',
      primary: true,
      alert: (totals?.overdue ?? 0) > 0,
      hint: 'Open beyond their resolution deadline',
      to: complaintsHref(params, { is_overdue: 'true' }),
    },
    {
      key: 'pending',
      label: 'Pending',
      value: totals?.pending,
      icon: Hourglass,
      tone: 'blue',
      primary: true,
      alert: (totals?.pending ?? 0) > 0,
      hint: 'Submitted, assigned or reopened',
      to: complaintsHref(params, { status: STATUS_GROUP_PARAM.pending }),
    },
    // The whole picture: compact readouts.
    {
      key: 'total',
      label: 'Total complaints',
      value: totals?.total,
      icon: ClipboardList,
      hint: totals ? (
        <>
          <StatusGroupBar totals={totals} mode="dark" />
          {`${formatNumber(totals.reopened ?? 0)} reopened, ${formatNumber(rejectedOf(totals))} rejected`}
        </>
      ) : null,
      to: complaintsHref(params),
    },
    {
      key: 'in_progress',
      label: 'In progress',
      value: totals?.in_progress,
      icon: Construction,
      tone: 'yellow',
      hint: 'Accepted or work under way',
      to: complaintsHref(params, { status: STATUS_GROUP_PARAM.in_progress }),
    },
    {
      key: 'resolved',
      label: 'Resolved',
      value: totals?.resolved,
      icon: CircleCheck,
      tone: 'green',
      hint: total ? `${formatPct((totals.resolved / total) * 100)} of all complaints` : 'Resolved, verified or closed',
      to: complaintsHref(params, { status: STATUS_GROUP_PARAM.resolved }),
    },
    {
      key: 'resolution',
      label: 'Average resolution time',
      value: data ? (data.avg_resolution_hours ? Number(data.avg_resolution_hours) : '—') : null,
      format: formatHours,
      icon: Timer,
      hint: data
        ? data.avg_resolution_hours
          ? `${formatPct(data.sla_compliance)} resolved within SLA`
          : 'Nothing resolved yet'
        : null,
    },
    {
      key: 'rating',
      label: 'Average rating',
      value: data ? (Number(data.avg_rating) ? Number(data.avg_rating) : '—') : null,
      format: ratingText,
      unit: data?.avg_rating ? '/ 5' : null,
      icon: Star,
      tone: 'yellow',
      hint: data
        ? data.feedback_count
          ? `${formatPct(data.satisfaction_rate)} satisfied, ${countLabel(data.feedback_count, 'rating')}`
          : 'No ratings yet'
        : null,
      to: withFilters('/admin/feedback', params),
    },
  ]

  const statusRows = useMemo(() => (data?.status_distribution ?? []).filter((row) => row.count > 0), [data])
  // Phones: "Roads Department" -> "Roads" (the suffix tells nothing in a chart of departments), so the stacked
  // bars keep most of the width.
  const departmentRows = useMemo(
    () =>
      (departments.data ?? []).map((row) => ({
        ...row,
        label: wide ? row.department?.name : String(row.department?.name ?? '').replace(/\s+Department$/i, ''),
        rejected: Math.max(0, (row.total ?? 0) - (row.pending ?? 0) - (row.in_progress ?? 0) - (row.resolved ?? 0)),
      })),
    [departments.data, wide],
  )
  const departmentSeries = [
    { key: 'pending', label: 'Pending', color: markColor(STATUS_META.assigned.color, theme.mode) },
    { key: 'in_progress', label: 'In progress', color: STATUS_META.in_progress.color },
    { key: 'resolved', label: 'Resolved', color: markColor(STATUS_META.resolved.color, theme.mode) },
    { key: 'rejected', label: 'Rejected', color: STATUS_META.rejected.color },
  ]
  const trendSeries = [
    { key: 'submitted', label: 'Submitted' },
    { key: 'resolved', label: 'Resolved', color: markColor(STATUS_META.resolved.color, theme.mode) },
    { key: 'critical', label: 'Critical priority', color: LEVEL_META.critical.color },
  ]
  const periodControl = (
    <SegmentedControl
      label="Time period"
      options={PERIODS.map(({ value, label }) => ({ value, label }))}
      value={period}
      onChange={setPeriod}
    />
  )
  // Phones: "Water Supply / Water Leakage" -> "Water Supply", so the bars keep most of the width.
  const categoryRows = useMemo(
    () =>
      (categories.data ?? []).map((row) => ({
        ...row,
        label: wide ? row.category?.name : shortCategoryName(row.category?.name),
      })),
    [categories.data, wide],
  )
  const trendDescription = trends.data
    ? `${periodMeta.adjective} totals from ${formatDate(trends.data.date_from)} to ${formatDate(trends.data.date_to)}`
    : `${periodMeta.adjective} totals`

  const visibleAlerts = useMemo(() => filterAlerts(alerts.data, params, categoryList), [alerts.data, params, categoryList])
  const sentimentData = sentiment.data
  const noComplaints = !overview.loading && data && total === 0

  const emptyMessage = filtered
    ? 'No complaints match these filters. Widen the date range or clear a filter.'
    : 'Numbers appear here as soon as citizens report issues.'

  /* ---- panels ----------------------------------------------------------------------------------------------- */
  // Where: the hotspots, as a 3D district or on the map.
  const pulsePanel = (
    <CityPulseCard
      hotspots={hotspots}
      categories={categoryList}
      params={params}
      scanning={running}
      quiet={outage}
      className="elev-raised"
    />
  )

  // How activity moves over time.
  const trendPanel = (
    <ChartCard
      className="flex-1"
      title="Complaints over time"
      description={trendDescription}
      actions={wide ? periodControl : null}
      loading={trends.loading}
      error={trends.data ? null : trends.error}
      onRetry={trends.refetch}
    >
      {wide ? null : <div className="mb-3">{periodControl}</div>}
      <LineTrendChart
        caption="Complaints over time"
        data={trends.data?.series}
        series={trendSeries}
        height={300}
        domain={[0, niceAxisMax]}
        emptyTitle="No complaints in this period"
        emptyDescription={emptyMessage}
      />
    </ChartCard>
  )

  // What the hotspot scan flagged (from xl the list scrolls at the trend chart's height).
  const alertsPanel = (
    <Card className="flex flex-1 flex-col">
      <CardHeader
        title="Hotspot alerts"
        description="Clusters of complaints found by the hotspot scan"
        actions={
          <Button variant="link" size="sm" to="/admin/hotspots" rightIcon={ArrowUpRight}>
            Map
          </Button>
        }
      />
      <div className="relative xl:min-h-48 xl:flex-1">
        <div className="px-4 py-4 sm:px-5 xl:absolute xl:inset-0 xl:overflow-y-auto xl:scrollbar-thin">
          {quiet(alerts) ? (
            <PanelUnavailable />
          ) : (
            <HotspotAlertList
              alerts={visibleAlerts}
              loading={alerts.loading}
              error={alerts.error}
              onRetry={alerts.refetch}
              onAcknowledge={acknowledge}
              mapHref={(alert) =>
                `/admin/hotspots?focus=${alert.latitude},${alert.longitude}&r=${Math.round(Number(alert.radius_m) || 0)}`
              }
              limit={4}
              emptyHint="Run checks now to scan again."
            />
          )}
        </div>
        {running ? <span aria-hidden className="ops-scan" data-scan="loop" /> : null}
      </div>
    </Card>
  )

  // Act now.
  const criticalPanel = (
    <Card className="min-w-0">
      <CardHeader
        title="Recent critical complaints"
        description="Open complaints with critical priority, newest first"
        actions={
          <Button
            variant="link"
            size="sm"
            rightIcon={ArrowUpRight}
            to={complaintsHref(params, { priority_level: 'critical', status: STATUS_GROUP_PARAM.open })}
          >
            View all
          </Button>
        }
      />
      {quiet(overview) ? (
        <PanelUnavailable className="m-4 sm:m-5" />
      ) : overview.error && !data ? (
        <ErrorState
          compact
          bordered={false}
          error={overview.error}
          onRetry={overview.refetch}
          title="Critical complaints could not load"
        />
      ) : (
        <ComplaintTable
          complaints={data?.recent_critical ?? []}
          loading={overview.loading}
          basePath="/admin/complaints"
          columns={CRITICAL_COLUMNS}
          caption="Recent critical complaints"
          actionLabel="Open"
          // `relative`: the sr-only labels of cells scrolled out of view ("Actions", "Open CIV-...") are
          // clipped by the table frame instead of widening the page.
          className="relative rounded-t-none border-0"
          empty={
            <EmptyState
              compact
              bordered={false}
              icon={CircleCheck}
              title="No open critical complaints"
              description="Critical issues appear here the moment the AI scores one, so they can be assigned first."
            />
          }
        />
      )}
    </Card>
  )

  /* What and who, the lifecycle and how serious it is, how fast and how well it was resolved. */
  const analyticsRows = (
    <>
      <PanelRow
        rise={intro}
        className="mt-4 grid gap-4 xl:grid-cols-2"
        items={[
          {
            key: 'categories',
            className: 'flex min-w-0 flex-col',
            node: (
              <HorizontalBarChart
                className="flex-1"
                title="Complaints by category"
                description="Classified by the AI engine, corrected by officers where needed"
                data={categoryRows}
                labelKey="label"
                valueKey="total"
                seriesLabel="Complaints"
                domain={[0, niceAxisMax]}
                loading={categories.loading}
                error={categories.data ? null : categories.error}
                onRetry={categories.refetch}
                emptyDescription={emptyMessage}
              />
            ),
          },
          {
            key: 'departments',
            className: 'flex min-w-0 flex-col',
            node: (
              <StackedBarChart
                className="flex-1"
                title="Complaints by department"
                description="Workload of each department, split by status group"
                data={departmentRows}
                xKey="label"
                series={departmentSeries}
                horizontal
                loading={departments.loading}
                error={departments.data ? null : departments.error}
                onRetry={departments.refetch}
                emptyDescription={emptyMessage}
              />
            ),
          },
        ]}
      />

      <PanelRow
        rise={intro}
        className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3"
        items={[
          {
            key: 'status',
            className: 'flex min-w-0 flex-col md:col-span-2 xl:col-span-1',
            node: (
              <HorizontalBarChart
                className="flex-1"
                title="Status distribution"
                description={
                  total ? `Where the ${formatNumber(total)} complaints are in their lifecycle` : 'Where complaints are in their lifecycle'
                }
                data={statusRows}
                valueKey="count"
                seriesLabel="Complaints"
                sort="none"
                domain={[0, niceAxisMax]}
                getColor={(row) => markColor(STATUS_META[row.status]?.color, theme.mode)}
                loading={overview.loading}
                error={data ? null : overview.error}
                onRetry={overview.refetch}
                emptyDescription={emptyMessage}
              />
            ),
          },
          {
            key: 'severity',
            className: 'flex min-w-0 flex-col',
            node: (
              <ChartCard
                className="flex-1"
                title="Severity distribution"
                description="AI-assessed severity of each complaint"
                loading={overview.loading}
                error={data ? null : overview.error}
                onRetry={overview.refetch}
              >
                <DonutChart
                  data={data?.severity_distribution}
                  caption="Severity distribution"
                  centerLabel="Complaints"
                  emptyDescription={emptyMessage}
                />
              </ChartCard>
            ),
          },
          {
            key: 'priority',
            className: 'flex min-w-0 flex-col',
            node: (
              <ChartCard
                className="flex-1"
                title="Priority distribution"
                description="Priority score histogram, coloured by level"
                loading={overview.loading}
                error={data ? null : overview.error}
                onRetry={overview.refetch}
              >
                <LevelCounts data={data?.priority_distribution} label="Complaints by priority level" className="mb-4" />
                <BarChartCard
                  data={data?.priority_histogram}
                  xKey="bucket"
                  xTickInterval="equidistantPreserveStart"
                  series={[{ key: 'count', label: 'Complaints' }]}
                  title="Priority score"
                  getColor={(row) => bucketLevelColor(row.bucket)}
                  showValues={false}
                  height={200}
                />
              </ChartCard>
            ),
          },
        ]}
      />

      <PanelRow
        rise={intro}
        className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3"
        items={[
          {
            key: 'resolution',
            className: 'flex min-w-0 flex-col md:col-span-2 xl:col-span-1',
            node: (
              <BarChartCard
                className="flex-1"
                title="Resolution time"
                description={
                  data?.avg_resolution_hours
                    ? `Average ${formatHours(data.avg_resolution_hours)}, ${formatPct(data.sla_compliance)} within SLA`
                    : 'Time from report to resolution'
                }
                data={data?.resolution_time_distribution}
                xKey="bucket"
                series={[{ key: 'count', label: 'Resolved complaints' }]}
                height={250}
                loading={overview.loading}
                error={data ? null : overview.error}
                onRetry={overview.refetch}
                emptyTitle="Nothing resolved yet"
                emptyDescription="Resolution times appear once officers resolve complaints in this period."
              />
            ),
          },
          {
            key: 'sentiment',
            className: 'flex min-w-0 flex-col',
            node: (
              <DonutChart
                className="flex-1"
                title="Citizen sentiment"
                description="Sentiment of feedback given in the period"
                data={sentimentData?.distribution}
                centerLabel="Feedback"
                height={180}
                loading={sentiment.loading}
                error={sentimentData ? null : sentiment.error}
                onRetry={sentiment.refetch}
                emptyTitle="No feedback yet"
                emptyDescription="Sentiment appears once citizens rate resolved complaints."
              />
            ),
          },
          {
            key: 'satisfaction',
            className: 'flex min-w-0 flex-col',
            node: (
              <RatingBars
                className="flex-1"
                title="Citizen satisfaction"
                description={
                  sentimentData?.total_feedback
                    ? `${formatPct(sentimentData.satisfaction_rate)} rated the resolution 4 or 5 stars`
                    : 'Ratings of resolved complaints'
                }
                data={sentimentData?.rating_distribution}
                average={sentimentData?.average_rating || null}
                total={sentimentData?.total_feedback}
                loading={sentiment.loading}
                error={sentimentData ? null : sentiment.error}
                onRetry={sentiment.refetch}
                footer={
                  <Button variant="link" size="sm" to={withFilters('/admin/feedback', params)} rightIcon={ArrowUpRight}>
                    Feedback analytics
                  </Button>
                }
              />
            ),
          },
        ]}
      />
    </>
  )

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Live picture of complaints, response times and citizen satisfaction across every department."
        actions={
          <>
            <Button variant="outline" leftIcon={ScanSearch} loading={running} onClick={runChecks}>
              Run checks now
            </Button>
            <Button variant="secondary" leftIcon={FileText} to={withFilters('/admin/reports', params)}>
              Build a report
            </Button>
          </>
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
        trailing={
          <>
            <UpdatedSignal generatedAt={data?.generated_at} loading={overview.loading} refreshFailed={refreshFailed} />
            <IconButton
              icon={RefreshCw}
              label="Refresh dashboard"
              variant="outline"
              size="sm"
              onClick={refreshAll}
              loading={overview.refreshing && Boolean(data)}
            />
          </>
        }
      />

      {invalidFilters ? (
        <InvalidFiltersAlert error={invalidFilters} onReset={reset} />
      ) : (
        <ChartEntranceContext value={intro}>
          <ChartErrorModeContext value={outage ? 'quiet' : 'full'}>
            {outage ? (
              <ErrorState
                className="mb-4"
                compact={!blackout}
                title={blackout ? "The analytics service can't be reached" : 'Part of the dashboard could not load'}
                message={
                  blackout
                    ? `None of the dashboard's figures could load. ${asSentence(getErrorMessage(failed[0].api.error))}`
                    : `Not available right now: ${joinParts(failed.map(({ part }) => part))}. ${asSentence(getErrorMessage(failed[0].api.error))}`
                }
                onRetry={refreshAll}
                retryLabel="Retry all"
              />
            ) : null}

            {blackout ? null : (
              <>
                {quiet(overview) ? null : (
                  <KpiStrip
                    variant="command"
                    heading="Needs action now"
                    items={kpis}
                    loading={overview.loading && !data}
                    error={data ? null : overview.error}
                    onRetry={overview.refetch}
                    scanning={running}
                    intro={intro}
                    label="Complaint key figures"
                  />
                )}

                {noComplaints ? (
                  <EmptyState
                    className="mt-4"
                    icon={ClipboardList}
                    title={filtered ? 'No complaints match these filters' : 'No complaints yet'}
                    description={emptyMessage}
                    action={
                      filtered ? (
                        <Button variant="outline" onClick={reset}>
                          Clear filters
                        </Button>
                      ) : null
                    }
                  />
                ) : phone ? (
                  // Phones: what needs action first - the critical list, the alerts - then where, then when.
                  <>
                    <PanelRow rise={intro} className="mt-4" items={[{ key: 'critical', node: criticalPanel }]} />
                    <PanelRow rise={intro} className="mt-4 flex flex-col" items={[{ key: 'alerts', className: 'flex flex-col', node: alertsPanel }]} />
                    <PanelRow rise={intro} className="mt-4" items={[{ key: 'pulse', node: pulsePanel }]} />
                    <PanelRow rise={intro} className="mt-4 flex flex-col" items={[{ key: 'trend', className: 'flex flex-col', node: trendPanel }]} />
                    {/* The eight distribution charts wait behind one disclosure, so the phone page stays short. */}
                    <Button
                      variant="outline"
                      className="mt-4 w-full [&[aria-expanded=true]_svg:last-child]:rotate-180"
                      rightIcon={ChevronDown}
                      aria-expanded={moreOpen}
                      aria-controls="dashboard-more-analytics"
                      onClick={() => setMoreOpen((open) => !open)}
                    >
                      More analytics
                    </Button>
                    <div id="dashboard-more-analytics" hidden={!moreOpen}>
                      {moreOpen ? analyticsRows : null}
                    </div>
                  </>
                ) : (
                  <>
                    <PanelRow rise={intro} className="mt-4" items={[{ key: 'pulse', node: pulsePanel }]} />
                    <PanelRow
                      rise={intro}
                      className="mt-4 grid gap-4 xl:grid-cols-12"
                      items={[
                        { key: 'trend', className: 'flex min-w-0 flex-col xl:col-span-8', node: trendPanel },
                        { key: 'alerts', className: 'flex min-w-0 flex-col xl:col-span-4', node: alertsPanel },
                      ]}
                    />
                    <PanelRow rise={intro} className="mt-4" items={[{ key: 'critical', node: criticalPanel }]} />
                    {analyticsRows}
                  </>
                )}
              </>
            )}
          </ChartErrorModeContext>
        </ChartEntranceContext>
      )}
    </>
  )
}
