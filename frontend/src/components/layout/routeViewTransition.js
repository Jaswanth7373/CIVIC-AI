/**
 * Route changes through the View Transitions API (cinematic plan 6.2) - without ever holding content back.
 *
 * How one route transition runs
 * 1. A navigation starts (a link, navigate(), a redirect). The router's state already holds the new location,
 *    React has not rendered it yet. `useRouteViewTransitions` (subscribed to the router) decides whether this
 *    navigation animates and, if so, calls document.startViewTransition().
 * 2. The browser captures the old page at its next frame. Until then the new page must not reach the screen, so
 *    <RouteViewTransitionGate> (inside the layout's Suspense boundary, next to the page) suspends the pending
 *    render - React keeps the current page on screen, exactly as it does while a lazy page loads.
 * 3. In the transition's update callback the gate opens, React renders and commits the new page, the gate's
 *    layout effect reports the commit, and the browser animates old -> new (index.css "System additions" 1: the
 *    content cross-fades with a little depth, the sidebar / top bar / tab bar / header stay put).
 * 4. Never a delay: if the new page is not committed within MAX_WAIT_MS (its code is still downloading, or a
 *    heavy first render), the transition is skipped on the spot. Rendering resumes at once, the lane-line
 *    progress bar runs, and the page arrives later with RouteTransition's framer-motion entrance - the fallback
 *    (it stays still only while `<html data-view-transition="route">` is set).
 *
 * Which navigations animate: PUSH navigations to another pathname inside the same area (the public site, or one
 * role's dashboard) - with the API available, motion welcome and the tab visible. Back / forward (POP) never
 * animates, so the browser's scroll restoration is untouched; neither do redirects (REPLACE), query-only changes
 * (filters, paging) and moves between areas (logging in or out).
 *
 * Quick succession: a navigation that starts while a route transition is still running, or within
 * QUICK_SUCCESSION_MS of the previous navigation, does not start another one. A running transition ends at once
 * and the page swaps with RouteTransition's light entrance - only one of the two animations ever runs. Someone
 * clicking through the navigation sees each page about a frame after the click instead of after a fresh snapshot
 * of the old page (measured: ~25 ms instead of ~70 ms per click), and the screen is never frozen again and again.
 * Clicks that land on a running transition are replayed on the page (components/ui/viewTransitionInput.js).
 *
 * Shared element, opt-in ("where cheap"): an element on the old page marked data-vt-morph="<pathname>" (e.g. a
 * complaint card whose link leads to /admin/complaints/12) and the element on the new page marked
 * data-vt-morph-target (its header) share the name `civic-morph` for that one transition, so the card morphs
 * into the header. Both must be in view; without a match the page simply cross-fades.
 */
import { useContext, useEffect, useRef } from 'react'
import { UNSAFE_DataRouterContext } from 'react-router-dom'
import { keepInputLive } from '@/components/ui/viewTransitionInput'

/** The longest the screen may wait (frozen on the old page) for the new page before the animation is dropped. */
const MAX_WAIT_MS = 200
/**
 * A navigation this soon after the previous one counts as clicking through quickly: about the time a route
 * transition takes (a frame or two to capture and render, then the 360 ms cross-fade).
 */
const QUICK_SUCCESSION_MS = 450
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'
const MORPH_NAME = 'civic-morph'

/**
 * The transition in flight, if any.
 * @type {null | {key: string, gate: Promise<void>, opened: boolean, open: () => void, committed: () => void,
 *   transition: ViewTransition | null, named: HTMLElement[]}}
 */
let active = null
/** performance.now() of the last navigation seen by a layout (animated or not). */
let lastNavigationAt = -Infinity

function endActive(entry) {
  if (active !== entry) return
  active = null
  markDocument(false)
}

/** True when this browser can run same-document view transitions. */
export function supportsViewTransitions() {
  return typeof document !== 'undefined' && typeof document.startViewTransition === 'function'
}

function motionWelcome() {
  return document.visibilityState === 'visible' && !window.matchMedia?.(REDUCED_MOTION_QUERY).matches
}

/**
 * Mark the document for the CSS of a route transition. `overlay`: the navigation starts under an open dialog,
 * drawer or the palette (the app root is inert). The shell is then NOT captured on its own - it would be drawn
 * above the dimmed backdrop and flash bright - so the whole page, overlay included, cross-fades as one.
 */
function markDocument(on, overlay = false) {
  const root = document.documentElement
  if (on) {
    root.dataset.viewTransition = 'route'
    if (overlay) root.dataset.vtOverlay = ''
    else delete root.dataset.vtOverlay
  } else if (root.dataset.viewTransition === 'route') {
    delete root.dataset.viewTransition
    delete root.dataset.vtOverlay
  }
}

