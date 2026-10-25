/**
 * MapControl - render React content inside a Leaflet control corner (legends, small toolbars).
 *
 * Props:
 * - position: 'topleft' | 'topright' | 'bottomleft' | 'bottomright' (default 'topright')
 * - className: classes for the wrapper inside the control
 * - children
 *
 * Must be rendered inside a map (BaseMap / ComplaintMap children). Technique: an `L.Control` creates the
 * container element, React portals the children into it, and `disableClickPropagation` /
 * `disableScrollPropagation` stop clicks and wheel events inside the control from also panning, zooming or
 * dropping a pin on the map underneath.
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMap } from 'react-leaflet'
import { L } from './leaflet'

export function MapControl({ position = 'topright', className, children }) {
  const map = useMap()
  const [container, setContainer] = useState(null)

  useEffect(() => {
    const control = L.control({ position })
    control.onAdd = () => {
      const element = L.DomUtil.create('div', 'leaflet-civic-control')
      L.DomEvent.disableClickPropagation(element)
      L.DomEvent.disableScrollPropagation(element)
      return element
    }
    control.addTo(map)
    setContainer(control.getContainer())
    return () => {
      control.remove()
      setContainer(null)
    }
  }, [map, position])

  return container ? createPortal(<div className={className}>{children}</div>, container) : null
}

export default MapControl
