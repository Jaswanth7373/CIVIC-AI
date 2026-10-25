/**
 * CityPulseCard - the admin dashboard's "City pulse": where complaints concentrate right now, from the hotspot
 * clusters the dashboard already loads (GET /analytics/hotspots/ with the page's filters - no extra request).
 *
 * - 3D view (default): CityPulse3D - one column per DBSCAN hotspot on a stylised district, height = its number
 *   of complaints, colour = its severity level, the largest three named; next to it the same hotspots as a
 *   ranked list. Choosing a hotspot (a list row, or a column in the 3D view) opens the hotspot map focused on it.
 * - Map view: the same clusters as circles with count badges on the city map (CityPulseMap, loaded lazily only
 *   when the Map view is picked, so the dashboard does not download Leaflet for a view it does not show).
 * - Phones (below md): the ranked list comes first ("List", the default there) and the 3D view is one tap away in
 *   the same switch ("List / 3D / Map"). The list is plain HTML, so a phone does not download or run the 3D
 *   scene until the viewer asks for it.
 * - The caption is the API's own account of the result: how many hotspots, from how many complaints, reported
 *   in which period; the footer explains the encoding and the clustering rule that found them.
 * - The chosen view is remembered per viewer (localStorage, optional - the page works without it).
 * - While `scanning` ("Run checks now", which runs the hotspot scan) the AI scan band sweeps the card.
 *
 * Props: hotspots (useApi result: {data, loading, error, refetch}), categories (CategoryOut list for map
 * popups), params (dashboard filters, carried to the hotspot map links), scanning, quiet (the page shows one
 * error for all its requests: a failed load is a quiet placeholder here, without its own retry), className.
 */
import { ArrowUpRight, Box, ChevronRight, ListOrdered, Map as MapIcon, MapPinOff } from 'lucide-react'
import { Suspense, lazy, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CityPulse3D } from '@/components/three'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardFooter, CardHeader } from '@/components/ui/Card'
import { ErrorState } from '@/components/ui/ErrorState'
import { Skeleton } from '@/components/ui/Skeleton'
import { BREAKPOINTS, useMediaQuery } from '@/hooks/useMediaQuery'
import { cn } from '@/utils/cn'
import { LEVEL_META, LEVEL_ORDER } from '@/utils/constants'
import { formatDate, formatNumber } from '@/utils/format'
import { countLabel, withFilters } from './insightUtils'
import { PanelUnavailable } from './PanelUnavailable'
import { SegmentedControl } from './SegmentedControl'
import '@/styles/admin.css'

const VIEW_KEY = 'civicai.admin.pulseView'
const CityPulseMap = lazy(() => import('./CityPulseMap'))
const MAP_SKELETON = <Skeleton className="h-[380px] w-full rounded-xl" />

/*
 * Framing of CityPulse3D on this card (through its className; descendant selectors on its markup, so they
 * simply stop applying if that markup changes): tablets (md to lg) stack the scene over the list - side by side
 * the scene would be shorter than its own list - and very wide screens give the scene a wider 2:1 frame.
 */
const PULSE_FRAMING = 'md:max-lg:[&>div]:grid-cols-1 min-[1700px]:[&_figure>div]:aspect-[2/1]'
const VIEWS = [
  { value: 'pulse', label: '3D', title: 'Hotspots as 3D columns' },
  { value: 'map', label: 'Map', title: 'Hotspots on the city map' },
]
/** Phones: the ranked list first, then the same 3D and map views. */
const PHONE_VIEWS = [{ value: 'list', label: 'List', title: 'Hotspots as a ranked list' }, ...VIEWS]
const VIEW_ICONS = { list: ListOrdered, pulse: Box, map: MapIcon }
const numberFormat = new Intl.NumberFormat('en-IN')

function readView() {
  try {
    return window.localStorage.getItem(VIEW_KEY) === 'map' ? 'map' : 'pulse'
  } catch {
    return 'pulse'
  }
}

function storeView(view) {
  try {
    window.localStorage.setItem(VIEW_KEY, view)
  } catch {
    // Private windows and blocked storage: the choice simply is not remembered.
  }
}

