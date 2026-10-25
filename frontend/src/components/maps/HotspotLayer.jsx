/**
 * HotspotLayer - DBSCAN complaint clusters as circles on a map (render inside BaseMap / ComplaintMap).
 *
 * Props:
 * - clusters: GET /analytics/hotspots/ `clusters` `[{cluster_id, latitude, longitude, count, radius_m,
 *   dominant_category: CategoryMini|null, dominant_category_name, category_breakdown: {slug: n},
 *   avg_severity_score, max_severity, severity_level, avg_priority_score, open_count, area_name,
 *   density_per_km2, ...}]`
 * - categories: optional CategoryMini list to name the slugs of `category_breakdown`
 * - onSelect(cluster): a hotspot circle or its count badge was clicked
 * - minRadius: smallest circle radius in metres (default 80) so tiny clusters stay visible
 * - showCounts: count badge at each centre (default true; keyboard-focusable, opens the same popup)
 *
 * How hotspots are found (ai/geospatial/hotspots.py): DBSCAN with the haversine metric on coordinates in
 * radians, eps = eps_m / 6 371 000 m and `min_samples` neighbours; complaints with too few neighbours are
 * noise. Each circle is centred on the cluster centroid with the distance to its farthest member as radius,
 * coloured by the cluster's severity level (LEVEL_META), and its popup lists the cluster statistics.
 *
 * Two hotspots a few hundred metres apart are only a few pixels apart when zoomed out, so their count badges
 * would cover each other. At every zoom level the badges that would touch are pushed apart (badgeOffsets);
 * the circles always stay on the true centroids.
 *
 * Entrance: the first clusters to arrive rise onto the map, largest first (hotspotCountIcon `enterDelay`).
 * A badge's icon only changes when its position does: a zoom during the entrance (FitBounds right after the
 * data arrives) continues the animation where it was (a negative delay), a zoom after it settles the badge
 * for good - so Leaflet never swaps a badge's element just to end an animation (a swap would drop the
 * keyboard focus of a badge). No entrance with reduced motion.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { Circle, Marker, Popup, useMap } from 'react-leaflet'
import { CategoryBadge } from '@/components/complaints/CategoryBadge'
import { usePrefersReducedMotion } from '@/components/motion/hooks'
import { STAGGER } from '@/components/motion/tokens'
import { getLevelMeta } from '@/utils/constants'
import { formatDistance, formatNumber } from '@/utils/format'
import { isValidLatLng } from './leaflet'
import { hotspotBadgeSize, hotspotCountIcon } from './mapIcons'
import '@/styles/admin.css'

/**
 * Count badges share Leaflet's marker pane with the complaint pins and cluster badges, where markers stack by
 * their screen position (lower on screen = on top). This offset keeps every hotspot badge above the pins that
 * overlap it (they are at most a few dozen pixels apart, hovered pins rise by 250), so the badge stays
 * clickable; the selected complaint pin (+1000) and spiderfied pins still come out on top.
 */
const BADGE_Z_OFFSET = 500

/** Free pixels kept between the count badges of two nearby hotspots. */
const BADGE_GAP = 4
const NO_OFFSET = [0, 0]
/** Entrance of the first badges: a short pause for the tiles, then one badge per stagger step, largest first. */
const ENTER_BASE_MS = 160
const ENTER_STEP_MS = Math.round(STAGGER.step * 1000)
/** Length of the badge entrance (styles/admin.css `civic-hotspot-in`). */
const ENTER_MS = 560

/**
 * Pixel offsets ([dx, dy] per cluster) that keep the count badges from overlapping at `zoom`. Each badge
 * starts on its hotspot centre; every pair that overlaps is pushed apart along the line between them
 * (sideways when they coincide), the hotspot with fewer complaints moving more, until no pair touches. The
 * positions are absolute pixels at that zoom, so panning needs no recalculation.
 */
