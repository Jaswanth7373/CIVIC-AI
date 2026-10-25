/**
 * Hotspot map (/admin/hotspots) - where complaints concentrate, found with DBSCAN.
 *
 * - GET /analytics/hotspots/ (filters + `days` + `eps_m` / `min_samples`): the clusters (circles coloured by
 *   severity), every analysed point with its cluster label, the statistics and the latest alerts.
 * - GET /complaints/map/ for the same window and filters: adds title, priority, photo and area to the points,
 *   so the pins carry priority badges and their popups are complete.
 * Filters, the period and the DBSCAN parameters live in the URL; `?focus=lat,lng&r=metres` (from the
 * dashboard's alerts) flies to a place on load. On lg+ the map fills the viewport next to the panel; on phones
 * the panel opens as a bottom drawer.
 *
 * Layers: the map opens with the hotspot circles only - their count badges are the subject of the page, and
 * the complaint pins' own "grouped nearby" bubbles carry counts too, so showing both by default put two
 * different numbers on the same spot. "Complaint pins" (grouped by default) adds the individual complaints;
 * the hotspot badges then stay on top of the pins so every hotspot can still be read and clicked.
 *
 * Motion: the first hotspot badges rise onto the map largest first (HotspotLayer), the panel's statistics
 * count up and its list rises in; while DBSCAN re-runs, the AI scan band sweeps the map. Reduced motion: none.
 */
import { ListTree } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ComplaintMap, HotspotLayer, MapLegend } from '@/components/maps'
import { Button } from '@/components/ui/Button'
import { Drawer } from '@/components/ui/Drawer'
import { PageHeader } from '@/components/ui/PageHeader'
import { useApi } from '@/hooks/useApi'
import { BREAKPOINTS, useMediaQuery } from '@/hooks/useMediaQuery'
import { useTheme } from '@/hooks/useTheme'
import { useToast } from '@/hooks/useToast'
import { analyticsService } from '@/services/analyticsService'
import { complaintService } from '@/services/complaintService'
import { cn } from '@/utils/cn'
import { LEVEL_META, LEVEL_ORDER } from '@/utils/constants'
import { getErrorMessage, getFieldErrors } from '@/utils/errors'
import { formatNumber } from '@/utils/format'
import { HotspotPanel } from './insights/HotspotPanel'
import { LayerControl, MapFocus, SelectionRing } from './insights/HotspotMapLayers'
import { InsightFilterBar } from './insights/InsightFilterBar'
import { HOTSPOT_RANGE_PRESETS, countLabel, filterValidationError } from './insights/insightUtils'
import { InvalidFiltersAlert } from './insights/InvalidFiltersAlert'
import { useInsightFilters, useReferenceData } from './insights/useInsightFilters'
import '@/styles/admin.css'

const FILTER_KEYS = ['date_from', 'date_to', 'department', 'category', 'severity', 'status']

/** "17.4387,78.4990" -> {lat, lng} or null. */
function parseFocus(value) {
  const [lat, lng] = String(value ?? '')
    .split(',')
    .map((part) => Number.parseFloat(part))
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null
}

