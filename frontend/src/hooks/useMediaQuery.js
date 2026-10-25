/**
 * Subscribe to a CSS media query: `const isDesktop = useMediaQuery(BREAKPOINTS.lg)`.
 *
 * Built on `useSyncExternalStore`, React's primitive for reading external mutable sources: the component
 * re-renders exactly when `matchMedia(query).matches` changes, and there is no stale first render.
 */
import { useCallback, useSyncExternalStore } from 'react'

/** Tailwind's default breakpoints as min-width media queries. */
export const BREAKPOINTS = Object.freeze({
  sm: '(min-width: 640px)',
  md: '(min-width: 768px)',
  lg: '(min-width: 1024px)',
  xl: '(min-width: 1280px)',
  '2xl': '(min-width: 1536px)',
  coarsePointer: '(pointer: coarse)',
  reducedMotion: '(prefers-reduced-motion: reduce)',
})

export function useMediaQuery(query) {
  const subscribe = useCallback(
    (onChange) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => {}
      const media = window.matchMedia(query)
      media.addEventListener('change', onChange)
      return () => media.removeEventListener('change', onChange)
    },
    [query],
  )
  const getSnapshot = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false)
  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}

export default useMediaQuery
