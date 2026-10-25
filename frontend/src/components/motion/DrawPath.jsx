import { motion } from 'framer-motion'
import { useRef } from 'react'
import { useInViewOnce, usePrefersReducedMotion } from './hooks'
import { DURATION, EASE } from './tokens'

const SHAPES = new Set(['path', 'line', 'polyline', 'polygon', 'circle', 'ellipse', 'rect'])

/**
 * An SVG stroke that draws itself once it scrolls into view (routing arcs, lane connectors, check marks).
 * Uses framer-motion's normalised `pathLength`, so any shape length works without measuring.
 *
 * - `inView` (optional) lets a parent drive several strokes from one trigger; otherwise the shape watches itself.
 * - Reduced motion: the finished stroke, immediately.
 * - For solid strokes: `pathLength` owns `stroke-dasharray`, so a dashed lane line should be revealed with a
 *   mask or `clip-path` instead.
 *
 * @param {object} props SVG attributes for the shape (d, points, x1..., stroke, strokeWidth, className ...) plus:
 * @param {'path'|'line'|'polyline'|'polygon'|'circle'|'ellipse'|'rect'} [props.as='path']
 * @param {boolean} [props.inView] external trigger
 * @param {number} [props.duration] seconds (default DURATION.slower x 2 - strokes read better a little slower)
 * @param {number} [props.delay] seconds
 */
export function DrawPath({ as = 'path', inView: inViewProp, duration = DURATION.slower * 2, delay = 0, ease = EASE.standard, ...props }) {
  const ref = useRef(null)
  const reduced = usePrefersReducedMotion()
  const seen = useInViewOnce(ref, { margin: '0px 0px -15% 0px' })
  const visible = inViewProp ?? seen
  const Shape = motion[SHAPES.has(as) ? as : 'path']

  return (
    <Shape
      ref={ref}
      initial={reduced ? false : { pathLength: 0, opacity: 0 }}
      animate={visible || reduced ? { pathLength: 1, opacity: 1 } : undefined}
      transition={{ pathLength: { duration, delay, ease }, opacity: { duration: 0.01, delay } }}
      {...props}
    />
  )
}

export default DrawPath
