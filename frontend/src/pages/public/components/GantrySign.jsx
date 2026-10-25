/**
 * GantrySign - a road sign hanging from two steel rods, drawn in CSS 3D (styles/public.css, section 1).
 *
 * The inner public pages hang their title on a guide-blue informatory sign (the convention for "information"
 * signs on Indian roads); the auth pages hang the CivicAI brand sign in sign green, like the logo. It is the page's
 * one display moment, so it is built from the product's own world rather than a generic hero treatment:
 * - Entrance (once): the rods drop from the header edge, then the panel - folded up edge-on - swings down on its
 *   hinge, passes rest slightly and settles (a damped spring around its top edge); a retroreflective glint then
 *   crosses it, like headlights passing.
 * - Scroll (optional `tilt`): the panel tilts back a little as the page scrolls under it - driving beneath an
 *   overhead sign. Pass the intro element as `scrollTarget` so the tilt follows the whole band.
 * - At rest the panel has no transform at all, so its text is never rasterised in 3D.
 * - Reduced motion: the finished sign, no swing, no glint, no tilt.
 *
 * The sign is presentational; its children carry the semantics (the page's <h1>, or text). The pictogram is
 * decorative.
 *
 * @param {object} props
 * @param {'guide'|'brand'} [props.tone='guide'] blue informatory sign or the green CivicAI sign
 * @param {import('react').ComponentType|import('react').ReactElement} [props.icon] pictogram for the white tile
 * @param {import('react').RefObject<Element>} [props.scrollTarget] element whose scroll-out drives the tilt
 * @param {boolean} [props.tilt=true] tilt with the scroll
 * @param {number} [props.delay=0.1] seconds before the entrance starts
 * @param {string} [props.className] classes for the outer element (positioning, rod length via --gantry-drop)
 * @param {string} [props.faceClassName] classes for the sign face (padding, width)
 */
import { motion, useTransform } from 'framer-motion'
import { useRef } from 'react'
import { useElementScrollProgress, usePrefersReducedMotion } from '@/components/motion/hooks'
import { EASE } from '@/components/motion/tokens'
import { cn } from '@/utils/cn'
import { renderIcon } from '@/utils/icons'
import '@/styles/public.css'

/**
 * A heavy panel released on its hinge: it starts folded up almost edge-on (so it never fades in like a web
 * element), swings down, passes rest by about ten degrees and settles - damping ratio ~0.55, done in ~0.7 s.
 */
const SWING = { type: 'spring', stiffness: 150, damping: 13.5, mass: 1 }
const FOLDED = -84

export function GantrySign({ tone = 'guide', icon, scrollTarget, tilt = true, delay = 0.1, className, faceClassName, children }) {
  const reduced = usePrefersReducedMotion()
  const ownRef = useRef(null)
  // 0..1 as the band scrolls out of the top of the window (not useScroll({ target }): see the hook).
  const scrollYProgress = useElementScrollProgress(scrollTarget ?? ownRef)
  const tiltX = useTransform(scrollYProgress, [0, 1], [0, -16])
  const animate = !reduced

  return (
    <div ref={ownRef} data-tone={tone} className={cn('pub-gantry', className)}>
      <div className="pub-gantry-body">
        <motion.div
          aria-hidden
          className="pub-gantry-hangers"
          initial={animate ? { scaleY: 0 } : false}
          animate={{ scaleY: 1 }}
          transition={{ duration: 0.28, ease: EASE.enter, delay }}
        >
          <span className="pub-gantry-rod" />
          <span className="pub-gantry-rod" />
        </motion.div>
        <motion.div className="pub-gantry-pivot" style={animate && tilt ? { rotateX: tiltX } : undefined}>
          <motion.div
            className="pub-gantry-swing"
            initial={animate ? { rotateX: FOLDED } : false}
            animate={{ rotateX: 0 }}
            transition={{ ...SWING, delay: delay + 0.16 }}
          >
            <div
              className={cn('pub-gantry-face', animate && 'pub-gantry-face--glint', faceClassName)}
              // The glint crosses once the swing has settled (about 0.85 s after it starts).
              style={animate ? { '--glint-delay': `${delay + 1}s` } : undefined}
            >
              {icon ? (
                <span aria-hidden className="pub-gantry-tile">
                  {renderIcon(icon, { strokeWidth: 2.4 })}
                </span>
              ) : null}
              <div className="relative min-w-0">{children}</div>
            </div>
          </motion.div>
        </motion.div>
      </div>
    </div>
  )
}

export default GantrySign
