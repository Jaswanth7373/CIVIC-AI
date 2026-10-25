/**
 * Shared behaviour of the SVG stills (CityFallback, PulseStill); no three.js import.
 *
 * - observeBox(node, onBox): reports the element's size from a ResizeObserver (delivered after layout, so measuring
 *   never forces one), ignoring momentary sliver boxes; without ResizeObserver it measures once in a frame.
 * - fadeInStill(element): a freshly composed still fades in on the compositor (opacity only), instantly with
 *   prefers-reduced-motion. The stills are built as React transitions after the page's first paint, so they arrive
 *   a frame or two after the page's own content: the fade makes that read as the lights coming up.
 */

/** Smallest box (CSS px, either side) a still is composed for. */
export const MIN_STILL_BOX = 16

/** Calls `onBox(width, height)` whenever `node` changes size (boxes under MIN_STILL_BOX px are ignored). */
export function observeBox(node, onBox) {
  const report = (width, height) => {
    if (width >= MIN_STILL_BOX && height >= MIN_STILL_BOX) onBox(width, height)
  }
  if (typeof ResizeObserver === 'undefined') {
    const frame = requestAnimationFrame(() => {
      const rect = node.getBoundingClientRect()
      report(rect.width, rect.height)
    })
    return () => cancelAnimationFrame(frame)
  }
  const observer = new ResizeObserver((entries) => {
    const { width, height } = entries[entries.length - 1].contentRect
    report(width, height)
  })
  observer.observe(node)
  return () => observer.disconnect()
}

export function fadeInStill(element) {
  if (!element || typeof element.animate !== 'function') return
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
  element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 320, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' })
}