function badgeOffsets(map, clusters, zoom) {
  if (clusters.length < 2 || !Number.isFinite(zoom)) return clusters.map(() => NO_OFFSET)
  const points = clusters.map((cluster) => map.project([Number(cluster.latitude), Number(cluster.longitude)], zoom))
  const radii = clusters.map((cluster) => hotspotBadgeSize(cluster.count) / 2)
  const weights = clusters.map((cluster) => Math.max(1, Number(cluster.count) || 0))
  const offsets = clusters.map(() => [0, 0])
  for (let pass = 0; pass < 60; pass += 1) {
    let moved = false
    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        let dx = points[j].x + offsets[j][0] - (points[i].x + offsets[i][0])
        let dy = points[j].y + offsets[j][1] - (points[i].y + offsets[i][1])
        let distance = Math.hypot(dx, dy)
        const needed = radii[i] + radii[j] + BADGE_GAP
        if (distance >= needed - 0.01) continue
        if (distance < 0.01) [dx, dy, distance] = [1, 0, 1]
        const push = needed - distance
        const share = weights[j] / (weights[i] + weights[j])
        offsets[i][0] -= (dx / distance) * push * share
        offsets[i][1] -= (dy / distance) * push * share
        offsets[j][0] += (dx / distance) * push * (1 - share)
        offsets[j][1] += (dy / distance) * push * (1 - share)
        moved = true
      }
    }
    if (!moved) break
  }
  return offsets.map(([dx, dy]) => [Math.round(dx), Math.round(dy)])
}

/**
 * The map's zoom level, updated when a zoom ends. The subscription stays in place across renders, and
 * useSyncExternalStore reads the zoom again after subscribing, so a zoom that ends in between (a FitBounds
 * rendered before this layer jumps to the new bounds without animation) is not missed.
 */
function useMapZoom(map) {
  const subscribe = useCallback(
    (onChange) => {
      map.on('zoomend', onChange)
      return () => map.off('zoomend', onChange)
    },
    [map],
  )
  return useSyncExternalStore(subscribe, () => map.getZoom())
}

function humanize(slug) {
  const text = String(slug ?? '').replace(/[_-]+/g, ' ').trim()
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : ''
}

