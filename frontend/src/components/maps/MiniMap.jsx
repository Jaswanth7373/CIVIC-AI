/**
 * MiniMap - a small, static map of one location (complaint details, work orders).
 *
 * Props:
 * - lat / lng: the location (strings from the API are accepted)
 * - color: pin colour, usually the complaint's category colour (default highway green)
 * - zoom: default 16
 * - height: default 180 px
 * - label: accessible name (default "Map of the complaint location")
 * - showLinks: "Open in OpenStreetMap" and "Directions" links under the map (default true) - officers can
 *   start turn-by-turn navigation to the site from the work order
 * - className
 *
 * Non-interactive on purpose (no dragging, zooming, keyboard focus or controls), so it never traps page
 * scrolling on phones; the OpenStreetMap attribution stays visible as the tile licence requires.
 */
import { ExternalLink, MapPinOff, Navigation } from 'lucide-react'
import { useMemo } from 'react'
import { Marker } from 'react-leaflet'
import { cn } from '@/utils/cn'
import { BaseMap } from './BaseMap'
import { isValidLatLng } from './leaflet'
import { complaintPinIcon } from './mapIcons'

export function MiniMap({
  lat,
  lng,
  color = '#0b6e4f',
  zoom = 16,
  height = 180,
  label = 'Map of the complaint location',
  showLinks = true,
  className,
}) {
  const valid = isValidLatLng(lat, lng)
  const latitude = Number(lat)
  const longitude = Number(lng)
  const position = useMemo(() => [latitude, longitude], [latitude, longitude])

  if (!valid) {
    return (
      <div
        className={cn('grid place-items-center rounded-xl border border-dashed border-line-strong bg-surface-2 text-ink-3', className)}
        style={{ height }}
      >
        <span className="flex items-center gap-1.5 text-xs font-medium">
          <MapPinOff aria-hidden className="size-4" />
          Location not available
        </span>
      </div>
    )
  }

  const osmUrl = `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=${zoom + 1}/${latitude}/${longitude}`
  const directionsUrl = `https://www.google.com/maps/dir/?api=1&destination=${latitude},${longitude}`

  return (
    <div className={cn('min-w-0', className)}>
      <BaseMap center={position} zoom={zoom} height={height} interactive={false} label={label}>
        <Marker position={position} icon={complaintPinIcon({ color })} interactive={false} keyboard={false} />
      </BaseMap>
      {showLinks ? (
        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs font-semibold">
          <a href={osmUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary-ink hover:underline pointer-coarse:min-h-11">
            <ExternalLink aria-hidden className="size-3.5" />
            Open in OpenStreetMap
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
          <a href={directionsUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary-ink hover:underline pointer-coarse:min-h-11">
            <Navigation aria-hidden className="size-3.5" />
            Directions
            <span className="sr-only"> (opens Google Maps in a new tab)</span>
          </a>
        </div>
      ) : null}
    </div>
  )
}

export default MiniMap
