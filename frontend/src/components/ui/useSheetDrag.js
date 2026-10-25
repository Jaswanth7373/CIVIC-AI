/**
 * Swipe-to-dismiss for sheets and drawers (Modal and Drawer on phones), built on framer-motion drag.
 *
 * - The drag starts only from the grab zone (`handleProps`: the handle bar and the sheet's header; for a side
 *   drawer the whole panel), never from the scrolling body, so reading and scrolling a long sheet never moves it.
 * - The panel follows the finger 1:1 toward the dismiss direction and not at all the other way; the page behind
 *   brightens as it goes (`dim`, a 0..1 motion value for the backdrop's opacity). Only the "not past the rest
 *   position" side is a drag constraint, so a release never starts framer-motion's constraint snap-back.
 * - Released past 30% of its size (at most 140px) or flicked faster than 650px/s, the sheet keeps moving the way
 *   the finger threw it: a spring that starts at the release velocity carries it off screen, and `onDismiss` is
 *   called when it is gone (the component's own exit then only fades the backdrop). Otherwise it springs back to
 *   rest (SPRING.panel). The panel's position is the hook's own motion value (`panelProps.style`), so the
 *   component's enter / exit animations and the drag move the same value.
 * - Keyboard and screen-reader users close sheets as before (Esc, the close button); the grab zone is visual.
 *
 * @param {object} options
 * @param {boolean} options.enabled
 * @param {boolean} options.open resets the dim when the sheet opens again
 * @param {() => void} [options.onDismiss]
 * @param {import('react').RefObject<HTMLElement>} options.panelRef
 * @param {'y'|'x'} [options.axis='y'] y: bottom sheet (dismiss downward); x: side drawer
 * @param {1|-1} [options.direction=1] dismiss direction along the axis (-1: a left drawer swiped left)
 * @returns {{panelProps: object, handleProps: object, dim: import('framer-motion').MotionValue<number>}}
 */
import { animate, useDragControls, useMotionValue, useTransform } from 'framer-motion'
import { useEffect } from 'react'
import { SPRING } from '@/components/motion/tokens'

const INTERACTIVE = 'button, a[href], input, select, textarea, [role="button"], [contenteditable="true"]'

export function useSheetDrag({ enabled, open, onDismiss, panelRef, axis = 'y', direction = 1 }) {
  const controls = useDragControls()
  const progress = useMotionValue(0)
  const dim = useTransform(progress, [0, 1], [1, 0.2])
  // The panel's offset along the drag axis (px), shared by the drag, the component's animations and ours.
  const offsetX = useMotionValue(0)
  const offsetY = useMotionValue(0)

  useEffect(() => {
    if (open) progress.set(0)
  }, [open, progress])

  if (!enabled) return { panelProps: {}, handleProps: {}, dim }

  const extent = () => {
    const rect = panelRef.current?.getBoundingClientRect()
    return (axis === 'y' ? rect?.height : rect?.width) || 1
  }
  const travelOf = (info) => (axis === 'y' ? info.offset.y : info.offset.x) * direction
  const speedOf = (info) => (axis === 'y' ? info.velocity.y : info.velocity.x) * direction
  const offset = axis === 'y' ? offsetY : offsetX
  // Only the rest side is constrained (a bottom sheet cannot be pulled up, a left drawer cannot be pulled right).
  const restSide = axis === 'y' ? (direction > 0 ? 'top' : 'bottom') : direction > 0 ? 'left' : 'right'

  const panelProps = {
    drag: axis,
    dragListener: false,
    dragControls: controls,
    dragConstraints: { [restSide]: 0 },
    dragElastic: 0,
    dragMomentum: false,
    style: { [axis]: offset },
    onDrag: (_event, info) => progress.set(Math.max(0, travelOf(info)) / extent()),
    onDragEnd: (_event, info) => {
      const size = extent()
      const travel = travelOf(info)
      const follow = (value) => progress.set(Math.max(0, Number(value) * direction) / size)
      if (travel > Math.min(140, size * 0.3) || (speedOf(info) > 650 && travel > 16)) {
        // Carry on at the release speed (at least a brisk 900px/s); close as soon as the panel is off screen (the
        // component's exit then animates the same value to 100%, just past which it already is).
        const speed = Math.max(900, speedOf(info))
        let closed = false
        const close = () => {
          if (closed) return
          closed = true
          onDismiss?.()
        }
        animate(offset, (size + 8) * direction, {
          type: 'spring',
          stiffness: 420,
          damping: 41,
          velocity: speed * direction,
          restDelta: 1,
          onUpdate: (value) => {
            follow(value)
            if (Number(value) * direction >= size) close()
          },
        }).then(close)
      } else {
        animate(offset, 0, { ...SPRING.panel, onUpdate: follow })
      }
    },
  }

  const handleProps = {
    onPointerDown: (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return
      // Buttons and fields inside the grab zone (the close button, a header action) keep their own behaviour.
      if (axis === 'y' && event.target instanceof Element && event.target.closest(INTERACTIVE)) return
      controls.start(event)
    },
    // The browser must not pan the page from the grab zone; a side drawer still scrolls its list vertically.
    style: { touchAction: axis === 'y' ? 'none' : 'pan-y' },
  }

  return { panelProps, handleProps, dim }
}

export default useSheetDrag
