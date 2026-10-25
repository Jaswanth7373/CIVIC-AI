/**
 * HotspotPanel - the hotspot map's side panel (a bottom drawer on phones): DBSCAN statistics, the clustering
 * parameters with "Re-run clustering", and two tabs - the clusters (click one to fly to it) and the latest
 * hotspot alerts.
 *
 * Props:
 * - data: GET /analytics/hotspots/ response `{clusters, noise_ids, total_points, params: {eps_m, min_samples},
 *   algorithm, window: {date_from, date_to, days}, points_available, points_truncated, alerts}`
 * - loading, error, onRetry
 * - epsValue / minValue: the applied DBSCAN parameters (strings; '' = server defaults)
 * - onRun({eps_m, min_samples}): apply parameters (URL) - also re-runs with unchanged values
 * - onResetParams(): back to the AI configuration's defaults
 * - fieldErrors: server field errors `{eps_m, min_samples}`
 * - selectedId: selected cluster id; onSelectCluster(cluster)
 * - onLocateAlert(alert), onAcknowledge(alert, value) (returns the service promise)
 * - className
 *
 * Motion: the three statistics count up and the hotspots rise into the list one after another on the first
 * result (later results - a re-run, a new sort - simply appear). Reduced motion: everything at once.
 */
import { ChevronDown, RotateCcw, ScanSearch } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { readableInk } from '@/components/charts/palette'
import { CategoryBadge, SeverityBadge } from '@/components/complaints'
import { CountUp } from '@/components/motion/CountUp'
import { Stagger, StaggerItem } from '@/components/motion/Stagger'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { FormField } from '@/components/ui/FormField'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Skeleton } from '@/components/ui/Skeleton'
import { TabPanel, Tabs } from '@/components/ui/Tabs'
import { cn } from '@/utils/cn'
import { getLevelMeta } from '@/utils/constants'
import { formatDate, formatDistance, formatNumber } from '@/utils/format'
import { HotspotAlertList } from './HotspotAlertList'
import { countLabel } from './insightUtils'

const SORTS = [
  { value: 'count', label: 'Most complaints', read: (cluster) => Number(cluster.count) || 0 },
  { value: 'open', label: 'Most still open', read: (cluster) => Number(cluster.open_count) || 0 },
  { value: 'severity', label: 'Highest severity', read: (cluster) => Number(cluster.avg_severity_score) || 0 },
  { value: 'density', label: 'Densest', read: (cluster) => Number(cluster.density_per_km2) || 0 },
]

const EPS_RANGE = { min: 50, max: 5000 }
const MIN_RANGE = { min: 2, max: 50 }

function validate(eps, min) {
  const errors = {}
  const epsNumber = Number(eps)
  const minNumber = Number(min)
  if (!Number.isInteger(epsNumber) || epsNumber < EPS_RANGE.min || epsNumber > EPS_RANGE.max) {
    errors.eps_m = `Enter whole metres from ${EPS_RANGE.min} to ${formatNumber(EPS_RANGE.max)}.`
  }
  if (!Number.isInteger(minNumber) || minNumber < MIN_RANGE.min || minNumber > MIN_RANGE.max) {
    errors.min_samples = `Enter a whole number from ${MIN_RANGE.min} to ${MIN_RANGE.max}.`
  }
  return errors
}

function Stat({ label, value }) {
  return (
    <div className="min-w-0 bg-surface px-3 py-2.5 shadow-[inset_1px_0_0_0_var(--c-line)] first:shadow-none">
      <dt className="text-xs text-ink-3">{label}</dt>
      <CountUp as="dd" value={value} className="font-display text-xl font-extrabold leading-tight text-ink tabular" />
    </div>
  )
}

