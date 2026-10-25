import { use, useLayoutEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { pendingRouteGate, routeCommitted } from './routeViewTransition'

/**
 * Holds a navigated-to page back for the one frame in which the browser captures the old page for a route view
 * transition, then reports when the new page is committed (see routeViewTransition.js). Renders nothing.
 *
 * Place it inside the layout's Suspense boundary, next to the page: suspending there keeps the current page on
 * screen (React treats it like a page whose code is still loading) - never a fallback, never a blank frame.
 */
export function RouteViewTransitionGate() {
  const { key } = useLocation()
  const gate = pendingRouteGate(key)
  if (gate) use(gate)

  useLayoutEffect(() => {
    routeCommitted(key)
  }, [key])

  return null
}

export default RouteViewTransitionGate