function inView(element) {
  const rect = element.getBoundingClientRect()
  return rect.width > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth
}

function nameElement(entry, element) {
  element.style.viewTransitionName = MORPH_NAME
  entry.named.push(element)
}

function clearNames(entry) {
  entry.named.forEach((element) => {
    element.style.viewTransitionName = ''
  })
  entry.named = []
}

/** End `entry` without animating: rendering resumes at once and the page keeps its fallback entrance. */
function abandon(entry) {
  entry.open()
  clearNames(entry)
  endActive(entry)
  try {
    entry.transition?.skipTransition()
  } catch {
    // Already finished.
  }
}

function begin(location) {
  if (active) abandon(active)

  let openGate
  const gate = new Promise((resolve) => {
    openGate = resolve
  })
  let resolveCommitted
  const committed = new Promise((resolve) => {
    resolveCommitted = resolve
  })
  const entry = {
    key: location.key,
    gate,
    opened: false,
    open: () => {
      if (entry.opened) return
      entry.opened = true
      openGate()
    },
    committed: resolveCommitted,
    transition: null,
    named: [],
  }
  active = entry
  markDocument(true, Boolean(document.getElementById('root')?.hasAttribute('inert')))

  // The card the user came from (named now, so it is in the old snapshot).
  for (const element of document.querySelectorAll('[data-vt-morph]')) {
    if (element.getAttribute('data-vt-morph') === location.pathname && inView(element)) {
      nameElement(entry, element)
      break
    }
  }

  try {
    entry.transition = document.startViewTransition(async () => {
      entry.open()
      let timer = 0
      const shown = await Promise.race([
        committed.then(() => true),
        new Promise((resolve) => {
          timer = window.setTimeout(() => resolve(false), MAX_WAIT_MS)
        }),
      ])
      window.clearTimeout(timer)
      if (!shown && active === entry) abandon(entry)
    })
  } catch {
    abandon(entry)
    return
  }
  // Clicks during the cross-fade (another link, a row) would land on the transition layer: replay them.
  keepInputLive(entry.transition)
  // A skipped transition rejects `ready`; nothing waits for it, so the rejection is handled here.
  entry.transition.ready.catch(() => {})
  entry.transition.finished.finally(() => {
    clearNames(entry)
    endActive(entry)
  })
}

/**
 * The promise the page render must wait for (the old page has not been captured yet), or null.
 * Read by <RouteViewTransitionGate> during render.
 */
export function pendingRouteGate(locationKey) {
  return active && active.key === locationKey && !active.opened ? active.gate : null
}

/** Called by <RouteViewTransitionGate> when the page for `locationKey` has been committed. */
export function routeCommitted(locationKey) {
  const entry = active
  if (!entry || entry.key !== locationKey) return
  // The old snapshot is taken: the card's name is no longer needed, and the header takes it over.
  const morphing = entry.named.length > 0
  clearNames(entry)
  if (morphing) {
    const target = document.querySelector('[data-vt-morph-target]')
    if (target && inView(target)) nameElement(entry, target)
  }
  entry.committed()
}

/**
 * Animate route changes inside one area with the View Transitions API. Call once in a layout and render
 * <RouteViewTransitionGate /> next to its <Outlet /> (inside the same Suspense boundary).
 *
 * @param {(pathname: string) => boolean} isInArea true for the paths this layout renders
 */
export function useRouteViewTransitions(isInArea) {
  const router = useContext(UNSAFE_DataRouterContext)?.router
  const isInAreaRef = useRef(isInArea)

  useEffect(() => {
    isInAreaRef.current = isInArea
  })

  useEffect(() => {
    if (!router || !supportsViewTransitions()) return undefined
    let current = router.state.location
    return router.subscribe((state, options) => {
      const next = state.location
      if (!next || next.key === current.key) return
      const previous = current
      current = next
      const inArea = isInAreaRef.current
      // Clicking through quickly: end the running transition and let this page swap at once (see above).
      const now = performance.now()
      const quickSuccession = active !== null || now - lastNavigationAt < QUICK_SUCCESSION_MS
      lastNavigationAt = now
      const animate =
        state.historyAction === 'PUSH' &&
        !options?.flushSync &&
        !options?.viewTransitionOpts &&
        previous.pathname !== next.pathname &&
        inArea(previous.pathname) &&
        inArea(next.pathname) &&
        !quickSuccession &&
        motionWelcome()
      if (animate) begin(next)
      else if (active) abandon(active) // a newer navigation overtakes one still in flight
    })
  }, [router])
}
