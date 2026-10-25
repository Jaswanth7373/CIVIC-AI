/**
 * SVG divIcons for the maps (complaint pins, cluster badges, hotspot counts).
 *
 * - Complaint pin: a map pin filled with the complaint's CATEGORY colour ("colour follows the entity", the
 *   same colour as its CategoryBadge), a white outline that separates it from any tile, and an inner dot in
 *   white or near-black (whichever reads better on the fill). Critical-priority complaints carry a small red
 *   badge, the selected one is enlarged with a road-marking yellow outline.
 * - Cluster badge (leaflet.markercluster `iconCreateFunction`): an asphalt disc with the number of
 *   complaints, ringed in the colour of the HIGHEST priority level inside the cluster, so an officer can see
 *   where critical work is waiting before zooming in.
 * Icons are cached by their visual parameters, so thousands of markers share a handful of icon objects.
 * Colours from the database pass through `safeColor` before they are written into the HTML string.
 */
import { readableInk, safeColor } from '@/components/charts/palette'
import { LEVEL_META, LEVEL_ORDER } from '@/utils/constants'
import { formatNumber } from '@/utils/format'
import { L } from './leaflet'

const PIN_PATH =
  'M14 1.2C7.1 1.2 1.6 6.6 1.6 13.3c0 8.3 10.4 19.2 11.5 20.3a1.3 1.3 0 0 0 1.8 0c1.1-1.1 11.5-12 11.5-20.3C26.4 6.6 20.9 1.2 14 1.2Z'

const pinCache = new Map()
const countCache = new Map()

/**
 * Category-coloured pin.
 * @param {{color?: string, critical?: boolean, selected?: boolean, size?: 'md'|'lg'}} options
 */
export function complaintPinIcon({ color, critical = false, selected = false, size = 'md' } = {}) {
  const fill = safeColor(color, '#6a7a77')
  const key = `${fill}|${critical}|${selected}|${size}`
  if (pinCache.has(key)) return pinCache.get(key)

  const scale = (size === 'lg' ? 1.3 : 1) * (selected ? 1.2 : 1)
  const width = Math.round(28 * scale)
  const height = Math.round(36 * scale)
  const dot = readableInk(fill)
  const outline = selected ? '#f5b700' : '#ffffff'
  const badge = critical ? '<circle cx="23" cy="5.5" r="4.6" fill="#d3341f" stroke="#ffffff" stroke-width="1.6"/>' : ''
  const html =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 28 36" ` +
    'aria-hidden="true" focusable="false" class="block overflow-visible drop-shadow-sm">' +
    `<path d="${PIN_PATH}" fill="${fill}" stroke="${outline}" stroke-width="${selected ? 2.6 : 2}"/>` +
    `<circle cx="14" cy="13.2" r="4.4" fill="${dot}"/>${badge}</svg>`

  const icon = L.divIcon({
    html,
    className: 'civic-map-pin bg-transparent',
    iconSize: [width, height],
    iconAnchor: [width / 2, height - 1],
    popupAnchor: [0, -height + 4],
    tooltipAnchor: [width / 2, -height / 2],
  })
  pinCache.set(key, icon)
  return icon
}

/** Highest priority level among a cluster's markers (each marker carries `options.priorityLevel`). */
function highestLevel(markers) {
  let best = -1
  markers.forEach((marker) => {
    const index = LEVEL_ORDER.indexOf(marker.options?.priorityLevel)
    if (index > best) best = index
  })
  return best >= 0 ? LEVEL_ORDER[best] : null
}

/** `iconCreateFunction` for L.markerClusterGroup. */
export function clusterIcon(cluster) {
  const count = cluster.getChildCount()
  const level = highestLevel(cluster.getAllChildMarkers())
  const ring = level ? LEVEL_META[level].color : '#8c9a96'
  const size = count < 10 ? 34 : count < 50 ? 40 : count < 250 ? 46 : 52
  const label = formatNumber(count, { compact: count >= 1000 })
  const description = `${count} complaints here${level ? `, highest priority ${LEVEL_META[level].label.toLowerCase()}` : ''}. Zoom in to see them.`
  const html =
    '<div class="grid size-full place-items-center rounded-full bg-asphalt-900 font-display text-[13px] font-extrabold text-white" ' +
    `style="box-shadow:0 0 0 3px ${ring},0 0 0 5px rgb(255 255 255 / 0.92),0 6px 14px -4px rgb(15 22 23 / 0.45)" title="${description}">` +
    `<span aria-hidden="true">${label}</span><span class="sr-only">${description}</span></div>`
  return L.divIcon({ html, className: 'civic-map-cluster bg-transparent', iconSize: L.point(size, size) })
}

/** Diameter in pixels of the count badge of a hotspot with `count` complaints. */
export function hotspotBadgeSize(count) {
  return Math.max(0, Math.round(Number(count) || 0)) < 100 ? 30 : 36
}

/**
 * Round count badge at the centre of a hotspot circle, in the hotspot's severity colour. `offset` ([dx, dy],
 * whole pixels) moves the badge off the centre: HotspotLayer uses it to keep the badges of nearby hotspots
 * from covering each other. `options.enterDelay` (ms) gives the badge a one-time entrance - it rises out of the
 * map with a small overshoot after that delay (styles/admin.css `[data-enter]`); without it the badge is
 * simply there.
 */
export function hotspotCountIcon(count, color, offset = [0, 0], { enterDelay } = {}) {
  const fill = safeColor(color, '#e8730c')
  const number = Math.max(0, Math.round(Number(count) || 0))
  const dx = Math.round(Number(offset?.[0]) || 0)
  const dy = Math.round(Number(offset?.[1]) || 0)
  // A negative delay continues an entrance that started earlier (the badge moved mid-animation).
  const enter = Number.isFinite(enterDelay) ? Math.round(enterDelay) : null
  const key = `${number}|${fill}|${dx}|${dy}|${enter ?? ''}`
  if (countCache.has(key)) return countCache.get(key)
  const size = hotspotBadgeSize(number)
  const html =
    `<div${enter == null ? '' : ' data-enter'} class="grid size-full place-items-center rounded-full font-display text-xs font-extrabold" ` +
    `style="${enter == null ? '' : `--enter-delay:${enter}ms;`}background:${fill};color:${readableInk(fill)};box-shadow:0 0 0 2px #ffffff,0 4px 10px -3px rgb(15 22 23 / 0.45)">` +
    `${formatNumber(number, { compact: number >= 1000 })}</div>`
  const icon = L.divIcon({
    html,
    className: 'civic-map-hotspot bg-transparent',
    iconSize: [size, size],
    // The anchor is the icon point placed on the hotspot centre, so moving it the other way moves the badge.
    iconAnchor: [size / 2 - dx, size / 2 - dy],
    popupAnchor: [dx, dy - size / 2],
  })
  countCache.set(key, icon)
  return icon
}
