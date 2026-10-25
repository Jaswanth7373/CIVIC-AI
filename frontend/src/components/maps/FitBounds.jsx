/**
 * FitBounds - fit the map to a set of points (inside a map).
 *
 * Props:
 * - points: `[{latitude, longitude}]` or `[{lat, lng}]`
 * - padding: pixels kept free around the points (default 40)
 * - maxZoom: never zoom in further than this when fitting (default 16)
 *
 * The map is only re-fitted when the bounding box of the points actually changes, so a list that is
 * refreshed every few seconds with the same complaints does not keep yanking the map away from where the
 * user panned. A single point is centred at street level instead of being zoomed to the maximum.
 *
 * Motion: the first fit is instant - the map simply opens on its points. Later re-fits (new filters) glide,
 * except with reduced motion. An animated first fit would also leave Leaflet's zoom animation pending: with
 * reduced motion (CSS transitions off) its fallback timer then finished it AFTER a view set right behind it
 * (a `?focus=` link on the hotspot map) and snapped the map back to the overview.
 */
import { useEffect, useRef } from 'react'
import { useMap } from 'react-leaflet'
import { usePrefersReducedMotion } from '@/components/motion/hooks'
import { L, toLatLng } from './leaflet'

export function FitBounds({ points, padding = 40, maxZoom = 16 }) {
  const map = useMap()
  const reduced = usePrefersReducedMotion()
  const fittedRef = useRef('')

  useEffect(() => {
    const coordinates = (Array.isArray(points) ? points : []).map(toLatLng).filter(Boolean)
    if (!coordinates.length) return
    const bounds = L.latLngBounds(coordinates)
    const key = bounds.toBBoxString()
    if (key === fittedRef.current) return
    const animate = Boolean(fittedRef.current) && !reduced
    fittedRef.current = key
    if (coordinates.length === 1) {
      map.setView(coordinates[0], Math.min(maxZoom, Math.max(map.getZoom(), 15)), { animate })
    } else {
      map.fitBounds(bounds, { padding: [padding, padding], maxZoom, animate })
    }
  }, [map, points, padding, maxZoom, reduced])

  return null
}

export default FitBounds