/** "8 hotspots from 96 complaints reported 21 Jul 2026 to 18 Oct 2026" - straight from the response. */
function caption(data, clusters) {
  if (!data) return 'Where complaints concentrate'
  const found = `${countLabel(clusters.length, 'hotspot')} from ${countLabel(data.total_points, 'complaint')}`
  const period = data.window
  if (period?.date_from && period?.date_to) return `${found} reported ${formatDate(period.date_from)} to ${formatDate(period.date_to)}`
  if (period?.days) return `${found} reported in the last ${countLabel(period.days, 'day')}`
  return found
}

/**
 * The hotspots largest first, with the same rules as the 3D list: a real position and a positive count; named by
 * the area, else the main category.
 */
function rankHotspots(clusters) {
  return clusters
    .filter(
      (cluster) =>
        Number.isFinite(Number(cluster?.latitude)) && Number.isFinite(Number(cluster?.longitude)) && Number(cluster?.count) > 0,
    )
    .sort((a, b) => Number(b.count) - Number(a.count))
    .map((cluster) => {
      const level = LEVEL_META[cluster.severity_level] ? cluster.severity_level : null
      const area = typeof cluster.area_name === 'string' ? cluster.area_name.trim() : ''
      return {
        key: String(cluster.cluster_id ?? `${cluster.latitude},${cluster.longitude}`),
        cluster,
        count: Number(cluster.count),
        level,
        color: level ? LEVEL_META[level].color : '#8C9A96',
        label: area || cluster.dominant_category_name || 'Hotspot',
      }
    })
}

/** Phone list view: one row (at least 48 px) per hotspot that opens the hotspot map focused on it. */
function HotspotRanking({ clusters, loading, onSelect }) {
  const items = useMemo(() => rankHotspots(clusters), [clusters])
  if (loading) {
    return (
      <div aria-busy="true" className="grid gap-1">
        {[0, 1, 2, 3, 4].map((key) => (
          <Skeleton key={key} className="h-12 w-full rounded-lg" />
        ))}
        <span className="sr-only">Loading hotspots</span>
      </div>
    )
  }
  if (!items.length) {
    return (
      <p className="flex items-start gap-2 rounded-xl border border-dashed border-line-strong px-4 py-6 text-sm text-ink-2">
        <MapPinOff aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-3" />
        <span>
          <span className="block font-semibold text-ink">No hotspots for these filters</span>
          When several complaints are reported close together, they appear here. Widen the date range or clear a filter.
        </span>
      </p>
    )
  }
  return (
    <ol aria-label="Hotspots, largest first" className="grid min-w-0 gap-1">
      {items.map((item, index) => {
        const meta = item.level ? LEVEL_META[item.level] : null
        return (
          <li key={item.key} className="min-w-0">
            <button
              type="button"
              onClick={() => onSelect(item.cluster)}
              className="flex min-h-12 w-full min-w-0 items-center gap-3 rounded-lg px-2.5 py-1.5 text-left transition-colors duration-150 hover:bg-surface-2 active:bg-surface-2"
            >
              <span aria-hidden className="w-5 shrink-0 text-right text-xs font-bold text-ink-3 tabular">
                {index + 1}
              </span>
              <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: item.color }} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-ink">{item.label}</span>
                <span className="block text-xs text-ink-2 tabular">
                  {numberFormat.format(item.count)} {item.count === 1 ? 'complaint' : 'complaints'}
                </span>
              </span>
              {meta ? (
                <Badge tone={meta.tone} size="sm" icon={meta.icon}>
                  <span className="sr-only">Severity: </span>
                  {meta.label}
                </Badge>
              ) : null}
              <ChevronRight aria-hidden className="size-4 shrink-0 text-ink-3" />
            </button>
          </li>
        )
      })}
    </ol>
  )
}

function SeverityKey() {
  return (
    <ul aria-label="Column colour: hotspot severity" className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {LEVEL_ORDER.map((level) => (
        <li key={level} className="inline-flex items-center gap-1.5">
          <span aria-hidden className="size-2.5 rounded-[3px]" style={{ backgroundColor: LEVEL_META[level].color }} />
          {LEVEL_META[level].label}
        </li>
      ))}
    </ul>
  )
}

