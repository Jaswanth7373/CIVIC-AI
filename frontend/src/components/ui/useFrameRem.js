/**
 * useFrameRem - the content width of an element in rem, measured before the first paint and on every resize:
 * what a CSS container query on that element would see (`@5xl` = 64rem ...).
 *
 * List components use it to render ONLY the layout that is shown - the cards or the table - instead of rendering
 * both and hiding one with a container query, which doubled the DOM (and the render and commit cost) of every
 * list page.
 *
 *   const frameRef = useRef(null)
 *   const width = useFrameRem(frameRef)          // null until measured
 *   const wide = width !== null && width >= 64   // like @5xl
 *
 * @param {import('react').RefObject<HTMLElement>} ref the measured element (always rendered)
 * @param {boolean} [enabled=true]
 * @returns {number|null} the width in rem, or null before the first measurement (or when disabled)
 */
import { useLayoutEffect, useState } from 'react'

export function useFrameRem(ref, enabled = true) {
  const [rem, setRem] = useState(null)
  useLayoutEffect(() => {
    const frame = ref.current
    if (!enabled || !frame) return undefined
    const read = () => {
      const rootPx = Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16
      setRem(frame.clientWidth / rootPx)
    }
    read()
    if (typeof ResizeObserver !== 'function') return undefined
    const observer = new ResizeObserver(read)
    observer.observe(frame)
    return () => observer.disconnect()
  }, [ref, enabled])
  return enabled ? rem : null
}

export default useFrameRem
