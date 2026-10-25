/**
 * Anchored positioning for menus, popovers and tooltips.
 *
 * Floating panels are portalled to <body> with `position: fixed`, so they are never clipped by a scrolling
 * table or card. Their coordinates are computed from the anchor's `getBoundingClientRect()`:
 * 1. place the panel on the requested side (`bottom-end`, `top`, `right` ...) with an offset;
 * 2. flip to the opposite side when it would overflow the viewport and the other side has more room;
 * 3. clamp it inside the viewport with a small padding;
 * 4. report the space left on that side as `maxHeight`, so long menus scroll instead of overflowing.
 * Position is recomputed on scroll (capture phase, so scrolling containers count), resize and when the
 * panel's own size changes (ResizeObserver) - batched with requestAnimationFrame.
 */
import { useLayoutEffect, useState } from 'react'

function parsePlacement(placement) {
  const [side = 'bottom', align = 'center'] = String(placement).split('-')
  return { side, align }
}

/** Pure function: compute `{top, left, side, maxHeight}` for a floating rect next to an anchor rect. */
export function computePosition(anchor, floating, placement = 'bottom-start', { offset = 8, padding = 8 } = {}) {
  const viewportWidth = document.documentElement.clientWidth
  const viewportHeight = window.innerHeight
  let { side } = parsePlacement(placement)
  const { align } = parsePlacement(placement)

  const space = {
    top: anchor.top - offset - padding,
    bottom: viewportHeight - anchor.bottom - offset - padding,
    left: anchor.left - offset - padding,
    right: viewportWidth - anchor.right - offset - padding,
  }
  const opposite = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }
  const needed = side === 'top' || side === 'bottom' ? floating.height : floating.width
  if (space[side] < needed && space[opposite[side]] > space[side]) side = opposite[side]

  let top
  let left
  if (side === 'top' || side === 'bottom') {
    top = side === 'bottom' ? anchor.bottom + offset : anchor.top - offset - floating.height
    if (align === 'start') left = anchor.left
    else if (align === 'end') left = anchor.right - floating.width
    else left = anchor.left + anchor.width / 2 - floating.width / 2
  } else {
    left = side === 'right' ? anchor.right + offset : anchor.left - offset - floating.width
    if (align === 'start') top = anchor.top
    else if (align === 'end') top = anchor.bottom - floating.height
    else top = anchor.top + anchor.height / 2 - floating.height / 2
  }

  left = Math.min(Math.max(left, padding), Math.max(padding, viewportWidth - floating.width - padding))
  top = Math.min(Math.max(top, padding), Math.max(padding, viewportHeight - floating.height - padding))

  const maxHeight = side === 'top' || side === 'bottom' ? Math.max(120, space[side]) : viewportHeight - padding * 2
  return { top: Math.round(top), left: Math.round(left), side, maxHeight: Math.round(maxHeight) }
}

/**
 * Track the position of `floatingRef` next to `anchorRef` while `open`.
 * Returns null until the first measurement (render the panel hidden until then).
 */
export function useAnchoredPosition(open, anchorRef, floatingRef, { placement = 'bottom-start', offset = 8, padding = 8 } = {}) {
  const [position, setPosition] = useState(null)

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return undefined
    }
    let frame = 0
    const update = () => {
      const anchor = anchorRef.current
      const floating = floatingRef.current
      if (!anchor || !floating) return
      const next = computePosition(anchor.getBoundingClientRect(), floating.getBoundingClientRect(), placement, {
        offset,
        padding,
      })
      setPosition((current) =>
        current &&
        current.top === next.top &&
        current.left === next.left &&
        current.side === next.side &&
        current.maxHeight === next.maxHeight
          ? current
          : next,
      )
    }
    const schedule = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(update)
    }
    update()
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null
    if (floatingRef.current) observer?.observe(floatingRef.current)
    if (anchorRef.current) observer?.observe(anchorRef.current)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      observer?.disconnect()
    }
  }, [open, anchorRef, floatingRef, placement, offset, padding])

  return position
}

/**
 * CSS `transform-origin` for a floating panel: the edge facing its anchor, at the aligned end - so a menu
 * opening below-right of its button grows out of the button ("right top"), a tooltip above it out of its
 * bottom centre ("center bottom").
 */
export function floatingOrigin(side = 'bottom', align = 'center') {
  const vertical = side === 'top' || side === 'bottom'
  const edge = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }[side] ?? 'top'
  let cross = 'center'
  if (align === 'start') cross = vertical ? 'left' : 'top'
  else if (align === 'end') cross = vertical ? 'right' : 'bottom'
  return vertical ? `${cross} ${edge}` : `${edge} ${cross}`
}

/** Offset a floating panel starts from (and leaves toward): `distance` px back toward its anchor. */
export function floatingOffset(side = 'bottom', distance = 6) {
  if (side === 'top') return { x: 0, y: distance }
  if (side === 'left') return { x: distance, y: 0 }
  if (side === 'right') return { x: -distance, y: 0 }
  return { x: 0, y: -distance }
}

/** Inline style for a floating panel: hidden until measured, then fixed at the computed coordinates. */
export function floatingStyle(position, extra = {}) {
  return {
    position: 'fixed',
    top: position?.top ?? 0,
    left: position?.left ?? 0,
    visibility: position ? 'visible' : 'hidden',
    ...extra,
  }
}