function ClusterItem({ cluster, selected, onSelect, itemRef, index }) {
  const level = getLevelMeta(cluster.severity_level) ?? getLevelMeta('medium')
  const worst = getLevelMeta(cluster.max_severity)
  const name = cluster.area_name || `Hotspot ${Number(cluster.cluster_id ?? 0) + 1}`
  return (
    <StaggerItem as="li" index={index} ref={itemRef}>
      <button
        type="button"
        aria-pressed={selected}
        onClick={() => onSelect?.(cluster)}
        className={cn(
          'flex w-full gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors focus-visible:outline-offset-1',
          selected
            ? 'border-marking-500 bg-marking-50/70 dark:bg-marking-500/10'
            : 'border-transparent hover:border-line hover:bg-surface-2',
        )}
      >
        <span
          aria-hidden
          className="grid size-9 shrink-0 place-items-center rounded-full font-display text-sm font-extrabold tabular"
          style={{ backgroundColor: level.color, color: readableInk(level.color) }}
        >
          {formatNumber(cluster.count)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate font-semibold text-ink">{name}</span>
            <SeverityBadge severity={cluster.severity_level} size="sm" />
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            <CategoryBadge category={cluster.dominant_category ?? cluster.dominant_category_name} size="sm" />
            {worst && worst.value !== level.value ? (
              <span className="text-[11px] font-medium text-ink-3">Peak {worst.label.toLowerCase()}</span>
            ) : null}
          </span>
          <span className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-ink-3">
            <span>
              <span className="font-semibold text-ink tabular">{formatNumber(cluster.open_count)}</span> open
            </span>
            <span>
              Severity{' '}
              <span className="font-semibold text-ink tabular">
                {/* One decimal, as the API sends it: the level is read from this value (50.9 is still medium,
                    while a rounded "51" would sit on the high threshold). */}
                {cluster.avg_severity_score == null ? '—' : formatNumber(cluster.avg_severity_score, { digits: 1 })}
              </span>
            </span>
            <span className="tabular">
              <span className="font-semibold text-ink">
                {cluster.density_per_km2 == null ? '—' : formatNumber(cluster.density_per_km2, { digits: 1 })}
              </span>
              /km²
            </span>
          </span>
          <span className="sr-only">
            {`${countLabel(cluster.count, 'complaint')}, ${level.label} severity, within ${formatDistance(cluster.radius_m)}. Select to zoom to it.`}
          </span>
        </span>
      </button>
    </StaggerItem>
  )
}

export function HotspotPanel({
  data,
  loading = false,
  error,
  onRetry,
  epsValue = '',
  minValue = '',
  onRun,
  onResetParams,
  fieldErrors = {},
  selectedId = null,
  onSelectCluster,
  onLocateAlert,
  onAcknowledge,
  className,
}) {
  const [tab, setTab] = useState('clusters')
  const [sort, setSort] = useState('count')
  const [draft, setDraft] = useState(null)
  const [errors, setErrors] = useState({})
  const itemRefs = useRef(new Map())

  const params = data?.params ?? {}
  const eps = draft?.eps ?? (epsValue || (params.eps_m != null ? String(params.eps_m) : ''))
  const min = draft?.min ?? (minValue || (params.min_samples != null ? String(params.min_samples) : ''))
  const clusters = Array.isArray(data?.clusters) ? data.clusters : []
  const sorter = SORTS.find((item) => item.value === sort) ?? SORTS[0]
  const sorted = [...clusters].sort((a, b) => sorter.read(b) - sorter.read(a))
  const alerts = Array.isArray(data?.alerts) ? data.alerts : []
  const activeAlerts = alerts.filter((alert) => !alert.is_acknowledged).length
  const customised = Boolean(epsValue || minValue)
  const shownErrors = { ...fieldErrors, ...errors }

  // Selecting a hotspot on the map brings its row into view.
  useEffect(() => {
    if (selectedId == null) return
    itemRefs.current.get(selectedId)?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  const submit = (event) => {
    event.preventDefault()
    const nextErrors = validate(eps, min)
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length) return
    setDraft(null)
    onRun?.({ eps_m: String(Number(eps)), min_samples: String(Number(min)) })
  }

  const resetParams = () => {
    setDraft(null)
    setErrors({})
    onResetParams?.()
  }

  return (
    <div className={cn('relative flex min-h-0 flex-col', className)}>
      {/* Statistics */}
      <div className="shrink-0 border-b border-line p-4">
        {loading && !data ? (
          <Skeleton className="h-14 w-full" />
        ) : (
          <>
            <dl className="grid grid-cols-3 overflow-hidden rounded-lg border border-line" aria-label="Clustering result">
              <Stat label="Points" value={Number(data?.total_points) || 0} />
              <Stat label="Hotspots" value={clusters.length} />
              <Stat label="Noise" value={data?.noise_ids?.length ?? 0} />
            </dl>
            <p className="mt-2 text-xs text-ink-3">
              {data?.window ? (
                <>
                  Complaints reported {formatDate(data.window.date_from)} to {formatDate(data.window.date_to)}.{' '}
                </>
              ) : null}
              Noise points have too few neighbours to form a hotspot.
              {data?.points_truncated ? (
                <span className="mt-1 block font-medium text-hazard-700 dark:text-hazard-300">
                  Showing the newest {formatNumber(data.total_points)} of {formatNumber(data.points_available)} complaints.
                </span>
              ) : null}
            </p>
          </>
        )}
      </div>

      {/* DBSCAN parameters: folded to a one-line summary unless they need attention. */}
      <details
        open={customised || (data && !clusters.length) || Object.keys(shownErrors).length > 0 || undefined}
        className="group shrink-0 border-b border-line"
      >
        <summary className="flex cursor-pointer select-none items-center justify-between gap-3 px-4 py-3 marker:content-none pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden">
          <span className="min-w-0">
            <span className="block font-display text-sm font-bold text-ink">DBSCAN clustering</span>
            <span className="block text-xs text-ink-3">
              Radius{' '}
              <span className="font-semibold text-ink-2 tabular">
                {params.eps_m != null ? `${formatNumber(params.eps_m)} m` : '—'}
              </span>
              , at least <span className="font-semibold text-ink-2 tabular">{params.min_samples ?? '—'}</span> complaints
              {customised ? ' (custom)' : ' (AI settings)'}
            </span>
          </span>
          <span className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-primary-ink">
            Adjust
            <ChevronDown aria-hidden className="size-4 transition-transform group-open:rotate-180" />
          </span>
        </summary>
        <form onSubmit={submit} noValidate className="px-4 pb-4" aria-label="Clustering parameters">
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Radius (eps)" htmlFor="hotspot-eps" error={shownErrors.eps_m}>
              <Input
                id="hotspot-eps"
                type="number"
                inputMode="numeric"
                min={EPS_RANGE.min}
                max={EPS_RANGE.max}
                step={50}
                value={eps}
                onChange={(event) => setDraft((current) => ({ eps: event.target.value, min: current?.min ?? min }))}
                rightSlot={<span className="pr-2 text-xs text-ink-3">m</span>}
              />
            </FormField>
            <FormField label="Min complaints" htmlFor="hotspot-min" error={shownErrors.min_samples}>
              <Input
                id="hotspot-min"
                type="number"
                inputMode="numeric"
                min={MIN_RANGE.min}
                max={MIN_RANGE.max}
                step={1}
                value={min}
                onChange={(event) => setDraft((current) => ({ eps: current?.eps ?? eps, min: event.target.value }))}
              />
            </FormField>
          </div>
          <p className="mt-2 text-xs text-ink-3">
            A hotspot is at least <span className="font-semibold text-ink-2 tabular">{min || '—'}</span> complaints, each within{' '}
            <span className="font-semibold text-ink-2 tabular">{eps ? `${formatNumber(Number(eps))} m` : '—'}</span> of a
            neighbour.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" leftIcon={ScanSearch} loading={loading && Boolean(data)}>
              Re-run clustering
            </Button>
            {customised ? (
              <Button type="button" variant="ghost" size="sm" leftIcon={RotateCcw} onClick={resetParams}>
                Use defaults
              </Button>
            ) : null}
          </div>
        </form>
      </details>

      {/* Clusters and alerts */}
      <Tabs
        idPrefix="hotspot-panel"
        label="Hotspot details"
        value={tab}
        onChange={setTab}
        className="shrink-0 px-3"
        tabs={[
          { id: 'clusters', label: 'Hotspots', count: clusters.length },
          { id: 'alerts', label: 'Alerts', count: activeAlerts },
        ]}
      />
      <div className="scrollbar-thin relative min-h-0 flex-1 overflow-y-auto">
        <TabPanel tabId="clusters" value={tab} idPrefix="hotspot-panel" className="p-3">
          {error && !data ? (
            <ErrorState compact bordered={false} error={error} onRetry={onRetry} title="Hotspots could not load" />
          ) : loading && !data ? (
            <div className="space-y-3 p-1">
              {[0, 1, 2, 3].map((index) => (
                <Skeleton key={index} className="h-20 w-full" />
              ))}
            </div>
          ) : clusters.length ? (
            <>
              <div className="mb-2 flex items-center justify-between gap-2 px-1">
                <label htmlFor="hotspot-sort" className="text-xs font-medium text-ink-3">
                  Sort hotspots
                </label>
                <Select
                  id="hotspot-sort"
                  size="sm"
                  value={sort}
                  onChange={(event) => setSort(event.target.value)}
                  options={SORTS.map(({ value, label }) => ({ value, label }))}
                  containerClassName="w-auto"
                />
              </div>
              <Stagger as="ul" className="space-y-1.5">
                {sorted.map((cluster, index) => (
                  <ClusterItem
                    key={cluster.cluster_id}
                    index={index}
                    cluster={cluster}
                    selected={cluster.cluster_id === selectedId}
                    onSelect={onSelectCluster}
                    itemRef={(element) => {
                      if (element) itemRefs.current.set(cluster.cluster_id, element)
                      else itemRefs.current.delete(cluster.cluster_id)
                    }}
                  />
                ))}
              </Stagger>
            </>
          ) : (
            <EmptyState
              compact
              bordered={false}
              icon={ScanSearch}
              title="No hotspots with these settings"
              description={
                data?.total_points
                  ? `None of the ${countLabel(data.total_points, 'complaint')} has enough neighbours. Try a larger radius or fewer minimum complaints.`
                  : 'There are no complaints for these filters. Widen the period or clear a filter.'
              }
            />
          )}
        </TabPanel>
        <TabPanel tabId="alerts" value={tab} idPrefix="hotspot-panel" className="p-4">
          <HotspotAlertList
            alerts={alerts}
            loading={loading && !data}
            onAcknowledge={onAcknowledge}
            onLocate={onLocateAlert}
            emptyHint="The dashboard's Run checks now scans again."
          />
        </TabPanel>
      </div>
    </div>
  )
}

export default HotspotPanel
