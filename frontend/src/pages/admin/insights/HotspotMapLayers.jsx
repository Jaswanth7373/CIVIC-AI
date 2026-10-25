/**
 * Small layers rendered INSIDE the hotspot map (children of ComplaintMap / BaseMap, so `useMap()` works).
 *
 * - MapFocus({target}): flies to `target` whenever it changes - `{bounds: [[lat, lng], [lat, lng]]}` (a
 *   cluster's extent) or `{lat, lng, zoom}`. Honours prefers-reduced-motion (jumps instead of flying). During a
 *   flight Leaflet scales its vector layer, so the hotspot circles would balloon into thick blurred rings: the
 *   vector layer is veiled for the flight (badges and tiles stay) and fades back in when the map lands.
 * - SelectionRing({center, radius}): the selected hotspot drawn with a dashed road-marking yellow ring - the
 *   product's lane-line motif - on top of its severity circle; not interactive. Its dashes flow slowly round the
 *   hotspot like lane markings passing under a car (styles/admin.css; still with reduced motion).
 * - LayerControl({...}): "Layers" toggles in the top-right map corner (complaint pins, grouping, hotspot
 *   circles). A disclosure that starts open from the md breakpoint and folded on phones.
 */
import { useReducedMotion } from 'framer-motion'
import { Layers } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { Circle, useMap } from 'react-leaflet'
import { MapControl, isValidLatLng } from '@/components/maps'
import { Switch } from '@/components/ui/Switch'
import { BREAKPOINTS, useMediaQuery } from '@/hooks/useMediaQuery'
import '@/styles/admin.css'

/** Longest a flight may keep the vector layer veiled, should Leaflet not report the end of the move. */
const VEIL_TIMEOUT_MS = 2000

export function MapFocus({ target }) {
  const map = useMap()
  const reducedMotion = useReducedMotion()
  useEffect(() => {
    if (!target) return undefined
    const animate = !reducedMotion
    const container = map.getContainer()
    let timer = 0
    const unveil = () => {
      window.clearTimeout(timer)
      container.classList.remove('civic-flying')
    }
    if (animate) {
      container.classList.add('civic-flying')
      map.once('moveend', unveil)
      timer = window.setTimeout(unveil, VEIL_TIMEOUT_MS)
    }
    if (Array.isArray(target.bounds) && target.bounds.length === 2) {
      const [[south, west], [north, east]] = target.bounds
      if (south === north && west === east) {
        map.flyTo([south, west], 16, { animate, duration: 0.8 })
      } else {
        map.flyToBounds(target.bounds, { animate, duration: 0.8, padding: [56, 56], maxZoom: 16 })
      }
    } else if (isValidLatLng(target.lat, target.lng)) {
      map.flyTo([Number(target.lat), Number(target.lng)], target.zoom ?? 15, { animate, duration: 0.8 })
    }
    return () => {
      map.off('moveend', unveil)
      unveil()
    }
  }, [map, target, reducedMotion])
  return null
}

const RING_STYLE = {
  color: '#f5b700',
  weight: 3,
  opacity: 1,
  dashArray: '10 8',
  fill: false,
  interactive: false,
  className: 'civic-selection-ring',
}

export function SelectionRing({ center, radius }) {
  const lat = Number(center?.[0])
  const lng = Number(center?.[1])
  const position = useMemo(() => [lat, lng], [lat, lng])

  if (!isValidLatLng(lat, lng)) return null
  return <Circle center={position} radius={Math.max(80, Number(radius) || 0) + 30} pathOptions={RING_STYLE} interactive={false} />
}

export function LayerControl({ showPoints, onShowPoints, grouped, onGrouped, showHotspots, onShowHotspots }) {
  const wide = useMediaQuery(BREAKPOINTS.md)
  return (
    <MapControl position="topright">
      <details
        open={wide || undefined}
        className="group w-max max-w-[calc(100vw-6rem)] rounded-lg border border-line bg-surface/95 text-ink shadow-[var(--shadow-overlay)] backdrop-blur-sm"
      >
        <summary className="flex cursor-pointer select-none items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold marker:text-ink-3 pointer-coarse:min-h-11">
          <Layers aria-hidden className="size-4 text-ink-3" />
          Layers
        </summary>
        <fieldset className="flex flex-col gap-1 px-3 pb-3">
          <legend className="sr-only">Map layers</legend>
          <Switch label="Complaint pins" checked={showPoints} onCheckedChange={onShowPoints} />
          <Switch label="Group nearby pins" checked={grouped} onCheckedChange={onGrouped} disabled={!showPoints} />
          <Switch label="Hotspot circles" checked={showHotspots} onCheckedChange={onShowHotspots} />
        </fieldset>
      </details>
    </MapControl>
  )
}