export default function HotspotMap() {
  const toast = useToast()
  const { isDark } = useTheme()
  const desktop = useMediaQuery(BREAKPOINTS.lg)
  const [searchParams, setSearchParams] = useSearchParams()
  const { filters, params, setFilters, reset, activeCount } = useInsightFilters({ keys: FILTER_KEYS })
  const { departments, categories } = useReferenceData()

  const epsValue = searchParams.get('eps_m') ?? ''
  const minValue = searchParams.get('min_samples') ?? ''
  const urlFocus = useMemo(() => parseFocus(searchParams.get('focus')), [searchParams])
  const focusRadius = Number(searchParams.get('r')) || 0

  const [showPoints, setShowPoints] = useState(false)
  const [grouped, setGrouped] = useState(true)
  const [showHotspots, setShowHotspots] = useState(true)
  const [selectedId, setSelectedId] = useState(null)
  const [target, setTarget] = useState(null)
  const [ring, setRing] = useState(null)
  const [panelOpen, setPanelOpen] = useState(false)

  const apiParams = useMemo(
    () => ({ ...params, eps_m: epsValue || undefined, min_samples: minValue || undefined }),
    [params, epsValue, minValue],
  )
  const hotspots = useApi(() => analyticsService.hotspots(apiParams), [apiParams])
  const data = hotspots.data
  const windowRange = data?.window

  // Title, priority, photo and area for the analysed points (same filters, same window).
  const detailParams = useMemo(() => {
    if (!windowRange) return null
    const { date_from: _from, date_to: _to, ...rest } = params
    return { ...rest, date_from: windowRange.date_from, date_to: windowRange.date_to }
  }, [params, windowRange])
  const details = useApi(() => (detailParams ? complaintService.map(detailParams) : Promise.resolve(null)), [detailParams])

  const points = useMemo(() => {
    const base = Array.isArray(data?.points) ? data.points : []
    const byId = new Map((Array.isArray(details.data) ? details.data : []).map((row) => [row.id, row]))
    return base.map((point) => ({ ...byId.get(point.id), ...point }))
  }, [data, details.data])
  const clusters = useMemo(() => (Array.isArray(data?.clusters) ? data.clusters : []), [data])
  // Drawn smallest first, so where two badges overlap (neighbouring hotspots at a low zoom) the bigger hotspot's
  // count stays on top and readable.
  const layerClusters = useMemo(() => [...clusters].sort((a, b) => (Number(a.count) || 0) - (Number(b.count) || 0)), [clusters])
  const legendCategories = useMemo(() => {
    const seen = new Map()
    points.forEach((point) => {
      const category = point.category
      if (category?.slug && !seen.has(category.slug)) seen.set(category.slug, category)
    })
    return [...seen.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)))
  }, [points])

  // One legend for everything on the map: category pins, grouped pins and hotspot circles by severity.
  // Hotspot severities first (the subject of the page), then grouped pins, then the category pins.
  const legendItems = [
    ...(showHotspots
      ? LEVEL_ORDER.map((level) => ({
          key: `level-${level}`,
          label: `${LEVEL_META[level].label} severity hotspot`,
          color: LEVEL_META[level].color,
          shape: 'circle',
        }))
      : []),
    ...(showPoints && grouped
      ? [{ key: 'group', label: 'Nearby complaints, grouped', color: isDark ? '#8c9a96' : '#172022', shape: 'dot' }]
      : []),
    ...(showPoints ? [{ key: 'critical', label: 'Critical priority', shape: 'critical' }] : []),
    ...(showPoints
      ? legendCategories.map((category) => ({
          key: `category-${category.slug}`,
          label: category.name,
          color: category.color,
          shape: 'pin',
        }))
      : []),
  ]

  // A new clustering result clears the selection; the URL focus is applied once, on the first result.
  const [resultKey, setResultKey] = useState(null)
  const [focusApplied, setFocusApplied] = useState(false)
  const currentKey = data ? JSON.stringify(apiParams) : null
  if (currentKey && currentKey !== resultKey) {
    setResultKey(currentKey)
    setSelectedId(null)
    setRing(null)
    if (urlFocus && !focusApplied) {
      setFocusApplied(true)
      setTarget({ lat: urlFocus.lat, lng: urlFocus.lng, zoom: 15 })
      setRing({ center: [urlFocus.lat, urlFocus.lng], radius: focusRadius })
    }
  }

  const selectCluster = (cluster, { fly = true } = {}) => {
    setSelectedId(cluster.cluster_id)
    setRing({ center: [cluster.latitude, cluster.longitude], radius: cluster.radius_m })
    if (fly) setTarget({ bounds: cluster.bounds, lat: cluster.latitude, lng: cluster.longitude })
    if (!desktop) setPanelOpen(false)
  }

  const locateAlert = (alert) => {
    setSelectedId(null)
    setRing({ center: [alert.latitude, alert.longitude], radius: alert.radius_m })
    setTarget({ lat: alert.latitude, lng: alert.longitude, zoom: 15 })
    if (!desktop) setPanelOpen(false)
  }

  const runClustering = ({ eps_m: eps, min_samples: min }) => {
    if (eps === epsValue && min === minValue) {
      hotspots.refetch()
      return
    }
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current)
        next.set('eps_m', eps)
        next.set('min_samples', min)
        return next
      },
      { replace: true },
    )
  }

  const resetClustering = () =>
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current)
        next.delete('eps_m')
        next.delete('min_samples')
        return next
      },
      { replace: true },
    )

  const acknowledge = async (alert, value) => {
    try {
      const updated = await analyticsService.acknowledgeAlert(alert.id, value)
      hotspots.setData((current) =>
        current
          ? { ...current, alerts: (current.alerts ?? []).map((item) => (item.id === updated.id ? updated : item)) }
          : current,
      )
      toast.success(
        value ? 'Alert acknowledged' : 'Alert reopened',
        `${updated.area_name || 'Hotspot'}: ${countLabel(updated.complaint_count, 'complaint')}`,
      )
    } catch (error) {
      toast.error(value ? 'Could not acknowledge alert' : 'Could not reopen alert', getErrorMessage(error))
      throw error
    }
  }

  const fieldErrors = getFieldErrors(hotspots.error)
  const invalidFilters = filterValidationError([hotspots.error])
  const panel = (
    <HotspotPanel
      data={data}
      loading={hotspots.loading}
      error={hotspots.error}
      onRetry={hotspots.refetch}
      epsValue={epsValue}
      minValue={minValue}
      onRun={runClustering}
      onResetParams={resetClustering}
      fieldErrors={fieldErrors}
      selectedId={selectedId}
      onSelectCluster={selectCluster}
      onLocateAlert={locateAlert}
      onAcknowledge={acknowledge}
      className="h-full"
    />
  )

  const summary = data
    ? `${countLabel(data.total_points, 'point')}, ${countLabel(clusters.length, 'hotspot')}, ${formatNumber(data.noise_ids?.length ?? 0)} noise`
    : null

  return (
    <div className="flex min-w-0 flex-col lg:h-[calc(100dvh-7rem)]">
      <PageHeader
        className="mb-4 shrink-0"
        title="Hotspot map"
        description="DBSCAN groups complaints that pile up close together, so crews can be sent where issues concentrate."
      />

      <InsightFilterBar
        filters={filters}
        onChange={setFilters}
        onReset={reset}
        activeCount={activeCount}
        departments={departments}
        categories={categories}
        show={['date', 'category', 'severity', 'department', 'status']}
        presets={HOTSPOT_RANGE_PRESETS}
        className="mb-3 shrink-0"
      />

      {invalidFilters ? (
        <InvalidFiltersAlert error={invalidFilters} onReset={reset} className="mb-3 shrink-0" />
      ) : hotspots.error && !data && !fieldErrors.eps_m && !fieldErrors.min_samples ? (
        <p
          role="alert"
          className="mb-3 shrink-0 rounded-lg border border-signal-200 bg-signal-50 px-3 py-2 text-sm text-signal-700 dark:border-signal-500/30 dark:bg-signal-500/10 dark:text-signal-300"
        >
          {getErrorMessage(hotspots.error)}
        </p>
      ) : null}

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_23rem] lg:grid-rows-[minmax(0,1fr)]">
        <div className="relative min-w-0 lg:h-full lg:min-h-0">
          <ComplaintMap
            points={points}
            pending={hotspots.loading && !data}
            cluster={grouped}
            basePath="/admin/complaints"
            legend={false}
            height={null}
            emptyMessage={
              hotspots.loading ? 'Loading complaints' : 'No complaints for these filters. Widen the period or clear a filter.'
            }
            className={cn(
              'h-[62dvh] min-h-[22rem] lg:h-full lg:min-h-0',
              // Both rules override Leaflet, hence `!`: leaflet.css (unlayered) sets the markers' display and
              // Leaflet stacks them by latitude with an inline z-index, which let pins and grouped bubbles
              // cover the hotspot badges. The badges - the page's subject - always stay on top.
              '[&_.civic-map-hotspot]:z-[100000]!',
              !showPoints && '[&_.civic-map-cluster]:hidden! [&_.civic-map-pin]:hidden!',
            )}
          >
            {showHotspots ? (
              <HotspotLayer
                clusters={layerClusters}
                categories={categories}
                onSelect={(cluster) => selectCluster(cluster, { fly: false })}
              />
            ) : null}
            {ring ? <SelectionRing center={ring.center} radius={ring.radius} /> : null}
            <MapFocus target={target} />
            <LayerControl
              showPoints={showPoints}
              onShowPoints={setShowPoints}
              grouped={grouped}
              onGrouped={setGrouped}
              showHotspots={showHotspots}
              onShowHotspots={setShowHotspots}
            />
            {legendItems.length ? <MapLegend items={legendItems} position="bottomleft" /> : null}
          </ComplaintMap>
          {hotspots.loading && data ? (
            <>
              <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-[600] h-1 overflow-hidden rounded-t-xl">
                <div className="lane-line-x animate-lane h-full w-full" />
              </div>
              {/* DBSCAN is re-running: the AI scan sweeps the map until the new clusters arrive. */}
              <div aria-hidden className="pointer-events-none absolute inset-0 z-[600] overflow-hidden rounded-xl">
                <span className="ops-scan" data-scan="loop" />
              </div>
            </>
          ) : null}
        </div>

        {desktop ? (
          <aside
            aria-label="Hotspots"
            className="relative flex min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-surface"
          >
            {panel}
          </aside>
        ) : (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface px-4 py-3">
            <p className="min-w-0 text-sm text-ink-2" aria-live="polite">
              {summary ?? 'Clustering complaints'}
            </p>
            <Button variant="outline" size="sm" leftIcon={ListTree} onClick={() => setPanelOpen(true)}>
              Hotspots
            </Button>
          </div>
        )}
      </div>

      {!desktop ? (
        <Drawer
          open={panelOpen}
          onClose={() => setPanelOpen(false)}
          side="bottom"
          title="Hotspots"
          description={summary ?? undefined}
          bodyClassName="p-0"
          className="h-[85dvh]"
        >
          {panel}
        </Drawer>
      ) : null}
    </div>
  )
}
