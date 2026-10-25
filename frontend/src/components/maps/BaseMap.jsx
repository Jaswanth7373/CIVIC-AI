/**
 * BaseMap - the themed OpenStreetMap canvas every CivicAI map is built on.
 *
 * Props:
 * - center: `[lat, lng]`; defaults to the city centre from GET /system/config/ (useConfig().mapCenter).
 *   Changing it later moves the map (react-leaflet's MapContainer only reads it once, so a small
 *   controller re-applies it).
 * - zoom: defaults to the configured zoom
 * - bounds / boundsOptions: create the map fitted to these bounds (`[[south, west], [north, east]]`) instead of
 *   at `center` / `zoom` - read once, when the map is created, so the first tiles are already the right ones
 * - height: CSS height of the map (number = px, default 360); pass null to size it with `className`
 * - interactive: false makes a static map (no drag, zoom, keyboard or controls) - MiniMap uses it
 * - scrollWheelZoom: default false, so scrolling the page over a map does not zoom it (use the +/- buttons,
 *   pinch, or double-click)
 * - label: accessible name of the map region (default "Map")
 * - overlay: node rendered above the map, outside Leaflet (e.g. an empty-state message)
 * - mapRef: receives the Leaflet map instance
 * - children: react-leaflet layers (markers, ClusterLayer, HotspotLayer, MapLegend, ...)
 * - className, plus any other Leaflet map option (minZoom, maxBounds, ...)
 *
 * Built-in behaviour: OSM tiles + attribution (leaflet.js), the light / dark tile grade of basemap.css, `invalidateSize()` whenever the container is resized (maps inside tabs, drawers or collapsing
 * sidebars otherwise show grey tiles), and an `isolate` stacking context so Leaflet's pane z-indexes never
 * cover the app's menus and dialogs.
 */
import { useEffect, useRef } from 'react'
import { MapContainer, TileLayer, useMap } from 'react-leaflet'
import { useConfig } from '@/hooks/useConfig'
import { cn } from '@/utils/cn'
import { MAX_ZOOM, OSM_ATTRIBUTION, OSM_TILE_URL, isValidLatLng } from './leaflet'
import { InsideMapContext } from './mapContext'

const STATIC_OPTIONS = {
  dragging: false,
  touchZoom: false,
  doubleClickZoom: false,
  scrollWheelZoom: false,
  boxZoom: false,
  keyboard: false,
  zoomControl: false,
}

/** Accessible name + resize handling for the map container. */
function MapChrome({ label, interactive }) {
  const map = useMap()
  useEffect(() => {
    const container = map.getContainer()
    container.setAttribute('role', 'region')
    container.setAttribute('aria-roledescription', 'map')
    container.setAttribute('aria-label', interactive ? `${label}. Use the arrow keys to pan and plus or minus to zoom.` : label)
    if (typeof ResizeObserver === 'undefined') return undefined
    let frame = 0
    const observer = new ResizeObserver(() => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => map.invalidateSize({ debounceMoveend: true }))
    })
    observer.observe(container)
    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [map, label, interactive])
  return null
}

/** Re-applies `center` / `zoom` when the props change after the map was created. */
function ViewSync({ center, zoom }) {
  const map = useMap()
  const lat = center?.[0]
  const lng = center?.[1]
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    if (isValidLatLng(lat, lng)) map.setView([Number(lat), Number(lng)], zoom ?? map.getZoom())
  }, [map, lat, lng, zoom])
  return null
}

export function BaseMap({
  center,
  zoom,
  bounds,
  boundsOptions,
  height = 360,
  interactive = true,
  scrollWheelZoom = false,
  label = 'Map',
  overlay,
  mapRef,
  className,
  children,
  ...options
}) {
  const { mapCenter, mapZoom } = useConfig()
  const initialCenter = Array.isArray(center) && isValidLatLng(center[0], center[1]) ? center : mapCenter
  const initialZoom = zoom ?? mapZoom
  const interaction = interactive ? { scrollWheelZoom } : STATIC_OPTIONS
  // MapContainer fits `bounds` only when it gets no center / zoom.
  const initialView = bounds ? { bounds, boundsOptions } : { center: initialCenter, zoom: initialZoom }

  return (
    <div
      className={cn('relative isolate min-w-0 overflow-hidden rounded-xl border border-line bg-sunken', className)}
      style={height == null ? undefined : { height }}
    >
      <MapContainer
        ref={mapRef}
        {...initialView}
        maxZoom={MAX_ZOOM}
        className="size-full"
        {...interaction}
        {...options}
      >
        <TileLayer url={OSM_TILE_URL} attribution={OSM_ATTRIBUTION} maxZoom={MAX_ZOOM} />
        <MapChrome label={label} interactive={interactive} />
        {center ? <ViewSync center={center} zoom={zoom} /> : null}
        <InsideMapContext value={true}>{children}</InsideMapContext>
      </MapContainer>
      {overlay ? <div className="pointer-events-none absolute inset-0 z-[500] grid place-items-center p-4">{overlay}</div> : null}
    </div>
  )
}

export default BaseMap