function HotspotDetails({ cluster, categories }) {
  const level = getLevelMeta(cluster.severity_level)
  const maxLevel = getLevelMeta(cluster.max_severity)
  const breakdown = Object.entries(cluster.category_breakdown ?? {})
    .map(([slug, count]) => ({ slug, count: Number(count) || 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 4)
  const nameOf = (slug) => (categories ?? []).find((category) => category.slug === slug)?.name ?? humanize(slug)
  const stats = [
    { label: 'Complaints', value: formatNumber(cluster.count) },
    { label: 'Still open', value: formatNumber(cluster.open_count) },
    { label: 'Avg severity', value: cluster.avg_severity_score == null ? '—' : formatNumber(cluster.avg_severity_score, { digits: 1 }) },
    { label: 'Avg priority', value: cluster.avg_priority_score == null ? '—' : formatNumber(cluster.avg_priority_score, { digits: 0 }) },
    { label: 'Radius', value: formatDistance(cluster.radius_m) },
    { label: 'Density', value: cluster.density_per_km2 == null ? '—' : `${formatNumber(cluster.density_per_km2, { digits: 1 })}/km²` },
  ]
  return (
    <div className="space-y-2 font-sans text-ink">
      <p className="m-0! font-display text-sm font-bold leading-snug">
        {cluster.area_name || `Hotspot ${Number(cluster.cluster_id ?? 0) + 1}`}
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        {cluster.dominant_category ? <CategoryBadge category={cluster.dominant_category} size="sm" /> : null}
        {level ? (
          <span className="text-xs font-semibold text-ink-2">
            {level.label} severity
            {maxLevel && maxLevel !== level ? `, worst ${maxLevel.label.toLowerCase()}` : ''}
          </span>
        ) : null}
      </div>
      <dl className="m-0! grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        {stats.map((stat) => (
          <div key={stat.label} className="flex items-baseline justify-between gap-2">
            <dt className="text-ink-3">{stat.label}</dt>
            <dd className="m-0 font-semibold tabular">{stat.value}</dd>
          </div>
        ))}
      </dl>
      {breakdown.length > 1 ? (
        <ul className="m-0! space-y-0.5 border-t border-line pt-1.5 text-xs text-ink-2">
          {breakdown.map((item) => (
            <li key={item.slug} className="flex justify-between gap-2">
              <span className="truncate">{nameOf(item.slug)}</span>
              <span className="font-semibold tabular">{formatNumber(item.count)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function Hotspot({ cluster, categories, onSelect, minRadius, showCounts, badgeOffset = NO_OFFSET, enterDelay }) {
  const lat = Number(cluster.latitude)
  const lng = Number(cluster.longitude)
  const center = useMemo(() => [lat, lng], [lat, lng])
  const meta = getLevelMeta(cluster.severity_level) ?? getLevelMeta('medium')
  const pathOptions = useMemo(
    () => ({ color: meta.color, weight: 2, opacity: 0.9, fillColor: meta.color, fillOpacity: 0.16 }),
    [meta.color],
  )
  const handlers = useMemo(() => ({ click: () => onSelect?.(cluster) }), [onSelect, cluster])
  const markerRef = useRef(null)
  const [dx, dy] = badgeOffset
  // An open popup stays where the previous icon anchored it; this runs after the Marker swapped its icon.
  useEffect(() => {
    const marker = markerRef.current
    if (marker?.isPopupOpen()) marker.getPopup()?.update()
  }, [dx, dy])
  const radius = Math.max(minRadius, Number(cluster.radius_m) || 0)
  const title = `${cluster.area_name || 'Hotspot'}: ${cluster.count} complaints, ${meta.label.toLowerCase()} severity`

  return (
    <Fragment>
      <Circle center={center} radius={radius} pathOptions={pathOptions} eventHandlers={handlers}>
        <Popup minWidth={220} maxWidth={280}>
          <HotspotDetails cluster={cluster} categories={categories} />
        </Popup>
      </Circle>
      {showCounts ? (
        <Marker
          ref={markerRef}
          position={center}
          icon={hotspotCountIcon(cluster.count, meta.color, badgeOffset, { enterDelay })}
          title={title}
          keyboard
          zIndexOffset={BADGE_Z_OFFSET}
          eventHandlers={handlers}
        >
          <Popup minWidth={220} maxWidth={280}>
            <HotspotDetails cluster={cluster} categories={categories} />
          </Popup>
        </Marker>
      ) : null}
    </Fragment>
  )
}

/** Key of a cluster for the entrance bookkeeping. */
const clusterKey = (cluster, index) => String(cluster.cluster_id ?? `${cluster.latitude},${cluster.longitude},${index}`)

export function HotspotLayer({ clusters = [], categories, onSelect, minRadius = 80, showCounts = true }) {
  const map = useMap()
  const zoom = useMapZoom(map)
  const reduced = usePrefersReducedMotion()
  // The first batch of clusters: {start, items: key -> {delay, offset, used, settled}}.
  const entranceRef = useRef(null)
  const valid = useMemo(
    () => (Array.isArray(clusters) ? clusters : []).filter((cluster) => isValidLatLng(cluster?.latitude, cluster?.longitude)),
    [clusters],
  )
  const offsets = useMemo(
    () => (showCounts ? badgeOffsets(map, valid, zoom) : valid.map(() => NO_OFFSET)),
    [map, valid, zoom, showCounts],
  )

  if (entranceRef.current === null && valid.length && showCounts && !reduced) {
    const ranked = valid
      .map((cluster, index) => ({ key: clusterKey(cluster, index), count: Number(cluster.count) || 0, offset: offsets[index] }))
      .sort((a, b) => b.count - a.count)
    entranceRef.current = {
      start: performance.now(),
      items: new Map(
        ranked.map((item, rank) => {
          const delay = ENTER_BASE_MS + Math.min(rank, STAGGER.max) * ENTER_STEP_MS
          return [item.key, { delay, offset: item.offset, used: delay, settled: false }]
        }),
      ),
    }
  }

  const entranceDelay = (cluster, index) => {
    const entrance = entranceRef.current
    const item = entrance?.items.get(clusterKey(cluster, index))
    if (!item || item.settled) return undefined
    const [dx, dy] = offsets[index] ?? NO_OFFSET
    if (dx === item.offset[0] && dy === item.offset[1]) return item.used
    // The badge moved (a zoom): continue its entrance from where it is, or settle it once the entrance is over.
    const elapsed = performance.now() - entrance.start
    if (elapsed >= item.delay + ENTER_MS) {
      item.settled = true
      return undefined
    }
    item.offset = [dx, dy]
    item.used = Math.round(item.delay - elapsed)
    return item.used
  }

  return valid.map((cluster, index) => (
    <Hotspot
      key={cluster.cluster_id ?? index}
      cluster={cluster}
      categories={categories}
      onSelect={onSelect}
      minRadius={minRadius}
      showCounts={showCounts}
      badgeOffset={offsets[index]}
      enterDelay={entranceDelay(cluster, index)}
    />
  ))
}

export default HotspotLayer
