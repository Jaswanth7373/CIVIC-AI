/**
 * Hooks shared by the motion components (and available to pages through `@/components/motion`).
 *
 * - usePrefersReducedMotion(): the user's "reduce motion" setting, live; <MotionConfig reducedMotion="always">
 *   also turns it on.
 * - useFinePointer(): true on devices with a mouse / trackpad (hover + fine pointer). Pointer effects such as
 *   tilt and glare are off on touch screens, where they would only fire on tap and stick.
 * - useInViewOnce(ref, options): true once the element has entered the viewport (never goes back to false).
 *   With reduced motion it is true from the start, so reveal-style components render their final state.
 * - useScrolled(threshold): true while the window is scrolled past `threshold` px (glass-on-scroll bars).
 *   Re-renders only when the answer changes, not on every scroll event; scroll position is read once per frame.
 * - useElementScrollProgress(ref): 0..1 as the element scrolls out of the top of the window (0 when its top is
 *   at the top of the window, 1 when its bottom is) - useScroll({ target, offset: ['start start', 'end start'] })
 *   without the target, whose timeline framer-motion caches per element forever (every visit of a page would
 *   keep its detached DOM alive).
 * - useLatestLocation(): the location being navigated to (or the current one) - for indicators that should
 *   respond to a click at once.
 * - useRouteLoading(): true while a navigation has started but its page has not been shown yet - React Router
 *   commits navigations in a transition, so while a lazy page chunk downloads the old page stays on screen and
 *   nothing else would tell the user that their click was received.
 */
import { MotionConfigContext, useInView, useMotionValue, useScroll } from 'framer-motion'
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { UNSAFE_DataRouterContext, useLocation } from 'react-router-dom'
import { BREAKPOINTS, useMediaQuery } from '@/hooks/useMediaQuery'

const FINE_POINTER_QUERY = '(hover: hover) and (pointer: fine)'

/**
 * The user's reduced-motion preference (live). `<MotionConfig reducedMotion="always">` forces it on; nothing
 * forces it off - "never" is also framer-motion's default outside any MotionConfig (another React root, a
 * portal into a separate tree), and an accessibility setting must not be dropped by accident.
 */
export function usePrefersReducedMotion() {
  const { reducedMotion } = useContext(MotionConfigContext)
  const prefersReduced = useMediaQuery(BREAKPOINTS.reducedMotion)
  return reducedMotion === 'always' || prefersReduced
}

/** True on devices whose primary pointer can hover precisely (mouse, trackpad, pen). */
export function useFinePointer() {
  return useMediaQuery(FINE_POINTER_QUERY)
}

/**
 * True once `ref`'s element has been in view. The default fires when any part of the element has risen above
 * the bottom 12% of the window - things reveal a little after they peek in, not at the very edge - and works
 * for elements of any height (a ratio such as `amount: 0.5` can never be reached by an element more than twice
 * as tall as the window, so only use ratios for small elements).
 *
 * @param {import('react').RefObject<Element>} ref
 * @param {{amount?: number|'some'|'all', margin?: string, root?: import('react').RefObject<Element>}} [options]
 */
export function useInViewOnce(ref, { amount = 'some', margin = '0px 0px -12% 0px', root } = {}) {
  const reduced = usePrefersReducedMotion()
  const inView = useInView(ref, { once: true, amount, margin, root })
  return reduced || inView
}

/**
 * True while `window.scrollY` is greater than `threshold` pixels. The position is read in a frame callback (at
 * most once per frame, when layout is clean), never during render: reading it in render would force a layout in
 * the middle of every commit of the component that uses it.
 */
export function useScrolled(threshold = 8) {
  const [scrolled, setScrolled] = useState(() => typeof window !== 'undefined' && window.scrollY > threshold)
  useEffect(() => {
    let frame = 0
    const read = () => {
      frame = 0
      setScrolled(window.scrollY > threshold)
    }
    const onChange = () => {
      if (!frame) frame = window.requestAnimationFrame(read)
    }
    onChange()
    window.addEventListener('scroll', onChange, { passive: true })
    window.addEventListener('resize', onChange)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('scroll', onChange)
      window.removeEventListener('resize', onChange)
    }
  }, [threshold])
  return scrolled
}

/**
 * How far `ref`'s element has scrolled out of the top of the window, as a MotionValue from 0 (its top at the top
 * of the window) to 1 (its bottom at the top of the window) - the same as framer-motion's
 * `useScroll({ target: ref, offset: ['start start', 'end start'] }).scrollYProgress`.
 *
 * Built on the document's scroll (`useScroll()` without a target) and the element's measured box: framer-motion
 * caches a scroll timeline per `target` element in a module-level map that is never cleared, so a target would
 * keep its page's whole detached DOM in memory after every visit. The box is measured before paint and again
 * when the element or the page resizes; the value updates with the scroll, never re-rendering React.
 *
 * @param {import('react').RefObject<Element>} ref
 * @returns {import('framer-motion').MotionValue<number>}
 */
export function useElementScrollProgress(ref) {
  const { scrollY } = useScroll()
  const progress = useMotionValue(0)
  const box = useRef({ top: 0, height: 1 })

  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return undefined
    const update = () => {
      const { top, height } = box.current
      progress.set(Math.min(1, Math.max(0, (scrollY.get() - top) / height)))
    }
    const measure = () => {
      const rect = node.getBoundingClientRect()
      box.current = { top: rect.top + window.scrollY, height: Math.max(1, rect.height) }
      update()
    }
    measure()
    const unsubscribe = scrollY.on('change', update)
    // The element's own size, and the page's (content loading above it moves it down).
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(node)
    observer?.observe(document.body)
    window.addEventListener('resize', measure)
    return () => {
      unsubscribe()
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [ref, scrollY, progress])

  return progress
}

const noSubscription = () => () => {}

/**
 * The router's newest location: the page being navigated to while it is still loading, otherwise the page on
 * screen. Navigation indicators (sidebar, tab bar, header links) use it to move the moment a link is
 * clicked, instead of after the next page's code has arrived.
 *
 * React Router 7 applies navigations inside `React.startTransition`; when the next page suspends, React keeps
 * the current page (and the committed `useLocation()`) until it is ready, while the router's own state already
 * holds the new location. Outside a data router (tests, stories) this is simply `useLocation()`.
 */
export function useLatestLocation() {
  const router = useContext(UNSAFE_DataRouterContext)?.router
  const location = useLocation()
  const subscribe = useCallback((onChange) => (router ? router.subscribe(() => onChange()) : noSubscription()), [router])
  const latest = useSyncExternalStore(
    subscribe,
    () => router?.state.location ?? null,
    () => null,
  )
  return latest ?? location
}

/** True while the router's newest location is not the one on screen yet (a lazy page is loading). */
export function useRouteLoading() {
  const location = useLocation()
  return useLatestLocation().key !== location.key
}