export function CityPulseCard({ hotspots, categories, params, scanning = false, quiet = false, className }) {
  const navigate = useNavigate()
  const wide = useMediaQuery(BREAKPOINTS.md)
  const [view, setView] = useState(readView)
  // Phones open on the list unless the viewer chose the map; picking 3D there is a deliberate tap.
  const [phoneView, setPhoneView] = useState(() => (readView() === 'map' ? 'map' : 'list'))
  const shown = wide ? view : phoneView
  const data = hotspots?.data
  const clusters = Array.isArray(data?.clusters) ? data.clusters : []
  const loadingFirst = Boolean(hotspots?.loading) && !data
  const failed = Boolean(hotspots?.error) && !data
  const rule = data?.params

  const chooseView = (next) => {
    if (!wide) setPhoneView(next)
    if (next === 'list') return
    setView(next)
    storeView(next)
  }

  const openCluster = (cluster) => {
    const lat = Number(cluster?.latitude)
    const lng = Number(cluster?.longitude)
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return
    navigate(withFilters('/admin/hotspots', params, { focus: `${lat},${lng}`, r: Math.round(Number(cluster.radius_m) || 0) }))
  }

  return (
    <Card className={cn('relative flex min-w-0 flex-col', className)} aria-busy={hotspots?.loading || undefined}>
      <CardHeader
        title="City pulse"
        description={caption(data, clusters)}
        actions={
          <>
            <SegmentedControl
              label="Hotspot view"
              options={(wide ? VIEWS : PHONE_VIEWS).map((item) => {
                const Icon = VIEW_ICONS[item.value]
                return {
                  ...item,
                  label: (
                    <span className="inline-flex items-center gap-1">
                      <Icon aria-hidden className="size-3.5" />
                      {item.label}
                    </span>
                  ),
                }
              })}
              value={shown}
              onChange={chooseView}
            />
            <Button variant="link" size="sm" to={withFilters('/admin/hotspots', params)} rightIcon={ArrowUpRight}>
              Hotspot map
            </Button>
          </>
        }
      />

      <div className="relative min-w-0 flex-1">
        <CardBody>
          {failed && quiet ? (
            <PanelUnavailable minHeight={240} />
          ) : failed ? (
            <ErrorState compact bordered={false} error={hotspots.error} onRetry={hotspots.refetch} title="Hotspots could not load" />
          ) : shown === 'list' ? (
            <HotspotRanking clusters={clusters} loading={loadingFirst} onSelect={openCluster} />
          ) : shown === 'pulse' ? (
            <CityPulse3D
              className={PULSE_FRAMING}
              clusters={clusters}
              loading={loadingFirst}
              onSelect={openCluster}
              emptyTitle="No hotspots for these filters"
              emptyDescription="When several complaints are reported close together, they rise here as a column. Widen the date range or clear a filter."
            />
          ) : loadingFirst ? (
            MAP_SKELETON
          ) : (
            <Suspense fallback={MAP_SKELETON}>
              <CityPulseMap clusters={clusters} categories={categories} />
            </Suspense>
          )}
        </CardBody>
        {scanning ? <span aria-hidden className="ops-scan" data-scan="loop" /> : null}
      </div>

      {clusters.length && !failed ? (
        <CardFooter className="justify-between gap-x-6 gap-y-2 text-xs text-ink-2">
          {shown === 'list' ? (
            <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
              Colour: severity
              <SeverityKey />
            </span>
          ) : shown === 'pulse' ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span>Height: complaints in the hotspot.</span>
              <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
                Colour: severity
                <SeverityKey />
              </span>
            </div>
          ) : (
            <span>Circles cover each hotspot; the badge counts its complaints.</span>
          )}
          {rule?.eps_m != null && rule?.min_samples != null ? (
            <span className="text-ink-3">
              Hotspot: at least <span className="font-semibold text-ink-2 tabular">{formatNumber(rule.min_samples)}</span> complaints,
              each within <span className="font-semibold text-ink-2 tabular">{formatNumber(rule.eps_m)} m</span> of a neighbour (DBSCAN)
            </span>
          ) : null}
        </CardFooter>
      ) : null}
    </Card>
  )
}

export default CityPulseCard
