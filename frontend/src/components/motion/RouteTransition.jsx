import { motion } from 'framer-motion'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocation } from 'react-router-dom'
import { usePrefersReducedMotion, useRouteLoading } from './hooks'
import { DURATION, EASE } from './tokens'

/** Set after the first page of the session has rendered: that page appears at once (fast first paint / LCP). */
let firstPageShown = false

/**
 * True while a View Transition drives the route change. The theme / routing code that starts a route view
 * transition sets `<html data-view-transition="route">` for its duration; the browser then animates the
 * snapshots and RouteTransition stays still, so the two never fade on top of each other.
 */
function viewTransitionRunning() {
  return typeof document !== 'undefined' && document.documentElement.dataset.viewTransition === 'route'
}

function RouteFrame({ offset, className, children }) {
  const reduced = usePrefersReducedMotion()
  const [animateIn] = useState(() => firstPageShown && !reduced && !viewTransitionRunning())

  useEffect(() => {
    firstPageShown = true
  }, [])

  return (
    <motion.div
      className={className}
      initial={animateIn ? { opacity: 0, y: offset } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: DURATION.route, ease: EASE.standard }}
    >
      {children}
    </motion.div>
  )
}

/**
 * The page area of a layout: wraps `<Outlet />` (inside the layout's Suspense boundary).
 *
 * - On every pathname change the new page rises 8 px and fades in over 280 ms. There is no exit animation and
 *   no `mode="wait"`: the next page is never delayed, and two pages are never on screen together. Query-string
 *   changes (filters, paging) don't animate.
 * - While a lazy page is still downloading, the current page stays and a road-marking progress bar runs along
 *   the top of the window (see RouteProgress).
 * - The first page of a visit and reduced motion: no entrance.
 *
 * Note: during its 280 ms entrance the page wrapper carries a transform, which re-anchors `position: fixed`
 * descendants to it; fixed overlays inside pages should be portalled to <body> (modals, toasts and the motion
 * components already are).
 *
 * @param {{className?: string, offset?: number, children: import('react').ReactNode}} props
 */
export function RouteTransition({ className, offset = 8, children }) {
  const { pathname } = useLocation()
  const loading = useRouteLoading()
  return (
    <>
      <RouteFrame key={pathname} offset={offset} className={className}>
        {children}
      </RouteFrame>
      <RouteProgress active={loading} />
    </>
  )
}

/**
 * Thin "road" along the top edge of the window with a moving yellow lane marking: shown while a page is
 * loading. It waits `delay` ms (300) before appearing, so loads under 300 ms never flash it, creeps forward while
 * waiting, then runs to the end and fades. Reduced motion: a still marking line while loading.
 *
 * Screen readers: a polite status region stays mounted (a live region inserted together with its text is often
 * not announced). It says "Loading page" only once the bar appears - never for a load under 300 ms - and is
 * emptied when the page arrives (RouteAnnouncer then names the new page).
 *
 * @param {{active: boolean, delay?: number}} props
 */
export function RouteProgress({ active, delay = 300 }) {
  const reduced = usePrefersReducedMotion()
  const [phase, setPhase] = useState('idle') // idle | loading | done

  useEffect(() => {
    if (active) {
      const timer = window.setTimeout(() => setPhase('loading'), delay)
      return () => window.clearTimeout(timer)
    }
    setPhase((current) => (current === 'idle' ? 'idle' : 'done'))
    return undefined
  }, [active, delay])

  useEffect(() => {
    if (phase !== 'done') return undefined
    const timer = window.setTimeout(() => setPhase('idle'), 650)
    return () => window.clearTimeout(timer)
  }, [phase])

  if (typeof document === 'undefined') return null

  const loading = phase === 'loading'
  return createPortal(
    <>
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {loading ? 'Loading page' : ''}
      </span>
      {phase === 'idle' ? null : (
        <div className="route-progress" data-phase={phase}>
          <motion.span
            aria-hidden
            className="route-progress-bar"
            initial={reduced ? false : { width: '0%' }}
            animate={reduced ? { width: '100%', opacity: loading ? 1 : 0 } : { width: loading ? '88%' : '100%', opacity: loading ? 1 : 0 }}
            transition={
              reduced
                ? { duration: 0 }
                : loading
                  ? { width: { duration: 9, ease: [0.08, 0.82, 0.17, 1] }, opacity: { duration: 0.12 } }
                  : { width: { duration: 0.25, ease: EASE.standard }, opacity: { duration: 0.3, delay: 0.25 } }
            }
          />
        </div>
      )}
    </>,
    document.body,
  )
}

export default RouteTransition
