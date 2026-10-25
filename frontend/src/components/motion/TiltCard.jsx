import { useSpring } from 'framer-motion'
import { useCallback, useEffect, useRef } from 'react'
import { cn } from '@/utils/cn'
import { useFinePointer, usePrefersReducedMotion } from './hooks'
import { SPRING } from './tokens'

const PERSPECTIVE = 1000
/** How far (px) the edge nearest the viewer may grow in perspective. Keeps wide cards from poking past the page. */
const MAX_EDGE_SHIFT = 5

/**
 * Largest tilt (degrees) for a card `size` px wide (or tall) so that its near edge grows by at most
 * MAX_EDGE_SHIFT px: small cards get the full `max`, a full-width panel only a degree or so.
 */
function limitFor(max, size) {
  const half = size / 2
  if (!(half > 0)) return 0
  const sine = (MAX_EDGE_SHIFT * PERSPECTIVE) / (half * (half + MAX_EDGE_SHIFT))
  return Math.min(max, (Math.asin(Math.min(1, sine)) * 180) / Math.PI)
}

const clamp01 = (value) => Math.min(1, Math.max(0, value))

/**
 * Card that leans toward the pointer: a spring-smoothed 3D tilt plus a soft sodium-light glare that follows
 * the cursor (the streetlight of the cinematic city, not a generic white shine). The glare is the card's own
 * `::before` layer (class `tilt-surface`, the card is `isolate`d), painted between its background and its
 * content - so don't give a glare-enabled card its own `before:` content.
 *
 * - Mouse / trackpad only: on touch screens and with reduced motion it renders the plain element.
 * - No transform at rest (the inline transform is removed once the card has settled), so it never creates a
 *   stacking context, blurs text or changes layout while idle. It does not handle focus or keyboard input,
 *   and passes every prop (href, to, onClick, aria-*) through to the element.
 * - While the pointer is over it, the element carries `data-tilt-active` (style a hover lift with
 *   `data-[tilt-active]:elev-floating`, for example).
 *
 * @param {object} props
 * @param {import('react').ElementType} [props.as='div'] element or component (e.g. a router Link)
 * @param {number} [props.max=6] maximum tilt in degrees (large cards are limited further automatically)
 * @param {boolean} [props.glare=true]
 * @param {boolean} [props.disabled]
 */
export function TiltCard({
  as: Component = 'div',
  max = 6,
  glare = true,
  disabled = false,
  className,
  children,
  onPointerEnter,
  onPointerMove,
  onPointerLeave,
  ref: forwardedRef,
  ...props
}) {
  const reduced = usePrefersReducedMotion()
  const finePointer = useFinePointer()
  const enabled = finePointer && !reduced && !disabled && max > 0
  const nodeRef = useRef(null)
  const frameRef = useRef(null)
  const rotateX = useSpring(0, SPRING.tilt)
  const rotateY = useSpring(0, SPRING.tilt)

  const setRef = useCallback(
    (node) => {
      nodeRef.current = node
      if (typeof forwardedRef === 'function') forwardedRef(node)
      else if (forwardedRef) forwardedRef.current = node
    },
    [forwardedRef],
  )

  // Write the spring values straight to the element (no React render per frame).
  useEffect(() => {
    const node = nodeRef.current
    if (!enabled || !node) return undefined
    const write = () => {
      const x = rotateX.get()
      const y = rotateY.get()
      if (Math.abs(x) < 0.02 && Math.abs(y) < 0.02 && !node.hasAttribute('data-tilt-active')) {
        node.style.removeProperty('transform')
        node.style.removeProperty('will-change')
        return
      }
      node.style.transform = `perspective(${PERSPECTIVE}px) rotateX(${x.toFixed(2)}deg) rotateY(${y.toFixed(2)}deg)`
    }
    const unsubscribe = [rotateX.on('change', write), rotateY.on('change', write)]
    return () => {
      unsubscribe.forEach((stop) => stop())
      node.style.removeProperty('transform')
      node.style.removeProperty('will-change')
      node.removeAttribute('data-tilt-active')
    }
  }, [enabled, rotateX, rotateY])

  const handleEnter = (event) => {
    onPointerEnter?.(event)
    const node = nodeRef.current
    if (!enabled || !node || event.pointerType === 'touch') return
    const rect = node.getBoundingClientRect()
    frameRef.current = {
      left: rect.left + window.scrollX,
      top: rect.top + window.scrollY,
      width: rect.width,
      height: rect.height,
      limitX: limitFor(max, rect.height),
      limitY: limitFor(max, rect.width),
    }
    node.setAttribute('data-tilt-active', '')
    node.style.willChange = 'transform'
  }

  const handleMove = (event) => {
    onPointerMove?.(event)
    const node = nodeRef.current
    const frame = frameRef.current
    if (!enabled || !node || !frame || event.pointerType === 'touch') return
    // Page coordinates measured on enter: the rectangle stays correct while the page scrolls under the pointer.
    const px = clamp01((event.pageX - frame.left) / frame.width)
    const py = clamp01((event.pageY - frame.top) / frame.height)
    rotateY.set((px - 0.5) * 2 * frame.limitY)
    rotateX.set(-(py - 0.5) * 2 * frame.limitX)
    node.style.setProperty('--tilt-x', `${(px * 100).toFixed(1)}%`)
    node.style.setProperty('--tilt-y', `${(py * 100).toFixed(1)}%`)
  }

  const handleLeave = (event) => {
    onPointerLeave?.(event)
    const node = nodeRef.current
    frameRef.current = null
    if (!node) return
    node.removeAttribute('data-tilt-active')
    rotateX.set(0)
    rotateY.set(0)
    // Already level (entered and left without moving): nothing will animate, so clean up right away.
    if (Math.abs(rotateX.get()) < 0.02 && Math.abs(rotateY.get()) < 0.02) {
      node.style.removeProperty('transform')
      node.style.removeProperty('will-change')
    }
  }

  return (
    <Component
      ref={setRef}
      className={cn('relative', enabled && glare && 'tilt-surface isolate', className)}
      onPointerEnter={handleEnter}
      onPointerMove={handleMove}
      onPointerLeave={handleLeave}
      {...props}
    >
      {children}
    </Component>
  )
}

export default TiltCard
