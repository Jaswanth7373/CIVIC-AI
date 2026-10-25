/**
 * ClusterLayer - complaint points as category-coloured pins, clustered with leaflet.markercluster.
 *
 * Props:
 * - points: `[{id, latitude, longitude, category: CategoryMini|null, priority_level, complaint_number,
 *   title, ...}]` (GET /complaints/map/ rows, or analytics hotspot points)
 * - cluster: group nearby pins into count badges (default true); false shows every pin
 * - selectedId: the highlighted point (enlarged pin with a yellow outline)
 * - onSelect(point): a pin was clicked or activated with Enter
 * - focusSelected: when `selectedId` changes, zoom / spiderfy until that pin is visible
 * - maxClusterRadius: pixel radius within which pins are clustered (default 48)
 *
 * Why imperative: the map endpoint returns up to 3000 points. Rendering 3000 React <Marker> components
 * would re-render all of them on every change; instead this layer (inside a map, via `useMap`) creates one
 * `L.markerClusterGroup` (or a plain `L.featureGroup` when clustering is off) and bulk-loads plain Leaflet
 * markers with `addLayers(..., chunkedLoading)`, which markercluster processes in small time slices so the
 * page stays responsive. Selection changes only swap the icons of the old and new pin. Each marker keeps its
 * priority level in `options.priorityLevel`, which the cluster badge uses to show the most urgent level in it.
 * Markers are keyboard-focusable (Leaflet `keyboard: true`) and titled with number + title.
 */
import { useEffect, useRef } from 'react'
import { useMap } from 'react-leaflet'
import { L, toLatLng } from './leaflet'
import { clusterIcon, complaintPinIcon } from './mapIcons'

function markerTitle(point) {
  return [point.complaint_number, point.title || point.category?.name].filter(Boolean).join(': ') || 'Complaint'
}

function iconFor(point, selected) {
  return complaintPinIcon({ color: point.category?.color, critical: point.priority_level === 'critical', selected })
}

export function ClusterLayer({ points = [], cluster = true, selectedId = null, onSelect, focusSelected = false, maxClusterRadius = 48 }) {
  const map = useMap()
  const groupRef = useRef(null)
  const markersRef = useRef(new Map())
  const selectedRef = useRef(selectedId)
  const onSelectRef = useRef(onSelect)

  useEffect(() => {
    onSelectRef.current = onSelect
  })

  // 1. The layer group itself (re-created only when the clustering mode changes).
  useEffect(() => {
    const group = cluster
      ? L.markerClusterGroup({
          chunkedLoading: true,
          showCoverageOnHover: false,
          spiderfyOnMaxZoom: true,
          removeOutsideVisibleBounds: true,
          maxClusterRadius,
          iconCreateFunction: clusterIcon,
        })
      : L.featureGroup()
    group.addTo(map)
    groupRef.current = group
    return () => {
      group.clearLayers()
      map.removeLayer(group)
      groupRef.current = null
      markersRef.current = new Map()
    }
  }, [map, cluster, maxClusterRadius])

  // 2. The markers (rebuilt when the points change or the group was re-created).
  useEffect(() => {
    const group = groupRef.current
    if (!group) return
    group.clearLayers()
    const markers = new Map()
    const layers = []
    points.forEach((point) => {
      const position = toLatLng(point)
      if (!position) return
      const marker = L.marker(position, {
        icon: iconFor(point, point.id === selectedRef.current),
        zIndexOffset: point.id === selectedRef.current ? 1000 : 0,
        title: markerTitle(point),
        keyboard: true,
        riseOnHover: true,
        priorityLevel: point.priority_level ?? null,
      })
      marker.on('click', () => onSelectRef.current?.(point))
      markers.set(point.id, { marker, point })
      layers.push(marker)
    })
    if (typeof group.addLayers === 'function') group.addLayers(layers)
    else layers.forEach((layer) => group.addLayer(layer))
    markersRef.current = markers
  }, [points, cluster, maxClusterRadius])

  // 3. Selection: swap the icons of the previously and newly selected pins only.
  useEffect(() => {
    const previous = selectedRef.current
    if (previous === selectedId) return
    selectedRef.current = selectedId
    const markers = markersRef.current
    const old = markers.get(previous)
    if (old) {
      old.marker.setIcon(iconFor(old.point, false))
      old.marker.setZIndexOffset(0)
    }
    const next = markers.get(selectedId)
    if (next) {
      next.marker.setIcon(iconFor(next.point, true))
      next.marker.setZIndexOffset(1000)
      const group = groupRef.current
      if (focusSelected && group && typeof group.zoomToShowLayer === 'function') group.zoomToShowLayer(next.marker)
    }
  }, [selectedId, focusSelected])

  return null
}

export default ClusterLayer
