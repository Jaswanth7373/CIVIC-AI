/**
 * Track whether a scrolling element has hidden content before or after its visible part, so a table or a
 * navigation list can show a scroll cue (an edge shadow) only while there is more to see in that direction.
 *
 *   const [scrollerRef, edges] = useScrollEdges()                 // horizontal (default)
 *   const [navRef, navEdges] = useScrollEdges({ axis: 'y' })     // vertical
 *   <div ref={scrollerRef} className="overflow-x-auto">...</div>
 *   {edges.end ? <EdgeShadow side="end" /> : null}
 *
 * `edges` is `{start, end}`: `start` = content is scrolled out of view on the left (top), `end` = more content
 * to the right (below). It updates on scroll, when the element resizes (viewport, sidebar) and when its first
 * child resizes (rows loaded, columns changed). The returned ref is a callback ref, so it also follows an
 * element that is mounted later (e.g. a table that replaces its loading state). The state object keeps its
 * identity while the edges do not change, so scrolling does not re-render the component on every frame.
 */
import { useCallback, useEffect, useState } from 'react'

const NO_EDGES = Object.freeze({ start: false, end: false })

export function useScrollEdges({ axis = 'x' } = {}) {
  const [node, setNode] = useState(null)
  const [edges, setEdges] = useState(NO_EDGES)
  const vertical = axis === 'y'

  useEffect(() => {
    if (!node) {
      setEdges(NO_EDGES)
      return undefined
    }
    let frame = 0
    const measure = () => {
      frame = 0
      const overflow = vertical ? node.scrollHeight - node.clientHeight : node.scrollWidth - node.clientWidth
      // scrollLeft is negative in right-to-left layouts; the distance from the start is what matters.
      const offset = Math.abs(vertical ? node.scrollTop : node.scrollLeft)
      const next = overflow > 1 ? { start: offset > 1, end: offset < overflow - 1 } : NO_EDGES
      setEdges((current) => (current.start === next.start && current.end === next.end ? current : next))
    }
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(measure)
    }
    measure()
    node.addEventListener('scroll', schedule, { passive: true })
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null
    observer?.observe(node)
    if (node.firstElementChild) observer?.observe(node.firstElementChild)
    return () => {
      node.removeEventListener('scroll', schedule)
      observer?.disconnect()
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [node, vertical])

  const ref = useCallback((element) => setNode(element), [])
  return [ref, edges]
}

export default useScrollEdges
