import { useEffect, useState } from 'react'
import { useLocation, useNavigationType } from 'react-router-dom'

/**
 * The pathname the shell last handled. Module scope, so it survives a switch between layouts (logging in moves
 * from PublicLayout to DashboardLayout): the newly mounted layout still knows that a navigation happened.
 * `null` until the first page of the visit has rendered - that page keeps the browser's own focus handling.
 */
let lastPathname = null

/** How long a closing dialog, drawer, palette or menu may take to hand focus back (its exit animation). */
const SETTLE_LIMIT_MS = 1200
/** How long to wait for a page that renders its heading only after its data has arrived. */
const HEADING_WAIT_MS = 2500

const ROUTE_FOCUS_ATTR = 'data-route-focus'

function appRoot() {
  return document.getElementById('root')
}

/** True while a modal layer is open, or focus is still inside a portalled layer that is on its way out. */
function layerHoldsFocus() {
  const root = appRoot()
  if (!root) return false
  if (root.hasAttribute('inert')) return true
  const active = document.activeElement
  return Boolean(active && active !== document.body && !root.contains(active))
}

/**
 * May the new page take focus from `element`? Yes when focus is nowhere (the link that was used unmounted with
 * the old page), on <main> itself, or on a part of the shell that stays (sidebar, top bar, tab bar, header,
 * footer). No when the new page already placed focus inside itself (an autofocus field, a wizard step).
 */
function focusIsFree(element, main) {
  if (!element || element === document.body || element === main) return true
  const root = appRoot()
  return Boolean(root?.contains(element) && !main?.contains(element))
}

function visibleHeading(main) {
  return Array.from(main.querySelectorAll('h1')).find((heading) => heading.getClientRects().length > 0) ?? null
}

/** Focus the page heading without scrolling; it leaves the tab order again once focus moves on. */
function focusTarget(target) {
  if (!target.hasAttribute('tabindex')) {
    target.setAttribute('tabindex', '-1')
    target.setAttribute(ROUTE_FOCUS_ATTR, '')
    target.addEventListener(
      'blur',
      () => {
        target.removeAttribute('tabindex')
        target.removeAttribute(ROUTE_FOCUS_ATTR)
      },
      { once: true },
    )
  }
  target.focus({ preventScroll: true })
}

/**
 * Accessible client-side navigation for a layout (WCAG 2.4.3 / 4.1.3). Render once per layout, outside <main>.
 *
 * After a navigation to another page has committed:
 * - focus moves to the new page's main heading (its h1, or #main-content when the page has none), so keyboard
 *   and screen-reader users start reading the new page instead of staying on a sidebar link or falling back to
 *   the top of the document. `preventScroll`: ScrollToTop and the browser's scroll restoration stay in charge.
 * - the new document title is written into a persistent, visually hidden polite live region.
 *
 * Skipped: the first page of the visit, query-only changes (filters, paging), and - for the focus move only -
 * back / forward (POP) and links to a #fragment. Focus is never taken from an element the new page focused
 * itself, nor from anything the user reached in the meantime. While a dialog, drawer, the palette or a menu is
 * still closing, the move waits until it has handed focus back.
 */
export function RouteAnnouncer() {
  const { key, pathname, hash } = useLocation()
  const navigationType = useNavigationType()
  const [message, setMessage] = useState('')

  useEffect(() => {
    const previous = lastPathname
    lastPathname = pathname
    if (previous === null || previous === pathname) return undefined

    const moveFocus = navigationType !== 'POP' && !hash
    let done = false
    let frame = 0
    let timer = 0
    let observer = null

    const finish = (heading, start) => {
      done = true
      observer?.disconnect()
      window.clearTimeout(timer)
      const main = document.getElementById('main-content')
      // Re-check: the user (or the page) may have moved focus while the heading was on its way.
      const active = document.activeElement
      if (moveFocus && main && (active === start || active === document.body) && focusIsFree(active, main)) {
        focusTarget(heading ?? main)
      }
      setMessage(document.title)
    }

    const awaitHeading = (start) => {
      const main = document.getElementById('main-content')
      const heading = main ? visibleHeading(main) : null
      if (heading || !main) {
        finish(heading, start)
        return
      }
      observer = new MutationObserver(() => {
        const found = visibleHeading(main)
        if (found) finish(found, start)
      })
      observer.observe(main, { childList: true, subtree: true })
      timer = window.setTimeout(() => finish(null, start), HEADING_WAIT_MS)
    }

    const startedAt = performance.now()
    const settle = () => {
      if (layerHoldsFocus() && performance.now() - startedAt < SETTLE_LIMIT_MS) {
        frame = window.requestAnimationFrame(settle)
        return
      }
      const start = document.activeElement
      // Focus still held by a layer after the limit: leave it there, only announce.
      if (layerHoldsFocus() || !focusIsFree(start, document.getElementById('main-content'))) {
        done = true
        setMessage(document.title)
        return
      }
      awaitHeading(start)
    }

    setMessage('')
    // One frame later: the page's own effects (document title, autofocus) have run.
    frame = window.requestAnimationFrame(settle)

    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(timer)
      observer?.disconnect()
      // Interrupted before it ran (React StrictMode re-runs effects; a quick second navigation): let the next
      // run see this navigation again.
      if (!done) lastPathname = previous
    }
  }, [key, pathname, hash, navigationType])

  return (
    <div className="sr-only" aria-live="polite" aria-atomic="true">
      {message}
    </div>
  )
}

export default RouteAnnouncer
