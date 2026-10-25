/**
 * ComplaintMap - complaints as clustered, category-coloured pins with a popup per complaint.
 *
 * Props:
 * - points: GET /complaints/map/ rows `[{id, complaint_number, title, latitude, longitude, category,
 *   severity, priority_level, priority_score, status, status_display, created_at, thumbnail, area}]`
 *   (analytics hotspot `points` work too - missing fields are simply not shown)
 * - cluster: cluster nearby pins (default true; leaflet.markercluster)
 * - onSelect(point): a pin was clicked / activated with the keyboard
 * - selectedId: highlight a pin from outside (e.g. a hovered list row); with `focusSelected` the map zooms to it
 * - basePath: e.g. "/admin/complaints" -> the popup links to `${basePath}/${id}`
 * - popup: show the popup for the clicked pin (default true)
 * - legend: category legend in the bottom-left corner (default true; built from the categories present)
 * - fitToPoints: fit the view to the points whenever their extent changes (default true). The map is also created
 *   at those bounds (same padding and zoom limit as the later fits), so it never opens at the city default and
 *   then re-zooms, which would throw away the first wave of tiles.
 * - pending: the first load is still running - a placeholder of the same size is shown and the map is created
 *   only once the points are known
 * - height, center, zoom, scrollWheelZoom, className: passed to BaseMap
 * - emptyMessage: shown over the map when there are no points
 * - children: extra layers, e.g. <HotspotLayer clusters={...} />
 */
import { MapPinOff } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { Popup } from 'react-leaflet'
import { Link } from 'react-router-dom'
import { CategoryBadge } from '@/components/complaints/CategoryBadge'
import { PriorityBadge } from '@/components/complaints/PriorityBadge'
import { StatusBadge } from '@/components/complaints/StatusBadge'
import { cn } from '@/utils/cn'
import { formatDateTime, timeAgo } from '@/utils/format'
import { BaseMap } from './BaseMap'
import { ClusterLayer } from './ClusterLayer'
import { FitBounds } from './FitBounds'
import { L, toLatLng } from './leaflet'
import { MapLegend } from './MapLegend'

function PointPopup({ point, basePath, onClose }) {
  const lat = Number(point.latitude)
  const lng = Number(point.longitude)
  const position = useMemo(() => [lat, lng], [lat, lng])
  const pointId = point.id
  const eventHandlers = useMemo(() => ({ remove: () => onClose(pointId) }), [onClose, pointId])
  const href = basePath && point.id != null ? `${basePath.replace(/\/+$/, '')}/${point.id}` : null

  return (
    <Popup position={position} offset={[0, -30]} eventHandlers={eventHandlers} minWidth={220} maxWidth={280} autoPanPadding={[24, 24]}>
      <div className="space-y-1.5 font-sans text-ink">
        {point.thumbnail ? (
          <img src={point.thumbnail} alt="" loading="lazy" className="mb-1 h-24 w-full rounded-md bg-sunken object-cover" />
        ) : null}
        <p className="m-0! text-xs font-semibold text-ink-3 tabular">{point.complaint_number}</p>
        {point.title ? <p className="m-0! text-sm font-semibold leading-snug text-ink">{point.title}</p> : null}
        <div className="flex flex-wrap items-center gap-1">
          {point.status ? <StatusBadge status={point.status} label={point.status_display} size="sm" /> : null}
          {point.priority_level || point.priority_score != null ? (
            <PriorityBadge level={point.priority_level} score={point.priority_score} size="sm" />
          ) : null}
        </div>
        <CategoryBadge category={point.category} size="sm" />
        {point.area || point.created_at ? (
          <p className="m-0! text-xs text-ink-3">
            {point.area}
            {point.area && point.created_at ? ', ' : ''}
            {point.created_at ? (
              <time dateTime={point.created_at} title={formatDateTime(point.created_at)}>
                reported {timeAgo(point.created_at)}
              </time>
            ) : null}
          </p>
        ) : null}
        {href ? (
          <Link to={href} className="inline-block pt-0.5 text-sm font-semibold text-primary-ink hover:underline">
            Open complaint
          </Link>
        ) : null}
      </div>
    </Popup>
  )
}

export function ComplaintMap({
  points = [],
  cluster = true,
  onSelect,
  selectedId,
  focusSelected = false,
  basePath,
  popup = true,
  legend = true,
  fitToPoints = true,
  pending = false,
  height = 420,
  center,
  zoom,
  scrollWheelZoom,
  emptyMessage = 'No complaints to show on the map for these filters.',
  className,
  children,
}) {
  const [active, setActive] = useState(null)
  const valid = useMemo(() => (Array.isArray(points) ? points.filter((point) => toLatLng(point)) : []), [points])

  const handleSelect = useCallback(
    (point) => {
      setActive(point)
      onSelect?.(point)
    },
    [onSelect],
  )
  // The popup that closes only clears the selection if it is still the selected one (opening a new popup
  // closes the previous one, and that must not cancel the new selection).
  const closePopup = useCallback((id) => setActive((current) => (current?.id === id ? null : current)), [])
  const activePoint = active && valid.some((point) => point.id === active.id) ? active : null

  const categories = useMemo(() => {
    const seen = new Map()
    valid.forEach((point) => {
      const category = point.category
      const key = category?.slug ?? category?.id
      if (category && key != null && !seen.has(key)) seen.set(key, category)
    })
    return [...seen.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)))
  }, [valid])

  // Initial view = what FitBounds would fit (padding 40, max zoom 16; one point at zoom 15). Read once by BaseMap.
  const initialBounds = useMemo(() => {
    if (!fitToPoints || center || !valid.length) return null
    return L.latLngBounds(valid.map(toLatLng))
  }, [fitToPoints, center, valid])
  const boundsOptions = valid.length === 1 ? { maxZoom: 15 } : { padding: [40, 40], maxZoom: 16 }

  if (pending) {
    return (
      <div
        aria-busy="true"
        className={cn('relative grid min-w-0 place-items-center overflow-hidden rounded-xl border border-line bg-sunken p-4', className)}
        style={height == null ? undefined : { height }}
      >
        <p className="flex items-center gap-2 rounded-lg border border-line bg-surface/95 px-3 py-2 text-sm font-medium text-ink-2 shadow-[var(--shadow-overlay)]">
          <MapPinOff aria-hidden className="size-4 text-ink-3" />
          {emptyMessage}
        </p>
      </div>
    )
  }

  return (
    <BaseMap
      height={height}
      center={center}
      zoom={zoom}
      bounds={initialBounds ?? undefined}
      boundsOptions={initialBounds ? boundsOptions : undefined}
      scrollWheelZoom={scrollWheelZoom}
      className={className}
      label="Complaints map"
      overlay={
        valid.length ? null : (
          <p className="flex items-center gap-2 rounded-lg border border-line bg-surface/95 px-3 py-2 text-sm font-medium text-ink-2 shadow-[var(--shadow-overlay)]">
            <MapPinOff aria-hidden className="size-4 text-ink-3" />
            {emptyMessage}
          </p>
        )
      }
    >
      <ClusterLayer
        points={valid}
        cluster={cluster}
        onSelect={handleSelect}
        selectedId={selectedId ?? activePoint?.id ?? null}
        focusSelected={focusSelected}
      />
      {fitToPoints ? <FitBounds points={valid} /> : null}
      {popup && activePoint ? (
        <PointPopup key={activePoint.id} point={activePoint} basePath={basePath} onClose={closePopup} />
      ) : null}
      {legend && categories.length ? <MapLegend categories={categories} position="bottomleft" /> : null}
      {children}
    </BaseMap>
  )
}

export default ComplaintMap
